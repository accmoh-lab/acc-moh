'use strict';
// طبقة قاعدة البيانات: SQLite (node:sqlite) مع Migrations. SQL المستخدم ANSI قدر الإمكان لتسهيل الانتقال إلى PostgreSQL.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
let db;

function open(file = DB_PATH) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate();
  return db;
}

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const dir = path.join(__dirname, '..', 'migrations');
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map(r => r.name));
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    db.exec('BEGIN');
    try {
      db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
      db.prepare('INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}

const norm = p => p.map(v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
const all = (sql, ...p) => db.prepare(sql).all(...norm(p)).map(r => ({ ...r }));
const get = (sql, ...p) => { const r = db.prepare(sql).get(...norm(p)); return r ? { ...r } : undefined; };
const run = (sql, ...p) => db.prepare(sql).run(...norm(p));
const insert = (table, obj) => {
  const keys = Object.keys(obj);
  const r = run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(k => obj[k]));
  return Number(r.lastInsertRowid);
};
const update = (table, id, obj, idCol = 'id') => {
  const keys = Object.keys(obj);
  if (!keys.length) return;
  run(`UPDATE ${table} SET ${keys.map(k => k + ' = ?').join(',')} WHERE ${idCol} = ?`, ...keys.map(k => obj[k]), id);
};
let depth = 0;
function tx(fn) {
  if (depth > 0) return fn();
  db.exec('BEGIN'); depth++;
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { depth--; }
}
const ph = arr => arr.map(() => '?').join(',') || 'NULL';

module.exports = { open, all, get, run, insert, update, tx, ph, raw: () => db, DB_PATH };
