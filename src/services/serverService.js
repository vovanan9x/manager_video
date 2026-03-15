const SftpClient = require('ssh2-sftp-client');
const { Client: SshClient } = require('ssh2');
const ftp = require('ftp');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

async function testConnection(server) {
    if (server.type === 'local') {
        if (!fs.existsSync(server.root_path)) {
            try { fs.mkdirSync(server.root_path, { recursive: true }); } catch (err) {
                return { ok: false, message: 'Không thể tạo thư mục: ' + err.message };
            }
        }
        return { ok: true, message: 'Local path accessible' };
    }

    if (server.type === 'sftp') {
        const sftp = new SftpClient();
        try {
            const connOpts = {
                host: server.host,
                port: server.port || 22,
                username: server.username,
                readyTimeout: 8000,
            };
            if (server.private_key) {
                connOpts.privateKey = server.private_key;
                if (server.password) connOpts.passphrase = server.password;
            } else if (server.password) {
                connOpts.password = server.password;
            }
            await sftp.connect(connOpts);
            await sftp.end();
            return { ok: true, message: 'SFTP connection successful' };
        } catch (err) {
            return { ok: false, message: 'SFTP Error: ' + err.message };
        }
    }

    if (server.type === 'http') {
        try {
            const axios = require('axios');
            const testUrl = server.base_url ? server.base_url.replace(/\/$/, '') + '/ping' : server.host;
            await axios.get(testUrl, { timeout: 5000 });
            return { ok: true, message: 'HTTP server reachable' };
        } catch (err) {
            return { ok: false, message: 'HTTP Error: ' + err.message };
        }
    }

    return { ok: false, message: 'Unknown server type' };
}

/**
 * Get disk info for a server.
 * Returns { total, used, free } in bytes.
 * Returns { total:0, used:0, free:0 } if not available.
 */
async function getServerDiskInfo(server) {
    // ── LOCAL ──────────────────────────────────────────────
    if (server.type === 'local') {
        try {
            const diskInfo = require('node-disk-info');
            const disks = await diskInfo.getDiskInfo();
            const driveLetter = path.parse(server.root_path).root.toLowerCase().replace('\\', '');
            const disk = disks.find(d => d.mounted && d.mounted.toLowerCase().replace('\\', '').startsWith(driveLetter));
            if (disk) {
                return {
                    total: disk.blocks * 1024,
                    used: disk.used * 1024,
                    free: disk.available * 1024,
                };
            }
        } catch (_) { }
        return { total: 0, used: 0, free: 0 };
    }

    // ── SFTP — chạy `df -k <root_path>` qua SSH exec ──────
    if (server.type === 'sftp') {
        return new Promise((resolve) => {
            const conn = new SshClient();
            const result = { total: 0, used: 0, free: 0 };
            let settled = false;
            const done = (val) => { if (!settled) { settled = true; resolve(val); } };

            const timeout = setTimeout(() => {
                try { conn.end(); } catch (_) {}
                done(result);
            }, 12000);

            conn.on('ready', () => {
                const remotePath = (server.root_path || '/').replace(/\\/g, '/');
                conn.exec(`df -k "${remotePath}"`, (err, stream) => {
                    if (err) { clearTimeout(timeout); try { conn.end(); } catch (_) {} done(result); return; }
                    let output = '';
                    stream.on('data', (d) => { output += d.toString(); });
                    stream.stderr.on('data', () => {});
                    stream.on('close', () => {
                        clearTimeout(timeout);
                        try { conn.end(); } catch (_) {}
                        // Parse df -k output (2nd line: Filesystem 1K-blocks Used Available ...)
                        const lines = output.trim().split('\n');
                        if (lines.length >= 2) {
                            const parts = lines[lines.length - 1].trim().split(/\s+/);
                            // df -k columns: Filesystem, 1K-blocks, Used, Available, Use%, Mounted
                            const kBlocks  = parseInt(parts[1], 10);
                            const kUsed    = parseInt(parts[2], 10);
                            const kAvail   = parseInt(parts[3], 10);
                            if (!isNaN(kBlocks) && !isNaN(kUsed) && !isNaN(kAvail)) {
                                done({ total: kBlocks * 1024, used: kUsed * 1024, free: kAvail * 1024 });
                                return;
                            }
                        }
                        done(result);
                    });
                });
            });

            conn.on('error', () => { clearTimeout(timeout); done(result); });

            const connOpts = {
                host: server.host,
                port: server.port || 22,
                username: server.username,
                readyTimeout: 10000,
            };
            if (server.private_key) {
                connOpts.privateKey = server.private_key;
                if (server.password) connOpts.passphrase = server.password;
            } else if (server.password) {
                connOpts.password = server.password;
            }
            try { conn.connect(connOpts); } catch (e) { clearTimeout(timeout); done(result); }
        });
    }

    // ── HTTP — gọi GET <base_url>/stats ───────────────────
    if (server.type === 'http') {
        try {
            const axios = require('axios');
            const statsUrl = server.base_url ? server.base_url.replace(/\/$/, '') + '/stats' : null;
            if (!statsUrl) return { total: 0, used: 0, free: 0 };
            const resp = await axios.get(statsUrl, { timeout: 6000 });
            const d = resp.data;
            if (d && typeof d.free === 'number') {
                return {
                    total: d.total || 0,
                    used:  d.used  || 0,
                    free:  d.free  || 0,
                };
            }
        } catch (_) {}
        return { total: 0, used: 0, free: 0 };
    }

    return { total: 0, used: 0, free: 0 };
}

function deleteFromServer(server, remotePath) {
    if (server.type === 'local') {
        const fullPath = path.join(server.root_path, remotePath);
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
            return true;
        }
        return false;
    }
    // SFTP/HTTP deletion handled async elsewhere
    return false;
}

async function deleteFromSftp(server, remotePath) {
    const sftp = new SftpClient();
    try {
        await sftp.connect({
            host: server.host,
            port: server.port || 22,
            username: server.username,
            password: server.password,
        });
        const remoteFullPath = server.root_path.replace(/\\/g, '/') + '/' + remotePath.replace(/\\/g, '/');
        await sftp.delete(remoteFullPath);
        await sftp.end();
        return true;
    } catch (err) {
        console.error('[SFTP Delete Error]', err.message);
        return false;
    }
}

module.exports = { testConnection, getServerDiskInfo, deleteFromServer, deleteFromSftp };
