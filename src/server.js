const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const multer = require('multer');
const crypto = require('crypto');

const db = require('./db');
const {
  ensureSeedUsers,
  findUserByPassword,
  requireAuth,
  requireInstructor,
} = require('./auth');

ensureSeedUsers();

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
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  const user = findUserByPassword(password);
  if (!user) return res.status(401).json({ error: 'Invalid password' });
  req.session.user = {
    id: user.id,
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
    .prepare(
      `SELECT id, name, parent_id, display_order, created_at
       FROM folders
       ORDER BY display_order ASC, id ASC`
    )
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
  const nextOrder =
    parentId == null
      ? db
          .prepare(
            'SELECT COALESCE(MAX(display_order), 0) + 1 AS n FROM folders WHERE parent_id IS NULL'
          )
          .get().n
      : db
          .prepare(
            'SELECT COALESCE(MAX(display_order), 0) + 1 AS n FROM folders WHERE parent_id = ?'
          )
          .get(parentId).n;
  const result = db
    .prepare('INSERT INTO folders (name, parent_id, display_order) VALUES (?, ?, ?)')
    .run(name.trim(), parentId ?? null, nextOrder);
  res.json({ id: result.lastInsertRowid });
});

// Move (reorder / re-parent) a folder. Body: { parentId, beforeId }
//   - parentId: new parent (null for root). Omit to keep current parent.
//   - beforeId: place immediately before this sibling, or null/undefined to append.
app.post('/api/folders/:id/place', requireAuth, requireInstructor, (req, res) => {
  const id = Number(req.params.id);
  const folder = db.prepare('SELECT id, parent_id FROM folders WHERE id = ?').get(id);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });

  const body = req.body || {};
  const newParentId =
    body.parentId === undefined
      ? folder.parent_id
      : body.parentId == null
        ? null
        : Number(body.parentId);
  const beforeId =
    body.beforeId == null || body.beforeId === undefined ? null : Number(body.beforeId);

  if (newParentId === id) {
    return res.status(400).json({ error: 'Cannot move folder into itself' });
  }
  if (newParentId != null) {
    if (!db.prepare('SELECT id FROM folders WHERE id = ?').get(newParentId)) {
      return res.status(400).json({ error: 'Target parent does not exist' });
    }
    const descendants = collectFolderTreeIds(id);
    if (descendants.includes(newParentId)) {
      return res.status(400).json({ error: 'Cannot move folder into its own descendant' });
    }
  }

  const place = db.transaction(() => {
    db.prepare('UPDATE folders SET parent_id = ? WHERE id = ?').run(newParentId, id);

    const siblings =
      newParentId == null
        ? db
            .prepare(
              'SELECT id FROM folders WHERE parent_id IS NULL ORDER BY display_order ASC, id ASC'
            )
            .all()
        : db
            .prepare(
              'SELECT id FROM folders WHERE parent_id = ? ORDER BY display_order ASC, id ASC'
            )
            .all(newParentId);

    const ordered = siblings.filter((s) => s.id !== id);
    if (beforeId == null) {
      ordered.push({ id });
    } else {
      const idx = ordered.findIndex((s) => s.id === beforeId);
      if (idx === -1) ordered.push({ id });
      else ordered.splice(idx, 0, { id });
    }

    const upd = db.prepare('UPDATE folders SET display_order = ? WHERE id = ?');
    ordered.forEach((s, i) => upd.run(i + 1, s.id));
  });
  place();
  res.json({ ok: true });
});

app.patch('/api/folders/:id', requireAuth, requireInstructor, (req, res) => {
  const id = Number(req.params.id);
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const r = db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name.trim(), id);
  if (!r.changes) return res.status(404).json({ error: 'Folder not found' });
  res.json({ ok: true });
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
      `SELECT f.id, f.original_name, f.display_name, f.mime_type, f.size_bytes,
              f.uploaded_at, f.display_order,
              u.display_name AS uploaded_by_name
       FROM files f
       LEFT JOIN users u ON u.id = f.uploaded_by
       WHERE f.folder_id = ?
       ORDER BY f.display_order ASC, f.uploaded_at ASC, f.id ASC`
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

    const nextOrder =
      (db
        .prepare('SELECT COALESCE(MAX(display_order), 0) + 1 AS n FROM files WHERE folder_id = ?')
        .get(folderId).n) || 1;

    const result = db
      .prepare(
        `INSERT INTO files
           (folder_id, original_name, stored_name, mime_type, size_bytes, uploaded_by, display_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        folderId,
        req.file.originalname,
        req.file.filename,
        req.file.mimetype,
        req.file.size,
        req.session.user.id,
        nextOrder
      );
    res.json({ id: result.lastInsertRowid });
  }
);

// Rename (override display title) — empty/null clears the override.
app.patch('/api/files/:id', requireAuth, requireInstructor, (req, res) => {
  const id = Number(req.params.id);
  const { displayName } = req.body || {};
  const value = displayName && displayName.trim() ? displayName.trim() : null;
  const r = db.prepare('UPDATE files SET display_name = ? WHERE id = ?').run(value, id);
  if (!r.changes) return res.status(404).json({ error: 'File not found' });
  res.json({ ok: true });
});

// Move a file up or down within its folder by swapping display_order with the neighbour.
app.post('/api/files/:id/move', requireAuth, requireInstructor, (req, res) => {
  const id = Number(req.params.id);
  const direction = (req.body && req.body.direction) || 'down';
  if (direction !== 'up' && direction !== 'down') {
    return res.status(400).json({ error: 'direction must be up or down' });
  }
  const file = db.prepare('SELECT id, folder_id, display_order FROM files WHERE id = ?').get(id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  const move = db.transaction(() => {
    // Renumber everyone in the folder so positions are unique and contiguous.
    const rows = db
      .prepare(
        `SELECT id FROM files
         WHERE folder_id = ?
         ORDER BY display_order ASC, uploaded_at ASC, id ASC`
      )
      .all(file.folder_id);
    const upd = db.prepare('UPDATE files SET display_order = ? WHERE id = ?');
    rows.forEach((r, i) => upd.run(i + 1, r.id));

    const idx = rows.findIndex((r) => r.id === id);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= rows.length) return false; // boundary, no-op

    const a = rows[idx].id;
    const b = rows[swapIdx].id;
    upd.run(swapIdx + 1, a);
    upd.run(idx + 1, b);
    return true;
  });
  const moved = move();
  res.json({ moved });
});

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
