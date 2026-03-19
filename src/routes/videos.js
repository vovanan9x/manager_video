const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { uploadToServer, fetchRemoteVideo, stopUpload, addSseClient, removeSseClient, enqueueUpload, emitProgress, _doUploadToServer, pauseQueue, resumeQueue, isQueuePaused, getQueueStatus } = require('../services/uploadService');
const { deleteFromServer, deleteFromSftp } = require('../services/serverService');

// GET /videos - list
router.get('/', requireAuth, (req, res) => {
    const user = req.session.user;
    const servers = db.prepare('SELECT id, name FROM servers ORDER BY name').all();
    const folders = db.prepare('SELECT id, name, path FROM folders ORDER BY path').all();
    const users   = db.prepare('SELECT id, username FROM users ORDER BY username').all();

    const ALLOWED_SIZES = [10, 15, 20, 30, 50, 100, 200];
    const rawSize = parseInt(req.query.per_page) || 15;
    const PAGE_SIZE = ALLOWED_SIZES.includes(rawSize) ? rawSize : 15;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const offset = (page - 1) * PAGE_SIZE;


    let baseQuery = `FROM videos v
    LEFT JOIN users u ON v.uploaded_by = u.id
    LEFT JOIN servers s ON v.server_id = s.id
    LEFT JOIN folders f ON v.folder_id = f.id`;
    const conditions = [];
    const params = [];

    if (req.query.server_id) {
        conditions.push('v.server_id = ?');
        params.push(req.query.server_id);
    }
    if (req.query.folder_id) {
        conditions.push('v.folder_id = ?');
        params.push(req.query.folder_id);
    }
    if (req.query.status) {
        conditions.push('v.status = ?');
        params.push(req.query.status);
    }
    if (req.query.user_id) {
        conditions.push('v.uploaded_by = ?');
        params.push(req.query.user_id);
    }
    if (req.query.search) {
        conditions.push('(v.title LIKE ? OR v.filename LIKE ? OR v.idah LIKE ?)');
        const term = '%' + req.query.search + '%';
        params.push(term, term, term);
    }

    const whereClause = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';

    const total = db.prepare(`SELECT COUNT(*) as count ${baseQuery}${whereClause}`).get(...params).count;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const videos = db.prepare(
        `SELECT v.*, u.username as uploader_name, s.name as server_name, f.name as folder_name
        ${baseQuery}${whereClause} ORDER BY v.created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, PAGE_SIZE, offset);

    res.render('videos', {
        user, activePage: 'videos', videos, servers, folders, users,
        filters: req.query,
        pagination: { page, totalPages, total, pageSize: PAGE_SIZE },
    });
});


// GET /videos/upload
router.get('/upload', requireAuth, (req, res) => {
    const serversAll = db.prepare('SELECT * FROM servers WHERE is_active = 1 ORDER BY name').all();
    const folders = db.prepare('SELECT * FROM folders ORDER BY path').all();
    const settings = db.prepare('SELECT key, value FROM settings').all();
    const settingsMap = {};
    settings.forEach(s => settingsMap[s.key] = s.value);

    res.render('upload', {
        user: req.session.user, activePage: 'upload',
        servers: serversAll, folders, settings: settingsMap, error: null
    });
});

// POST /videos/upload - local file
router.post('/upload/local', requireAuth, upload.single('video'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Không có file được upload' });

    const { title, description, genre, server_id, folder_id, idah } = req.body;
    if (!title || !server_id) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Thiếu tiêu đề hoặc server' });
    }

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id);
    if (!server) return res.status(400).json({ error: 'Server không tồn tại' });
    if (server.type === 'local') {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Không thể upload lên server local. Vui lòng chọn server SFTP hoặc HTTP.' });
    }

    const folder = folder_id ? db.prepare('SELECT * FROM folders WHERE id = ?').get(folder_id) : null;
    const filename = req.file.filename;
    const remotePath = (folder ? 'f' + folder.id + '/' : '') + filename;

    const stmt = db.prepare(
        'INSERT INTO videos (title, description, genre, filename, original_name, folder_id, server_id, uploaded_by, status, source_type, idah) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const result = stmt.run(title, description || '', genre || '', filename, req.file.originalname, folder_id || null, server_id, req.session.user.id, 'pending', 'local', idah || null);
    const videoId = result.lastInsertRowid;

    // Start upload in background
    const controller = { cancelled: false };
    uploadToServer(videoId, req.file.path, server, remotePath, controller);

    res.json({ success: true, videoId });
});

// POST /videos/upload/remote - remote URL
router.post('/upload/remote', requireAuth, async (req, res) => {
    const { title, description, genre, server_id, folder_id, url, idah } = req.body;
    if (!title || !server_id || !url) {
        return res.status(400).json({ error: 'Thiếu tiêu đề, server hoặc URL' });
    }
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id);
    if (!server) return res.status(400).json({ error: 'Server không tồn tại' });

    const folder = folder_id ? db.prepare('SELECT * FROM folders WHERE id = ?').get(folder_id) : null;
    const ext = path.extname(url.split('?')[0]) || '.mp4';
    const filename = crypto.randomUUID() + ext;
    const remotePath = (folder ? 'f' + folder.id + '/' : '') + filename;

    const stmt = db.prepare(
        'INSERT INTO videos (title, description, genre, filename, original_name, folder_id, server_id, uploaded_by, status, source_type, source_url, idah) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const result = stmt.run(title, description || '', genre || '', filename, path.basename(url), folder_id || null, server_id, req.session.user.id, 'pending', 'remote', url, idah || null);
    const videoId = result.lastInsertRowid;

    const controller = { cancelled: false };
    fetchRemoteVideo(videoId, url, server, remotePath, controller);

    res.json({ success: true, videoId });
});

// POST /videos/stop/:id
router.post('/stop/:id', requireAuth, (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) return res.json({ success: false, error: 'Video không tồn tại' });
    if (video.uploaded_by !== req.session.user.id && req.session.user.role !== 'administrator') {
        return res.status(403).json({ error: 'Không có quyền' });
    }
    const stopped = stopUpload(parseInt(req.params.id));
    res.json({ success: true, stopped });
});

// ── Queue Pause / Resume (admin only) ────────────────────────────────────────
// QUAN TRỌNG: Phải khai báo TRƯỚC route /:id/retry để tránh Express match
// 'queue' như một :id parameter.
function requireAdmin(req, res, next) {
    if (req.session && req.session.user && req.session.user.role === 'administrator') return next();
    return res.status(403).json({ error: 'Chỉ admin mới có quyền thực hiện hành động này' });
}

// GET /videos/queue/status
router.get('/queue/status', requireAuth, requireAdmin, (req, res) => {
    const qs = getQueueStatus();
    res.json({ success: true, paused: isQueuePaused(), running: qs.running, waiting: qs.waiting.length });
});

// POST /videos/queue/pause
router.post('/queue/pause', requireAuth, requireAdmin, (req, res) => {
    pauseQueue();
    res.json({ success: true, paused: true });
});

// POST /videos/queue/resume
router.post('/queue/resume', requireAuth, requireAdmin, (req, res) => {
    resumeQueue();
    res.json({ success: true, paused: false });
});
// ───────────────────────────────────────────────────────────────────────────

// POST /videos/:id/retry — thử lại upload cho video lỗi / bị dừng
router.post('/:id/retry', requireAuth, async (req, res) => {
    const videoId = parseInt(req.params.id);
    // Query tách biệt để tránh s.id ghi đè v.id khi JOIN
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
    if (!video) return res.status(404).json({ error: 'Video không tồn tại' });

    // Chỉ cho phép owner hoặc admin retry
    if (video.uploaded_by !== req.session.user.id && req.session.user.role !== 'administrator') {
        return res.status(403).json({ error: 'Không có quyền' });
    }

    // Chỉ retry khi đang ở trạng thái lỗi hoặc bị dừng
    if (video.status !== 'error' && video.status !== 'stopped') {
        return res.status(400).json({ error: 'Chỉ có thể thử lại video có trạng thái lỗi hoặc bị dừng' });
    }

    if (!video.server_id) {
        return res.status(400).json({ error: 'Video không có server được gán' });
    }

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(video.server_id);
    if (!server) return res.status(400).json({ error: 'Server không tồn tại' });

    const remotePath = video.remote_path || ((video.folder_id ? 'f' + video.folder_id + '/' : '') + video.filename);

    const sourceType = video.source_type;

    if (sourceType === 'local') {
        return res.status(400).json({ error: 'Không thể thử lại upload từ file gốc vì file tạm đã bị xóa. Vui lòng upload lại file.' });
    }

    if (sourceType === 'remote') {
        if (!video.source_url) return res.status(400).json({ error: 'Không tìm thấy URL nguồn để thử lại' });
        db.prepare("UPDATE videos SET status='pending', upload_progress=0 WHERE id=?").run(videoId);
        emitProgress(videoId, 0, 'pending');
        const controller = { cancelled: false, abort: () => {} };
        fetchRemoteVideo(videoId, video.source_url, server, remotePath, controller);
        return res.json({ success: true, message: 'Đã thêm vào hàng chờ upload lại' });
    }

    if (sourceType === 'drive' || (video.source_url && video.source_url.includes('drive.google.com'))) {
        if (!video.source_url) return res.status(400).json({ error: 'Không tìm thấy Drive URL để thử lại' });

        const fileIdMatch = video.source_url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
        if (!fileIdMatch) return res.status(400).json({ error: 'Không thể lấy file ID từ Drive URL' });
        const fileId = fileIdMatch[1];

        db.prepare("UPDATE videos SET status='pending', upload_progress=0 WHERE id=?").run(videoId);
        emitProgress(videoId, 0, 'pending');

        enqueueUpload(videoId, async () => {
            const { addErrorLog } = require('../config/database');
            try {
                db.prepare("UPDATE videos SET status='uploading', upload_progress=0 WHERE id=?").run(videoId);
                emitProgress(videoId, 0, 'uploading');

                const { getDriveStream } = require('../services/driveService');
                const { stream: driveStream, size: driveSize } = await getDriveStream(fileId);

                const tmpPath = path.join(os.tmpdir(), video.filename);
                const writeStream = fs.createWriteStream(tmpPath);
                let downloaded = 0;
                driveStream.on('data', chunk => {
                    downloaded += chunk.length;
                    if (driveSize > 0) emitProgress(videoId, Math.floor(downloaded / driveSize * 50), 'uploading');
                });
                await new Promise((resolve, reject) => {
                    driveStream.pipe(writeStream);
                    writeStream.on('finish', resolve);
                    writeStream.on('error', reject);
                    driveStream.on('error', reject);
                });

                await _doUploadToServer(videoId, tmpPath, server, remotePath, { progressOffset: 50 });

            } catch (err) {
                console.error('[Retry Drive Error]', err.message);
                addErrorLog('drive_upload', {
                    video_id: videoId,
                    video_title: video.title,
                    server_id: server.id,
                    server_label: server.name,
                    message: err.message,
                    stack: err.stack,
                });
                db.prepare("UPDATE videos SET status='error' WHERE id=?").run(videoId);
                emitProgress(videoId, 0, 'error');
            }
        });

        return res.json({ success: true, message: 'Đã thêm vào hàng chờ tải lại từ Drive' });
    }

    return res.status(400).json({ error: `Không hỗ trợ retry cho loại nguồn: ${sourceType}` });
});
// POST /videos/bulk-retry — retry nhiều video cùng lúc
router.post('/bulk-retry', requireAuth, async (req, res) => {
    const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'Không có video nào được chọn' });

    const results = { queued: [], skipped: [], errors: [] };

    for (const videoId of ids) {
        const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
        if (!video) { results.skipped.push({ id: videoId, reason: 'Không tồn tại' }); continue; }

        // Quyền: admin hoặc owner
        if (video.uploaded_by !== req.session.user.id && req.session.user.role !== 'administrator') {
            results.skipped.push({ id: videoId, reason: 'Không có quyền' });
            continue;
        }
        if (video.status !== 'error' && video.status !== 'stopped') {
            results.skipped.push({ id: videoId, reason: `Trạng thái ${video.status} không thể retry` });
            continue;
        }
        if (!video.server_id) {
            results.errors.push({ id: videoId, reason: 'Chưa gán server' });
            continue;
        }
        if (video.source_type === 'local') {
            results.skipped.push({ id: videoId, reason: 'Local upload không thể retry' });
            continue;
        }

        const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(video.server_id);
        if (!server) { results.errors.push({ id: videoId, reason: 'Server không tồn tại' }); continue; }

        const remotePath = video.remote_path || ((video.folder_id ? 'f' + video.folder_id + '/' : '') + video.filename);

        db.prepare("UPDATE videos SET status='pending', upload_progress=0 WHERE id=?").run(videoId);
        emitProgress(videoId, 0, 'pending');

        if (video.source_type === 'remote') {
            const controller = { cancelled: false, abort: () => {} };
            fetchRemoteVideo(videoId, video.source_url, server, remotePath, controller);
        } else if (video.source_type === 'drive' || (video.source_url && video.source_url.includes('drive.google.com'))) {
            const fileIdMatch = (video.source_url || '').match(/[?&]id=([a-zA-Z0-9_-]+)/);
            if (!fileIdMatch) { results.errors.push({ id: videoId, reason: 'Không lấy được Drive file ID' }); continue; }
            const fileId = fileIdMatch[1];

            enqueueUpload(videoId, async () => {
                const { addErrorLog } = require('../config/database');
                try {
                    db.prepare("UPDATE videos SET status='uploading', upload_progress=0 WHERE id=?").run(videoId);
                    emitProgress(videoId, 0, 'uploading');
                    const { getDriveStream } = require('../services/driveService');
                    const { stream: driveStream, size: driveSize } = await getDriveStream(fileId);
                    const tmpPath = path.join(os.tmpdir(), video.filename);
                    const ws = fs.createWriteStream(tmpPath);
                    let dl = 0;
                    driveStream.on('data', c => { dl += c.length; if (driveSize > 0) emitProgress(videoId, Math.floor(dl / driveSize * 50), 'uploading'); });
                    await new Promise((res, rej) => { driveStream.pipe(ws); ws.on('finish', res); ws.on('error', rej); driveStream.on('error', rej); });
                    await _doUploadToServer(videoId, tmpPath, server, remotePath, { progressOffset: 50 });
                } catch (err) {
                    console.error(`[Bulk Retry Drive #${videoId}]`, err.message);
                    addErrorLog('drive_upload', { video_id: videoId, video_title: video.title, server_id: server.id, server_label: server.name, message: err.message, stack: err.stack });
                    db.prepare("UPDATE videos SET status='error' WHERE id=?").run(videoId);
                    emitProgress(videoId, 0, 'error');
                }
            });
        }

        results.queued.push(videoId);
    }

    res.json({ success: true, queued: results.queued.length, skipped: results.skipped.length, errors: results.errors.length, detail: results });
});

