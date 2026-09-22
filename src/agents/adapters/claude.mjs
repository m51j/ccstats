// Claude Code, for the combined page only. Its own page is still rendered by
// ../../render.mjs from ../../aggregate.mjs, untouched.
//
// Converts the scanner's tuples into the shared record shape, keeping the same
// counting rule (one row per requestId, the copy with the most output) and the
// same list-price cost as the Claude report.

import { F } from '../../scan.mjs';
import { costOf } from '../../pricing.js';
import { rec } from '../record.mjs';

export function fromClaudeTuples(tuples) {
  const byReq = new Map();
  const out = [];
  for (const t of tuples) {
    const key = t[F.REQ];
    if (!key) {
      out.push(t);
      continue;
    }
    const prev = byReq.get(key);
    if (!prev || t[F.OUT] > prev[F.OUT]) byReq.set(key, t);
  }
  for (const t of byReq.values()) out.push(t);
  return out.map((t) => rec({
    ts: t[F.TS],
    model: t[F.MODEL],
    input: t[F.IN],
    cw: t[F.CW5M] + t[F.CW1H],
    cr: t[F.CR],
    out: t[F.OUT],
    think: t[F.THINK],
    cost: costOf({ in: t[F.IN], cw5m: t[F.CW5M], cw1h: t[F.CW1H], cr: t[F.CR], out: t[F.OUT] }, t[F.MODEL]),
    session: t[F.SESSION],
    req: t[F.REQ],
    cwd: t[F.CWD],
  }));
}
