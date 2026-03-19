const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { requireAdmin } = require('../middleware/auth');

// GET /settings — admin only
router.get('/', requireAdmin, (req, res) => {
    const settings = db.prepare('SELECT key, value FROM settings').all();
    const settingsMap = {};
    settings.forEach(s => settingsMap[s.key] = s.value);
    // Che bớt JSON Service Account — chỉ hiện email
    if (settingsMap.drive_service_account) {
        try {
            const sa = JSON.parse(settingsMap.drive_service_account);
            settingsMap.drive_sa_email = sa.client_email || '';
            settingsMap.drive_sa_configured = true;
        } catch (_) { settingsMap.drive_sa_configured = false; }
    }
    res.render('settings', { user: req.session.user, activePage: 'settings', settings: settingsMap, success: null, error: null });
});

// POST /settings — admin only
router.post('/', requireAdmin, (req, res) => {
    const { domain, api_key, stream_key, drive_service_account, clear_sa } = req.body;
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('domain', (domain || '').trim());
    if (api_key && api_key.trim()) {
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('api_key', api_key.trim());
    }
    // Lưu stream_key nếu được gửi
    if (stream_key && stream_key.trim()) {
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('stream_key', stream_key.trim());
    }
    // Lưu Service Account JSON (validate trước)
    let saError = null;
    if (clear_sa === '1') {
        // Xóa Service Account chỉ khi user bấm nút Xóa riêng
        db.prepare("DELETE FROM settings WHERE key='drive_service_account'").run();
    } else if (drive_service_account && drive_service_account.trim()) {
        try {
            JSON.parse(drive_service_account.trim()); // validate JSON
            db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('drive_service_account', drive_service_account.trim());
        } catch (_) {
            saError = 'Service Account JSON không hợp lệ — chưa lưu.';
        }
    }
    // Nếu textarea rỗng → KHÔNG làm gì (giữ nguyên SA hiện tại)
    const settings = db.prepare('SELECT key, value FROM settings').all();
    const settingsMap = {};
    settings.forEach(s => settingsMap[s.key] = s.value);
    if (settingsMap.drive_service_account) {
        try {
            const sa = JSON.parse(settingsMap.drive_service_account);
            settingsMap.drive_sa_email = sa.client_email || '';
            settingsMap.drive_sa_configured = true;
        } catch (_) { settingsMap.drive_sa_configured = false; }
    }
    res.render('settings', { user: req.session.user, activePage: 'settings', settings: settingsMap,
        success: saError ? null : 'Đã lưu cài đặt!', error: saError || null });
});

module.exports = router;
