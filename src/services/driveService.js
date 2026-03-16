/**
 * driveService.js
 * Tải file từ Google Drive — ưu tiên Service Account API, fallback sang anonymous URL.
 */
const { google } = require('googleapis');
const db = require('../config/database');

/**
 * Đọc Service Account JSON từ settings table.
 * Trả về object JSON hoặc null nếu chưa cấu hình.
 */
function getServiceAccountCredentials() {
    try {
        const row = db.prepare("SELECT value FROM settings WHERE key='drive_service_account'").get();
        if (!row || !row.value || row.value.trim() === '') return null;
        return JSON.parse(row.value);
    } catch (e) {
        console.warn('[DriveService] Service Account JSON không hợp lệ:', e.message);
        return null;
    }
}

/**
 * Tải file từ Drive bằng Service Account API.
 * @param {string} fileId - Google Drive file ID
 * @returns {{ stream: Readable, size: number }}
 */
async function getDriveStreamViaAPI(fileId, credentials) {
    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    const drive = google.drive({ version: 'v3', auth });

    // Lấy metadata để có file size
    let size = 0;
    try {
        const meta = await drive.files.get({ fileId, fields: 'size' });
        size = parseInt(meta.data.size || '0', 10);
    } catch (_) { /* size không bắt buộc */ }

    // Stream file content
    const resp = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream' }
    );

    return { stream: resp.data, size };
}

/**
 * Tải file từ Drive bằng anonymous URL (fallback khi chưa cấu hình SA).
 * @param {string} fileId
 * @returns {{ stream: Readable, size: number }}
 */
async function getDriveStreamAnonymous(fileId) {
    const axios = require('axios');

    const commonHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
    };

    const urls = [
        `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0&confirm=t`,
        `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`,
        `https://drive.google.com/uc?id=${fileId}&export=download`,
    ];

    let lastHtml = '';

    for (const url of urls) {
        try {
            const resp1 = await axios.get(url, {
                responseType: 'stream', maxRedirects: 10,
                headers: commonHeaders, timeout: 60000,
                validateStatus: s => s < 500,
            });

            const ct = resp1.headers['content-type'] || '';
            if (!ct.includes('text/html')) {
                return { stream: resp1.data, size: parseInt(resp1.headers['content-length'] || '0', 10) };
            }

            const chunks = [];
            for await (const c of resp1.data) chunks.push(c);
            const html = Buffer.concat(chunks).toString('utf8');
            lastHtml = html.substring(0, 800);
            console.warn(`[DriveAnon] ${url} trả HTML:\n${lastHtml.substring(0, 200)}`);

            const htmlLow = html.toLowerCase();
            if (htmlLow.includes('quota') || htmlLow.includes('too many'))
                throw new Error('Google Drive: File đã đạt giới hạn lượt tải trong ngày. Hãy thử lại sau hoặc dùng link Drive khác.');
            if (htmlLow.includes('you need access') || htmlLow.includes('request access') || htmlLow.includes('access denied'))
                throw new Error('Google Drive: File chưa được chia sẻ công khai. Hãy Share → "Anyone with the link".');
            if (htmlLow.includes('sharing has been disabled'))
                throw new Error('Google Drive: File bị tắt chia sẻ bởi admin hoặc chính sách tổ chức.');

            // Parse confirm token
            const cookies = [].concat(resp1.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
            const confirmMatch = html.match(/name="confirm"\s+value="([^"]+)"/i) || html.match(/"confirm"\s*:\s*"([^"]+)"/i);
            const uuidMatch = html.match(/name="uuid"\s+value="([^"]+)"/i);

            if (!confirmMatch && !uuidMatch && !cookies) continue;

            let cu = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0&confirm=t`;
            if (confirmMatch) cu += `&confirm=${confirmMatch[1]}`;
            if (uuidMatch) cu += `&uuid=${uuidMatch[1]}`;

            const resp2 = await axios.get(cu, {
                responseType: 'stream', maxRedirects: 10,
                headers: { ...commonHeaders, ...(cookies ? { Cookie: cookies } : {}) },
                timeout: 60000,
            });
            const ct2 = resp2.headers['content-type'] || '';
            if (!ct2.includes('text/html')) {
                return { stream: resp2.data, size: parseInt(resp2.headers['content-length'] || '0', 10) };
            }
            const ch2 = []; for await (const c of resp2.data) ch2.push(c);
            const html2 = Buffer.concat(ch2).toString('utf8').toLowerCase();
            lastHtml = html2.substring(0, 800);
            if (html2.includes('quota') || html2.includes('too many'))
                throw new Error('Google Drive: File đã đạt giới hạn lượt tải trong ngày.');
        } catch (e) {
            if (url === urls[urls.length - 1]) throw e;
            if (e.message.startsWith('Google Drive:')) throw e;
        }
    }

    throw new Error(`Google Drive: Không thể tải file. Hãy đảm bảo file được chia sẻ công khai (Anyone with the link).\nHTML: ${lastHtml.substring(0, 200)}`);
}

/**
 * Entry point duy nhất — tự chọn API hoặc anonymous.
 * @param {string} fileId
 * @returns {{ stream: Readable, size: number }}
 */
async function getDriveStream(fileId) {
    const creds = getServiceAccountCredentials();
    if (creds) {
        console.log(`[DriveService] Dùng Service Account: ${creds.client_email || '(no email)'}`);
        try {
            return await getDriveStreamViaAPI(fileId, creds);
        } catch (e) {
            console.warn('[DriveService] Service Account thất bại, fallback anonymous:', e.message);
            // fallback
        }
    }
    return getDriveStreamAnonymous(fileId);
}

module.exports = { getDriveStream };
