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
        html += `<span style="font-size:.7rem;color:var(--text-muted);background:var(--bg-secondary);border:1px solid var(--border);border-radius:4px;padding:1px 6px;font-family:monospace;margin-left:4px" title="Folder ID">ID:${node.id}</span>`;
        html += `<div class="folder-actions">`;
        // ➕ Tạo thư mục con — mọi user
        html += `<button class="action-btn success" onclick="openCreateModal(${node.id},'${jsPath}',${sid})" title="Tạo thư mục con">➕ <span>Tạo con</span></button>`;
        // ✏️ Đổi tên — mọi user
        html += `<button class="action-btn" onclick="openRename(${node.id},'${jsName}','${jsPath}')" title="Đổi tên">✏️ <span>Đổi tên</span></button>`;
        // 📦 Di chuyển — mọi user
        html += `<button class="action-btn" onclick="openMoveModal(${node.id},'${jsName}','${jsPath}',${sid})" title="Di chuyển">📦 <span>Di chuyển</span></button>`;
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
    circularMove: '⚠️ Không thể di chuyển thư mục vào chính nó hoặc thư mục con của nó.',
    sameParent: '⚠️ Thư mục đã ở vị trí này rồi.',
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

// POST /folders/move/:id
router.post('/move/:id', requireAuth, (req, res) => {
    const folderId = parseInt(req.params.id, 10);
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId);
    if (!folder) return res.redirect('/folders?error=notfound');

    // new_parent_id: empty string → move to root, number → move under that folder
    const rawParent = req.body.new_parent_id;
    const newParentId = (rawParent === '' || rawParent === undefined) ? null : parseInt(rawParent, 10);

    // Same parent — no-op
    const currentParent = folder.parent_id === null ? null : folder.parent_id;
    if (newParentId === currentParent) return res.redirect('/folders?error=sameParent');

    // Prevent moving into itself or its own descendants
    if (newParentId !== null) {
        if (newParentId === folderId) return res.redirect('/folders?error=circularMove');
        // Walk up the ancestor chain of newParentId to see if folderId appears
        let cursor = db.prepare('SELECT * FROM folders WHERE id = ?').get(newParentId);
        while (cursor) {
            if (cursor.parent_id === folderId) return res.redirect('/folders?error=circularMove');
            cursor = cursor.parent_id ? db.prepare('SELECT * FROM folders WHERE id = ?').get(cursor.parent_id) : null;
        }
    }

    // Compute new path
    let newBasePath = '';
    if (newParentId !== null) {
        const newParent = db.prepare('SELECT * FROM folders WHERE id = ?').get(newParentId);
        if (!newParent) return res.redirect('/folders?error=notfound');
        newBasePath = newParent.path;
    }
    const newPath = newBasePath ? `${newBasePath}/${folder.name}` : folder.name;

    // Duplicate check
    const existing = db.prepare('SELECT id FROM folders WHERE path = ? AND server_id = ? AND id != ?')
        .get(newPath, folder.server_id, folderId);
    if (existing) return res.redirect('/folders?error=duplicate');

    const oldPath = folder.path;

    // Update this folder
    db.prepare('UPDATE folders SET parent_id = ?, path = ? WHERE id = ?')
        .run(newParentId, newPath, folderId);

    // Update all descendants
    const children = db.prepare('SELECT * FROM folders WHERE path LIKE ?').all(oldPath + '/%');
    children.forEach(child => {
        const newChildPath = newPath + child.path.substring(oldPath.length);
        db.prepare('UPDATE folders SET path = ? WHERE id = ?').run(newChildPath, child.id);
    });

    res.redirect('/folders?success=moved');
});

module.exports = router;
