// ZCode (Z.ai). ~/.zcode/cli/db/db.sqlite, table model_usage: one row per
// model call. input_tokens includes the cache reads (total = input + output).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rec, num } from '../record.mjs';
import { withDb, hasTable } from '../sqlite.mjs';

const DB = path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');

export default {
  id: 'zcode',
  label: 'ZCode',
  detect: () => fs.existsSync(DB),
  async load() {
    const records = await withDb(DB, (db) => {
      if (!hasTable(db, 'model_usage')) return [];
      const rows = db.prepare(`
        select u.id, u.session_id, u.model_id, u.started_at, u.input_tokens, u.output_tokens,
               u.reasoning_tokens, u.cache_creation_input_tokens cw, u.cache_read_input_tokens cr,
               s.directory
        from model_usage u left join session s on s.id = u.session_id
        where u.input_tokens > 0 or u.output_tokens > 0`).all();
      return rows.map((r) => rec({
        ts: num(r.started_at),
        model: r.model_id,
        input: num(r.input_tokens) - num(r.cr) - num(r.cw),
        cw: num(r.cw),
        cr: num(r.cr),
        out: num(r.output_tokens),
        think: num(r.reasoning_tokens),
        session: r.session_id,
        req: r.id,
        cwd: r.directory,
      }));
    });
    return { records, stats: { files: 1 } };
  },
};
