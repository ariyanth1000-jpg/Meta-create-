const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Render-এ absolute path ব্যবহার করা বাধ্যতামূলক
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'ivas.db');
const dirPath = path.dirname(dbPath);

if (!fs.existsSync(dirPath)) {
  fs.mkdirSync(dirPath, { recursive: true });
  console.log(`📁 Created DB directory: ${dirPath}`);
}

console.log(`💾 DB path: ${dbPath}`);

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
  CREATE INDEX IF NOT EXISTS idx_messages_number ON messages(number);
  CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_otp ON messages(otp);

  CREATE TABLE IF NOT EXISTS numbers_cache (
    number TEXT PRIMARY KEY,
    range_name TEXT,
    a2p_rate REAL,
    currency TEXT,
    assigned_at TEXT,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
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

function getMessages({ number, q, from, to, limit = 100, offset = 0 } = {}) {
  let sql = 'SELECT * FROM messages WHERE 1=1';
  const params = [];
  if (number) { sql += ' AND number = ?'; params.push(number); }
  if (q) { sql += ' AND (message LIKE ? OR source LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  if (from) { sql += ' AND received_at >= ?'; params.push(from); }
  if (to) { sql += ' AND received_at <= ?'; params.push(to); }
  sql += ' ORDER BY received_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

function countMessages(filters = {}) {
  let sql = 'SELECT COUNT(*) c FROM messages WHERE 1=1';
  const params = [];
  if (filters.number) { sql += ' AND number = ?'; params.push(filters.number); }
  if (filters.q) { sql += ' AND message LIKE ?'; params.push(`%${filters.q}%`); }
  return db.prepare(sql).get(...params).c;
}

function getLatestOTP(number) {
  if (number) {
    return db.prepare(`SELECT * FROM messages WHERE number = ? AND otp IS NOT NULL ORDER BY received_at DESC LIMIT 1`).get(number);
  }
  return db.prepare(`SELECT * FROM messages WHERE otp IS NOT NULL ORDER BY received_at DESC LIMIT 1`).get();
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
  const tx = db.transaction(list => list.forEach(n =>
    stmt.run(n.number, n.range_name, n.a2p_rate, n.currency, n.assigned_at)
  ));
  tx(nums);
}

function getCachedNumbers() {
  return db.prepare('SELECT * FROM numbers_cache ORDER BY range_name, number').all();
}

function getDailyStats(days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return db.prepare(`
    SELECT substr(received_at,1,10) AS day,
           COUNT(*) AS messages,
           SUM(CASE WHEN type='a2p' THEN 1 ELSE 0 END) AS a2p,
           SUM(CASE WHEN type='p2p' THEN 1 ELSE 0 END) AS p2p,
           SUM(rate) AS earnings
    FROM messages
    WHERE received_at >= ?
    GROUP BY day ORDER BY day ASC
  `).all(since);
}

function getOtpStats() {
  const total = db.prepare('SELECT COUNT(*) c FROM messages').get().c;
  const withOtp = db.prepare('SELECT COUNT(*) c FROM messages WHERE otp IS NOT NULL').get().c;
  const last24 = db.prepare(`SELECT COUNT(*) c FROM messages WHERE created_at > strftime('%s','now') - 86400`).get().c;
  return { total, withOtp, last24 };
}

module.exports = {
  db, saveMessage, getMessages, countMessages, getLatestOTP,
  saveNumbers, getCachedNumbers, getDailyStats, getOtpStats,
};
