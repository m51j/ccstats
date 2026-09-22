// GitHub Copilot Chat (VS Code). Each chat is a patch log at
// %APPDATA%/Code/User/workspaceStorage/<ws>/chatSessions/<id>.jsonl:
//   kind 0  initial state {requests:[...], ...}
//   kind 1  set the value at path k
//   kind 2  append v (an array) to the array at path k
// Replaying it gives requests[] with timestamp, modelId and, once finished,
// result.metadata.{promptTokens, outputTokens, toolCallRounds}.
//
// LOWER BOUND: Copilot keeps the prompt size of the last tool-call round only,
// not the sum over every round of an agent turn, so input is undercounted.
// completionTokens accumulates over the rounds and is used for output.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rec, num } from '../record.mjs';
import { cachedFiles } from '../filecache.mjs';

const WS = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Code', 'User', 'workspaceStorage'
);

function setPath(root, k, v) {
  let o = root;
  for (let i = 0; i < k.length - 1; i++) {
    if (o[k[i]] == null || typeof o[k[i]] !== 'object') o[k[i]] = typeof k[i + 1] === 'number' ? [] : {};
    o = o[k[i]];
  }
  o[k[k.length - 1]] = v;
}

function getPath(root, k) {
  let o = root;
  for (const p of k) {
    if (o == null) return undefined;
    o = o[p];
  }
  return o;
}

function workspaceFolder(wsDir) {
  try {
    const w = JSON.parse(fs.readFileSync(path.join(wsDir, 'workspace.json'), 'utf8'));
    const uri = w.folder || w.workspace || '';
    if (!uri.startsWith('file:///')) return uri;
    return decodeURIComponent(uri.slice(8)).replace(/\//g, '\\');
  } catch {
    return '';
  }
}

function parse(file) {
  let state = {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  // Completion counts arrive as a stream of set-patches; keep the largest.
  const completion = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.kind === 0) state = d.v || {};
    else if (d.kind === 1 && Array.isArray(d.k)) {
      if (d.k.length === 3 && d.k[0] === 'requests' && d.k[2] === 'completionTokens') {
        completion.set(d.k[1], Math.max(completion.get(d.k[1]) || 0, num(d.v)));
      }
      // Response bodies are large and never needed.
      if (d.k[d.k.length - 1] === 'response') continue;
      setPath(state, d.k, d.v);
    } else if (d.kind === 2 && Array.isArray(d.k)) {
      let arr = getPath(state, d.k);
      if (!Array.isArray(arr)) setPath(state, d.k, (arr = []));
      const items = Array.isArray(d.v) ? d.v : [d.v];
      if (typeof d.i === 'number') arr.splice(d.i, arr.length - d.i, ...items);
      else arr.push(...items);
    }
  }

  const cwd = workspaceFolder(path.dirname(path.dirname(file)));
  const session = state.sessionId || path.basename(file, '.jsonl');
  const out = [];
  (state.requests || []).forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    const md = r.result?.metadata || {};
    const input = num(md.promptTokens) || num(r.promptTokens);
    const output = Math.max(completion.get(i) || 0, num(r.completionTokens), num(md.outputTokens));
    if (!input && !output) return;
    const rounds = Array.isArray(md.toolCallRounds) ? md.toolCallRounds.length : 0;
    const model = String(r.modelId || md.resolvedModel || state.inputState?.selectedModel?.identifier || 'unknown')
      .replace(/^copilot\//, '');
    out.push(rec({
      ts: num(r.timestamp) || num(state.creationDate),
      model,
      input,
      out: output,
      session,
      req: r.requestId || `${session}:${i}`,
      cwd,
      calls: Math.max(1, rounds),
    }));
  });
  return out;
}

export default {
  id: 'copilot',
  label: 'Copilot Chat',
  note: 'Copilot saves only the last tool-call round’s prompt size for each request, so input tokens here are a lower bound. Model calls count every tool-call round.',
  detect: () => fs.existsSync(WS),
  async load({ rescan }) {
    const files = [];
    let dirs = [];
    try {
      dirs = fs.readdirSync(WS);
    } catch {
      /* none */
    }
    for (const d of dirs) {
      const cs = path.join(WS, d, 'chatSessions');
      let names = [];
      try {
        names = fs.readdirSync(cs);
      } catch {
        continue;
      }
      for (const n of names) if (n.endsWith('.jsonl')) files.push(path.join(cs, n));
    }
    return cachedFiles('copilot', files.sort(), parse, { rescan, version: 1 });
  },
};
