const bcrypt = require('bcryptjs');
const db = require('./db');

function findUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function createUser({ username, displayName, password, role }) {
  const stmt = db.prepare(
    'INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)'
  );
  return stmt.run(username, displayName, hashPassword(password), role);
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

function requireInstructor(req, res, next) {
  if (!req.session?.user || req.session.user.role !== 'instructor') {
    return res.status(403).json({ error: 'Instructor only' });
  }
  next();
}

module.exports = {
  findUserByUsername,
  verifyPassword,
  hashPassword,
  createUser,
  requireAuth,
  requireInstructor,
};
