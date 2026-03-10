const SftpClient = require('ssh2-sftp-client');
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
                if (server.password) connOpts.passphrase = server.password; // password = passphrase for key
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

async function getServerDiskInfo(server) {
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
        // Fallback
        const { statSync } = require('fs');
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
