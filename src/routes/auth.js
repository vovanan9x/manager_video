const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../config/database');

// ─── Simple in-memory rate limiter cho login ─────────────────────────────────
// Max 20 lần thử / IP / 15 phút
const loginAttempts = new Map(); // ip -> { count, resetAt }
const LOGIN_MAX = 20;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function checkLoginRate(ip) {
    const now = Date.now();
    let entry = loginAttempts.get(ip);
    if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
        loginAttempts.set(ip, entry);
    }
    entry.count++;
    if (entry.count > LOGIN_MAX) {
        const wait = Math.ceil((entry.resetAt - now) / 60000);
        return `Quá nhiều lần thử đăng nhập. Thử lại sau ${wait} phút.`;
    }
    return null;
}

// Dọn map định kỳ mỗi 30 phút
setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of loginAttempts.entries()) {
        if (now > e.resetAt) loginAttempts.delete(ip);
    }
}, 30 * 60 * 1000);

// GET /login
router.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('login', { error: null });
});

// POST /login
router.post('/login', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const rateLimitMsg = checkLoginRate(ip);
    if (rateLimitMsg) {
        return res.status(429).render('login', { error: rateLimitMsg });
    }

    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password, user.password)) {
        return res.render('login', { error: 'Sai tên đăng nhập hoặc mật khẩu' });
    }
    // Reset counter on successful login
    loginAttempts.delete(ip);
    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.redirect('/');
});

// GET /logout
router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

module.exports = router;
