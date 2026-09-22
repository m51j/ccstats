// Read-only access to the SQLite stores other agents keep, via the built-in
// node:sqlite (Node >= 22.13). The live database is opened read-only; if the
// owning app holds a lock, a private copy (with its -wal) is read instead.

import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from './filecache.mjs';

let DatabaseSync = null;

async function driver() {
  if (DatabaseSync) return DatabaseSync;
  // Silence the one-time ExperimentalWarning some Node versions print.
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => {
    if (String(w?.message ?? w).includes('SQLite')) return;
    emit.call(process, w, ...rest);
  };
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    throw new Error(`node:sqlite is unavailable in Node ${process.version} (needs >= 22.13)`);
  } finally {
    process.emitWarning = emit;
  }
  return DatabaseSync;
}

/** Run `fn(db)` against `file` opened read-only, and return its result. */
export async function withDb(file, fn) {
  const Db = await driver();
  let db;
  try {
    db = new Db(file, { readOnly: true });
    db.prepare('select count(*) from sqlite_master').get();
  } catch {
    db?.close();
    const dir = path.join(CACHE_DIR, 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    const copy = path.join(dir, path.basename(path.dirname(file)) + '-' + path.basename(file));
    fs.copyFileSync(file, copy);
    for (const ext of ['-wal', '-shm']) {
      if (fs.existsSync(file + ext)) fs.copyFileSync(file + ext, copy + ext);
      else fs.rmSync(copy + ext, { force: true });
    }
    db = new Db(copy, { readOnly: true });
  }
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function hasTable(db, name) {
  return Boolean(db.prepare("select 1 from sqlite_master where type='table' and name=?").get(name));
}
