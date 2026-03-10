const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { requireAdmin } = require('../middleware/auth');
const { testConnection, getServerDiskInfo } = require('../services/serverService');

// GET /servers
router.get('/', requireAdmin, async (req, res) => {
    const servers = db.prepare('SELECT * FROM servers ORDER BY created_at DESC').all();
    const errorMap = {
        hasvideos: 'Không thể xóa server vì vẫn còn video đang lưu trên server này. Xóa video trước rồi thử lại.',
        missing: 'Vui lòng điền đầy đủ thông tin bắt buộc (Tên, Loại, Root Path).',
    };
    const successMap = {
        added: '✅ Thêm server thành công!',
        updated: '✅ Cập nhật server thành công!',
        deleted: '✅ Xóa server thành công!',
    };
    const error = errorMap[req.query.error] || (req.query.error ? req.query.error : null);
    const success = successMap[req.query.success] || null;
    res.render('servers', { user: req.session.user, activePage: 'servers', servers, error, success });
});

// POST /servers/add
router.post('/add', requireAdmin, (req, res) => {
    const { name, type, host, port, username, password, root_path, base_url, private_key } = req.body;
    if (!name || !type || !root_path) {
        return res.redirect('/servers?error=missing');
    }
    db.prepare('INSERT INTO servers (name, type, host, port, username, password, root_path, base_url, private_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(name.trim(), type, host || null, parseInt(port) || null, username || null, password || null, root_path.trim(), base_url || null, private_key || null);
    res.redirect('/servers?success=added');
});

// POST /servers/edit/:id
router.post('/edit/:id', requireAdmin, (req, res) => {
    const { name, type, host, port, username, password, root_path, base_url, is_active, private_key } = req.body;
    // is_active: checkbox sends '1' when checked, nothing when unchecked.
    // Default to 1 (active) unless explicitly set to '0'.
    const activeVal = is_active === '0' ? 0 : 1;
    // If private_key is empty, keep the existing one
    if (private_key && private_key.trim()) {
        db.prepare('UPDATE servers SET name=?, type=?, host=?, port=?, username=?, password=?, root_path=?, base_url=?, is_active=?, private_key=? WHERE id=?')
            .run(name.trim(), type, host || null, parseInt(port) || null, username || null, password || null, root_path.trim(), base_url || null, activeVal, private_key.trim(), req.params.id);
    } else {
        db.prepare('UPDATE servers SET name=?, type=?, host=?, port=?, username=?, password=?, root_path=?, base_url=?, is_active=? WHERE id=?')
            .run(name.trim(), type, host || null, parseInt(port) || null, username || null, password || null, root_path.trim(), base_url || null, activeVal, req.params.id);
    }
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
