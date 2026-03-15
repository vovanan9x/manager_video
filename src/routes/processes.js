const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { getActiveUploads } = require('../services/uploadService');
const db = require('../config/database');
const os = require('os');

function fmtMB(bytes) { return (bytes / 1024 / 1024).toFixed(1); }
function formatUptime(sec) {
    sec = Math.floor(sec);
    const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

router.use(requireAdmin);

// GET /processes — main page
router.get('/', (req, res) => {
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    // Active uploads from uploadService
    const activeUploads = getActiveUploads ? getActiveUploads() : [];

    // Recent videos with status pending/uploading
    const activeVideos = db.prepare(`
        SELECT v.id, v.title, v.status, v.upload_progress, v.source_type,
               v.created_at, s.name as server_name, u.username as uploader
        FROM videos v
        LEFT JOIN servers s ON v.server_id = s.id
        LEFT JOIN users u ON v.uploaded_by = u.id
        WHERE v.status IN ('pending','uploading')
        ORDER BY v.created_at DESC
    `).all();

    // Recent errors (last 20) — guard in case table doesn't exist
    let recentErrors = [];
    try {
        recentErrors = db.prepare(
            `SELECT * FROM error_logs ORDER BY created_at DESC LIMIT 20`
        ).all();
    } catch (_) {}

    res.render('processes', {
        user: req.session.user,
        activePage: 'processes',
        nodeVersion: process.version,
        platform: process.platform,
        pid: process.pid,
        uptime: formatUptime(process.uptime()),
        mem: {
            rss: fmtMB(mem.rss),
            heapUsed: fmtMB(mem.heapUsed),
            heapTotal: fmtMB(mem.heapTotal),
            heapPct: Math.round(mem.heapUsed / mem.heapTotal * 100),
        },
        os: {
            totalMem: fmtMB(totalMem),
            freeMem: fmtMB(freeMem),
            usedMem: fmtMB(totalMem - freeMem),
            usedPct: Math.round((totalMem - freeMem) / totalMem * 100),
            cpus: os.cpus().length,
            hostname: os.hostname(),
        },
        activeVideos,
        recentErrors,
    });
});

// POST /processes/stop/:id — stop an upload
router.post('/stop/:id', async (req, res) => {
    const { stopUpload } = require('../services/uploadService');
    const id = parseInt(req.params.id);
    const stopped = stopUpload(id);
    if (stopped) {
        db.prepare("UPDATE videos SET status='stopped' WHERE id=?").run(id);
    }
    res.json({ success: true, stopped });
});

// GET /processes/stats — JSON stats for live refresh
router.get('/stats', (req, res) => {
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const activeVideos = db.prepare(
        "SELECT id, title, status, upload_progress FROM videos WHERE status IN ('pending','uploading') ORDER BY created_at DESC"
    ).all();
    res.json({
        uptime: process.uptime(),
        mem: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
        os: { totalMem, freeMem, usedMem: totalMem - freeMem },
        activeVideos,
    });
});

module.exports = router;
