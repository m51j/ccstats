#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultRoots, F } from './scan.mjs';
import { loadRecords } from './cache.mjs';
import { aggregate, V } from './aggregate.mjs';
import { renderHtml } from './render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const o = {
    days: 0,
    since: null,
    until: null,
    tz: 'local',
    raw: false,
    rescan: false,
    open: true,
    out: path.join(ROOT, 'report.html'),
    json: null,
    roots: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--days': o.days = Number(next()); break;
      case '--since': o.since = next(); break;
      case '--until': o.until = next(); break;
      case '--tz': o.tz = next(); break;
      case '--raw': o.raw = true; break;
      case '--rescan': o.rescan = true; break;
      case '--no-open': o.open = false; break;
      case '--out': o.out = path.resolve(next()); break;
      case '--json': o.json = path.resolve(next()); break;
      case '--root': (o.roots ||= []).push(path.resolve(next())); break;
      case '-h': case '--help': o.help = true; break;
      default:
        if (a.startsWith('-')) { console.error('unknown option: ' + a); process.exit(2); }
    }
  }
  return o;
}

const HELP = `ccstats - accurate Claude Code token usage, cache included

  node src/cli.mjs [options]

  --days N        only the last N days
  --since DATE    ISO date lower bound (e.g. 2026-08-01)
  --until DATE    ISO date upper bound
  --tz local|utc  bucket timestamps in local time (default) or UTC
  --raw           do NOT deduplicate by request id - reproduces the
                  desktop app's inflated per-record basis
  --rescan        ignore the incremental cache and re-parse everything
  --out PATH      output html (default: report.html next to this project)
  --json PATH     also write the aggregate payload as json
  --root PATH     extra transcript root (repeatable)
  --no-open       do not open the report in a browser
`;

function fmtTok(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
const fmtUSD = (n) => (n >= 1000 ? '$' + Math.round(n).toLocaleString('en-US') : '$' + n.toFixed(2));
const pad = (s, w, right = true) =>
  right ? String(s).padStart(w) : String(s).padEnd(w);

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { process.stdout.write(HELP); return; }

  const roots = o.roots || defaultRoots();
  if (!roots.length) {
    console.error('No transcript directory found. Expected ~/.claude/projects');
    process.exit(1);
  }

  const t0 = Date.now();
  process.stderr.write('scanning ' + roots.join(', ') + '\n');
  const { records, stats } = await loadRecords({
    roots,
    rescan: o.rescan,
    onProgress: ({ done, total, parsed }) => {
      if (!process.stderr.isTTY) return;
      process.stderr.write(`\r  ${done}/${total} files (${parsed} parsed)   `);
    },
  });
  if (process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(48) + '\r');
  process.stderr.write(
    `  ${stats.files} files, ${stats.parsed} parsed, ${stats.reused} from cache, ` +
    `${(stats.bytes / 1e9).toFixed(2)} GB, ${((Date.now() - t0) / 1000).toFixed(1)}s\n`
  );

  let since = o.since ? Date.parse(o.since) : undefined;
  let until = o.until ? Date.parse(o.until + 'T23:59:59.999Z') : undefined;
  if (o.days > 0) {
    const last = records.reduce((m, r) => Math.max(m, r[F.TS]), 0) || Date.now();
    const d = new Date(last);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (o.days - 1));
    since = Math.max(since ?? -Infinity, d.getTime());
  }

  const payload = aggregate(records, { tz: o.tz, dedupe: !o.raw, since, until });

  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  fs.writeFileSync(o.out, renderHtml(payload), 'utf8');
  if (o.json) fs.writeFileSync(o.json, JSON.stringify(payload, null, 2), 'utf8');

  printSummary(payload, o);
  process.stderr.write('\nreport: ' + o.out + '\n');
  if (o.open) openFile(o.out);
}

