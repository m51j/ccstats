// Price table in USD per million tokens (MTok).
//
// Cache pricing follows the documented multipliers:
//   cache read      = 0.1x the input rate  (exception: claude-fable-5-1 is a flat $0.25/MTok)
//   cache write 5m  = 1.25x the input rate
//   cache write 1h  = 2x    the input rate
//
// These are first-party Anthropic API list rates. If you are on a subscription
// plan the dollar figures are an equivalent-cost estimate, not a bill.

export const WRITE_5M_MULTIPLIER = 1.25;
export const WRITE_1H_MULTIPLIER = 2.0;
export const CACHE_READ_MULTIPLIER = 0.1;

// input / output $ per MTok, plus an optional explicit cacheRead override.
const RATES = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-haiku-3-5': { input: 0.8, output: 4 },
};

// Fast mode on Opus 5 / 4.8 is billed at premium rates.
const FAST_RATES = {
  'claude-opus-5': { input: 10, output: 50 },
  'claude-opus-4-8': { input: 10, output: 50 },
};

const FALLBACK = { input: 5, output: 25 };

/** Strip a trailing date snapshot: claude-haiku-4-5-20251001 -> claude-haiku-4-5 */
export function normalizeModel(model) {
  if (typeof model !== 'string') return 'unknown';
  return model.replace(/-\d{8}$/, '').replace(/^anthropic\./, '').replace(/@\d{8}$/, '');
}

/** Short display name: claude-opus-4-8 -> Opus 4.8 */
export function displayModel(model) {
  const id = normalizeModel(model);
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?$/.exec(id);
  if (!m) return id;
  const family = m[1][0].toUpperCase() + m[1].slice(1);
  return m[3] ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`;
}

export function ratesFor(model, fast = false) {
  const id = normalizeModel(model);
  const table = fast && FAST_RATES[id] ? FAST_RATES[id] : RATES[id];
  const base = table || FALLBACK;
  return {
    input: base.input,
    output: base.output,
    cacheRead: base.cacheRead ?? base.input * CACHE_READ_MULTIPLIER,
    write5m: base.input * WRITE_5M_MULTIPLIER,
    write1h: base.input * WRITE_1H_MULTIPLIER,
    known: Boolean(table),
  };
}

export function isKnownModel(model) {
  return Boolean(RATES[normalizeModel(model)]);
}

/**
 * Cost in USD for one bucket of tokens.
 * @param {{in:number,cw5m:number,cw1h:number,cr:number,out:number}} t
 */
export function costOf(t, model, fast = false) {
  const r = ratesFor(model, fast);
  return (
    (t.in * r.input +
      t.cw5m * r.write5m +
      t.cw1h * r.write1h +
      t.cr * r.cacheRead +
      t.out * r.output) /
    1e6
  );
}
