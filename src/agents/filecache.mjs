// Incremental per-agent cache, same idea as ../cache.mjs: a source file whose
// size and mtime are unchanged is re-used from disk instead of re-parsed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CACHE_DIR = path.join(ROOT, '.cache');
const CACHE_VERSION = 1;

/**
 * @param {string} id        agent id, used for the cache file name
 * @param {string[]} files   source files to load
 * @param {(file: string) => Promise<any[][]>|any[][]} parse
 * @param {{rescan?: boolean, version?: number}} opts  bump `version` when the
 *        adapter's parsing changes so stale caches are dropped
 */
export async function cachedFiles(id, files, parse, { rescan = false, version = 1 } = {}) {
  const file = path.join(CACHE_DIR, `agent-${id}.json`);
  const v = `${CACHE_VERSION}.${version}`;
  let cache = { version: v, files: {} };
  if (!rescan) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.version === v && parsed.files) cache = parsed;
    } catch {
      /* start empty */
    }
  }

  const next = { version: v, files: {} };
  const records = [];
  let parsed = 0;
  let reused = 0;
  for (const f of files) {
    let st;
    try {
      st = fs.statSync(f);
    } catch {
      continue;
    }
    const hit = cache.files[f];
    let rows;
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
      rows = hit.records;
      reused++;
    } else {
      rows = await parse(f);
      parsed++;
    }
    next.files[f] = { size: st.size, mtimeMs: st.mtimeMs, records: rows };
    for (const r of rows) records.push(r);
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(next));
  fs.renameSync(`${file}.tmp`, file);
  return { records, stats: { files: files.length, parsed, reused } };
}

/** Recursively collect files under `dir` whose name passes `test`. */
export function walk(dir, test, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, test, out);
    else if (e.isFile() && test(e.name)) out.push(full);
  }
  return out;
}