function printSummary(payload, o) {
  const m = payload.meta;
  const totals = {};
  const tot = [0, 0, 0, 0, 0, 0, 0];
  for (const day in payload.hours)
    for (const h in payload.hours[day])
      for (const model in payload.hours[day][h]) {
        const v = payload.hours[day][h][model];
        const t = (totals[model] ||= [0, 0, 0, 0, 0, 0, 0]);
        for (let i = 0; i < 7; i++) { t[i] += v[i]; tot[i] += v[i]; }
      }

  const sum = (v) => v[V.IN] + v[V.CW5M] + v[V.CW1H] + v[V.CR] + v[V.OUT];
  const cost = (v, model) => {
    const r = payload.rates[model];
    return (v[V.IN] * r.input + v[V.CW5M] * r.write5m + v[V.CW1H] * r.write1h +
      v[V.CR] * r.cacheRead + v[V.OUT] * r.output) / 1e6;
  };

  const rows = Object.keys(totals).sort((a, b) => sum(totals[b]) - sum(totals[a]));
  const grand = sum(tot) || 1;
  let grandCost = 0;

  const W = [14, 9, 9, 11, 11, 9, 11, 8, 10];
  const head = ['model', 'requests', 'input', 'cache wr', 'cache rd', 'output', 'real total', 'share', 'cost'];
  console.log('');
  console.log(head.map((h, i) => pad(h, W[i], i > 0)).join(' '));
  console.log(W.map((w) => '-'.repeat(w)).join(' '));
  for (const model of rows) {
    const v = totals[model];
    const c = cost(v, model);
    grandCost += c;
    console.log([
      pad(payload.rates[model].label, W[0], false),
      pad(v[V.REQ].toLocaleString('en-US'), W[1]),
      pad(fmtTok(v[V.IN]), W[2]),
      pad(fmtTok(v[V.CW5M] + v[V.CW1H]), W[3]),
      pad(fmtTok(v[V.CR]), W[4]),
      pad(fmtTok(v[V.OUT]), W[5]),
      pad(fmtTok(sum(v)), W[6]),
      pad(((sum(v) / grand) * 100).toFixed(1) + '%', W[7]),
      pad(fmtUSD(c), W[8]),
    ].join(' '));
  }
  console.log(W.map((w) => '-'.repeat(w)).join(' '));
  console.log([
    pad('TOTAL', W[0], false),
    pad(tot[V.REQ].toLocaleString('en-US'), W[1]),
    pad(fmtTok(tot[V.IN]), W[2]),
    pad(fmtTok(tot[V.CW5M] + tot[V.CW1H]), W[3]),
    pad(fmtTok(tot[V.CR]), W[4]),
    pad(fmtTok(tot[V.OUT]), W[5]),
    pad(fmtTok(sum(tot)), W[6]),
    pad('100%', W[7]),
    pad(fmtUSD(grandCost), W[8]),
  ].join(' '));

  console.log('');
  console.log(`basis: ${o.raw ? 'RAW per-record (matches the app card)' : 'deduplicated per API request'}`);
  console.log(`records: ${m.rawRecords.toLocaleString('en-US')} in transcripts -> ` +
    `${m.countedRecords.toLocaleString('en-US')} counted (${m.inflation.toFixed(2)}x inflation)` +
    (m.partialRecords ? `, of which ${m.partialRecords.toLocaleString('en-US')} were superseded streaming snapshots` : ''));
  console.log(`sessions: ${m.sessions.toLocaleString('en-US')} | timezone: ${m.tzLabel}`);
  if (m.unknownModels.length) {
    console.log(`note: no price for ${m.unknownModels.join(', ')} - billed at Opus rates in this report`);
  }
}

function openFile(file) {
  const p = os.platform();
  if (p === 'win32') spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore' }).unref();
  else if (p === 'darwin') spawn('open', [file], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [file], { detached: true, stdio: 'ignore' }).unref();
}

main().catch((e) => { console.error(e); process.exit(1); });
