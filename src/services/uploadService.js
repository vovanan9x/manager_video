const fs = require('fs');
const path = require('path');
const axios = require('axios');
const SftpClient = require('ssh2-sftp-client');
const { EventEmitter } = require('events');
const db = require('../config/database');
const { addErrorLog } = require('../config/database');

// Global map of active uploads: videoId -> { abort, type }
const activeUploads = new Map();
// SSE clients: videoId -> [res, ...]
const sseClients = new Map();

const uploadEmitter = new EventEmitter();
uploadEmitter.setMaxListeners(100);

function emitProgress(videoId, progress, status) {
    // Update DB
    db.prepare('UPDATE videos SET upload_progress = ?, status = ? WHERE id = ?').run(progress, status, videoId);
    // Notify SSE clients
    const clients = sseClients.get(String(videoId)) || [];
    const data = JSON.stringify({ videoId, progress, status });
    clients.forEach(res => {
        try { res.write(`data: ${data}\n\n`); } catch (_) { }
    });
    uploadEmitter.emit('progress', { videoId, progress, status });
}

function addSseClient(videoId, res) {
    const key = String(videoId);
    if (!sseClients.has(key)) sseClients.set(key, []);
    sseClients.get(key).push(res);
}

function removeSseClient(videoId, res) {
    const key = String(videoId);
    const list = sseClients.get(key) || [];
    const idx = list.indexOf(res);
    if (idx >= 0) list.splice(idx, 1);
}

async function uploadToServer(videoId, localFilePath, server, remotePath) {
    const controller = { cancelled: false };
    activeUploads.set(videoId, { controller, type: server.type });

    try {
        if (server.type === 'local') {
            await uploadLocal(videoId, localFilePath, server, remotePath, controller);
        } else if (server.type === 'sftp') {
            await uploadSftp(videoId, localFilePath, server, remotePath, controller);
        } else if (server.type === 'http') {
            await uploadHttp(videoId, localFilePath, server, remotePath, controller);
        }

        if (!controller.cancelled) {
            emitProgress(videoId, 100, 'done');
            // Clean up local temp file
            if (fs.existsSync(localFilePath) && localFilePath.includes('uploads')) {
                try { fs.unlinkSync(localFilePath); } catch (_) { }
            }
        }
    } catch (err) {
        if (!controller.cancelled) {
            console.error('[Upload Error]', err.message);
            // Get video + server info for error log
            const videoRow = db.prepare('SELECT v.title, v.server_id, s.name as server_name FROM videos v LEFT JOIN servers s ON v.server_id = s.id WHERE v.id = ?').get(videoId);
            addErrorLog('upload', {
                video_id: videoId,
                video_title: videoRow ? videoRow.title : null,
                server_id: videoRow ? videoRow.server_id : null,
                server_label: videoRow ? videoRow.server_name : null,
                message: err.message,
                stack: err.stack,
            });
            emitProgress(videoId, 0, 'error');
        }
    } finally {
        activeUploads.delete(videoId);
    }
}

async function uploadLocal(videoId, localFilePath, server, remotePath, controller) {
    const destPath = path.join(server.root_path, remotePath);
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    const fileSize = fs.statSync(localFilePath).size;
    let transferred = 0;
    const CHUNK = 1024 * 1024; // 1MB

    const readStream = fs.createReadStream(localFilePath, { highWaterMark: CHUNK });
    const writeStream = fs.createWriteStream(destPath);

    await new Promise((resolve, reject) => {
        readStream.on('data', chunk => {
            if (controller.cancelled) {
                readStream.destroy();
                writeStream.destroy();
                try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (_) { }
                return;
            }
            transferred += chunk.length;
            const pct = Math.floor((transferred / fileSize) * 100);
            emitProgress(videoId, pct, 'uploading');
        });
        readStream.on('error', reject);
        writeStream.on('error', reject);
        writeStream.on('finish', resolve);
        readStream.pipe(writeStream);
    });

    // Update remote_path in DB
    db.prepare('UPDATE videos SET remote_path = ?, file_size = ? WHERE id = ?').run(remotePath, fileSize, videoId);
}

