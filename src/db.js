const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'canvasback.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('instructor','student')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS folders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    parent_id  INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);

  CREATE TABLE IF NOT EXISTS files (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id     INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    stored_name   TEXT NOT NULL UNIQUE,
    mime_type     TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL,
    uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    uploaded_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);

  CREATE TABLE IF NOT EXISTS announcements (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    author_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Idempotent column migrations for existing deployments.
const folderCols = db.prepare('PRAGMA table_info(folders)').all().map((c) => c.name);
if (!folderCols.includes('display_order')) {
  db.exec('ALTER TABLE folders ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0');
  // Backfill existing folders with alphabetical order within each parent so
  // their visual order is preserved on first load.
  db.exec(`
    WITH ordered AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY COALESCE(parent_id, -1)
        ORDER BY name COLLATE NOCASE ASC, id ASC
      ) AS rn
      FROM folders
    )
    UPDATE folders SET display_order = (SELECT rn FROM ordered WHERE ordered.id = folders.id);
  `);
}

const fileCols = db.prepare('PRAGMA table_info(files)').all().map((c) => c.name);
if (!fileCols.includes('display_name')) {
  db.exec('ALTER TABLE files ADD COLUMN display_name TEXT');
}
if (!fileCols.includes('display_order')) {
  db.exec('ALTER TABLE files ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0');
  // Seed display_order from upload time so existing files keep their order.
  db.exec(`
    WITH ordered AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY folder_id ORDER BY uploaded_at ASC, id ASC) AS rn
      FROM files
    )
    UPDATE files SET display_order = (SELECT rn FROM ordered WHERE ordered.id = files.id);
  `);
}
if (!fileCols.includes('kind')) {
  db.exec("ALTER TABLE files ADD COLUMN kind TEXT NOT NULL DEFAULT 'pdf'");
}
if (!fileCols.includes('url')) {
  db.exec('ALTER TABLE files ADD COLUMN url TEXT');
}

module.exports = db;
module.exports.DATA_DIR = DATA_DIR;
