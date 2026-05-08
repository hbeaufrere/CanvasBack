// Bulk-create student accounts.
//
// Two modes:
//   1) Auto-generate N students with random passwords:
//        node src/scripts/createStudents.js --count 70 [--prefix student]
//   2) From a CSV file with columns: username,displayName[,password]
//        node src/scripts/createStudents.js --csv students.csv
//
// In auto mode, credentials are written to data/students-credentials.csv so the
// instructor can hand them out.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createUser, findUserByUsername } = require('../auth');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1];
  }
  return args;
}

function randomPassword() {
  // 10-char URL-safe password.
  return crypto.randomBytes(8).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 10);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.csv) {
    const filePath = path.resolve(args.csv);
    const lines = fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    let created = 0;
    for (const line of lines) {
      const [username, displayName, password] = line.split(',').map((s) => s?.trim());
      if (!username || !displayName) continue;
      if (findUserByUsername(username)) {
        console.warn(`Skip: ${username} already exists.`);
        continue;
      }
      const pwd = password || randomPassword();
      createUser({ username, displayName, password: pwd, role: 'student' });
      console.log(`${username},${displayName},${pwd}`);
      created++;
    }
    console.log(`Created ${created} student accounts.`);
    return;
  }

  const count = Number(args.count || 70);
  const prefix = args.prefix || 'student';
  const outDir = path.join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'students-credentials.csv');

  const lines = ['username,displayName,password'];
  let created = 0;
  for (let i = 1; i <= count; i++) {
    const num = String(i).padStart(2, '0');
    const username = `${prefix}${num}`;
    if (findUserByUsername(username)) continue;
    const displayName = `Student ${num}`;
    const password = randomPassword();
    createUser({ username, displayName, password, role: 'student' });
    lines.push(`${username},${displayName},${password}`);
    created++;
  }
  fs.writeFileSync(outFile, lines.join('\n') + '\n');
  console.log(`Created ${created} students. Credentials written to ${outFile}`);
}

main();
