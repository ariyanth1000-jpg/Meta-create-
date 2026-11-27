const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'ivas.db');
const dirPath = path.dirname(dbPath);

if (!fs.existsSync(dirPath)) {
  fs.mkdirSync(dirPath, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint TEXT UNIQUE,
    number TEXT,
    source TEXT,
    message TEXT,
    otp TEXT,
    rate REAL,
    currency TEXT,
    status TEXT,
    type TEXT,
    range_name TEXT,
    received_at TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS numbers_cache (
    number TEXT PRIMARY KEY,
    range_name TEXT,
    a2p_rate REAL,
    currency TEXT,
    assigned_at TEXT,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS deleted_numbers (
    number TEXT PRIMARY KEY,
    deleted_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

function saveMessage(m, otp) {
  if (!m || !m.number || !m.received_at) return false;
  const fp = crypto.createHash('md5')
    .update(`${m.received_at}|${m.number}|${m.source || ''}|${m.message || ''}`)
    .digest('hex');

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO messages
      (fingerprint, number, source, message, otp, rate, currency, status, type, range_name, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const r = stmt.run(
    fp, m.number, m.source || null, m.message || null, otp || null,
    m.rate ?? null, m.currency || null, m.status || null,
    m.type || null, m.range_name || null, m.received_at
  );
  return r.changes > 0;
}

// ফিল্টার সহ মেসেজ লোড করা
function getMessages({ number, limit = 100, offset = 0 } = {}) {
  let sql = 'SELECT * FROM messages WHERE 1=1';
  const params = [];
  if (number) { sql += ' AND number = ?'; params.push(number); }
  sql += ' ORDER BY received_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

function countMessages(number = null) {
  if (number) {
    return db.prepare('SELECT COUNT(*) c FROM messages WHERE number = ?').get(number).c;
  }
  return db.prepare('SELECT COUNT(*) c FROM messages').get().c;
}

function saveNumbers(nums) {
  const stmt = db.prepare(`
    INSERT INTO numbers_cache (number, range_name, a2p_rate, currency, assigned_at, updated_at)
    VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(number) DO UPDATE SET
      range_name=excluded.range_name, a2p_rate=excluded.a2p_rate,
      currency=excluded.currency, assigned_at=excluded.assigned_at,
      updated_at=strftime('%s','now')
  `);
  const checkDeleted = db.prepare('SELECT number FROM deleted_numbers WHERE number = ?');
  
  const tx = db.transaction(list => {
    list.forEach(n => {
      if (!checkDeleted.get(n.number)) {
        stmt.run(n.number, n.range_name, n.a2p_rate, n.currency, n.assigned_at);
      }
    });
  });
  tx(nums);
}

function getUniqueRanges() {
  return db.prepare('SELECT DISTINCT range_name FROM numbers_cache WHERE range_name IS NOT NULL').all().map(r => r.range_name);
}

function getNumberByRange(range_name) {
  return db.prepare('SELECT * FROM numbers_cache WHERE range_name = ? LIMIT 1').get(range_name);
}

function deleteNumber(num) {
  db.prepare('INSERT OR IGNORE INTO deleted_numbers (number) VALUES (?)').run(num);
  return db.prepare('DELETE FROM numbers_cache WHERE number = ?').run(num);
}

module.exports = {
  db, saveMessage, getMessages, countMessages,
  saveNumbers, getUniqueRanges, getNumberByRange, deleteNumber,
};
