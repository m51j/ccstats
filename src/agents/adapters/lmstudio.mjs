// LM Studio. ~/.lmstudio/conversations/*.conversation.json; every generation
// step of an assistant message carries genInfo.stats with the prompt and
// predicted token counts. Models run locally, so the cost is a known $0.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rec, num } from '../record.mjs';
import { cachedFiles } from '../filecache.mjs';

const ROOT = path.join(os.homedir(), '.lmstudio', 'conversations');

function parse(file) {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const session = path.basename(file, '.conversation.json');
  const fallback = num(j.assistantLastMessagedAt) || num(j.userLastMessagedAt) || num(j.createdAt);
  const out = [];
  for (const m of j.messages || []) {
    // Only the branch the user kept counts; regenerated versions were discarded.
    const v = m.versions?.[m.currentlySelected ?? 0] ?? m.versions?.[0];
    if (!v || v.role !== 'assistant') continue;
    for (const s of v.steps || []) {
      const st = s.genInfo?.stats;
      if (!st) continue;
      const ts = Number(String(s.stepIdentifier || '').split('-')[0]) || fallback;
      out.push(rec({
        ts,
        model: s.genInfo.identifier || s.genInfo.indexedModelIdentifier || j.lastUsedModel?.identifier,
        input: num(st.promptTokensCount),
        out: num(st.predictedTokensCount),
        cost: 0,
        session,
        req: `lmstudio:${s.stepIdentifier || ts}`,
      }));
    }
  }
  return out;
}

export default {
  id: 'lmstudio',
  label: 'LM Studio',
  detect: () => fs.existsSync(ROOT),
  async load({ rescan }) {
    let names = [];
    try {
      names = fs.readdirSync(ROOT);
    } catch {
      /* none */
    }
    const files = names.filter((n) => n.endsWith('.conversation.json')).map((n) => path.join(ROOT, n)).sort();
    return cachedFiles('lmstudio', files, parse, { rescan, version: 1 });
  },
};
