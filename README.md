# ccstats

Accurate token usage for Claude Code, read straight from the transcripts in
`~/.claude/projects/`. Cache tokens included, one row per real API request.

```bash
node src/cli.mjs
```

Scans every transcript, writes `report.html`, and opens it. The first run parses
everything (~20s for 3.8 GB); later runs reuse an incremental cache and finish in
about a second.

## Why the numbers differ from the app's usage card

The desktop app's usage card is wrong in two compounding ways.

**1. Cache tokens are invisible.** Its `in` column is the raw `input_tokens`
field only. `cache_read_input_tokens` and `cache_creation_input_tokens` are left
out entirely — and they are ~98% of real consumption. Its headline "total
tokens" is the sum of `output_tokens` alone, and its per-model percentages are
shares of output tokens only.

**2. Every number is inflated ~1.9×.** One API response is written to the
transcript once per content block — a response with 11 parallel `tool_use`
blocks produces 11 records, each repeating the *same* usage object. Streaming
adds an earlier snapshot whose `output_tokens` is still growing. The card sums
per record.

On one real profile: the card showed `2.3M in / 240M out` for Opus 5. The truth
was **34 billion** tokens.

## Counting rules

- A record counts only if `type === "assistant"`, `message.usage` is an object,
  and `message.model` is a string that does not start with `<` (that filters out
  `<synthetic>` placeholders and `type:"user"` records whose embedded
  `toolUseResult` merely contains the substring `"usage"`).
- Records are deduplicated globally by `requestId` (falling back to
  `message.id`). One key = one billable API call. This collapses both the
  per-content-block copies and the copies that forked/resumed sessions leave in
  other files.
- Where copies of one request disagree, the one with the **largest
  `output_tokens`** wins — a streaming snapshot is always a prefix of the final
  usage. Keeping the first instead undercounts output by ~13%.
- Only top-level `usage` fields are read, never `usage.iterations[]` — those are
  components of the same total.
- Cache-write TTL split comes from `usage.cache_creation.ephemeral_5m_input_tokens`
  and `ephemeral_1h_input_tokens`.
- Subagent and workflow transcripts nested under
  `<sessionId>/subagents/...` are included; a non-recursive scan misses them.

## Options

```
--days N        only the last N days
--since DATE    ISO date lower bound (e.g. 2026-08-01)
--until DATE    ISO date upper bound
--tz local|utc  bucket timestamps in local time (default) or UTC
--raw           do NOT deduplicate - reproduces the app card's inflated basis
--rescan        ignore the incremental cache and re-parse everything
--out PATH      output html (default: report.html)
--json PATH     also write the aggregate payload as json
--root PATH     extra transcript root (repeatable)
--no-open       do not open the report in a browser
```

`--raw` is the audit switch: run it and the per-model `input` / `output` columns
reproduce the app's card almost exactly. The default run is the truth.

## The report

| Tab | What it shows |
|---|---|
| Overview | Stat tiles, a day-by-day activity heatmap keyed to real tokens, and the token-class mix |
| Models | Stacked daily totals by model, plus a per-model table with every token class and cost |
| Time | Hour-of-day profile, weekday × hour heatmap, daily stacked consumption, monthly table |
| Tables | Exact counts, the consumption distribution, the cost breakdown, and an app-card-vs-reality comparison |
| Projects | Usage per working directory and the heaviest individual sessions |

Range filters (All / 90d / 30d / 7d) apply to everything except the app-card
comparison, which is always all-time.

## Cost figures

Dollar amounts are computed at Anthropic's first-party API list rates in
`src/pricing.js`: cache reads at 0.1× the input rate (Fable 5.1 at a flat
$0.25/MTok), cache writes at 1.25× for the 5-minute TTL and 2× for the 1-hour
TTL. **On a subscription plan these are an equivalent-cost estimate, not a
bill.** Edit `src/pricing.js` to change a rate or add a model; unknown models
fall back to Opus rates and are flagged in the report.

## Other AI agents

```bash
npm run all        # node src/all.mjs
```

This covers every AI agent on the machine. It writes:

- `report.html`: the Claude Code report above, byte-for-byte what `npm start` writes.
- `agents/<id>.html`: one page per other agent, with the same tabs and range filter.
- `agents/all.html`: every agent combined, with a *By agent / By model* switch.
- `dashboard.html`: a tab bar that opens each page above. This file is the one to open.

Takes the same `--days --since --until --tz --rescan --no-open` options, plus
`--only a,b` / `--skip a,b` (ids: `claude codex antigravity-ide antigravity agy
zcode opencode kilo cline copilot hermes lmstudio`). An agent with no data on disk gets no tab. Reading
the SQLite stores needs Node 22.13+ (`node:sqlite`); `npm start` still runs on 18.

