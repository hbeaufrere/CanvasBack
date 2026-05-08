const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const multer = require('multer');
const crypto = require('crypto');

const db = require('./db');
const {
  findUserByUsername,
  verifyPassword,
  requireAuth,
  requireInstructor,
} = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const DATA_DIR = db.DATA_DIR;
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (IS_PROD && !process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET must be set in production.');
  process.exit(1);
}

// Behind Render's HTTPS proxy: required for secure cookies.
app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: new SQLiteStore({ db: 'sessions.sqlite', dir: DATA_DIR }),
    secret: process.env.SESSION_SECRET || 'dev-only-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
    },
  })
);

// Simple in-memory login rate limit: 10 attempts / 15 min per IP.
const loginAttempts = new Map();
function loginLimiter(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const window = 15 * 60 * 1000;
  const max = 10;
  const entry = loginAttempts.get(ip) || { count: 0, start: now };
  if (now - entry.start > window) {
    entry.count = 0;
    entry.start = now;
  }
  entry.count++;
  loginAttempts.set(ip, entry);
  if (entry.count > max) {
    return res.status(429).json({ error: 'Too many attempts, try again later.' });
  }
  next();
}

// ---------- Uploads ----------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safe = crypto.randomBytes(16).toString('hex') + ext;
    cb(null, safe);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

// ---------- Auth routes ----------
app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Missing credentials' });
  }
  const user = findUserByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  req.session.user = {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
  };
  res.json({ user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

// ---------- Folders ----------
app.get('/api/folders', requireAuth, (_req, res) => {
  const rows = db
    .prepare('SELECT id, name, parent_id, created_at FROM folders ORDER BY name')
    .all();
  res.json({ folders: rows });
});

app.post('/api/folders', requireAuth, requireInstructor, (req, res) => {
  const { name, parentId } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Folder name is required' });
  }
  if (parentId != null) {
    const parent = db.prepare('SELECT id FROM folders WHERE id = ?').get(parentId);
    if (!parent) return res.status(400).json({ error: 'Parent folder not found' });
  }
  const result = db
    .prepare('INSERT INTO folders (name, parent_id) VALUES (?, ?)')
    .run(name.trim(), parentId ?? null);
  res.json({ id: result.lastInsertRowid });
});

app.delete('/api/folders/:id', requireAuth, requireInstructor, (req, res) => {
  const id = Number(req.params.id);
  // Collect files that will be removed (folder + descendants) so we can unlink them on disk.
  const ids = collectFolderTreeIds(id);
  if (!ids.length) return res.status(404).json({ error: 'Folder not found' });
  const placeholders = ids.map(() => '?').join(',');
  const filesToDelete = db
    .prepare(`SELECT stored_name FROM files WHERE folder_id IN (${placeholders})`)
    .all(...ids);
  db.prepare('DELETE FROM folders WHERE id = ?').run(id); // cascades to children + files
  for (const f of filesToDelete) {
    const p = path.join(UPLOAD_DIR, f.stored_name);
    fs.promises.unlink(p).catch(() => {});
  }
  res.json({ ok: true });
});

function collectFolderTreeIds(rootId) {
  const found = new Set();
  const stack = [rootId];
  const childStmt = db.prepare('SELECT id FROM folders WHERE parent_id = ?');
  const existsStmt = db.prepare('SELECT id FROM folders WHERE id = ?');
  if (!existsStmt.get(rootId)) return [];
  while (stack.length) {
    const id = stack.pop();
    if (found.has(id)) continue;
    found.add(id);
    for (const row of childStmt.all(id)) stack.push(row.id);
  }
  return [...found];
}

// ---------- Files ----------
app.get('/api/folders/:id/files', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const rows = db
    .prepare(
      `SELECT f.id, f.original_name, f.mime_type, f.size_bytes, f.uploaded_at,
              u.display_name AS uploaded_by_name
       FROM files f
       LEFT JOIN users u ON u.id = f.uploaded_by
       WHERE f.folder_id = ?
       ORDER BY f.uploaded_at DESC`
    )
    .all(id);
  res.json({ files: rows });
});

app.post(
  '/api/folders/:id/files',
  requireAuth,
  requireInstructor,
  upload.single('file'),
  (req, res) => {
    const folderId = Number(req.params.id);
    const folder = db.prepare('SELECT id FROM folders WHERE id = ?').get(folderId);
    if (!folder) {
      if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: 'Folder not found' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const result = db
      .prepare(
        `INSERT INTO files (folder_id, original_name, stored_name, mime_type, size_bytes, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        folderId,
        req.file.originalname,
        req.file.filename,
        req.file.mimetype,
        req.file.size,
        req.session.user.id
      );
    res.json({ id: result.lastInsertRowid });
  }
);

function sendFile(req, res, disposition) {
  const id = Number(req.params.id);
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  const filePath = path.join(UPLOAD_DIR, file.stored_name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File missing on disk' });
  }
  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename="${encodeURIComponent(file.original_name)}"`
  );
  fs.createReadStream(filePath).pipe(res);
}

app.get('/api/files/:id/view', requireAuth, (req, res) => sendFile(req, res, 'inline'));
app.get('/api/files/:id/download', requireAuth, (req, res) =>
  sendFile(req, res, 'attachment')
);

app.delete('/api/files/:id', requireAuth, requireInstructor, (req, res) => {
  const id = Number(req.params.id);
  const file = db.prepare('SELECT stored_name FROM files WHERE id = ?').get(id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  db.prepare('DELETE FROM files WHERE id = ?').run(id);
  fs.promises.unlink(path.join(UPLOAD_DIR, file.stored_name)).catch(() => {});
  res.json({ ok: true });
});

// ---------- Announcements ----------
app.get('/api/announcements', requireAuth, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT a.id, a.title, a.body, a.created_at, u.display_name AS author_name
       FROM announcements a
       LEFT JOIN users u ON u.id = a.author_id
       ORDER BY a.created_at DESC`
    )
    .all();
  res.json({ announcements: rows });
});

app.post('/api/announcements', requireAuth, requireInstructor, (req, res) => {
  const { title, body } = req.body || {};
  if (!title?.trim() || !body?.trim()) {
    return res.status(400).json({ error: 'Title and body are required' });
  }
  const result = db
    .prepare('INSERT INTO announcements (title, body, author_id) VALUES (?, ?, ?)')
    .run(title.trim(), body.trim(), req.session.user.id);
  res.json({ id: result.lastInsertRowid });
});

app.delete('/api/announcements/:id', requireAuth, requireInstructor, (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('DELETE FROM announcements WHERE id = ?').run(id);
  if (!r.changes) return res.status(404).json({ error: 'Announcement not found' });
  res.json({ ok: true });
});

// ---------- Static frontend ----------
app.use(express.static(path.join(__dirname, '..', 'public')));

// Multer / generic error handler
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => {
  console.log(`CanvasBack running on http://localhost:${PORT}`);
});
