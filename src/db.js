import './env.js';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.SPOOLRSS_DATA || path.resolve('data');
fs.mkdirSync(dataDir, { recursive: true });

// Databases from before the rename (Feedster) are taken over under the new name, along with
// SQLite's -wal and -shm files, which hold changes not yet written to the main file.
const dbFile = path.join(dataDir, 'spoolrss.db');
const oldFile = path.join(dataDir, 'feedster.db');
if (!fs.existsSync(dbFile) && fs.existsSync(oldFile)) {
  for (const suffix of ['-wal', '-shm', '']) {
    if (fs.existsSync(oldFile + suffix)) fs.renameSync(oldFile + suffix, dbFile + suffix);
  }
  console.log(`Renamed ${oldFile} to ${dbFile}`);
}

export const db = new DatabaseSync(dbFile);

// Wait for another connection's lock instead of failing with "database is locked".
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    position INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS feeds (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    site_url TEXT,
    folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    etag TEXT,
    last_modified TEXT,
    last_fetched INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY,
    feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    guid TEXT NOT NULL,
    url TEXT,
    title TEXT,
    author TEXT,
    content TEXT,
    image TEXT,
    published INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    starred INTEGER NOT NULL DEFAULT 0,
    UNIQUE (feed_id, guid)
  );

  CREATE INDEX IF NOT EXISTS articles_feed_pub ON articles (feed_id, published DESC);
  CREATE INDEX IF NOT EXISTS articles_pub ON articles (published DESC, id DESC);
  CREATE INDEX IF NOT EXISTS articles_unread ON articles (read, feed_id);
  CREATE INDEX IF NOT EXISTS articles_starred ON articles (starred) WHERE starred = 1;

  -- data is NULL when no icon was found (the UI then shows a letter)
  CREATE TABLE IF NOT EXISTS icons (
    feed_id INTEGER PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE,
    data BLOB,
    type TEXT,
    source TEXT,
    checked_at INTEGER NOT NULL
  );

  -- Full article text fetched from the article's page; error is set when extraction failed
  CREATE TABLE IF NOT EXISTS fulltext (
    article_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
    content TEXT,
    error TEXT,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Columns added after the first release; databases created earlier get them here.
function addColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
// Failed refreshes in a row, and when to try the feed again (see refreshFeed).
addColumn('feeds', 'fail_count', 'INTEGER NOT NULL DEFAULT 0');
addColumn('feeds', 'next_fetch_at', 'INTEGER');
// 1 keeps the feed's articles out of "All articles" and its unread count (still shown in the
// feed itself, its folder and reading apps).
addColumn('feeds', 'hide_in_all', 'INTEGER NOT NULL DEFAULT 0');
// 1 while the article is still listed in its feed (as of the last full fetch). Those are never
// pruned: deleting one would bring it back as a new, unread article on the next refresh. Existing
// articles start as listed, until their feed next sends its full contents.
addColumn('articles', 'in_feed', 'INTEGER NOT NULL DEFAULT 1');

export function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
