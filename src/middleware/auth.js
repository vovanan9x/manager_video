function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.redirect('/login');
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.redirect('/login');
    }
    if (req.session.user.role !== 'administrator') {
        return res.status(403).render('error', {
            user: req.session.user,
            message: 'Bạn không có quyền truy cập trang này.',
            activePage: ''
        });
    }
    next();
}

function requireUploader(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.redirect('/login');
    }
    next();
}

module.exports = { requireAuth, requireAdmin, requireUploader };
