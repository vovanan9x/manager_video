/**
 * GET /v/:code — short link redirect cho video MP4
 *
 * Tra cứu short_code trong DB, lấy CDN URL thật, redirect 302.
 * Client không bao giờ thấy URL CDN trong response của API —
 * chỉ thấy link ngắn dạng: https://yourdomain.com/v/a1b2c3d4e5f6
 */
const express = require('express');
const router = express.Router();
const db = require('../config/database');

router.get('/:code', (req, res) => {
    const { code } = req.params;

    const video = db.prepare(`
        SELECT v.remote_path, v.status,
               s.base_url, s.type AS server_type
        FROM videos v
        LEFT JOIN servers s ON v.server_id = s.id
        WHERE v.short_code = ?
        LIMIT 1
    `).get(code);

    if (!video) {
        return res.status(404).send('404 — Link không tồn tại hoặc đã bị xóa');
    }

    if (video.status !== 'done') {
        return res.status(503).send('Video chưa sẵn sàng (đang xử lý hoặc lỗi)');
    }

    if (!video.remote_path || !video.base_url) {
        return res.status(404).send('Không tìm thấy đường dẫn video');
    }

    const cdnUrl = video.base_url.replace(/\/$/, '') + '/' + video.remote_path.replace(/^\//, '');

    // 302 redirect — gọn nhẹ, browser tự cache nếu cần
    return res.redirect(302, cdnUrl);
});

module.exports = router;
