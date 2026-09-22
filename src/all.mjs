#!/usr/bin/env node
// Every AI agent on this machine: Claude Code's own report (unchanged), one page
// per other agent, a combined page, and a dashboard with a tab for each.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultRoots, F } from './scan.mjs';
import { loadRecords } from './cache.mjs';
import { aggregate } from './aggregate.mjs';
import { renderHtml } from './render.mjs';
import { ADAPTERS } from './agents/adapters/index.mjs';
import { fromClaudeTuples } from './agents/adapters/claude.mjs';
import { R } from './agents/record.mjs';
import { aggregateAgents, V } from './agents/aggregate.mjs';
import { renderAgentHtml } from './agents/render.mjs';
import { renderDashboard } from './agents/dashboard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_DIR = path.join(ROOT, 'agents');

function parseArgs(argv) {
  const o = { days: 0, since: null, until: null, tz: 'local', raw: false, rescan: false, open: true, only: null, skip: [] };
  const list = (s) => String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
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
      case '--only': o.only = list(next()); break;
      case '--skip': o.skip = list(next()); break;
      case '-h': case '--help': o.help = true; break;
      default:
        if (a.startsWith('-')) { console.error('unknown option: ' + a); process.exit(2); }
    }
  }
  return o;
}

const HELP = `ccstats all - token usage for every AI agent on this machine

  node src/all.mjs [options]

  --days N          only the last N days
  --since DATE      ISO date lower bound (e.g. 2026-08-01)
  --until DATE      ISO date upper bound
  --tz local|utc    bucket timestamps in local time (default) or UTC
  --raw             Claude page only: do NOT deduplicate by request id
  --rescan          ignore the incremental caches and re-parse everything
  --only a,b        only these agents (ids: claude, ${ADAPTERS.map((a) => a.id).join(', ')})
  --skip a,b        leave these agents out
  --no-open         do not open the dashboard in a browser

Writes report.html (Claude Code, same as \`npm start\`), agents/<id>.html,
agents/all.html and dashboard.html.
`;

function fmtTok(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
const fmtUSD = (n) => (n >= 1000 ? '$' + Math.round(n).toLocaleString('en-US') : '$' + n.toFixed(2));
const pad = (s, w, right = true) => (right ? String(s).padStart(w) : String(s).padEnd(w));

/** The same --since/--until/--days window cli.mjs uses, relative to `lastTs`. */
function windowFor(o, lastTs) {
  let since = o.since ? Date.parse(o.since) : undefined;
  const until = o.until ? Date.parse(o.until + 'T23:59:59.999Z') : undefined;
  if (o.days > 0) {
    const d = new Date(lastTs || Date.now());
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (o.days - 1));
    since = Math.max(since ?? -Infinity, d.getTime());
  }
  return { since, until };
}
const maxTs = (records, i) => records.reduce((m, r) => Math.max(m, r[i]), 0);

