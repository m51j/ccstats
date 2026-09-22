// Cline. ~/.cline/data/sessions/<id>/<id>.json holds the session header
// (cwd, model); <id>.messages.json holds every message, and each assistant
// message that came from an API call has per-call `metrics`.
// inputTokens includes the cache reads/writes (OpenAI style).
//
// The per-message metrics are used rather than the header's metadata.usage:
// the header total covers only the last run of a resumed session.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rec, num } from '../record.mjs';
import { cachedFiles } from '../filecache.mjs';

const ROOT = path.join(os.homedir(), '.cline', 'data', 'sessions');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function parse(file) {
  const dir = path.dirname(file);
  const id = path.basename(dir);
  const head = readJson(path.join(dir, `${id}.json`)) || {};
  const body = readJson(file);
  if (!body || !Array.isArray(body.messages)) return [];
  const out = [];
  for (const m of body.messages) {
    const x = m.metrics;
    if (!x || m.role !== 'assistant') continue;
    const cr = num(x.cacheReadTokens);
    const cw = num(x.cacheWriteTokens);
    if (!num(x.inputTokens) && !num(x.outputTokens)) continue;
    out.push(rec({
      ts: num(m.ts) || Date.parse(head.started_at) || 0,
      model: m.modelInfo?.id || head.model,
      input: num(x.inputTokens) - cr - cw,
      cw,
      cr,
      out: num(x.outputTokens),
      cost: typeof x.cost === 'number' ? x.cost : null,
      session: head.session_id || id,
      req: `cline:${m.id || m.ts}`,
      cwd: head.cwd || head.workspace_root,
    }));
  }
  return out;
}

export default {
  id: 'cline',
  label: 'Cline',
  detect: () => fs.existsSync(ROOT),
  async load({ rescan }) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(ROOT);
    } catch {
      /* none */
    }
    const files = dirs
      .map((d) => path.join(ROOT, d, `${d}.messages.json`))
      .filter((f) => fs.existsSync(f));
    return cachedFiles('cline', files, parse, { rescan, version: 1 });
  },
};