router.get('/edit/:id', requireAuth, (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) return res.redirect('/videos');
    if (video.uploaded_by !== req.session.user.id && req.session.user.role !== 'administrator') {
        return res.status(403).render('error', { user: req.session.user, message: 'Không có quyền', activePage: '' });
    }
    const servers = db.prepare('SELECT * FROM servers WHERE is_active = 1').all();
    const folders = db.prepare('SELECT * FROM folders ORDER BY path').all();
    res.render('edit_video', { user: req.session.user, activePage: 'videos', video, servers, folders, error: null, success: null });
});

// POST /videos/edit/:id
router.post('/edit/:id', requireAuth, (req, res) => {
    const { title, description, genre, folder_id, idah } = req.body;
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) return res.redirect('/videos');
    if (video.uploaded_by !== req.session.user.id && req.session.user.role !== 'administrator') {
        return res.status(403).end();
    }
    db.prepare('UPDATE videos SET title = ?, description = ?, genre = ?, folder_id = ?, idah = ? WHERE id = ?')
        .run(title, description || '', genre || '', folder_id || null, idah || null, req.params.id);
    res.redirect('/videos?success=updated');
});

// POST /videos/delete/:id — admin only
router.post('/delete/:id', requireAuth, async (req, res) => {
    if (req.session.user.role !== 'administrator') {
        return res.status(403).json({ error: 'Chỉ admin mới có quyền xóa video' });
    }
    const video = db.prepare('SELECT v.*, s.type as server_type, s.root_path, s.host, s.port, s.username as s_username, s.password as s_password FROM videos v LEFT JOIN servers s ON v.server_id = s.id WHERE v.id = ?').get(req.params.id);
    if (!video) return res.json({ success: false });

    // Stop if uploading
    stopUpload(parseInt(req.params.id));

    // Delete file from server
    if (video.remote_path && video.server_type) {
        if (video.server_type === 'local') {
            deleteFromServer({ type: 'local', root_path: video.root_path }, video.remote_path);
        } else if (video.server_type === 'sftp') {
            deleteFromSftp({ host: video.host, port: video.port, username: video.s_username, password: video.s_password, root_path: video.root_path }, video.remote_path).catch(() => { });
        }
    }

    db.prepare('DELETE FROM videos WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

// GET /videos/progress/:id - SSE
router.get('/progress/:id', requireAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const videoId = req.params.id;
    addSseClient(videoId, res);

    // Send current state immediately
    const video = db.prepare('SELECT status, upload_progress FROM videos WHERE id = ?').get(videoId);
    if (video) {
        res.write(`data: ${JSON.stringify({ videoId: parseInt(videoId), progress: video.upload_progress, status: video.status })}\n\n`);
    }

    req.on('close', () => removeSseClient(videoId, res));
});

module.exports = router;
