/**
 * /stream/*  — serve video files with Range support
 *
 * Local servers: serve from disk directly.
 * SFTP servers (e.g. Hetzner Storage Box): proxy via HTTP(S) Basic Auth.
 *   - Storage Box exposes files over HTTPS at:
 *     https://<username>.your-storagebox.de/<root_path>/<remote_path>
 *   - We forward the browser's Range header, then pipe the response back.
 *   - The browser never sees the credentials.
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const db = require('../config/database');

const MIME_TYPES = {
    '.mp4': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.flv': 'video/x-flv',
    '.m3u8': 'application/vnd.apple.mpegurl',
    '.ts': 'video/mp2t',
};

// Build a Hetzner Storage Box HTTPS URL from server config + remote_path.
// Storage Box HTTPS base: https://<username>.your-storagebox.de
// root_path on Storage Box is the folder path (e.g. /data/videos or just /)
function buildStorageBoxUrl(server, remotePath) {
    // If base_url is set, use it as-is (allows custom CDN/domain override)
    if (server.base_url) {
        const base = server.base_url.replace(/\/$/, '');
        return base + '/' + remotePath.replace(/^\//, '');
    }
    // Auto-build from host + root_path
    // host format: u123456.your-storagebox.de  (or just the hostname)
    const host = (server.host || '').replace(/\/$/, '');
    const rootOnBox = (server.root_path || '').replace(/\\/g, '/').replace(/\/$/, '');
    const remote = remotePath.replace(/^\//, '');
    const filePath = rootOnBox ? rootOnBox + '/' + remote : remote;
    return `https://${host}/${filePath}`;
}

// Proxy a remote URL (with optional Basic Auth) back to the browser,
// forwarding Range header for seekable playback.
async function proxyStream(req, res, remoteUrl, username, password) {
    return new Promise((resolve) => {
        const parsedUrl = new URL(remoteUrl);
        const isHttps = parsedUrl.protocol === 'https:';
        const lib = isHttps ? https : http;

        const headers = {};
        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }
        if (username && password) {
            headers['Authorization'] = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
        }

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers,
        };

        const proxyReq = lib.request(options, (proxyRes) => {
            // Forward status + selected headers
            const forwardHeaders = {};
            const copyHeaders = [
                'content-type', 'content-length', 'content-range',
                'accept-ranges', 'cache-control', 'last-modified', 'etag',
            ];
            copyHeaders.forEach(h => {
                if (proxyRes.headers[h]) forwardHeaders[h] = proxyRes.headers[h];
            });

            // Always advertise Range support
            forwardHeaders['accept-ranges'] = 'bytes';

            res.writeHead(proxyRes.statusCode || 200, forwardHeaders);
            proxyRes.pipe(res);
            proxyRes.on('end', resolve);
            proxyRes.on('error', resolve);
        });

        proxyReq.on('error', (err) => {
            console.error('[Stream Proxy Error]', err.message);
            if (!res.headersSent) {
                res.status(502).send('Proxy error: ' + err.message);
            }
            resolve();
        });

        proxyReq.end();
    });
}

// Handle all GET requests — req.path will be the part after /stream
router.use('/', async (req, res) => {
    // Strip leading slash
    const remotePath = req.path.replace(/^\//, '');
    if (!remotePath) return res.status(400).send('Missing path');

    // Find the video with this remote_path
    const video = db.prepare(`
        SELECT v.remote_path,
               s.type        AS server_type,
               s.root_path,
               s.base_url,
               s.host,
               s.port,
               s.username,
               s.password
        FROM videos v
        LEFT JOIN servers s ON v.server_id = s.id
        WHERE v.remote_path = ?
    `).get(remotePath);

    if (!video) {
        return res.status(404).send('Video not found');
    }

    // ── LOCAL SERVER ────────────────────────────────────────────────────────
    if (video.server_type === 'local') {
        const filePath = path.join(video.root_path, remotePath);

        // Security: ensure resolved path stays inside root_path
        const rootReal = path.resolve(video.root_path);
        const fileReal = path.resolve(filePath);
        if (!fileReal.startsWith(rootReal)) {
            return res.status(403).send('Forbidden');
        }
        if (!fs.existsSync(fileReal)) {
            return res.status(404).send('File not found on disk: ' + fileReal);
        }

        const stat = fs.statSync(fileReal);
        const fileSize = stat.size;
        const ext = path.extname(fileReal).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        const range = req.headers.range;
        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunkSize = end - start + 1;
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunkSize,
                'Content-Type': contentType,
            });
            fs.createReadStream(fileReal, { start, end }).pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Length': fileSize,
                'Content-Type': contentType,
                'Accept-Ranges': 'bytes',
            });
            fs.createReadStream(fileReal).pipe(res);
        }
        return;
    }

    // ── SFTP / HTTP SERVER (Storage Box or remote) ─────────────────────────
    // Build the remote URL and proxy it with Basic Auth credentials.
    let remoteUrl;
    if (video.server_type === 'sftp') {
        remoteUrl = buildStorageBoxUrl(video, remotePath);
    } else if (video.server_type === 'http') {
        // HTTP upload servers: construct URL from base_url
        if (video.base_url) {
            remoteUrl = video.base_url.replace(/\/$/, '') + '/' + remotePath.replace(/^\//, '');
        } else {
            return res.status(400).send('HTTP server has no base_url configured');
        }
    } else {
        return res.status(400).send('Unknown server type: ' + video.server_type);
    }

    await proxyStream(req, res, remoteUrl, video.username, video.password);
});

module.exports = router;
