const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { requireAdmin } = require('../middleware/auth');

// GET /settings — admin only
router.get('/', requireAdmin, (req, res) => {
    const settings = db.prepare('SELECT key, value FROM settings').all();
    const settingsMap = {};
    settings.forEach(s => settingsMap[s.key] = s.value);
    res.render('settings', { user: req.session.user, activePage: 'settings', settings: settingsMap, success: null, error: null });
});

// POST /settings — admin only
router.post('/', requireAdmin, (req, res) => {
    const { domain } = req.body;
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('domain', (domain || '').trim());
    const settings = db.prepare('SELECT key, value FROM settings').all();
    const settingsMap = {};
    settings.forEach(s => settingsMap[s.key] = s.value);
    res.render('settings', { user: req.session.user, activePage: 'settings', settings: settingsMap, success: 'Đã lưu cài đặt!', error: null });
});

module.exports = router;
