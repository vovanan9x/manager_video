const fs = require('fs');
const path = require('path');
const axios = require('axios');
const SftpClient = require('ssh2-sftp-client');
const { EventEmitter } = require('events');
const db = require('../config/database');
const { addErrorLog } = require('../config/database');

// ── Upload Queue ──────────────────────────────────────────────────────────────
// Tối đa MAX_CONCURRENT upload chạy song song.
// Các upload vượt quá giới hạn sẽ ở trạng thái "pending" và tự động khởi chạy
// khi có slot trống.
const MAX_CONCURRENT = 1;
let runningCount = 0;
let queuePaused = false;  // khi true: không start job mới, job đang chạy vẫn hoàn thành
const uploadQueue = []; // [{ fn: async function, videoId }]

function tryFlushQueue() {
    if (queuePaused) return; // << dừng flush khi queue bị pause
    while (runningCount < MAX_CONCURRENT && uploadQueue.length > 0) {
        const { fn, videoId } = uploadQueue.shift();
        runningCount++;
        console.log(`[Queue] Bắt đầu upload video #${videoId} (đang chạy: ${runningCount}/${MAX_CONCURRENT}, còn chờ: ${uploadQueue.length})`);
        fn().finally(() => {
            runningCount--;
            console.log(`[Queue] Hoàn thành video #${videoId} (đang chạy: ${runningCount}/${MAX_CONCURRENT}, còn chờ: ${uploadQueue.length})`);
            tryFlushQueue();
        });
    }
}

function enqueueUpload(videoId, fn) {
    if (!queuePaused && runningCount < MAX_CONCURRENT) {
        runningCount++;
        console.log(`[Queue] Bắt đầu upload video #${videoId} ngay (đang chạy: ${runningCount}/${MAX_CONCURRENT})`);
        fn().finally(() => {
            runningCount--;
            console.log(`[Queue] Hoàn thành video #${videoId} (đang chạy: ${runningCount}/${MAX_CONCURRENT}, còn chờ: ${uploadQueue.length})`);
            tryFlushQueue();
        });
    } else {
        const reason = queuePaused ? 'queue đang dừng' : `slot đầy: ${runningCount}/${MAX_CONCURRENT}`;
        console.log(`[Queue] Video #${videoId} xếp hàng chờ (${reason}, vị trí: ${uploadQueue.length + 1})`);
        uploadQueue.push({ fn, videoId });
        // Giữ nguyên status "pending" trong DB — không cần thay đổi
    }
}

function pauseQueue() {
    queuePaused = true;
    console.log('[Queue] ⏸ Hàng chờ đã được dừng — không có job mới nào sẽ bắt đầu');
}

function resumeQueue() {
    queuePaused = false;
    console.log('[Queue] ▶️ Hàng chờ tiếp tục — đang flush...');
    tryFlushQueue();
}

function isQueuePaused() {
    return queuePaused;
}
// ─────────────────────────────────────────────────────────────────────────────

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

// Public API — adds to queue, respects MAX_CONCURRENT
function uploadToServer(videoId, localFilePath, server, remotePath) {
    enqueueUpload(videoId, () => _doUploadToServer(videoId, localFilePath, server, remotePath));
}

