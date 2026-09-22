// opencode and Kilo Code share one SQLite schema. Every assistant row of the
// message table carries its call's usage in the JSON `data` column:
//   tokens.input excludes cache reads; tokens.output excludes reasoning
//   (total = input + output + reasoning + cache), so OUT = output + reasoning.
//   `cost` is what the provider billed. Free models ("...:free", "-free") and
//   the opencode Zen free tier record 0, which is a real, known cost.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rec, num } from '../record.mjs';
import { withDb, hasTable } from '../sqlite.mjs';

const isFree = (model) => /(:free|-free)$/i.test(model);

function make({ id, label, db }) {
  return {
    id,
    label,
    detect: () => fs.existsSync(db),
    async load() {
      const records = await withDb(db, (d) => {
        if (!hasTable(d, 'message')) return [];
        const rows = d.prepare(`
          select m.id, m.session_id, m.time_created, m.data, s.directory
          from message m left join session s on s.id = m.session_id
          where json_extract(m.data, '$.role') = 'assistant'`).all();
        const out = [];
        for (const r of rows) {
          let x;
          try {
            x = JSON.parse(r.data);
          } catch {
            continue;
          }
          const t = x.tokens || {};
          const c = t.cache || {};
          const reasoning = num(t.reasoning);
          if (!num(t.input) && !num(t.output) && !reasoning && !num(c.read) && !num(c.write) && !(num(x.cost) > 0)) continue;
          const model = x.modelID || 'unknown';
          const cost = num(x.cost) > 0 || isFree(model) ? num(x.cost) : null;
          out.push(rec({
            ts: num(x.time?.created) || num(r.time_created),
            model,
            input: num(t.input),
            cw: num(c.write),
            cr: num(c.read),
            out: num(t.output) + reasoning,
            think: reasoning,
            cost,
            session: r.session_id,
            req: r.id,
            cwd: x.path?.cwd || r.directory,
          }));
        }
        return out;
      });
      return { records, stats: { files: 1 } };
    },
  };
}

const SHARE = path.join(os.homedir(), '.local', 'share');

export const opencode = make({ id: 'opencode', label: 'opencode', db: path.join(SHARE, 'opencode', 'opencode.db') });
export const kilo = make({ id: 'kilo', label: 'Kilo Code', db: path.join(SHARE, 'kilo', 'kilo.db') });
