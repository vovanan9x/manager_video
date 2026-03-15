const express = require('express');
const router = express.Router();
const path = require('path');
const db = require('../config/database');
const upload = require('../middleware/upload');
const { uploadToServer, fetchRemoteVideo, stopUpload, emitProgress } = require('../services/uploadService');
const { deleteFromServer, deleteFromSftp } = require('../services/serverService');
const crypto = require('crypto');
const fs = require('fs');

// API auth: admin only (session or API key)
function apiAuth(req, res, next) {
    // Allow session auth — admin only
    if (req.session && req.session.user) {
        if (req.session.user.role !== 'administrator') {
            return res.status(403).json({ error: 'Forbidden: API access requires administrator role' });
        }
        return next();
    }
    // Allow API key
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (apiKey) {
        const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get('api_key');
        if (setting && setting.value === apiKey) {
            req.apiUser = { role: 'administrator' };
            return next();
        }
    }
    res.status(401).json({ error: 'Unauthorized' });
}

// GET /api/videos - list all videos
router.get('/videos', apiAuth, (req, res) => {
    const { server_id, folder_id, status, limit = 50, offset = 0 } = req.query;
    let query = `SELECT v.id, v.title, v.description, v.genre, v.filename, v.file_size,
    v.status, v.upload_progress, v.remote_path, v.source_type, v.source_url, v.created_at,
    s.name as server_name, s.base_url as server_base_url, f.path as folder_path
    FROM videos v
    LEFT JOIN servers s ON v.server_id = s.id
    LEFT JOIN folders f ON v.folder_id = f.id`;
    const conditions = [];
    const params = [];

    if (server_id) { conditions.push('v.server_id = ?'); params.push(server_id); }
    if (folder_id) { conditions.push('v.folder_id = ?'); params.push(folder_id); }
    if (status) { conditions.push('v.status = ?'); params.push(status); }

    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY v.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const videos = db.prepare(query).all(...params);
    const total = db.prepare('SELECT COUNT(*) as count FROM videos').get();

    res.json({ success: true, total: total.count, videos });
});

// GET /api/videos/:id/link - get video link
router.get('/videos/:id/link', requireSessionUser, (req, res) => {
    const video = db.prepare(`
    SELECT v.*, s.base_url, s.root_path, s.type as server_type
    FROM videos v LEFT JOIN servers s ON v.server_id = s.id
    WHERE v.id = ?
  `).get(req.params.id);

    if (!video) return res.status(404).json({ error: 'Video not found' });

    const settingDomain = db.prepare('SELECT value FROM settings WHERE key = ?').get('domain');
    const domain = settingDomain ? settingDomain.value.replace(/\/$/, '') : 'http://localhost:3000';

    let link = null;
    if (video.remote_path && video.base_url) {
        link = video.base_url.replace(/\/$/, '') + '/' + video.remote_path.replace(/^\//, '');
    }

    res.json({
        success: true,
        video: {
            id: video.id,
            title: video.title,
            description: video.description,
            genre: video.genre,
            status: video.status,
            filename: video.filename,
            remote_path: video.remote_path,
            idah: video.idah || null,
            link,
            created_at: video.created_at,
        }
    });
});

// GET /api/videos/by-idah/:idah/link - get video link by IDAH
router.get('/videos/by-idah/:idah/link', requireSessionUser, (req, res) => {
    const idah = req.params.idah;
    const video = db.prepare(`
        SELECT v.*, s.base_url, s.root_path, s.type as server_type
        FROM videos v LEFT JOIN servers s ON v.server_id = s.id
        WHERE v.idah = ?
        ORDER BY v.created_at DESC
        LIMIT 1
    `).get(idah);

    if (!video) return res.status(404).json({ error: 'Không tìm thấy video với IDAH: ' + idah });

    let link = null;
    if (video.remote_path && video.base_url) {
        link = video.base_url.replace(/\/$/, '') + '/' + video.remote_path.replace(/^\//, '');
    }

    res.json({
        success: true,
        video: {
            id: video.id,
            title: video.title,
            description: video.description,
            genre: video.genre,
            status: video.status,
            filename: video.filename,
            remote_path: video.remote_path,
            idah: video.idah,
            link,
            created_at: video.created_at,
        }
    });
});


// POST /api/videos/upload - upload via API
router.post('/videos/upload', apiAuth, upload.single('video'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const { title, description, genre, server_id, folder_id } = req.body;
    if (!title || !server_id) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'title and server_id required' });
    }
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const folder = folder_id ? db.prepare('SELECT * FROM folders WHERE id = ?').get(folder_id) : null;
    const filename = req.file.filename;
    const remotePath = (folder ? 'f' + folder.id + '/' : '') + filename;
    const userId = req.session?.user?.id || 1;

    const result = db.prepare(
        'INSERT INTO videos (title, description, filename, original_name, folder_id, server_id, uploaded_by, status, source_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(title, description || '', filename, req.file.originalname, folder_id || null, server_id, userId, 'pending', 'local');

    const videoId = result.lastInsertRowid;
    const controller = { cancelled: false };
    uploadToServer(videoId, req.file.path, server, remotePath, controller);

    res.json({ success: true, videoId, message: 'Upload started' });
});

