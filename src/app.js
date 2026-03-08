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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));
app.use(session({
    secret: process.env.SESSION_SECRET || 'changeme',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 days
}));

// Routes
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/dashboard'));
app.use('/users', require('./routes/users'));
app.use('/videos', require('./routes/videos'));
app.use('/folders', require('./routes/folders'));
app.use('/servers', require('./routes/servers'));
app.use('/settings', require('./routes/settings'));
app.use('/api', require('./routes/api'));

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
    res.status(500).render('error', {
        user: req.session?.user || null,
        message: 'Lỗi máy chủ: ' + err.message,
        activePage: ''
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🎬 Video Manager running at http://localhost:${PORT}`);
    console.log(`📋 Default login: admin / admin123\n`);
});

module.exports = app;
