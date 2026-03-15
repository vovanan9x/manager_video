const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');

// Helper: generate folder tree HTML (called as EJS local function)
function renderTree(nodes, serverId, isAdmin) {
    if (!nodes || nodes.length === 0) return '';
    let html = '';
    for (const node of nodes) {
        const hasKids = node.children && node.children.length > 0;
        const sid = serverId || node.server_id;
        const esc = s => String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        const safeName = esc(node.name);
        const safePath = esc(node.path);
        const jsName = node.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const jsPath = node.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

        html += `<li class="folder-node" data-id="${node.id}">`;
        html += `<div class="folder-row">`;
        html += hasKids
            ? `<button class="toggle-btn" onclick="toggleNode(this)" title="Thu gọn/Mở rộng" data-folder-id="${node.id}">&#9658;</button>`
            : `<span class="toggle-placeholder"></span>`;
        html += `<span class="folder-icon">📁</span>`;
        html += `<span class="folder-name">${safeName}</span>`;
        html += `<span class="folder-path-chip" title="${safePath}">${safePath}</span>`;
        html += `<div class="folder-actions">`;
        // ➕ Tạo thư mục con — mọi user
        html += `<button class="action-btn success" onclick="openCreateModal(${node.id},'${jsPath}',${sid})" title="Tạo thư mục con">➕ <span>Tạo con</span></button>`;
        // ✏️ Đổi tên — mọi user
        html += `<button class="action-btn" onclick="openRename(${node.id},'${jsName}','${jsPath}')" title="Đổi tên">✏️ <span>Đổi tên</span></button>`;
        // 🗑️ Xóa — chỉ admin
        if (isAdmin) {
            html += `<button type="button" class="action-btn danger folder-delete-btn" data-id="${node.id}" data-name="${esc(node.name)}" title="Xóa">🗑️ <span>Xóa</span></button>`;
        }

        html += `</div></div>`;
        if (hasKids) {
            html += `<ul class="folder-tree children-list collapsed" data-parent-id="${node.id}">${renderTree(node.children, sid, isAdmin)}</ul>`;
        }
        html += `</li>`;
    }
    return html;
}

// Helper: build recursive tree from flat folder list
function buildFolderTrees(servers, folders) {
    return servers.map(server => {
        const sf = folders.filter(f => f.server_id === server.id);
        const byId = {};
        sf.forEach(f => { byId[f.id] = { id: f.id, name: f.name, path: f.path, parent_id: f.parent_id, children: [] }; });
        const roots = [];
        sf.forEach(f => {
            if (f.parent_id && byId[f.parent_id]) byId[f.parent_id].children.push(byId[f.id]);
            else roots.push(byId[f.id]);
        });
        return { server, roots };
    });
}

const ERROR_MESSAGES = {
    missing: '⚠️ Thiếu tên hoặc server.',
    noserver: '⚠️ Server không tồn tại.',
    duplicate: '⚠️ Thư mục đã tồn tại.',
    notfound: '⚠️ Không tìm thấy thư mục.',
    notempty: '⚠️ Thư mục còn video hoặc thư mục con, không thể xóa.',
    permission: '⚠️ Bạn không có quyền thực hiện thao tác này.',
};

// GET /folders
router.get('/', requireAuth, (req, res) => {
    const servers = db.prepare('SELECT * FROM servers WHERE is_active = 1 ORDER BY name').all();
    const folders = db.prepare('SELECT f.*, s.name as server_name FROM folders f LEFT JOIN servers s ON f.server_id = s.id ORDER BY f.server_id, f.path').all();
    const folderTrees = buildFolderTrees(servers, folders);
    const isAdmin = req.session.user.role === 'administrator';
    const errCode = req.query.error || null;
    res.render('folders', {
        user: req.session.user,
        activePage: 'folders',
        servers,
        folders,
        folderTrees,
        renderTree: (nodes, serverId) => renderTree(nodes, serverId, isAdmin),
        foldersJson: JSON.stringify(folders),
        queryError: errCode ? (ERROR_MESSAGES[errCode] || '⚠️ Lỗi không xác định.') : null,
        querySuccess: req.query.success ? true : null,
        isAdmin,
    });
});

// POST /folders/add
router.post('/add', requireAuth, (req, res) => {
    const { name, parent_id, server_id } = req.body;
    if (!name || !server_id) {
        return res.redirect('/folders?error=missing');
    }

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(server_id);
    if (!server) return res.redirect('/folders?error=noserver');

    let parentPath = '';
    if (parent_id) {
        const parent = db.prepare('SELECT * FROM folders WHERE id = ?').get(parent_id);
        if (parent) parentPath = parent.path;
    }

    const folderPath = parentPath ? `${parentPath}/${name.trim()}` : name.trim();

    // Check duplicate
    const existing = db.prepare('SELECT id FROM folders WHERE path = ? AND server_id = ?').get(folderPath, server_id);
    if (existing) return res.redirect('/folders?error=duplicate');

    db.prepare('INSERT INTO folders (name, parent_id, server_id, path) VALUES (?, ?, ?, ?)')
        .run(name.trim(), parent_id || null, server_id, folderPath);

    res.redirect('/folders?success=added');
});

// POST /folders/rename/:id
router.post('/rename/:id', requireAuth, (req, res) => {
    const { name } = req.body;
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
    if (!folder) return res.redirect('/folders?error=notfound');

    const parentPath = folder.path.substring(0, folder.path.lastIndexOf('/'));
    const newPath = parentPath ? `${parentPath}/${name.trim()}` : name.trim();

    // Update this folder and all children paths
    const oldPath = folder.path;
    db.prepare('UPDATE folders SET name = ?, path = ? WHERE id = ?').run(name.trim(), newPath, folder.id);

    // Update children
    const children = db.prepare('SELECT * FROM folders WHERE path LIKE ?').all(oldPath + '/%');
    children.forEach(child => {
        const newChildPath = newPath + child.path.substring(oldPath.length);
        db.prepare('UPDATE folders SET path = ? WHERE id = ?').run(newChildPath, child.id);
    });

    res.redirect('/folders?success=renamed');
});

// POST /folders/delete/:id — admin only
router.post('/delete/:id', requireAuth, (req, res) => {
    if (req.session.user.role !== 'administrator') {
        return res.redirect('/folders?error=permission');
    }
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
    if (!folder) return res.redirect('/folders?error=notfound');

    const hasVideos = db.prepare('SELECT COUNT(*) as count FROM videos WHERE folder_id = ?').get(req.params.id);
    const hasChildren = db.prepare('SELECT COUNT(*) as count FROM folders WHERE parent_id = ?').get(req.params.id);

    if (hasVideos.count > 0 || hasChildren.count > 0) {
        return res.redirect('/folders?error=notempty');
    }

    db.prepare('DELETE FROM folders WHERE id = ?').run(req.params.id);
    res.redirect('/folders?success=deleted');
});

module.exports = router;
