// The one record shape every agent adapter produces.
//
// Counting rules shared by all agents (same as the Claude report):
//   IN    uncached input only. Sources that fold cached tokens into their
//         input count (OpenAI style) have them subtracted by the adapter.
//   CW    cache writes, CR cache reads, OUT output.
//   THINK reasoning/thinking tokens. Shown separately, never added to the
//         total, because every source already counts them inside OUT.
//   COST  USD the agent itself recorded for this call, or null when unknown.
//
// Kept positional so the on-disk caches stay small.

export const R = {
  TS: 0,
  MODEL: 1,
  IN: 2,
  CW: 3,
  CR: 4,
  OUT: 5,
  THINK: 6,
  COST: 7,
  SESSION: 8,
  REQ: 9,
  CWD: 10,
  CALLS: 11,
};

export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Build a record. `calls` is how many model calls the record stands for. */
export function rec({ ts, model, input = 0, cw = 0, cr = 0, out = 0, think = 0, cost = null,
  session = '', req = '', cwd = '', calls = 1 }) {
  return [
    ts,
    model || 'unknown',
    Math.max(0, num(input)),
    num(cw),
    num(cr),
    num(out),
    num(think),
    typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
    session || '',
    req || '',
    cwd || '',
    calls,
  ];
}