// POST /api/videos/remote-upload - remote URL upload via API
router.post('/videos/remote-upload', apiAuth, async (req, res) => {
    const { title, description, server_id, folder_id, url } = req.body;
    if (!title || !server_id || !url) return res.status(400).json({ error: 'title, server_id, url required' });
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const folder = folder_id ? db.prepare('SELECT * FROM folders WHERE id = ?').get(folder_id) : null;
    const ext = path.extname(url.split('?')[0]) || '.mp4';
    const filename = crypto.randomUUID() + ext;
    const remotePath = (folder ? 'f' + folder.id + '/' : '') + filename;
    const userId = req.session?.user?.id || 1;

    const result = db.prepare(
        'INSERT INTO videos (title, description, filename, original_name, folder_id, server_id, uploaded_by, status, source_type, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(title, description || '', filename, path.basename(url), folder_id || null, server_id, userId, 'pending', 'remote', url);

    const videoId = result.lastInsertRowid;
    const controller = { cancelled: false };
    fetchRemoteVideo(videoId, url, server, remotePath, controller);

    res.json({ success: true, videoId, message: 'Remote upload started' });
});

// ─── Google Drive Upload ──────────────────────────────────────────────────
// Extract file ID from various Google Drive URL formats
function extractDriveFileId(input) {
    if (!input) return null;
    // Already a raw ID (no slashes or dots)
    if (/^[a-zA-Z0-9_-]{25,}$/.test(input)) return input;
    // https://drive.google.com/file/d/FILE_ID/view
    let m = input.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    // https://drive.google.com/open?id=FILE_ID
    m = input.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    // https://drive.google.com/uc?export=download&id=FILE_ID
    m = input.match(/\/uc\?.*id=([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    return null;
}

// Build a direct download URL, handling large-file virus-scan confirmation
async function getDriveDownloadStream(fileId) {
    const axios = require('axios');

    // Modern endpoint (2024+) — handles large files better
    const urls = [
        `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0&confirm=t`,
        `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`,
    ];

    for (const url of urls) {
        try {
            // Use a cookie jar approach: first request may set warning cookie
            const resp1 = await axios.get(url, {
                responseType: 'stream',
                maxRedirects: 10,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': '*/*',
                },
                timeout: 60000,
                validateStatus: s => s < 500,
            });

            const contentType = resp1.headers['content-type'] || '';

            // Got a real file stream
            if (!contentType.includes('text/html')) {
                const size = parseInt(resp1.headers['content-length'] || '0', 10);
                return { stream: resp1.data, size };
            }

            // Got HTML — parse for confirm token or cookie
            const chunks = [];
            for await (const chunk of resp1.data) chunks.push(chunk);
            const html = Buffer.concat(chunks).toString('utf8');

            // Extract Set-Cookie warning cookie (e.g. download_warning_xxxxx)
            const cookies = [].concat(resp1.headers['set-cookie'] || []);
            const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');

            // Try to find confirm token in form or in download_warning cookie
            const confirmMatch = html.match(/name="confirm"\s+value="([^"]+)"/i)
                || html.match(/"confirm"\s*:\s*"([^"]+)"/i);
            const uuidMatch = html.match(/name="uuid"\s+value="([^"]+)"/i);

            // Build confirmed URL
            let confirmedUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0&confirm=t`;
            if (confirmMatch) confirmedUrl += `&confirm=${confirmMatch[1]}`;
            if (uuidMatch) confirmedUrl += `&uuid=${uuidMatch[1]}`;

            const resp2 = await axios.get(confirmedUrl, {
                responseType: 'stream',
                maxRedirects: 10,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': '*/*',
                    ...(cookieStr ? { 'Cookie': cookieStr } : {}),
                },
                timeout: 60000,
            });

            const ct2 = resp2.headers['content-type'] || '';
            if (!ct2.includes('text/html')) {
                const size = parseInt(resp2.headers['content-length'] || '0', 10);
                return { stream: resp2.data, size };
            }

            // Still HTML — this URL didn't work, try next
            resp2.data.destroy();
        } catch (e) {
            // Try next URL
            if (url === urls[urls.length - 1]) throw e;
        }
    }

    throw new Error('Google Drive: Không thể tải file. Hãy đảm bảo file được chia sẻ công khai (Anyone with the link).');
}

/**
 * POST /api/videos/drive-upload
 *
 * Body (JSON or form):
 *   drive_url   {string}  required  Google Drive share link or file ID
 *   title       {string}  required
 *   server_id   {number}  required
 *   folder_id   {number}  optional
 *   description {string}  optional
 *   filename    {string}  optional  custom filename (without extension)
 *
 * Returns: { success, videoId, message }
 *
 * Auth: session cookie OR X-Api-Key header
 */
// Auth cho drive-upload: cho phép mọi user đã đăng nhập (admin + uploader)
function requireSessionUser(req, res, next) {
    if (req.session && req.session.user) return next();
    // Cũng cho phép API key (giữ tính tương thích)
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (apiKey) {
        const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get('api_key');
        if (setting && setting.value === apiKey) {
            req.apiUser = { role: 'administrator' };
            return next();
        }
    }
    res.status(401).json({ error: 'Unauthorized' });
}

router.post('/videos/drive-upload', requireSessionUser, async (req, res) => {
    const { drive_url, title, server_id, folder_id, description, filename: customName, idah } = req.body;

    if (!drive_url) return res.status(400).json({ error: 'drive_url is required' });
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!server_id) return res.status(400).json({ error: 'server_id is required' });

    const fileId = extractDriveFileId(drive_url);
    if (!fileId) return res.status(400).json({ error: 'Cannot extract Google Drive file ID from the provided URL' });

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id);
    if (!server) return res.status(400).json({ error: 'Server not found' });

    const folder = folder_id ? db.prepare('SELECT * FROM folders WHERE id = ?').get(folder_id) : null;
    const ext = '.mp4';
    const baseName = customName ? customName.replace(/[^a-zA-Z0-9_-]/g, '_') : crypto.randomUUID();
    const filename = baseName + ext;
    const remotePath = (folder ? 'f' + folder.id + '/' : '') + filename;
    const sourceUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
    const userId = req.session?.user?.id || 1;

    const result = db.prepare(
        'INSERT INTO videos (title, description, filename, original_name, folder_id, server_id, uploaded_by, status, source_type, source_url, idah) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(title, description || '', filename, `drive_${fileId}`, folder_id || null, server_id, userId, 'pending', 'remote', sourceUrl, idah || null);

    const videoId = result.lastInsertRowid;

    // Run upload asynchronously
    (async () => {
        const { emitProgress } = require('../services/uploadService');
        try {
            db.prepare("UPDATE videos SET status='uploading', upload_progress=0 WHERE id=?").run(videoId);
            emitProgress(videoId, 0, 'uploading');

            // Get download stream from Drive
            const { stream, size } = await getDriveDownloadStream(fileId);

            // Save to temp file first, then upload to server
            const tmpPath = path.join(require('os').tmpdir(), filename);
            const writeStream = require('fs').createWriteStream(tmpPath);
            let downloaded = 0;
            stream.on('data', chunk => {
                downloaded += chunk.length;
                if (size > 0) emitProgress(videoId, Math.floor(downloaded / size * 50), 'uploading'); // 0–50% = download
            });
            await new Promise((resolve, reject) => {
                stream.pipe(writeStream);
                writeStream.on('finish', resolve);
                writeStream.on('error', reject);
                stream.on('error', reject);
            });

            // Now upload temp file to server
            const controller = { cancelled: false };
            await uploadToServer(videoId, tmpPath, server, remotePath, controller);

            // Cleanup temp file
            try { fs.unlinkSync(tmpPath); } catch (_) { }
        } catch (err) {
            console.error('[Drive Upload Error]', err.message);
            db.prepare("UPDATE videos SET status='error' WHERE id=?").run(videoId);
            emitProgress(videoId, 0, 'error');
        }
    })();

    res.json({ success: true, videoId, message: 'Google Drive upload started', fileId });
});

// GET /api/servers - list all active servers
router.get('/servers', apiAuth, (req, res) => {
    const servers = db.prepare('SELECT id, name, type, root_path, base_url, is_active FROM servers WHERE is_active = 1 ORDER BY name').all();
    res.json({ success: true, servers });
});

// GET /api/folders - list folders (optionally filtered by server)
router.get('/folders', apiAuth, (req, res) => {
    const { server_id } = req.query;
    let query = 'SELECT id, name, path, server_id, parent_id FROM folders';
    const params = [];
    if (server_id) { query += ' WHERE server_id = ?'; params.push(server_id); }
    query += ' ORDER BY path';
    const folders = db.prepare(query).all(...params);
    res.json({ success: true, folders });
});



// DELETE /api/videos/:id
router.delete('/videos/:id', apiAuth, async (req, res) => {
    const video = db.prepare('SELECT v.*, s.type as server_type, s.root_path, s.host, s.port, s.username as s_username, s.password as s_password FROM videos v LEFT JOIN servers s ON v.server_id = s.id WHERE v.id = ?').get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });

    stopUpload(parseInt(req.params.id));

    if (video.remote_path && video.server_type) {
        if (video.server_type === 'local') {
            deleteFromServer({ type: 'local', root_path: video.root_path }, video.remote_path);
        } else if (video.server_type === 'sftp') {
            deleteFromSftp({ host: video.host, port: video.port, username: video.s_username, password: video.s_password, root_path: video.root_path }, video.remote_path).catch(() => { });
        }
    }

    db.prepare('DELETE FROM videos WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Video deleted' });
});

module.exports = router;
