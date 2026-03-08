const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { requireAdmin } = require('../middleware/auth');
const { testConnection, getServerDiskInfo } = require('../services/serverService');

// GET /servers
router.get('/', requireAdmin, async (req, res) => {
    const servers = db.prepare('SELECT * FROM servers ORDER BY created_at DESC').all();
    res.render('servers', { user: req.session.user, activePage: 'servers', servers, error: null, success: null });
});

// POST /servers/add
router.post('/add', requireAdmin, (req, res) => {
    const { name, type, host, port, username, password, root_path, base_url } = req.body;
    if (!name || !type || !root_path) {
        const servers = db.prepare('SELECT * FROM servers ORDER BY created_at DESC').all();
        return res.render('servers', { user: req.session.user, activePage: 'servers', servers, error: 'Vui lòng điền thông tin bắt buộc', success: null });
    }
    db.prepare('INSERT INTO servers (name, type, host, port, username, password, root_path, base_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(name.trim(), type, host || null, parseInt(port) || null, username || null, password || null, root_path.trim(), base_url || null);
    res.redirect('/servers?success=added');
});

// POST /servers/edit/:id
router.post('/edit/:id', requireAdmin, (req, res) => {
    const { name, type, host, port, username, password, root_path, base_url, is_active } = req.body;
    db.prepare('UPDATE servers SET name = ?, type = ?, host = ?, port = ?, username = ?, password = ?, root_path = ?, base_url = ?, is_active = ? WHERE id = ?')
        .run(name.trim(), type, host || null, parseInt(port) || null, username || null, password || null, root_path.trim(), base_url || null, is_active ? 1 : 0, req.params.id);
    res.redirect('/servers?success=updated');
});

// POST /servers/delete/:id
router.post('/delete/:id', requireAdmin, (req, res) => {
    const videoCount = db.prepare('SELECT COUNT(*) as count FROM videos WHERE server_id = ?').get(req.params.id);
    if (videoCount.count > 0) {
        return res.redirect('/servers?error=hasvideos');
    }
    db.prepare('DELETE FROM folders WHERE server_id = ?').run(req.params.id);
    db.prepare('DELETE FROM servers WHERE id = ?').run(req.params.id);
    res.redirect('/servers?success=deleted');
});

// POST /servers/test/:id
router.post('/test/:id', requireAdmin, async (req, res) => {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.json({ ok: false, message: 'Server không tồn tại' });
    const result = await testConnection(server);
    res.json(result);
});

// GET /servers/disk/:id
router.get('/disk/:id', requireAdmin, async (req, res) => {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.json({ ok: false });
    const info = await getServerDiskInfo(server);
    res.json({ ok: true, ...info });
});

module.exports = router;