function totalsOf(payload) {
  const t = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const day in payload.hours)
    for (const h in payload.hours[day])
      for (const k in payload.hours[day][h]) {
        const v = payload.hours[day][h][k];
        for (let i = 0; i < 8; i++) t[i] += v[i];
      }
  return t;
}
const realTokens = (t) => t[V.IN] + t[V.CW] + t[V.CR] + t[V.OUT];

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { process.stdout.write(HELP); return; }
  const wanted = (id) => (!o.only || o.only.includes(id)) && !o.skip.includes(id);

  fs.mkdirSync(AGENT_DIR, { recursive: true });
  const sources = [];
  const tabs = [];

  // Claude Code: exactly the npm start pipeline, into the same report.html.
  if (wanted('claude')) {
    const roots = defaultRoots();
    if (roots.length) {
      const t0 = Date.now();
      process.stderr.write('claude   scanning ' + roots.join(', ') + '\n');
      const { records } = await loadRecords({ roots, rescan: o.rescan });
      const win = windowFor(o, maxTs(records, F.TS));
      const payload = aggregate(records, { tz: o.tz, dedupe: !o.raw, since: win.since, until: win.until });
      fs.writeFileSync(path.join(ROOT, 'report.html'), renderHtml(payload), 'utf8');
      sources.push({ id: 'claude', label: 'Claude Code', records: fromClaudeTuples(records) });
      tabs.push({ id: 'claude', label: 'Claude Code', href: 'report.html' });
      process.stderr.write(`         ${records.length} records, ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    }
  }

  for (const a of ADAPTERS) {
    if (!wanted(a.id)) continue;
    if (!a.detect()) continue;
    const t0 = Date.now();
    try {
      const { records } = await a.load({ rescan: o.rescan });
      process.stderr.write(`${pad(a.id, 8, false)} ${records.length} records, ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
      if (!records.length) continue;
      sources.push({ id: a.id, label: a.label, note: a.note, records });
      const win = windowFor(o, maxTs(records, R.TS));
      const payload = aggregateAgents([{ id: a.id, label: a.label, note: a.note, records }],
        { title: a.label, tz: o.tz, since: win.since, until: win.until });
      fs.writeFileSync(path.join(AGENT_DIR, `${a.id}.html`), renderAgentHtml(payload), 'utf8');
      tabs.push({ id: a.id, label: a.label, href: `agents/${a.id}.html` });
    } catch (e) {
      process.stderr.write(`${pad(a.id, 8, false)} skipped: ${e.message}\n`);
    }
  }

  if (!sources.length) {
    console.error('No agent usage data found.');
    process.exit(1);
  }

  const lastAll = Math.max(...sources.map((s) => maxTs(s.records, R.TS)));
  const win = windowFor(o, lastAll);
  const all = aggregateAgents(sources, { title: 'All agents', tz: o.tz, since: win.since, until: win.until });
  fs.writeFileSync(path.join(AGENT_DIR, 'all.html'), renderAgentHtml(all), 'utf8');

  // Tab badges and the terminal summary both come from the combined payload,
  // so every agent is measured on the same basis.
  const perAgent = {};
  for (const day in all.hours)
    for (const h in all.hours[day])
      for (const k in all.hours[day][h]) {
        const t = (perAgent[k.split('::')[0]] ||= [0, 0, 0, 0, 0, 0, 0, 0]);
        const v = all.hours[day][h][k];
        for (let i = 0; i < 8; i++) t[i] += v[i];
      }
  const dashTabs = [
    { id: 'all', label: 'All agents', href: 'agents/all.html', tokens: realTokens(totalsOf(all)) },
    ...tabs.map((t) => ({ id: t.id, label: t.label, href: t.href, tokens: realTokens(perAgent[t.id] || [0, 0, 0, 0]) })),
  ];
  const dash = path.join(ROOT, 'dashboard.html');
  fs.writeFileSync(dash, renderDashboard(dashTabs, all.meta.generatedAt), 'utf8');

  printSummary(all, perAgent);
  process.stderr.write('\ndashboard: ' + dash + '\n');
  if (o.open) openFile(dash);
}

function printSummary(all, perAgent) {
  const sessions = {};
  for (const s of all.sessions) sessions[s[0]] = (sessions[s[0]] || 0) + 1;
  const ids = Object.keys(perAgent).sort((a, b) => realTokens(perAgent[b]) - realTokens(perAgent[a]));
  const grand = realTokens(totalsOf(all)) || 1;
  const W = [16, 8, 9, 9, 10, 9, 11, 7, 10];
  const head = ['agent', 'sessions', 'calls', 'input', 'cache rd', 'output', 'real total', 'share', 'known cost'];
  console.log('');
  console.log(head.map((h, i) => pad(h, W[i], i > 0)).join(' '));
  console.log(W.map((w) => '-'.repeat(w)).join(' '));
  const row = (name, s, v, share) => console.log([
    pad(name, W[0], false),
    pad((s ?? 0).toLocaleString('en-US'), W[1]),
    pad(v[V.REQ].toLocaleString('en-US'), W[2]),
    pad(fmtTok(v[V.IN]), W[3]),
    pad(fmtTok(v[V.CR]), W[4]),
    pad(fmtTok(v[V.OUT]), W[5]),
    pad(fmtTok(realTokens(v)), W[6]),
    pad(share, W[7]),
    pad(v[V.COSTTOK] || v[V.COST] ? fmtUSD(v[V.COST]) + (v[V.COSTTOK] < realTokens(v) * 0.999 ? '*' : ' ') : '- ', W[8]),
  ].join(' '));
  for (const id of ids) row(all.agents[id].label, sessions[id], perAgent[id], ((realTokens(perAgent[id]) / grand) * 100).toFixed(1) + '%');
  console.log(W.map((w) => '-'.repeat(w)).join(' '));
  row('TOTAL', all.sessions.length, totalsOf(all), '100%');
  console.log('\n* cost covers only part of the tokens (recorded by the agent or at a known list price)');
}

function openFile(file) {
  const p = os.platform();
  if (p === 'win32') spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore' }).unref();
  else if (p === 'darwin') spawn('open', [file], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [file], { detached: true, stdio: 'ignore' }).unref();
}

main().catch((e) => { console.error(e); process.exit(1); });
