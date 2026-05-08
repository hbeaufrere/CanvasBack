const fs = require('fs');
const path = require('path');
// Import the inner module directly to avoid pdf-parse's debug-mode side effect
// of trying to read a bundled test PDF from a missing path.
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const db = require('./db');

const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '..', 'uploads');

async function extractAndStore(fileId) {
  const file = db
    .prepare('SELECT id, stored_name, kind FROM files WHERE id = ?')
    .get(fileId);
  if (!file || file.kind !== 'pdf') return false;

  const filePath = path.join(UPLOAD_DIR, file.stored_name);
  if (!fs.existsSync(filePath)) return false;

  try {
    const buffer = await fs.promises.readFile(filePath);
    const result = await pdfParse(buffer);
    const text = (result.text || '').trim();
    if (!text) {
      console.warn(`No text extracted from file ${file.id} (${file.stored_name}).`);
      return false;
    }
    db.prepare(
      'INSERT OR REPLACE INTO file_text (file_id, text_content) VALUES (?, ?)'
    ).run(file.id, text);
    return true;
  } catch (e) {
    console.error(`PDF text extraction failed for file ${file.id}:`, e.message);
    return false;
  }
}

async function extractAllPending() {
  const rows = db
    .prepare(
      `SELECT f.id FROM files f
       LEFT JOIN file_text ft ON ft.file_id = f.id
       WHERE f.kind = 'pdf' AND ft.file_id IS NULL`
    )
    .all();
  if (!rows.length) return;
  console.log(`Backfilling text for ${rows.length} PDF(s)...`);
  for (const r of rows) {
    await extractAndStore(r.id);
  }
  console.log('PDF text backfill complete.');
}

module.exports = { extractAndStore, extractAllPending };
