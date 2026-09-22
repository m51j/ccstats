// OpenAI Codex (CLI, VS Code extension, desktop app).
//
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (+ archived_sessions/). Each
// model call emits an event_msg of type token_count whose info.last_token_usage
// is that call's usage and info.total_token_usage the running session total.
//   - input_tokens includes cached_input_tokens (OpenAI style), so IN = input - cached.
//   - output_tokens includes reasoning_output_tokens.
//   - A token_count whose running total did not move is a re-emit, not a call.
//   - Forked/resumed threads copy earlier events into the new file with their
//     original timestamps; the request key (timestamp + running total) lets the
//     aggregator drop those copies.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { rec, num } from '../record.mjs';
import { cachedFiles, walk } from '../filecache.mjs';

const HOME = path.join(os.homedir(), '.codex');
const ROOTS = [path.join(HOME, 'sessions'), path.join(HOME, 'archived_sessions')];

async function parse(file) {
  const out = [];
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let session = '';
  let cwd = '';
  let model = '';
  let prevTotal = -1;
  try {
    for await (const line of rl) {
      const isTok = line.includes('"token_count"');
      if (!isTok && !line.includes('"turn_context"') && !line.includes('"session_meta"')) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const p = d.payload || {};
      if (d.type === 'session_meta') {
        if (!session) session = p.id || p.session_id || '';
        if (!cwd && p.cwd) cwd = p.cwd;
      } else if (d.type === 'turn_context') {
        if (p.model) model = p.model;
        if (p.cwd) cwd = p.cwd;
      } else if (d.type === 'event_msg' && p.type === 'token_count' && p.info) {
        const last = p.info.last_token_usage;
        const total = p.info.total_token_usage;
        if (!last || !total) continue;
        const t = num(total.total_tokens);
        if (t === prevTotal) continue;
        prevTotal = t;
        const ts = Date.parse(d.timestamp);
        if (!Number.isFinite(ts)) continue;
        const cached = num(last.cached_input_tokens);
        out.push(rec({
          ts,
          model: model || 'unknown',
          input: num(last.input_tokens) - cached,
          cw: num(last.cache_write_input_tokens),
          cr: cached,
          out: num(last.output_tokens),
          think: num(last.reasoning_output_tokens),
          session,
          req: `codex:${d.timestamp}:${t}`,
          cwd,
        }));
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return out;
}

export default {
  id: 'codex',
  label: 'Codex',
  detect: () => ROOTS.some((r) => fs.existsSync(r)),
  async load({ rescan }) {
    const files = ROOTS.flatMap((r) => walk(r, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))).sort();
    return cachedFiles('codex', files, parse, { rescan, version: 1 });
  },
};
