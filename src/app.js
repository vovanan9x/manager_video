require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const morgan = require('morgan');

const app = express();

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(morgan('dev'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../public')));
const isProd = process.env.NODE_ENV === 'production';
app.use(session({
    secret: process.env.SESSION_SECRET || 'changeme-dev-only',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        httpOnly: true,          // JS không đọc được cookie
        secure: isProd,          // chỉ gửi qua HTTPS trong production
        sameSite: 'lax',         // giảm nhẹ CSRF
    }
}));

// Routes
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/dashboard'));
app.use('/users', require('./routes/users'));
app.use('/videos', require('./routes/videos'));
app.use('/folders', require('./routes/folders'));
app.use('/servers', require('./routes/servers'));
app.use('/settings', require('./routes/settings'));
app.use('/database', require('./routes/database'));
app.use('/processes', require('./routes/processes'));
// CORS — chỉ áp dụng cho /api (cho phép gọi từ domain khác qua X-Api-Key)
app.use('/api', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204); // preflight
    next();
});
app.use('/api', require('./routes/api'));
// app.use('/stream', require('./routes/stream')); // Stream proxy disabled
app.use('/errors', require('./routes/errors'));

// API Docs page — admin only
const { requireAuth, requireAdmin } = require('./middleware/auth');
const db = require('./config/database');
app.get('/api-docs', requireAdmin, (req, res) => {
    const settingRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('domain');
    const settings = { domain: settingRow ? settingRow.value : '' };
    res.render('api_docs', { user: req.session.user, activePage: 'api-docs', settings });
});

// Server Guide page — all authenticated users
app.get('/server-guide', requireAuth, (req, res) => {
    res.render('server_guide', { user: req.session.user, activePage: 'server-guide' });
});

// 404
app.use((req, res) => {
    res.status(404).render('error', {
        user: req.session?.user || null,
        message: 'Trang không tìm thấy (404)',
        activePage: ''
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    const msg = isProd ? 'Lỗi máy chủ nội bộ' : 'Lỗi: ' + err.message;
    res.status(500).render('error', {
        user: req.session?.user || null,
        message: msg,
        activePage: ''
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🎥 Video Manager running at http://localhost:${PORT}`);
    if (!isProd) console.log(`📋 Default login: admin / admin123\n`);

    // Tự động re-enqueue video pending/uploading còn tồn đọng từ session trước
    const { recoverPendingUploads } = require('./services/uploadService');
    recoverPendingUploads();
});

module.exports = app;
