const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const { requireAdmin } = require('../middleware/auth');

// GET /users
router.get('/', requireAdmin, (req, res) => {
    const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC').all();
    res.render('users', { user: req.session.user, activePage: 'users', users, error: null, success: null });
});

// POST /users/add
router.post('/add', requireAdmin, (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password || !role) {
        const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC').all();
        return res.render('users', { user: req.session.user, activePage: 'users', users, error: 'Vui lòng điền đầy đủ thông tin', success: null });
    }
    try {
        const hash = bcrypt.hashSync(password, 10);
        db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(username.trim(), hash, role);
        const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC').all();
        res.render('users', { user: req.session.user, activePage: 'users', users, error: null, success: 'Thêm user thành công!' });
    } catch (err) {
        const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC').all();
        res.render('users', { user: req.session.user, activePage: 'users', users, error: 'Username đã tồn tại', success: null });
    }
});

// POST /users/edit/:id
router.post('/edit/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    const { username, password, role } = req.body;
    const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!targetUser) return res.redirect('/users');

    // Whitelist role values
    const VALID_ROLES = ['administrator', 'uploader'];
    if (!VALID_ROLES.includes(role)) {
        return res.redirect('/users?error=invalid_role');
    }

    let updates = 'role = ?, username = ?';
    let params = [role, username.trim()];

    if (password && password.trim()) {
        const hash = bcrypt.hashSync(password, 10);
        updates += ', password = ?';
        params.push(hash);
    }

    params.push(id);
    db.prepare(`UPDATE users SET ${updates} WHERE id = ?`).run(...params);
    res.redirect('/users?success=updated');
});

// POST /users/delete/:id
router.post('/delete/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    if (parseInt(id) === req.session.user.id) {
        return res.redirect('/users?error=self');
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.redirect('/users?success=deleted');
});

module.exports = router;
