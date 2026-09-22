// List prices for non-Anthropic models, USD per million tokens, standard tier.
// Used only when the agent did not record a cost itself. A model missing here
// shows "—" instead of a guessed price: add a row to price it.
//
// Sources (checked 2026-09-22):
//   OpenAI  https://developers.openai.com/api/docs/pricing  (Standard tab)
//   xAI     https://docs.x.ai/docs/models
// gpt-5.6-sol is a promotional price, announced through at least 2026-11-21.
// gpt-5.5 and grok-4.3 use their short-context tier (<272K / <200K prompt).

import { ratesFor, isKnownModel } from '../pricing.js';

const RATES = {
  'gpt-5.5': { input: 5, cacheRead: 0.5, output: 30 },
  'gpt-5.6-sol': { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 },
  'gpt-5.6-terra': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 },
  'gpt-6-astra': { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
  'grok-4.3': { input: 1.25, cacheRead: 0.2, output: 2.5 },
};

export function listRate(model) {
  const id = String(model).toLowerCase();
  const r = RATES[id];
  if (r) return { input: r.input, cacheRead: r.cacheRead ?? r.input, cacheWrite: r.cacheWrite ?? r.input, output: r.output };
  // Claude models run through another agent (e.g. Antigravity's
  // "claude-opus-4-6-thinking") use the Anthropic table the Claude page uses.
  const claude = id.replace(/-thinking$/, '');
  if (claude.startsWith('claude-') && isKnownModel(claude)) {
    const a = ratesFor(claude);
    return { input: a.input, cacheRead: a.cacheRead, cacheWrite: a.write5m, output: a.output };
  }
  return null;
}
