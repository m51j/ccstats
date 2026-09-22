// Streams Claude Code transcripts and extracts one normalized record per
// assistant message that carries a usage object.
//
// Counting rules (see README):
//   - only  type === "assistant"  AND  message.usage is an object  AND
//     message.model is a string. This excludes <synthetic> rows and the
//     type:"user" records whose embedded toolUseResult merely contains the
//     substring "usage".
//   - top-level usage fields only, never usage.iterations[] (those are
//     components of the same total).

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import os from 'node:os';
import { normalizeModel } from './pricing.js';

// Tuple layout. Kept positional so the on-disk cache stays small.
export const F = {
  TS: 0,
  MODEL: 1,
  IN: 2,
  CW5M: 3,
  CW1H: 4,
  CR: 5,
  OUT: 6,
  THINK: 7,
  SESSION: 8,
  REQ: 9,
  CWD: 10,
  BRANCH: 11,
  SPEED: 12,
  TIER: 13,
  SIDECHAIN: 14,
  EFFORT: 15,
};

export function defaultRoots() {
  const home = os.homedir();
  return [path.join(home, '.claude', 'projects')].filter((p) => fs.existsSync(p));
}

/** Recursively collect *.jsonl files under the given roots. */
export function listTranscripts(roots) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  for (const r of roots) walk(r);
  return out.sort();
}

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Parse one transcript file into an array of record tuples. */
export async function scanFile(file) {
  const records = [];
  let stream;
  try {
    stream = fs.createReadStream(file, { encoding: 'utf8' });
  } catch {
    return records;
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      // Cheap pre-filter before the expensive JSON.parse.
      if (line.length < 80) continue;
      if (!line.includes('"usage"')) continue;
      if (!line.includes('"type":"assistant"')) continue;

      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (d.type !== 'assistant') continue;

      const msg = d.message;
      if (!msg || typeof msg !== 'object') continue;
      const u = msg.usage;
      if (!u || typeof u !== 'object' || Array.isArray(u)) continue;
      if (typeof msg.model !== 'string' || !msg.model) continue;
      // Locally generated placeholders (API errors, interrupts) are recorded as
      // model "<synthetic>" with an all-zero usage object. Never a billed call.
      if (msg.model.startsWith('<')) continue;

      const ts = Date.parse(d.timestamp);
      if (!Number.isFinite(ts)) continue;

      const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : {};
      let cw5m = n(cc.ephemeral_5m_input_tokens);
      let cw1h = n(cc.ephemeral_1h_input_tokens);
      const cwTotal = n(u.cache_creation_input_tokens);
      // If the TTL breakdown is missing or disagrees, trust the total and
      // attribute the remainder to the 5-minute TTL (the API default).
      if (cw5m + cw1h !== cwTotal) {
        if (cw5m + cw1h === 0) cw5m = cwTotal;
        else cw5m = Math.max(0, cwTotal - cw1h);
      }

      const details = u.output_tokens_details;

      records.push([
        ts,
        normalizeModel(msg.model),
        n(u.input_tokens),
        cw5m,
        cw1h,
        n(u.cache_read_input_tokens),
        n(u.output_tokens),
        details && typeof details === 'object' ? n(details.thinking_tokens) : 0,
        d.sessionId || '',
        d.requestId || msg.id || '',
        d.cwd || '',
        d.gitBranch || '',
        u.speed || 'standard',
        u.service_tier || '',
        d.isSidechain ? 1 : 0,
        d.effort || '',
      ]);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return records;
}
