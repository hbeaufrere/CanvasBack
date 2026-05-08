const bcrypt = require('bcryptjs');
const db = require('./db');

// Single shared account per role. The "username" is internal; users only ever
// type a password. Display names show up next to announcements/uploads.
const SEED = {
  instructor: { username: 'instructor', displayName: 'Instructor' },
  student: { username: 'student', displayName: 'Student' },
};

function ensureSeedUsers() {
  const instructorPwd = process.env.INSTRUCTOR_PASSWORD;
  const studentPwd = process.env.STUDENT_PASSWORD;

  if (process.env.NODE_ENV === 'production') {
    if (!instructorPwd || !studentPwd) {
      console.error(
        'INSTRUCTOR_PASSWORD and STUDENT_PASSWORD must be set in production.'
      );
      process.exit(1);
    }
  }

  upsertSeedUser('instructor', instructorPwd || 'admin');
  upsertSeedUser('student', studentPwd || 'student');
}

function upsertSeedUser(role, password) {
  const { username, displayName } = SEED[role];
  const hash = bcrypt.hashSync(password, 10);
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    db.prepare(
      'UPDATE users SET password_hash = ?, display_name = ?, role = ? WHERE id = ?'
    ).run(hash, displayName, role, existing.id);
  } else {
    db.prepare(
      'INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)'
    ).run(username, displayName, hash, role);
  }
}

// Look up the seed user for each role and check the password against it.
// bcrypt.compare is constant-time. We always check both to keep the timing
// roughly uniform regardless of which password (if any) matched.
function findUserByPassword(password) {
  if (!password) return null;
  const instructor = db
    .prepare("SELECT * FROM users WHERE role = 'instructor' ORDER BY id LIMIT 1")
    .get();
  const student = db
    .prepare("SELECT * FROM users WHERE role = 'student' ORDER BY id LIMIT 1")
    .get();
  const instOk = instructor && bcrypt.compareSync(password, instructor.password_hash);
  const studOk = student && bcrypt.compareSync(password, student.password_hash);
  if (instOk) return instructor;
  if (studOk) return student;
  return null;
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
  ensureSeedUsers,
  findUserByPassword,
  requireAuth,
  requireInstructor,
};
