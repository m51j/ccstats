// Google Antigravity: the IDE, the standalone app and the `agy` CLI. Each keeps
// ~/.gemini/<variant>/conversations/<conversation id>.db, one SQLite file per
// conversation (sub-agents get their own file). Everything inside is protobuf
// with no published schema; the fields read here were matched by hand:
//
//   steps.metadata                      a step
//     1  {1 seconds, 2 nanos}           created at
//     9  usage (Codeium ModelUsageStats; output = thinking + response adds up)
//        1 model enum   2 input (excludes cache reads)   3 output
//        4 cache write  5 cache read   9 thinking   11 response id
//   gen_metadata.data  1 {4 usage, 19 model name}   -> enum -> name map
//   trajectory_metadata_blob.data  1 {1 workspace uri}
//
// Only steps that called a model carry usage. The response id is unique per
// call and serves as the request key.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rec } from '../record.mjs';
import { withDb, hasTable } from '../sqlite.mjs';

/** Decode one protobuf message into field -> values (Buffer for length-delimited). */
function pb(buf) {
  const m = {};
  let i = 0;
  const varint = () => {
    let r = 0;
    let s = 1;
    let b;
    do {
      b = buf[i++];
      r += (b & 0x7f) * s;
      s *= 128;
    } while (b & 0x80 && i < buf.length);
    return r;
  };
  while (i < buf.length) {
    const key = varint();
    const f = Math.floor(key / 8);
    const t = key % 8;
    let v;
    if (t === 0) v = varint();
    else if (t === 2) {
      const n = varint();
      v = buf.subarray(i, i + n);
      i += n;
    } else if (t === 1) i += 8;
    else if (t === 5) i += 4;
    else return m; // not a message; keep what was read
    if (v !== undefined) (m[f] ||= []).push(v);
  }
  return m;
}
const sub = (m, f) => (m[f]?.[0] instanceof Uint8Array ? pb(m[f][0]) : null);
const int = (m, f) => (typeof m?.[f]?.[0] === 'number' ? m[f][0] : 0);
const str = (m, f) => (m?.[f]?.[0] instanceof Uint8Array ? Buffer.from(m[f][0]).toString('utf8') : '');

function uriToPath(uri) {
  if (!uri.startsWith('file:///')) return uri;
  const p = decodeURIComponent(uri.slice(8));
  return /^[a-zA-Z]:/.test(p) ? p.replace(/\//g, '\\') : '/' + p;
}

function readConversation(db, file) {
  if (!hasTable(db, 'steps')) return { calls: [], names: {} };

  const names = {};
  if (hasTable(db, 'gen_metadata')) {
    for (const r of db.prepare('select data from gen_metadata').all()) {
      if (!r.data) continue;
      const one = sub(pb(Buffer.from(r.data)), 1);
      const usage = one && sub(one, 4);
      const name = one && str(one, 19);
      if (usage && name) names[int(usage, 1)] = name;
    }
  }

  let cwd = '';
  if (hasTable(db, 'trajectory_metadata_blob')) {
    const r = db.prepare('select data from trajectory_metadata_blob').get();
    const ws = r?.data && sub(pb(Buffer.from(r.data)), 1);
    if (ws) cwd = uriToPath(str(ws, 1));
  }

  const session = path.basename(file, '.db');
  const calls = [];
  for (const r of db.prepare('select idx, metadata from steps where metadata is not null').all()) {
    const m = pb(Buffer.from(r.metadata));
    const u = sub(m, 9);
    if (!u) continue;
    const at = sub(m, 1);
    const ts = int(at, 1) * 1000 + Math.floor(int(at, 2) / 1e6);
    if (!ts) continue;
    calls.push({
      ts,
      model: int(u, 1),
      input: int(u, 2),
      out: int(u, 3),
      cw: int(u, 4),
      cr: int(u, 5),
      think: int(u, 9),
      req: str(u, 11) || `${session}:${r.idx}`,
      session,
      cwd,
    });
  }
  return { calls, names };
}

function make({ id, label, dir }) {
  const root = path.join(os.homedir(), '.gemini', dir, 'conversations');
  return {
    id,
    label,
    note: 'Antigravity keeps no official usage log; these counts are decoded from its conversation databases (the per-call usage record each model step stores).',
    detect: () => fs.existsSync(root),
    async load() {
      let files = [];
      try {
        files = fs.readdirSync(root).filter((n) => n.endsWith('.db')).map((n) => path.join(root, n)).sort();
      } catch {
        /* none */
      }
      const convs = [];
      const global = {};
      for (const f of files) {
        try {
          const c = await withDb(f, (db) => readConversation(db, f));
          convs.push(c);
          for (const k in c.names) global[k] ||= c.names[k];
        } catch {
          /* unreadable conversation: skip it, keep the rest */
        }
      }
      // A model is named by its own conversation first: the same enum has
      // carried different names over time.
      const records = [];
      for (const c of convs) {
        for (const x of c.calls) {
          records.push(rec({
            ...x,
            model: c.names[x.model] || global[x.model] || `unnamed model #${x.model}`,
          }));
        }
      }
      return { records, stats: { files: files.length } };
    },
  };
}

export const antigravityIde = make({ id: 'antigravity-ide', label: 'Antigravity IDE', dir: 'antigravity-ide' });
export const antigravity = make({ id: 'antigravity', label: 'Antigravity', dir: 'antigravity' });
export const agy = make({ id: 'agy', label: 'agy', dir: 'antigravity-cli' });
