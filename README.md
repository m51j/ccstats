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

## Layout

```
src/scan.mjs       transcript streaming + record extraction
src/cache.mjs      incremental scan cache (.cache/index.json)
src/aggregate.mjs  dedup policy and all rollups
src/pricing.js     rate table
src/render.mjs     self-contained HTML report (inline SVG, no dependencies)
src/cli.mjs        arg parsing, terminal summary, opens the report
```

No dependencies, Node 18+.
