const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { requireAdmin } = require('../middleware/auth');

// All routes require admin
router.use(requireAdmin);

// Helper: get all table names (exclude internal sqlite tables)
function getAllTables() {
    return db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(r => r.name);
}

// Helper: get table info (columns)
function getTableInfo(tableName) {
    // Validate table name to prevent SQL injection
    const tables = getAllTables();
    if (!tables.includes(tableName)) return null;
    return db.prepare(`PRAGMA table_info("${tableName}")`).all();
}

// Helper: get row count
function getRowCount(tableName) {
    try {
        return db.prepare(`SELECT COUNT(*) as cnt FROM "${tableName}"`).get().cnt;
    } catch { return 0; }
}

// ─── GET /database ─── Main page: list all tables
router.get('/', (req, res) => {
    const tables = getAllTables().map(name => ({
        name,
        rowCount: getRowCount(name)
    }));
    res.render('database', {
        user: req.session.user,
        activePage: 'database',
        tables,
        selectedTable: null,
        columns: [],
        rows: [],
        total: 0,
        page: 1,
        pageSize: 50,
        search: '',
        success: req.query.success || null,
        error: req.query.error || null
    });
});

// ─── GET /database/table/:name ─── View table data
router.get('/table/:name', (req, res) => {
    const tableName = req.params.name;
    const columns = getTableInfo(tableName);
    if (!columns) {
        return res.redirect('/database?error=Bảng+không+tồn+tại');
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = 50;
    const search = (req.query.search || '').trim();
    const offset = (page - 1) * pageSize;

    const tables = getAllTables().map(name => ({
        name,
        rowCount: getRowCount(name)
    }));

    let rows = [], total = 0;
    try {
        if (search) {
            // Search across all text columns
            const textCols = columns.filter(c =>
                ['TEXT', 'VARCHAR', 'CHAR', ''].includes((c.type || '').toUpperCase().split('(')[0])
                || c.type === ''
            );
            if (textCols.length > 0) {
                const whereClause = textCols.map(c => `"${c.name}" LIKE ?`).join(' OR ');
                const params = textCols.map(() => `%${search}%`);
                total = db.prepare(`SELECT COUNT(*) as cnt FROM "${tableName}" WHERE ${whereClause}`).get(...params).cnt;
                rows = db.prepare(`SELECT rowid as __rowid__, * FROM "${tableName}" WHERE ${whereClause} LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
            } else {
                total = getRowCount(tableName);
                rows = db.prepare(`SELECT rowid as __rowid__, * FROM "${tableName}" LIMIT ? OFFSET ?`).all(pageSize, offset);
            }
        } else {
            total = getRowCount(tableName);
            rows = db.prepare(`SELECT rowid as __rowid__, * FROM "${tableName}" LIMIT ? OFFSET ?`).all(pageSize, offset);
        }
    } catch (e) {
        return res.redirect(`/database?error=${encodeURIComponent('Lỗi truy vấn: ' + e.message)}`);
    }

    res.render('database', {
        user: req.session.user,
        activePage: 'database',
        tables,
        selectedTable: tableName,
        columns,
        rows,
        total,
        page,
        pageSize,
        search,
        success: req.query.success || null,
        error: req.query.error || null
    });
});

// ─── POST /database/table/:name/row ─── Add a new row
router.post('/table/:name/row', (req, res) => {
    const tableName = req.params.name;
    const columns = getTableInfo(tableName);
    if (!columns) return res.redirect('/database?error=Bảng+không+tồn+tại');

    // Filter out autoincrement primary key
    const writableCols = columns.filter(c => !(c.pk && c.type === 'INTEGER'));
    const colNames = writableCols.map(c => `"${c.name}"`).join(', ');
    const placeholders = writableCols.map(() => '?').join(', ');
    const values = writableCols.map(c => {
        const v = req.body[c.name];
        if (v === '' || v === undefined || v === null) return null;
        return v;
    });

    try {
        db.prepare(`INSERT INTO "${tableName}" (${colNames}) VALUES (${placeholders})`).run(...values);
        res.redirect(`/database/table/${encodeURIComponent(tableName)}?success=Đã+thêm+hàng+mới`);
    } catch (e) {
        res.redirect(`/database/table/${encodeURIComponent(tableName)}?error=${encodeURIComponent('Lỗi thêm hàng: ' + e.message)}`);
    }
});

// ─── POST /database/table/:name/row/:rowid ─── Update a row (POST with _method=PUT)
router.post('/table/:name/row/:rowid', (req, res) => {
    const tableName = req.params.name;
    const rowid = req.params.rowid;
    const columns = getTableInfo(tableName);
    if (!columns) return res.redirect('/database?error=Bảng+không+tồn+tại');

    const method = req.body._method || '';
    if (method === 'DELETE') {
        // Delete row
        try {
            db.prepare(`DELETE FROM "${tableName}" WHERE rowid = ?`).run(rowid);
            res.redirect(`/database/table/${encodeURIComponent(tableName)}?success=Đã+xoá+hàng`);
        } catch (e) {
            res.redirect(`/database/table/${encodeURIComponent(tableName)}?error=${encodeURIComponent('Lỗi xoá: ' + e.message)}`);
        }
        return;
    }

    // Update row
    const writableCols = columns.filter(c => !c.pk);
    const setParts = writableCols.map(c => `"${c.name}" = ?`).join(', ');
    const values = writableCols.map(c => {
        const v = req.body[c.name];
        if (v === '' || v === undefined) return null;
        return v;
    });

    try {
        db.prepare(`UPDATE "${tableName}" SET ${setParts} WHERE rowid = ?`).run(...values, rowid);
        res.redirect(`/database/table/${encodeURIComponent(tableName)}?success=Đã+cập+nhật+hàng`);
    } catch (e) {
        res.redirect(`/database/table/${encodeURIComponent(tableName)}?error=${encodeURIComponent('Lỗi cập nhật: ' + e.message)}`);
    }
});

// ─── POST /database/table/:name/add-column ─── Add a new column
router.post('/table/:name/add-column', (req, res) => {
    const tableName = req.params.name;
    const columns = getTableInfo(tableName);
    if (!columns) return res.redirect('/database?error=Bảng+không+tồn+tại');

    const { colName, colType, colDefault, colNotNull } = req.body;
    if (!colName || !colType) {
        return res.redirect(`/database/table/${encodeURIComponent(tableName)}?error=Tên+và+kiểu+cột+là+bắt+buộc`);
    }
    // Whitelist kiểu cột hợp lệ
    const VALID_COL_TYPES = ['TEXT', 'INTEGER', 'REAL', 'BLOB', 'NUMERIC', 'DATETIME', 'BOOLEAN'];
    if (!VALID_COL_TYPES.includes((colType || '').toUpperCase())) {
        return res.redirect(`/database/table/${encodeURIComponent(tableName)}?error=Kiểu+cột+không+hợp+lệ+(chỉ+TEXT,INTEGER,REAL,BLOB,NUMERIC,DATETIME,BOOLEAN)`);
    }
    // Basic sanitize: only allow alphanumeric + underscore column names
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(colName)) {
        return res.redirect(`/database/table/${encodeURIComponent(tableName)}?error=Tên+cột+không+hợp+lệ`);
    }

    let sql = `ALTER TABLE "${tableName}" ADD COLUMN "${colName}" ${colType}`;
    if (colNotNull === 'on' && colDefault !== undefined && colDefault !== '') {
        sql += ` NOT NULL DEFAULT '${colDefault.replace(/'/g, "''")}'`;
    } else if (colDefault !== undefined && colDefault !== '') {
        sql += ` DEFAULT '${colDefault.replace(/'/g, "''")}'`;
    }

    try {
        db.prepare(sql).run();
        res.redirect(`/database/table/${encodeURIComponent(tableName)}?success=Đã+thêm+cột+${encodeURIComponent(colName)}`);
    } catch (e) {
        res.redirect(`/database/table/${encodeURIComponent(tableName)}?error=${encodeURIComponent('Lỗi thêm cột: ' + e.message)}`);
    }
});

// ─── POST /database/table/:name/truncate ─── Delete all rows in a table
router.post('/table/:name/truncate', (req, res) => {
    const tableName = req.params.name;
    const columns = getTableInfo(tableName);
    if (!columns) return res.redirect('/database?error=Bảng+không+tồn+tại');

    const confirm = (req.body.confirm || '').trim();
    if (confirm !== tableName) {
        return res.redirect(`/database/table/${encodeURIComponent(tableName)}?error=Xác+nhận+không+khớp+tên+bảng`);
    }

    try {
        db.prepare(`DELETE FROM "${tableName}"`).run();
        res.redirect(`/database/table/${encodeURIComponent(tableName)}?success=Đã+xoá+toàn+bộ+dữ+liệu+trong+bảng+${encodeURIComponent(tableName)}`);
    } catch (e) {
        res.redirect(`/database/table/${encodeURIComponent(tableName)}?error=${encodeURIComponent('Lỗi xoá bảng: ' + e.message)}`);
    }
});

// ─── GET /database/table/:name/export ─── Export table to JSON
router.get('/table/:name/export', (req, res) => {
    const tableName = req.params.name;
    const columns = getTableInfo(tableName);
    if (!columns) return res.redirect('/database?error=Bảng+không+tồn+tại');

    try {
        const allRows = db.prepare(`SELECT * FROM "${tableName}"`).all();
        // Mask sensitive fields
        const SENSITIVE_FIELDS = { users: ['password'] };
        const masked = (SENSITIVE_FIELDS[tableName] || []);
        const rows = allRows.map(row => {
            if (!masked.length) return row;
            const safe = { ...row };
            masked.forEach(f => { if (safe[f] !== undefined) safe[f] = '[REDACTED]'; });
            return safe;
        });
        res.setHeader('Content-Disposition', `attachment; filename="${tableName}.json"`);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.send(JSON.stringify({ table: tableName, columns: columns.map(c => c.name), rows }, null, 2));
    } catch (e) {
        res.redirect(`/database/table/${encodeURIComponent(tableName)}?error=${encodeURIComponent('Lỗi xuất dữ liệu: ' + e.message)}`);
    }
});

module.exports = router;
