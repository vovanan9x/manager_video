const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { requireAdmin } = require('../middleware/auth');

// GET /errors — list error logs (admin only)
router.get('/', requireAdmin, (req, res) => {
    const { type, video_id, limit: limitParam } = req.query;
    const limit = parseInt(limitParam) || 100;

    let query = `SELECT el.*, v.title as video_title_live
                 FROM error_logs el
                 LEFT JOIN videos v ON el.video_id = v.id`;
    const conditions = [];
    const params = [];

    if (type) {
        conditions.push('el.type = ?');
        params.push(type);
    }
    if (video_id) {
        conditions.push('el.video_id = ?');
        params.push(video_id);
    }

    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY el.created_at DESC LIMIT ?';
    params.push(limit);

    const errors = db.prepare(query).all(...params);
    const totalCount = db.prepare('SELECT COUNT(*) as cnt FROM error_logs').get().cnt;
    const types = db.prepare('SELECT DISTINCT type FROM error_logs ORDER BY type').all().map(r => r.type);

    res.render('errors', {
        user: req.session.user,
        activePage: 'errors',
        errors,
        totalCount,
        types,
        filters: req.query,
    });
});

// DELETE /errors/clear — clear all logs (admin only)
router.post('/clear', requireAdmin, (req, res) => {
    const { type } = req.body;
    if (type) {
        db.prepare('DELETE FROM error_logs WHERE type = ?').run(type);
    } else {
        db.prepare('DELETE FROM error_logs').run();
    }
    res.json({ success: true });
});

// DELETE /errors/:id — delete single log (admin only)
router.post('/delete/:id', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM error_logs WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

// GET /errors/stats — JSON stats for dashboard
router.get('/stats', requireAdmin, (req, res) => {
    const total = db.prepare('SELECT COUNT(*) as cnt FROM error_logs').get().cnt;
    const byType = db.prepare('SELECT type, COUNT(*) as cnt FROM error_logs GROUP BY type').all();
    const recent = db.prepare('SELECT * FROM error_logs ORDER BY created_at DESC LIMIT 5').all();
    res.json({ total, byType, recent });
});

module.exports = router;