| Agent | Source | Granularity |
|---|---|---|
| Codex | `~/.codex/sessions/**/rollout-*.jsonl`, `token_count` events | per model call |
| Antigravity IDE / Antigravity / agy | `~/.gemini/{antigravity-ide,antigravity,antigravity-cli}/conversations/*.db` | per model call |
| ZCode | `~/.zcode/cli/db/db.sqlite`, table `model_usage` | per model call |
| opencode | `~/.local/share/opencode/opencode.db`, assistant rows of `message` | per model call |
| Kilo Code | `~/.local/share/kilo/kilo.db` (opencode schema) | per model call |
| Cline | `~/.cline/data/sessions/<id>/<id>.messages.json`, `metrics` | per model call |
| Copilot Chat | `%APPDATA%/Code/User/workspaceStorage/*/chatSessions/*.jsonl` | per request (**lower bound**) |
| Hermes | `%LOCALAPPDATA%/hermes/state.db`, table `sessions` | per session |
| LM Studio | `~/.lmstudio/conversations/*.conversation.json`, `genInfo.stats` | per generation |

Every agent is normalised to the same token classes as Claude: uncached input,
cache write, cache read, output. Reasoning is shown on its own and never added
to the total, because output already includes it.

- **Codex:** `input_tokens` includes `cached_input_tokens`, so the cached part is
  moved to cache read. Each call is counted from `last_token_usage`. A
  `token_count` whose running total did not change is a re-emit and is skipped.
  The total lands about 13% below Codex's own `threads.tokens_used`. That column
  counts the parent's usage again in every forked thread, because a fork
  inherits the running total.
- **ZCode, Cline:** input includes the cache reads, which are split out as for Codex.
- **opencode, Kilo:** `tokens.output` excludes reasoning (total = input + output
  + reasoning + cache), so output here is `output + reasoning`.
- **Cline:** per-message `metrics` are used. The session header's
  `metadata.usage` covers only the last run of a resumed session.
- **Copilot Chat:** for each request Copilot keeps only the prompt size of the
  final tool-call round, so input is undercounted. Model calls count every round.
- **Hermes:** usage exists only per session, so a session's tokens all land on
  the hour it started.
- **Antigravity (IDE, app, `agy`):** there is no official usage log. Each
  conversation is its own SQLite file of protobuf, read in
  `src/agents/adapters/antigravity.mjs`. Every model step's `metadata` carries a
  creation time (field 1) and a usage record (field 9). The usage record matches
  Codeium's `ModelUsageStats`: input, which excludes cache reads, output,
  cache write, cache read, thinking, and a response id. Output equals thinking plus
  response on every row, which is how the fields were confirmed. Model names come
  from `gen_metadata`. A model enum that never appears there shows as
  `unnamed model #N`. Response ids are unique, so sub-agent conversations are
  not double-counted.
- **Not included:** OmniRoute is a proxy, and counting it would double-count the
  clients behind it.

**Cost** is the figure the agent recorded itself: Kilo's paid providers, $0 for
free or local models, and Hermes's `actual_cost_usd`. Hermes records 0 for
subscription billing, which is treated as unknown. Where none was recorded, it is the list price from
`src/agents/pricing.mjs` (OpenAI and xAI models; Claude models run through
another agent use the Anthropic table from `src/pricing.js`). Where neither exists it shows `—`
and is never guessed. A `*` marks a total that covers only part of the tokens.
In the combined view, Claude is priced exactly as on its own page.

## Layout

```
src/scan.mjs       transcript streaming + record extraction
src/cache.mjs      incremental scan cache (.cache/index.json)
src/aggregate.mjs  dedup policy and all rollups
src/pricing.js     rate table
src/render.mjs     self-contained HTML report (inline SVG, no dependencies)
src/cli.mjs        arg parsing, terminal summary, opens the report

src/all.mjs                every agent: pages, combined view, dashboard
src/agents/adapters/*.mjs  one reader per agent -> shared record shape
src/agents/record.mjs      the shared record shape
src/agents/filecache.mjs   incremental cache per agent (.cache/agent-<id>.json)
src/agents/sqlite.mjs      read-only SQLite access (node:sqlite)
src/agents/aggregate.mjs   rollups keyed by agent::model
src/agents/pricing.mjs     list prices for non-Anthropic models
src/agents/render.mjs      agent page (generalised copy of src/render.mjs)
src/agents/dashboard.mjs   the tabbed shell
```

No dependencies. Node 18+ for Claude alone, 22.13+ for `npm run all`.
