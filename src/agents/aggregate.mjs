// Turns agent records into the payload the agent pages consume. Same shape of
// thinking as ../aggregate.mjs: one fact table `hours` (day -> hour -> key ->
// vec) that the browser rolls up. The key is "agent::model", so one payload
// can be viewed by agent or by model.

import { R } from './record.mjs';
import { listRate } from './pricing.mjs';

export const V = { IN: 0, CW: 1, CR: 2, OUT: 3, REQ: 4, THINK: 5, COST: 6, COSTTOK: 7 };
const vec = () => [0, 0, 0, 0, 0, 0, 0, 0];
export const SEP = '::';

function parts(ts, tz) {
  const d = new Date(ts);
  const utc = tz === 'utc';
  const y = utc ? d.getUTCFullYear() : d.getFullYear();
  const m = (utc ? d.getUTCMonth() : d.getMonth()) + 1;
  const dd = utc ? d.getUTCDate() : d.getDate();
  return {
    day: `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`,
    hour: utc ? d.getUTCHours() : d.getHours(),
  };
}

/** Recorded cost, else list price, else null (unknown). */
function costOf(r) {
  if (r[R.COST] != null) return r[R.COST];
  const p = listRate(r[R.MODEL]);
  if (!p) return null;
  return (r[R.IN] * p.input + r[R.CW] * p.cacheWrite + r[R.CR] * p.cacheRead + r[R.OUT] * p.output) / 1e6;
}

function addInto(v, r, cost) {
  v[V.IN] += r[R.IN];
  v[V.CW] += r[R.CW];
  v[V.CR] += r[R.CR];
  v[V.OUT] += r[R.OUT];
  v[V.REQ] += r[R.CALLS];
  v[V.THINK] += r[R.THINK];
  if (cost != null) {
    v[V.COST] += cost;
    v[V.COSTTOK] += r[R.IN] + r[R.CW] + r[R.CR] + r[R.OUT];
  }
}

function formatOffset(mins) {
  const sign = mins < 0 ? '-' : '+';
  const a = Math.abs(mins);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/**
 * @param {{id:string,label:string,note?:string,records:any[][]}[]} sources
 * @param {{title:string, tz?:'local'|'utc', since?:number, until?:number}} opts
 */
export function aggregateAgents(sources, opts) {
  const tz = opts.tz === 'utc' ? 'utc' : 'local';
  const since = opts.since ?? -Infinity;
  const until = opts.until ?? Infinity;

  const hours = {};
  const sessions = new Map();
  const keys = new Set();
  const agents = {};
  let firstTs = Infinity;
  let lastTs = -Infinity;
  let counted = 0;
  let dropped = 0;

  for (const src of sources) {
    agents[src.id] = { label: src.label, note: src.note || '' };
    const seen = new Set();
    for (const r of src.records) {
      if (r[R.TS] < since || r[R.TS] > until) continue;
      const req = r[R.REQ];
      if (req) {
        if (seen.has(req)) {
          dropped++;
          continue;
        }
        seen.add(req);
      }
      counted++;
      const key = src.id + SEP + r[R.MODEL];
      keys.add(key);
      const cost = costOf(r);
      const { day, hour } = parts(r[R.TS], tz);
      if (r[R.TS] < firstTs) firstTs = r[R.TS];
      if (r[R.TS] > lastTs) lastTs = r[R.TS];
      addInto(((hours[day] ||= {})[hour] ||= {})[key] ||= vec(), r, cost);

      const sid = src.id + SEP + (r[R.SESSION] || 'unknown');
      let s = sessions.get(sid);
      if (!s) {
        s = { agent: src.id, id: r[R.SESSION], start: r[R.TS], end: r[R.TS], cwd: r[R.CWD], keys: new Map(), v: vec() };
        sessions.set(sid, s);
      }
      if (r[R.TS] < s.start) s.start = r[R.TS];
      if (r[R.TS] >= s.end) {
        s.end = r[R.TS];
        if (r[R.CWD]) s.cwd = r[R.CWD];
      }
      addInto(s.v, r, cost);
      s.keys.set(key, (s.keys.get(key) || 0) + r[R.OUT] + r[R.CR] + r[R.IN]);
    }
  }

  const sessionRows = [...sessions.values()]
    .map((s) => {
      let top = '';
      let best = -1;
      for (const [k, w] of s.keys) if (w > best) ((best = w), (top = k));
      return [s.agent, s.id, s.start, s.end, s.cwd || '', top, ...s.v];
    })
    .sort((a, b) => a[2] - b[2]);

  return {
    meta: {
      title: opts.title,
      generatedAt: Date.now(),
      tz,
      tzLabel: tz === 'utc' ? 'UTC' : `local (UTC${formatOffset(-new Date().getTimezoneOffset())})`,
      countedRecords: counted,
      droppedDuplicates: dropped,
      firstTs: Number.isFinite(firstTs) ? firstTs : null,
      lastTs: Number.isFinite(lastTs) ? lastTs : null,
      sessions: sessionRows.length,
    },
    agents,
    keys: [...keys].sort(),
    hours,
    sessions: sessionRows,
  };
}
