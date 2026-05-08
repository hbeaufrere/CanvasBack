// Idempotent seed for the VET437 course folder structure.
// Creates four top-level folders (Lectures, Labs, DSL, Discussions) if they
// don't already exist, then populates each with its subfolders.
//
// Skips any folder that already exists by name under the same parent, so the
// LEC 1-3 subfolders you set up by hand are left untouched. Exam (EXM)
// folders are intentionally not created.
//
// Run on Render: Service -> Shell -> `node src/scripts/seedVet437.js`
// Naming convention used here: "<TYPE> <NUM> - <Topic>".

const db = require('../db');

const STRUCTURE = [
  {
    parent: 'Lectures',
    items: [
      [1, 'Introductory session'],
      [2, 'Anatomy and physiology of reptiles'],
      [3, 'Anatomy and physiology of birds'],
      [4, 'Imaging of reptiles and birds'],
      [5, 'Nutrition and nutritional disorders of birds'],
      [6, 'Hematology of birds and reptiles'],
      [7, 'Biochemistry of birds and reptiles'],
      [8, 'Anesthesia and pain management of birds'],
      [9, 'Anesthesia and pain management of reptiles'],
      [10, 'Cardiology of reptiles'],
      [11, 'Respiratory disorders of reptiles'],
      [12, 'Respiratory disorders of birds'],
      [13, 'Nutrition and nutritional disorders of reptiles'],
      [14, 'Neurological disorders of birds'],
      [15, 'Neurological disorders of reptiles'],
      [16, 'Urogenital disorders of birds'],
      [17, 'Urogenital disorders of reptiles'],
      [18, 'Cardiology of birds'],
      [19, 'Hepatic disorders of reptiles and birds'],
      [20, 'Gastrointestinal disorders of birds'],
      [21, 'Gastrointestinal disorders of reptiles'],
      [22, 'Soft tissue surgery of birds'],
      [23, 'Soft tissue surgery of reptiles'],
    ].map(([n, t]) => `LEC ${n} - ${t}`),
  },
  {
    parent: 'Labs',
    items: [
      [1, 'Anatomy of reptiles'],
      [2, 'Anatomy of birds'],
      [3, 'Avian handling and physical examination'],
      [4, 'Reptile handling and physical examination'],
      [5, 'Clinical pathology'],
      [6, 'Reptile anesthesia and clinical techniques'],
      [7, 'Avian and reptile necropsy'],
      [8, 'Avian pre-anesthesia exam, anesthesia and clinical techniques laboratory'],
      [9, 'Avian post-anesthetic examination'],
    ].map(([n, t]) => `LAB ${n} - ${t}`),
  },
  {
    parent: 'DSL',
    items: [
      [1, 'Husbandry: virtual pets assignment'],
      [2, 'Dermatologic disorders of birds'],
      [3, 'Dermatologic disorders of reptiles'],
    ].map(([n, t]) => `DSL ${n} - ${t}`),
  },
  {
    parent: 'Discussions',
    items: [
      [1, 'Imaging of reptiles and birds: cases'],
      [2, 'Orthopedic surgery of birds'],
      [3, 'Orthopedic surgery and shell repair of reptiles'],
      [4, 'Husbandry: virtual pets'],
      [5, 'Pre-exam discussion'],
    ].map(([n, t]) => `DIS ${n} - ${t}`),
  },
];

function findFolder(name, parentId) {
  if (parentId == null) {
    return db
      .prepare('SELECT id FROM folders WHERE name = ? AND parent_id IS NULL')
      .get(name);
  }
  return db
    .prepare('SELECT id FROM folders WHERE name = ? AND parent_id = ?')
    .get(name, parentId);
}

function nextOrder(parentId) {
  if (parentId == null) {
    return db
      .prepare(
        'SELECT COALESCE(MAX(display_order), 0) + 1 AS n FROM folders WHERE parent_id IS NULL'
      )
      .get().n;
  }
  return db
    .prepare(
      'SELECT COALESCE(MAX(display_order), 0) + 1 AS n FROM folders WHERE parent_id = ?'
    )
    .get(parentId).n;
}

function ensureFolder(name, parentId) {
  const existing = findFolder(name, parentId);
  if (existing) return { id: existing.id, created: false };
  const order = nextOrder(parentId);
  const result = db
    .prepare('INSERT INTO folders (name, parent_id, display_order) VALUES (?, ?, ?)')
    .run(name, parentId, order);
  return { id: result.lastInsertRowid, created: true };
}

let createdCount = 0;
let skippedCount = 0;

for (const group of STRUCTURE) {
  const top = ensureFolder(group.parent, null);
  if (top.created) {
    console.log(`+ ${group.parent}`);
    createdCount++;
  } else {
    console.log(`= ${group.parent} (already exists)`);
    skippedCount++;
  }
  for (const subName of group.items) {
    const sub = ensureFolder(subName, top.id);
    if (sub.created) {
      console.log(`  + ${subName}`);
      createdCount++;
    } else {
      console.log(`  = ${subName} (skipped)`);
      skippedCount++;
    }
  }
}

console.log(`\nDone. Created ${createdCount} folder(s); skipped ${skippedCount} that already existed.`);
