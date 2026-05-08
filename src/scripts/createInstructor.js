// Create one instructor account from CLI args:
//   node src/scripts/createInstructor.js <username> <displayName> <password>
const { createUser, findUserByUsername } = require('../auth');

const [, , username, displayName, password] = process.argv;
if (!username || !displayName || !password) {
  console.error(
    'Usage: node src/scripts/createInstructor.js <username> "<display name>" <password>'
  );
  process.exit(1);
}
if (findUserByUsername(username)) {
  console.error(`User "${username}" already exists.`);
  process.exit(1);
}
createUser({ username, displayName, password, role: 'instructor' });
console.log(`Instructor "${username}" created.`);
