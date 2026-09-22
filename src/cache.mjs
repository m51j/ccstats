// Incremental scan cache: transcripts are append-only, so a file whose size
// and mtime are unchanged is re-used verbatim from disk instead of re-parsed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTranscripts, scanFile } from './scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'index.json');
const CACHE_VERSION = 2;

function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === CACHE_VERSION && parsed.files) return parsed;
  } catch {
    /* fall through to an empty cache */
  }
  return { version: CACHE_VERSION, files: {} };
}

function writeCache(cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, CACHE_FILE);
}

/**
 * Load every usage record under `roots`, re-parsing only changed files.
 * @returns {Promise<{records: any[][], stats: object}>}
 */
export async function loadRecords({ roots, rescan = false, onProgress = null } = {}) {
  const files = listTranscripts(roots);
  const cache = rescan ? { version: CACHE_VERSION, files: {} } : readCache();
  const next = { version: CACHE_VERSION, files: {} };

  let parsed = 0;
  let reused = 0;
  let bytes = 0;
  const records = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    bytes += st.size;

    const hit = cache.files[file];
    let rows;
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
      rows = hit.records;
      reused++;
    } else {
      rows = await scanFile(file);
      parsed++;
    }
    next.files[file] = { size: st.size, mtimeMs: st.mtimeMs, records: rows };
    for (const r of rows) records.push(r);

    if (onProgress && (i % 25 === 0 || i === files.length - 1)) {
      onProgress({ done: i + 1, total: files.length, parsed, reused });
    }
  }

  writeCache(next);
  return {
    records,
    stats: { files: files.length, parsed, reused, bytes, cacheFile: CACHE_FILE },
  };
}

export { CACHE_FILE };
