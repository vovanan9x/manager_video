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

    // Attach video stats (count + total size) per server — synchronous from DB
    const videoStats = db.prepare(`
        SELECT server_id,
               COUNT(*) as video_count,
               COALESCE(SUM(file_size), 0) as video_size
        FROM videos
        WHERE server_id IS NOT NULL
        GROUP BY server_id
    `).all();
    const statsMap = {};
    videoStats.forEach(s => { statsMap[s.server_id] = s; });
    const serversWithStats = servers.map(s => ({
        ...s,
        video_count: (statsMap[s.id] || {}).video_count || 0,
        video_size:  (statsMap[s.id] || {}).video_size  || 0,
    }));

    res.render('servers', { user: req.session.user, activePage: 'servers', servers: serversWithStats, error, success });
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
    const activeVal = is_active === '0' ? 0 : 1;
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

// GET /servers/disk/:id  — disk info for a single server
router.get('/disk/:id', requireAdmin, async (req, res) => {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.json({ ok: false });
    const info = await getServerDiskInfo(server);
    res.json({ ok: true, ...info });
});

// GET /servers/api/stats  — disk info + video stats for ALL active servers
router.get('/api/stats', requireAdmin, async (req, res) => {
    const servers = db.prepare('SELECT * FROM servers WHERE is_active = 1').all();

    // Video stats from DB (fast)
    const videoStats = db.prepare(`
        SELECT server_id,
               COUNT(*) as video_count,
               COALESCE(SUM(file_size), 0) as video_size
        FROM videos
        WHERE server_id IS NOT NULL
        GROUP BY server_id
    `).all();
    const statsMap = {};
    videoStats.forEach(s => { statsMap[s.server_id] = s; });

    // Fetch disk info concurrently (may be slow for SFTP)
    const results = await Promise.all(servers.map(async (s) => {
        const disk = await getServerDiskInfo(s);
        return {
            id:          s.id,
            name:        s.name,
            type:        s.type,
            total:       disk.total,
            used:        disk.used,
            free:        disk.free,
            video_count: (statsMap[s.id] || {}).video_count || 0,
            video_size:  (statsMap[s.id] || {}).video_size  || 0,
        };
    }));

    res.json(results);
});

// GET /servers/api/auto-select  — returns server_id with the most free space
router.get('/api/auto-select', requireAdmin, async (req, res) => {
    const servers = db.prepare('SELECT * FROM servers WHERE is_active = 1').all();
    if (!servers.length) return res.json({ server_id: null, name: null, free: 0 });

    // Fetch disk info concurrently
    const infos = await Promise.all(servers.map(async (s) => {
        const disk = await getServerDiskInfo(s);
        return { server_id: s.id, name: s.name, type: s.type, free: disk.free };
    }));

    // Prefer servers where free > 0 (i.e. disk info was available)
    const withInfo = infos.filter(i => i.free > 0);
    const pool = withInfo.length ? withInfo : infos;

    // If disk info completely unavailable, fall back to server with least video data
    if (!withInfo.length) {
        const videoStats = db.prepare(`
            SELECT server_id, COALESCE(SUM(file_size), 0) as total_size
            FROM videos WHERE server_id IS NOT NULL GROUP BY server_id
        `).all();
        const sizeMap = {};
        videoStats.forEach(s => { sizeMap[s.server_id] = s.total_size; });
        const best = servers.reduce((a, b) =>
            (sizeMap[a.id] || 0) <= (sizeMap[b.id] || 0) ? a : b
        );
        return res.json({ server_id: best.id, name: best.name, free: 0, fallback: true });
    }

    pool.sort((a, b) => b.free - a.free);
    const winner = pool[0];
    res.json({ server_id: winner.server_id, name: winner.name, free: winner.free });
});

module.exports = router;
