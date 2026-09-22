// Turns raw usage records into the payload the HTML report consumes.
//
// The primary fact table is `hours`: day -> hour -> model -> token vector.
// Everything the report shows (ranges, day/hour/weekday rollups, model splits,
// cost) is derived from it in the browser, so the filters stay instant and the
// numbers can never drift between views.

import { F } from './scan.mjs';
import { ratesFor, displayModel, isKnownModel } from './pricing.js';

const V = { IN: 0, CW5M: 1, CW1H: 2, CR: 3, OUT: 4, REQ: 5, THINK: 6 };
const vec = () => [0, 0, 0, 0, 0, 0, 0];

function addInto(target, r) {
  target[V.IN] += r[F.IN];
  target[V.CW5M] += r[F.CW5M];
  target[V.CW1H] += r[F.CW1H];
  target[V.CR] += r[F.CR];
  target[V.OUT] += r[F.OUT];
  target[V.REQ] += 1;
  target[V.THINK] += r[F.THINK];
}

function parts(ts, tz) {
  const d = new Date(ts);
  if (tz === 'utc') {
    return {
      day: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
        d.getUTCDate()
      ).padStart(2, '0')}`,
      hour: d.getUTCHours(),
    };
  }
  return {
    day: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')}`,
    hour: d.getHours(),
  };
}

function sameTokens(a, b) {
  return (
    a[F.IN] === b[F.IN] &&
    a[F.CW5M] === b[F.CW5M] &&
    a[F.CW1H] === b[F.CW1H] &&
    a[F.CR] === b[F.CR] &&
    a[F.OUT] === b[F.OUT]
  );
}

/**
 * @param {any[][]} records raw tuples from the scanner
 * @param {{tz?: 'local'|'utc', dedupe?: boolean, since?: number, until?: number}} opts
 */
export function aggregate(records, opts = {}) {
  const tz = opts.tz === 'utc' ? 'utc' : 'local';
  const dedupe = opts.dedupe !== false;
  const since = opts.since ?? -Infinity;
  const until = opts.until ?? Infinity;

  // One API response is written to the transcript once per content block, and
  // streaming writes an early snapshot whose output_tokens is still growing.
  // Both share a requestId, so the winner per requestId is the copy with the
  // largest output_tokens - the final, billable usage.
  const seen = new Map(); // requestId -> tuple kept
  const kept = [];
  const appBasis = new Map(); // model -> vec  (no dedup: reproduces the app's card)
  let duplicates = 0;
  let partials = 0;

  for (const r of records) {
    if (r[F.TS] < since || r[F.TS] > until) continue;

    let bucket = appBasis.get(r[F.MODEL]);
    if (!bucket) appBasis.set(r[F.MODEL], (bucket = vec()));
    addInto(bucket, r);

    const key = r[F.REQ];
    if (dedupe && key) {
      const prev = seen.get(key);
      if (prev) {
        duplicates++;
        if (!sameTokens(prev, r)) partials++;
        // Keep the copy that saw the most output; a streaming snapshot is
        // always a prefix of the final one.
        if (r[F.OUT] > prev[F.OUT]) seen.set(key, r);
        continue;
      }
      seen.set(key, r);
      kept.push(r);
    } else {
      kept.push(r);
    }
  }

  // `kept` holds placeholders in arrival order; swap in each request's winner.
  for (let i = 0; i < kept.length; i++) {
    const key = kept[i][F.REQ];
    if (dedupe && key) kept[i] = seen.get(key);
  }

  // day -> hour -> model -> vec
  const hours = {};
  const sessions = new Map();
  const modelSet = new Set();
  let firstTs = Infinity;
  let lastTs = -Infinity;

  for (const r of kept) {
    const { day, hour } = parts(r[F.TS], tz);
    modelSet.add(r[F.MODEL]);
    if (r[F.TS] < firstTs) firstTs = r[F.TS];
    if (r[F.TS] > lastTs) lastTs = r[F.TS];

    const byHour = (hours[day] ||= {});
    const byModel = (byHour[hour] ||= {});
    addInto((byModel[r[F.MODEL]] ||= vec()), r);

    const sid = r[F.SESSION] || 'unknown';
    let s = sessions.get(sid);
    if (!s) {
      s = {
        id: sid,
        start: r[F.TS],
        end: r[F.TS],
        cwd: r[F.CWD],
        branch: r[F.BRANCH],
        models: new Map(),
        v: vec(),
      };
      sessions.set(sid, s);
    }
    if (r[F.TS] < s.start) s.start = r[F.TS];
    if (r[F.TS] > s.end) {
      s.end = r[F.TS];
      if (r[F.CWD]) s.cwd = r[F.CWD];
      if (r[F.BRANCH]) s.branch = r[F.BRANCH];
    }
    addInto(s.v, r);
    s.models.set(r[F.MODEL], (s.models.get(r[F.MODEL]) || 0) + r[F.OUT] + r[F.CR]);
  }

  const models = [...modelSet].sort();
  const rates = {};
  const unknownModels = [];
  for (const m of models) {
    rates[m] = ratesFor(m);
    rates[m].label = displayModel(m);
    if (!isKnownModel(m)) unknownModels.push(m);
  }

  const sessionRows = [...sessions.values()]
    .map((s) => {
      let top = '';
      let best = -1;
      for (const [m, w] of s.models) if (w > best) ((best = w), (top = m));
      return [
        s.id,
        s.start,
        s.end,
        s.v[V.REQ],
        s.v[V.IN],
        s.v[V.CW5M],
        s.v[V.CW1H],
        s.v[V.CR],
        s.v[V.OUT],
        s.cwd,
        s.branch,
        top,
      ];
    })
    .sort((a, b) => a[1] - b[1]);

  return {
    meta: {
      generatedAt: Date.now(),
      tz,
      tzLabel:
        tz === 'utc'
          ? 'UTC'
          : `local (UTC${formatOffset(-new Date().getTimezoneOffset())})`,
      dedupe,
      rawRecords: records.length,
      countedRecords: kept.length,
      duplicateRecords: duplicates,
      partialRecords: partials,
      inflation: kept.length ? records.length / kept.length : 0,
      firstTs: Number.isFinite(firstTs) ? firstTs : null,
      lastTs: Number.isFinite(lastTs) ? lastTs : null,
      sessions: sessionRows.length,
      unknownModels,
    },
    rates,
    models,
    hours,
    sessions: sessionRows,
    appBasis: Object.fromEntries(appBasis),
  };
}

function formatOffset(mins) {
  const sign = mins < 0 ? '-' : '+';
  const a = Math.abs(mins);
  const h = String(Math.floor(a / 60)).padStart(2, '0');
  const m = String(a % 60).padStart(2, '0');
  return `${sign}${h}:${m}`;
}

export { V };
