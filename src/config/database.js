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
  // Seed stream_key — dùng để bảo vệ link MP4 qua /stream/*
  const streamKeySetting = db.prepare('SELECT key FROM settings WHERE key = ?').get('stream_key');
  if (!streamKeySetting) {
    const { randomBytes } = require('crypto');
    const defaultKey = 'sk_' + randomBytes(16).toString('hex');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('stream_key', defaultKey);
    console.log('[DB] Default stream_key generated. Configure in /settings');
  }
}

initDatabase();

// ─── Auto Migrations ────────────────────────────────────────────────────────
// Mỗi khi thêm cột mới vào schema, khai báo tại đây.
// Hàm sẽ tự kiểm tra cột đã tồn tại chưa trước khi ALTER TABLE.
function runMigrations() {
  const migrations = [
    // Format: { table, column, definition }
    // videos table
    { table: 'videos', column: 'source_type',   definition: "TEXT DEFAULT 'local'" },
    { table: 'videos', column: 'source_url',    definition: 'TEXT' },
    { table: 'videos', column: 'original_name', definition: 'TEXT' },
    { table: 'videos', column: 'idah',          definition: 'TEXT' },
    // servers table — các cột thêm sau
    { table: 'servers', column: 'private_key',  definition: 'TEXT' },
    { table: 'servers', column: 'api_key',      definition: 'TEXT' },
    { table: 'servers', column: 'cdn_zone_id',  definition: 'TEXT' },
    { table: 'servers', column: 'cdn_api_token',definition: 'TEXT' },

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

// Unique index cho idah (idempotent — CREATE INDEX IF NOT EXISTS)
try {
  db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_idah ON videos(idah) WHERE idah IS NOT NULL').run();
} catch (e) {
  console.error('[Index] Failed to create idx_videos_idah:', e.message);
}

// ─── Performance Indexes ─────────────────────────────────────────────────────
const perfIndexes = [
  // Sắp xếp mặc định (ORDER BY created_at DESC) — quan trọng nhất
  'CREATE INDEX IF NOT EXISTS idx_videos_created_at   ON videos(created_at DESC)',
  // Filter box: status, server, folder, user
  'CREATE INDEX IF NOT EXISTS idx_videos_status       ON videos(status)',
  'CREATE INDEX IF NOT EXISTS idx_videos_server_id    ON videos(server_id)',
  'CREATE INDEX IF NOT EXISTS idx_videos_folder_id    ON videos(folder_id)',
  'CREATE INDEX IF NOT EXISTS idx_videos_uploaded_by  ON videos(uploaded_by)',
  // Error logs
  'CREATE INDEX IF NOT EXISTS idx_error_logs_created  ON error_logs(created_at DESC)',
];
for (const sql of perfIndexes) {
  try {
    db.prepare(sql).run();
  } catch (e) {
    console.error('[Index]', e.message);
  }
}


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
