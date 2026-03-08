const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const os = require('os');
const fs = require('fs');
const path = require('path');

router.get('/', requireAuth, (req, res) => {
    const user = req.session.user;

    // Stats for current user
    const userVideoCount = db.prepare('SELECT COUNT(*) as count FROM videos WHERE uploaded_by = ?').get(user.id);
    const userUploadedSize = db.prepare('SELECT SUM(file_size) as total FROM videos WHERE uploaded_by = ?').get(user.id);

    // Global stats (admin sees all, uploader sees only own)
    const totalVideoCount = db.prepare('SELECT COUNT(*) as count FROM videos').get();
    const totalUploadedSize = db.prepare('SELECT SUM(file_size) as total FROM videos').get();
    const totalServers = db.prepare('SELECT COUNT(*) as count FROM servers WHERE is_active = 1').get();
    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get();

    // Disk info for server machine
    const uploadDir = path.join(__dirname, '../../uploads');
    let diskInfo = { total: 0, free: 0, used: 0 };
    try {
        const stat = fs.statfsSync ? fs.statfsSync('/') : null;
        if (stat) {
            diskInfo.total = stat.blocks * stat.bsize;
            diskInfo.free = stat.bfree * stat.bsize;
            diskInfo.used = diskInfo.total - diskInfo.free;
        }
    } catch (_) {
        diskInfo = { total: os.totalmem() * 10, free: 0, used: 0 }; // fallback
    }

    // Recent videos
    const recentVideos = db.prepare(`
    SELECT v.*, u.username as uploader_name
    FROM videos v
    LEFT JOIN users u ON v.uploaded_by = u.id
    ORDER BY v.created_at DESC LIMIT 5
  `).all();

    res.render('dashboard', {
        user,
        activePage: 'dashboard',
        stats: {
            myVideoCount: userVideoCount.count,
            myUploadedSize: userUploadedSize.total || 0,
            totalVideoCount: totalVideoCount.count,
            totalUploadedSize: totalUploadedSize.total || 0,
            totalServers: totalServers.count,
            totalUsers: totalUsers.count,
            diskInfo,
        },
        recentVideos,
    });
});

module.exports = router;