async function uploadSftp(videoId, localFilePath, server, remotePath, controller) {
    const fileSize = fs.statSync(localFilePath).size;
    const remoteFullPath = server.root_path.replace(/\\/g, '/') + '/' + remotePath.replace(/\\/g, '/');
    const remoteDir = path.dirname(remoteFullPath).replace(/\\/g, '/');

    const buildConnOpts = () => {
        const opts = {
            host: server.host,
            port: server.port || 22,
            username: server.username,
            keepaliveInterval: 10000,   // send keepalive every 10s
            keepaliveCountMax: 10,      // allow 10 missed keepalives before disconnect
            readyTimeout: 30000,
        };
        if (server.private_key) {
            opts.privateKey = server.private_key;
            if (server.password) opts.passphrase = server.password;
        } else if (server.password) {
            opts.password = server.password;
        }
        return opts;
    };

    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (controller.cancelled) break;
        const sftp = new SftpClient();
        activeUploads.get(videoId).sftp = sftp;
        try {
            await sftp.connect(buildConnOpts());
            try { await sftp.mkdir(remoteDir, true); } catch (_) { }

            let transferred = 0;
            const readStream = fs.createReadStream(localFilePath);
            readStream.on('data', chunk => {
                if (controller.cancelled) { readStream.destroy(); return; }
                transferred += chunk.length;
                const pct = Math.floor((transferred / fileSize) * 100);
                emitProgress(videoId, pct, 'uploading');
            });

            if (!controller.cancelled) {
                await sftp.put(readStream, remoteFullPath);
                db.prepare('UPDATE videos SET remote_path = ?, file_size = ? WHERE id = ?').run(remotePath, fileSize, videoId);
            }
            await sftp.end();
            return; // success — exit retry loop
        } catch (err) {
            try { await sftp.end(); } catch (_) { }
            const isResetError = err.message && (err.message.includes('ECONNRESET') || err.message.includes('ETIMEDOUT') || err.message.includes('ECONNREFUSED'));
            if (isResetError && attempt < MAX_RETRIES && !controller.cancelled) {
                console.log(`[SFTP Retry] Attempt ${attempt} failed (${err.message}), retrying in 3s...`);
                emitProgress(videoId, 0, 'uploading');
                await new Promise(r => setTimeout(r, 3000));
                continue;
            }
            throw err; // non-retryable or max retries reached
        }
    }
}


async function uploadHttp(videoId, localFilePath, server, remotePath, controller) {
    const FormData = require('form-data');
    const fileSize = fs.statSync(localFilePath).size;
    const form = new FormData();
    const readStream = fs.createReadStream(localFilePath);

    let transferred = 0;
    readStream.on('data', chunk => {
        transferred += chunk.length;
        const pct = Math.floor((transferred / fileSize) * 100);
        emitProgress(videoId, pct, 'uploading');
    });

    form.append('file', readStream, { filename: path.basename(remotePath) });
    form.append('path', remotePath);

    const abortController = new AbortController();
    if (controller) controller.abort = () => abortController.abort();

    const uploadUrl = server.base_url ? server.base_url.replace(/\/$/, '') + '/upload' : server.host;

    await axios.post(uploadUrl, form, {
        headers: form.getHeaders(),
        signal: abortController.signal,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
    });

    db.prepare('UPDATE videos SET remote_path = ?, file_size = ? WHERE id = ?').run(remotePath, fileSize, videoId);
}