async function _doUploadToServer(videoId, localFilePath, server, remotePath) {
    const controller = { cancelled: false };
    activeUploads.set(videoId, { controller, type: server.type });

    try {
        if (server.type === 'sftp') {
            await uploadSftp(videoId, localFilePath, server, remotePath, controller);
        } else if (server.type === 'http') {
            await uploadHttp(videoId, localFilePath, server, remotePath, controller);
        } else {
            throw new Error(`Loại server '${server.type}' không được hỗ trợ để upload.`);
        }

        if (!controller.cancelled) {
            emitProgress(videoId, 100, 'done');
            // Xóa file tạm trên app server sau khi upload lên storage thành công
            if (localFilePath && fs.existsSync(localFilePath)) {
                fs.unlink(localFilePath, (err) => {
                    if (err) {
                        console.warn(`[Cleanup] Không thể xóa file tạm: ${localFilePath}`, err.message);
                    } else {
                        console.log(`[Cleanup] Đã xóa file tạm: ${path.basename(localFilePath)}`);
                    }
                });
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

            if (controller.cancelled) { await sftp.end(); break; }

            // Track progress via polling interval (fastPut uses file path, not stream)
            let progressInterval = setInterval(async () => {
                if (controller.cancelled) return;
                try {
                    const stat = await sftp.stat(remoteFullPath).catch(() => null);
                    if (stat && fileSize > 0) {
                        const pct = Math.min(99, Math.floor((stat.size / fileSize) * 100));
                        emitProgress(videoId, pct, 'uploading');
                    }
                } catch (_) {}
            }, 1500);

            try {
                await sftp.fastPut(localFilePath, remoteFullPath, {
                    concurrency: 16,
                    chunkSize: 1024 * 1024, // 1MB chunks
                });
            } finally {
                clearInterval(progressInterval);
            }

            db.prepare('UPDATE videos SET remote_path = ?, file_size = ? WHERE id = ?').run(remotePath, fileSize, videoId);
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

// Public API — adds to queue
function fetchRemoteVideo(videoId, url, server, remotePath, controller) {
    enqueueUpload(videoId, () => _doFetchRemoteVideo(videoId, url, server, remotePath, controller));
}

async function _doFetchRemoteVideo(videoId, url, server, remotePath, controller) {
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
    // Remove from waiting queue first
    const queueIdx = uploadQueue.findIndex(item => item.videoId === videoId);
    if (queueIdx !== -1) {
        uploadQueue.splice(queueIdx, 1);
        emitProgress(videoId, 0, 'stopped');
        console.log(`[Queue] Video #${videoId} đã bị xóa khỏi hàng chờ`);
        return true;
    }

    const upload = activeUploads.get(videoId);
    if (!upload) return false;

    upload.controller.cancelled = true;
    if (typeof upload.controller.abort === 'function') upload.controller.abort();
    if (upload.sftp) { try { upload.sftp.end(); } catch (_) { } }

    emitProgress(videoId, 0, 'stopped');
    activeUploads.delete(videoId);
    return true;
}

function getActiveUploads() {
    return Array.from(activeUploads.keys());
}

function getQueueStatus() {
    return {
        running: runningCount,
        maxConcurrent: MAX_CONCURRENT,
        waiting: uploadQueue.map(item => item.videoId),
    };
}

function recoverPendingUploads() {
    const pending = db.prepare(`
        SELECT v.*, s.id as srv_id, s.type as srv_type, s.host, s.port, s.username,
               s.password, s.private_key, s.root_path, s.base_url
        FROM videos v
        LEFT JOIN servers s ON v.server_id = s.id
        WHERE v.status IN ('pending', 'uploading')
        ORDER BY v.created_at ASC
    `).all();

    if (pending.length === 0) return;
    console.log(`[Recovery] Tìm thấy ${pending.length} video chưa hoàn thành — đang re-enqueue...`);

    for (const video of pending) {
        // Reset uploading → pending
        if (video.status === 'uploading') {
            db.prepare("UPDATE videos SET status='pending', upload_progress=0 WHERE id=?").run(video.id);
        }

        const server = video.srv_id ? {
            id: video.srv_id, type: video.srv_type, host: video.host, port: video.port,
            username: video.username, password: video.password, private_key: video.private_key,
            root_path: video.root_path, base_url: video.base_url,
        } : null;

        if (!server) {
            console.warn(`[Recovery] Video #${video.id} không có server — bỏ qua`);
            db.prepare("UPDATE videos SET status='error' WHERE id=?").run(video.id);
            continue;
        }

        const remotePath = video.remote_path || ((video.folder_id ? 'f' + video.folder_id + '/' : '') + video.filename);
        const sourceType = video.source_type;

        if (sourceType === 'local') {
            // File tạm đã bị xóa sau restart — không thể recover
            console.warn(`[Recovery] Video #${video.id} (local) — file tạm đã mất, đặt lỗi`);
            db.prepare("UPDATE videos SET status='error' WHERE id=?").run(video.id);
            continue;
        }

        if (sourceType === 'remote' && video.source_url) {
            const vid = video;
            enqueueUpload(video.id, () => _doFetchRemoteVideo(vid.id, vid.source_url, server, remotePath, { cancelled: false }));
            console.log(`[Recovery] Video #${video.id} (remote) đã được re-enqueue`);
            continue;
        }

        if ((sourceType === 'drive' || (video.source_url && video.source_url.includes('drive.google.com'))) && video.source_url) {
            const fileIdMatch = video.source_url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
            if (!fileIdMatch) {
                db.prepare("UPDATE videos SET status='error' WHERE id=?").run(video.id);
                continue;
            }
            const fileId = fileIdMatch[1];
            const vid = video;
            enqueueUpload(video.id, async () => {
                try {
                    db.prepare("UPDATE videos SET status='uploading', upload_progress=0 WHERE id=?").run(vid.id);
                    emitProgress(vid.id, 0, 'uploading');
                    // Inline Drive download (xem api.js getDriveDownloadStream)
                    const axios = require('axios');
                    const os = require('os');
                    const urls = [
                        `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0&confirm=t`,
                        `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`,
                    ];
                    let driveStream = null, driveSize = 0;
                    for (const url of urls) {
                        try {
                            const resp = await axios.get(url, { responseType: 'stream', maxRedirects: 10, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' }, timeout: 60000, validateStatus: s => s < 500 });
                            const ct = resp.headers['content-type'] || '';
                            if (!ct.includes('text/html')) { driveStream = resp.data; driveSize = parseInt(resp.headers['content-length'] || '0', 10); break; }
                            const chunks = []; for await (const chunk of resp.data) chunks.push(chunk);
                            const html = Buffer.concat(chunks).toString('utf8');
                            const cookies = [].concat(resp.headers['set-cookie'] || []);
                            const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
                            const confirmMatch = html.match(/name="confirm"\s+value="([^"]+)"/i) || html.match(/"confirm"\s*:\s*"([^"]+)"/i);
                            const uuidMatch = html.match(/name="uuid"\s+value="([^"]+)"/i);
                            let cu = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0&confirm=t`;
                            if (confirmMatch) cu += `&confirm=${confirmMatch[1]}`;
                            if (uuidMatch) cu += `&uuid=${uuidMatch[1]}`;
                            const r2 = await axios.get(cu, { responseType: 'stream', maxRedirects: 10, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*', ...(cookieStr ? { 'Cookie': cookieStr } : {}) }, timeout: 60000 });
                            if (!(r2.headers['content-type'] || '').includes('text/html')) { driveStream = r2.data; driveSize = parseInt(r2.headers['content-length'] || '0', 10); break; }
                            r2.data.destroy();
                        } catch (e) { if (url === urls[urls.length - 1]) throw e; }
                    }
                    if (!driveStream) throw new Error('Không thể tải file từ Google Drive');
                    const tmpPath = require('path').join(os.tmpdir(), vid.filename);
                    const writeStream = require('fs').createWriteStream(tmpPath);
                    let downloaded = 0;
                    driveStream.on('data', chunk => { downloaded += chunk.length; if (driveSize > 0) emitProgress(vid.id, Math.floor(downloaded / driveSize * 50), 'uploading'); });
                    await new Promise((resolve, reject) => { driveStream.pipe(writeStream); writeStream.on('finish', resolve); writeStream.on('error', reject); driveStream.on('error', reject); });
                    await _doUploadToServer(vid.id, tmpPath, server, remotePath);
                } catch (err) {
                    console.error(`[Recovery Drive Error] Video #${vid.id}:`, err.message);
                    addErrorLog('drive_upload', { video_id: vid.id, video_title: vid.title, server_id: server.id, server_label: server.name, message: err.message, stack: err.stack });
                    db.prepare("UPDATE videos SET status='error' WHERE id=?").run(vid.id);
                    emitProgress(vid.id, 0, 'error');
                }
            });
            console.log(`[Recovery] Video #${video.id} (drive) đã được re-enqueue`);
            continue;
        }

        console.warn(`[Recovery] Video #${video.id} source_type='${sourceType}' không xử lý được — bỏ qua`);
    }

    console.log(`[Recovery] Hoàn tất: ${pending.length} video đã được xem xét`);
}

module.exports = {
    uploadToServer,
    fetchRemoteVideo,
    stopUpload,
    addSseClient,
    removeSseClient,
    uploadEmitter,
    emitProgress,
    getActiveUploads,
    getQueueStatus,
    enqueueUpload,
    _doUploadToServer,
    pauseQueue,
    resumeQueue,
    isQueuePaused,
    recoverPendingUploads,
};
