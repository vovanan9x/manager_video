const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { uploadToServer, fetchRemoteVideo, stopUpload, addSseClient, removeSseClient } = require('../services/uploadService');
const { deleteFromServer, deleteFromSftp } = require('../services/serverService');

// GET /videos - list
router.get('/', requireAuth, (req, res) => {
    const user = req.session.user;
    const servers = db.prepare('SELECT id, name FROM servers ORDER BY name').all();
    const folders = db.prepare('SELECT id, name, path FROM folders ORDER BY path').all();
    const users   = db.prepare('SELECT id, username FROM users ORDER BY username').all();

    const PAGE_SIZE = 15;
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

// GET /videos/edit/:id
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