async function fetchRemoteVideo(videoId, url, server, remotePath, controller) {
    activeUploads.set(videoId, { controller, type: 'remote_fetch' });

    const abortController = new AbortController();
    controller.abort = () => abortController.abort();

    try {
        const response = await axios.get(url, {
            responseType: 'stream',
            signal: abortController.signal,
        });

        const totalSize = parseInt(response.headers['content-length'] || '0', 10);
        let transferred = 0;

        if (server.type === 'sftp') {
            const sftp = new SftpClient();
            activeUploads.get(videoId).sftp = sftp;
            const connOpts2 = {
                host: server.host,
                port: server.port || 22,
                username: server.username,
            };
            if (server.private_key) {
                connOpts2.privateKey = server.private_key;
                if (server.password) connOpts2.passphrase = server.password;
            } else if (server.password) {
                connOpts2.password = server.password;
            }
            await sftp.connect(connOpts2);

            const remoteFullPath = server.root_path.replace(/\\/g, '/') + '/' + remotePath.replace(/\\/g, '/');
            const remoteDir = path.dirname(remoteFullPath).replace(/\\/g, '/');
            try { await sftp.mkdir(remoteDir, true); } catch (_) { }

            response.data.on('data', chunk => {
                transferred += chunk.length;
                const pct = totalSize ? Math.floor((transferred / totalSize) * 100) : 0;
                emitProgress(videoId, pct, 'uploading');
            });

            await sftp.put(response.data, remoteFullPath);
            await sftp.end();
            db.prepare('UPDATE videos SET remote_path = ?, file_size = ? WHERE id = ?').run(remotePath, transferred, videoId);
        } else if (server.type === 'local') {
            const destPath = path.join(server.root_path, remotePath);
            const destDir = path.dirname(destPath);
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

            const writeStream = fs.createWriteStream(destPath);
            response.data.on('data', chunk => {
                transferred += chunk.length;
                const pct = totalSize ? Math.floor((transferred / totalSize) * 100) : 0;
                emitProgress(videoId, pct, 'uploading');
            });

            await new Promise((resolve, reject) => {
                response.data.pipe(writeStream);
                writeStream.on('finish', resolve);
                writeStream.on('error', reject);
            });

            db.prepare('UPDATE videos SET remote_path = ?, file_size = ? WHERE id = ?').run(remotePath, transferred, videoId);
        } else if (server.type === 'http') {
            const FormData = require('form-data');
            const form = new FormData();
            response.data.on('data', chunk => {
                transferred += chunk.length;
                const pct = totalSize ? Math.floor((transferred / totalSize) * 100) : 0;
                emitProgress(videoId, pct, 'uploading');
            });
            form.append('file', response.data, { filename: path.basename(remotePath) });
            form.append('path', remotePath);
            const uploadUrl = server.base_url ? server.base_url.replace(/\/$/, '') + '/upload' : server.host;
            await axios.post(uploadUrl, form, { headers: form.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity });
            db.prepare('UPDATE videos SET remote_path = ?, file_size = ? WHERE id = ?').run(remotePath, transferred, videoId);
        }

        if (!controller.cancelled) {
            emitProgress(videoId, 100, 'done');
        }
    } catch (err) {
        if (!controller.cancelled) {
            console.error('[Remote Fetch Error]', err.message);
            const videoRow = db.prepare('SELECT v.title, v.server_id, s.name as server_name FROM videos v LEFT JOIN servers s ON v.server_id = s.id WHERE v.id = ?').get(videoId);
            addErrorLog('remote_fetch', {
                video_id: videoId,
                video_title: videoRow ? videoRow.title : null,
                server_id: videoRow ? videoRow.server_id : null,
                server_label: videoRow ? videoRow.server_name : null,
                message: err.message,
                stack: err.stack,
            });
            emitProgress(videoId, 0, 'error');
        }
    } finally {
        activeUploads.delete(videoId);
    }
}

function stopUpload(videoId) {
    const upload = activeUploads.get(videoId);
    if (!upload) return false;

    upload.controller.cancelled = true;
    if (typeof upload.controller.abort === 'function') upload.controller.abort();
    if (upload.sftp) { try { upload.sftp.end(); } catch (_) { } }

    emitProgress(videoId, 0, 'stopped');
    activeUploads.delete(videoId);
    return true;
}

module.exports = {
    uploadToServer,
    fetchRemoteVideo,
    stopUpload,
    addSseClient,
    removeSseClient,
    uploadEmitter,
    emitProgress,
};
