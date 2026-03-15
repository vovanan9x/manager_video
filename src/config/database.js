const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../data/manager_video.db');

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'uploader',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      host TEXT,
      port INTEGER,
      username TEXT,
      password TEXT,
      root_path TEXT NOT NULL,
      base_url TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER,
      server_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      genre TEXT,
      filename TEXT NOT NULL,
      original_name TEXT,
      file_size INTEGER DEFAULT 0,
      folder_id INTEGER,
      server_id INTEGER,
      uploaded_by INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      upload_progress INTEGER DEFAULT 0,
      remote_path TEXT,
      source_type TEXT DEFAULT 'local',
      source_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL,
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS error_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT 'upload',
      video_id INTEGER,
      video_title TEXT,
      server_id INTEGER,
      server_label TEXT,
      message TEXT NOT NULL,
      stack TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed default admin user
  const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!adminExists) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run('admin', hash, 'administrator');
    console.log('[DB] Default admin created: admin / admin123');
  }

  // Seed default settings
  const domainSetting = db.prepare('SELECT key FROM settings WHERE key = ?').get('domain');
  if (!domainSetting) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('domain', 'http://localhost:3000');
  }
}

initDatabase();

// ─── Auto Migrations ────────────────────────────────────────────────────────
// Mỗi khi thêm cột mới vào schema, khai báo tại đây.
// Hàm sẽ tự kiểm tra cột đã tồn tại chưa trước khi ALTER TABLE.
function runMigrations() {
  const migrations = [
    // Format: { table, column, definition }
    // Ví dụ thêm cột mới:
    // { table: 'videos', column: 'quality', definition: "TEXT DEFAULT 'HD'" },
    { table: 'videos', column: 'source_type', definition: "TEXT DEFAULT 'local'" },
    { table: 'videos', column: 'source_url',  definition: 'TEXT' },
    { table: 'videos', column: 'original_name', definition: 'TEXT' },
  ];

  for (const m of migrations) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${m.table})`).all();
      const exists = cols.some(c => c.name === m.column);
      if (!exists) {
        db.prepare(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.definition}`).run();
        console.log(`[Migration] Added column ${m.table}.${m.column}`);
      }
    } catch (e) {
      console.error(`[Migration] Failed ${m.table}.${m.column}:`, e.message);
    }
  }
}

runMigrations();

function addErrorLog(type, { video_id, video_title, server_id, server_label, message, stack } = {}) {
  try {
    db.prepare(
      'INSERT INTO error_logs (type, video_id, video_title, server_id, server_label, message, stack) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(type, video_id || null, video_title || null, server_id || null, server_label || null, message || 'Unknown error', stack || null);
  } catch (e) {
    console.error('[ErrorLog] Failed to write error log:', e.message);
  }
}

module.exports = db;
module.exports.addErrorLog = addErrorLog;
