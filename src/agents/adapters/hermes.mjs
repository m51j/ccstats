// Hermes Agent (Nous). %LOCALAPPDATA%/hermes/state.db keeps usage per session
// only, so each session becomes one record at its start time that stands for
// api_call_count model calls. input_tokens excludes the cache reads.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rec, num } from '../record.mjs';
import { withDb, hasTable } from '../sqlite.mjs';

const DB = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'hermes', 'state.db'
);

export default {
  id: 'hermes',
  label: 'Hermes',
  note: 'Hermes stores usage per session, not per call, so all of a session’s tokens land on the hour it started.',
  detect: () => fs.existsSync(DB),
  async load() {
    const records = await withDb(DB, (db) => {
      if (!hasTable(db, 'sessions')) return [];
      return db.prepare('select * from sessions').all()
        .filter((r) => num(r.input_tokens) || num(r.output_tokens))
        .map((r) => {
          // estimated_cost_usd is 0 for subscription (oauth) billing - unknown, not free.
          const cost = r.actual_cost_usd != null ? num(r.actual_cost_usd)
            : num(r.estimated_cost_usd) > 0 ? num(r.estimated_cost_usd) : null;
          return rec({
            ts: Math.round(num(r.started_at) * 1000),
            model: r.model,
            input: num(r.input_tokens),
            cw: num(r.cache_write_tokens),
            cr: num(r.cache_read_tokens),
            out: num(r.output_tokens),
            think: num(r.reasoning_tokens),
            cost,
            session: r.id,
            req: `hermes:${r.id}`,
            cwd: r.cwd,
            calls: Math.max(1, num(r.api_call_count)),
          });
        });
    });
    return { records, stats: { files: 1 } };
  },
};
