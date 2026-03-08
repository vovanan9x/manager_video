const express = require('express');
const router = express.Router();
const path = require('path');
const db = require('../config/database');
const upload = require('../middleware/upload');
const { uploadToServer, fetchRemoteVideo, stopUpload } = require('../services/uploadService');
const { deleteFromServer, deleteFromSftp } = require('../services/serverService');
const crypto = require('crypto');
const fs = require('fs');

// Simple API key auth middleware
function apiAuth(req, res, next) {
    // Allow session auth
    if (req.session && req.session.user) return next();
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
router.get('/videos/:id/link', apiAuth, (req, res) => {
    const video = db.prepare(`
    SELECT v.*, s.base_url, s.root_path, s.type as server_type
    FROM videos v LEFT JOIN servers s ON v.server_id = s.id
    WHERE v.id = ?
  `).get(req.params.id);

    if (!video) return res.status(404).json({ error: 'Video not found' });

    const settingDomain = db.prepare('SELECT value FROM settings WHERE key = ?').get('domain');
    const domain = settingDomain ? settingDomain.value.replace(/\/$/, '') : 'http://localhost:3000';

    let link = null;
    if (video.base_url && video.remote_path) {
        link = video.base_url.replace(/\/$/, '') + '/' + video.remote_path.replace(/^\//, '');
    } else if (video.remote_path) {
        link = domain + '/stream/' + video.remote_path.replace(/^\//, '');
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
    const remotePath = (folder ? folder.path + '/' : '') + filename;
    const userId = req.session?.user?.id || 1;

    const result = db.prepare(
        'INSERT INTO videos (title, description, genre, filename, original_name, folder_id, server_id, uploaded_by, status, source_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(title, description || '', genre || '', filename, req.file.originalname, folder_id || null, server_id, userId, 'pending', 'local');

    const videoId = result.lastInsertRowid;
    const controller = { cancelled: false };
    uploadToServer(videoId, req.file.path, server, remotePath, controller);

    res.json({ success: true, videoId, message: 'Upload started' });
});

// POST /api/videos/remote-upload - remote URL upload via API
router.post('/videos/remote-upload', apiAuth, async (req, res) => {
    const { title, description, genre, server_id, folder_id, url } = req.body;
    if (!title || !server_id || !url) return res.status(400).json({ error: 'title, server_id, url required' });
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id);
    if (!server) return res.status(400).json({ error: 'Server not found' });
    const folder = folder_id ? db.prepare('SELECT * FROM folders WHERE id = ?').get(folder_id) : null;
    const ext = path.extname(url.split('?')[0]) || '.mp4';
    const filename = crypto.randomUUID() + ext;
    const remotePath = (folder ? folder.path + '/' : '') + filename;
    const userId = req.session?.user?.id || 1;

    const result = db.prepare(
        'INSERT INTO videos (title, description, genre, filename, original_name, folder_id, server_id, uploaded_by, status, source_type, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(title, description || '', genre || '', filename, path.basename(url), folder_id || null, server_id, userId, 'pending', 'remote', url);

    const videoId = result.lastInsertRowid;
    const controller = { cancelled: false };
    fetchRemoteVideo(videoId, url, server, remotePath, controller);

    res.json({ success: true, videoId, message: 'Remote upload started' });
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
