// Initialise the SQLite DB by simply requiring db.js (which runs CREATE TABLE IF NOT EXISTS).
require('./db');
console.log('Database initialised at data/canvasback.sqlite');
