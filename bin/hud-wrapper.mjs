#!/usr/bin/env node
// statusLine 入口：调 omc-hud 拿原始多行，追加 [Fee💰] 行。
// 任何步骤失败都不能让 HUD 整体崩——所以全程 try/catch 兜底。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const HUD_DIR = join(HOME, '.claude/hud-extras');
const CACHE_FILE = join(HUD_DIR, 'ccusage-cache.json');
const OMC_HUD = join(HOME, '.claude/hud/omc-hud.mjs');
const OMC_TIMEOUT_MS = 2000;

const C = {
  green:  s => `\x1b[32m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  purple: s => `\x1b[35m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  orange: s => `\x1b[38;5;208m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
};

// 价格 per 1M tokens, USD（顺序重要：先 opus 再 sonnet 再 haiku，避免子串误判）
const MODEL_PRICES = [
  { match: /opus/i,   in: 15.0, out: 75.0, cw: 18.75, cr: 1.5 },
  { match: /sonnet/i, in: 3.0,  out: 15.0, cw: 3.75,  cr: 0.3 },
  { match: /haiku/i,  in: 0.8,  out: 4.0,  cw: 1.0,   cr: 0.08 },
];

function priceFor(model) {
  if (!model) return null;
  return MODEL_PRICES.find(p => p.match.test(model)) || null;
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function fmtNum(n) {
  if (n == null || isNaN(n)) return '--';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(Math.round(n));
}

function fmtUsd(n) {
  if (n == null || isNaN(n)) return '--';
  if (n >= 100) return '$' + Math.round(n);
  if (n >= 10) return '$' + n.toFixed(1);
  return '$' + n.toFixed(2);
}

function pct(n) {
  if (n == null || isNaN(n)) return '--';
  return Math.round(n) + '%';
}

function fmtMin(min) {
  if (min == null || isNaN(min) || min < 0) return '--';
  if (min === Infinity || min > 60 * 24 * 30) return '>30d';
  if (min < 60) return Math.round(min) + 'm';
  if (min < 60 * 24) {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  const d = Math.floor(min / (60 * 24));
  const h = Math.round((min % (60 * 24)) / 60);
  return h > 0 ? `${d}d${h}h` : `${d}d`;
}

function readSessionStats(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  try {
    const text = readFileSync(transcriptPath, 'utf-8');
    let inp = 0, out = 0, cacheRead = 0, cacheCreate = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        const u = obj.message?.usage;
        if (!u) continue;
        const ti = u.input_tokens || 0;
        const to = u.output_tokens || 0;
        const tcr = u.cache_read_input_tokens || 0;
        const tcw = u.cache_creation_input_tokens || 0;
        // total-input 含 cache_creation + cache_read（codex 风格）
        inp += ti + tcr + tcw;
        out += to;
        cacheRead += tcr;
        cacheCreate += tcw;
      } catch { /* skip bad line */ }
    }
    return { in: inp, out, cacheRead, cacheCreate };
  } catch {
    return null;
  }
}

function readCache() {
  if (!existsSync(CACHE_FILE)) return null;
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf-8')); }
  catch { return null; }
}

// 读 omc 的限额缓存（5h / 周限额百分比 + 重置时间）
function readOmcUsage() {
  const p = join(HOME, '.claude/plugins/oh-my-claudecode/.usage-cache.json');
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf-8'));
    return j.data || null;
  } catch { return null; }
}

// 按"周已过去时间内的平均增长率"推算用完周配额还需多少分钟
const WEEK_MS = 7 * 24 * 3600 * 1000;
function calcWeeklyRunOutMinutes(usage) {
  if (!usage || usage.weeklyPercent == null || !usage.weeklyResetsAt) return null;
  const pct = usage.weeklyPercent;
  if (pct >= 100) return 0;
  const resetTs = new Date(usage.weeklyResetsAt).getTime();
  const now = Date.now();
  const remainMs = resetTs - now;
  if (remainMs <= 0) return null;
  const elapsedMs = WEEK_MS - remainMs;
  if (elapsedMs <= 0 || pct <= 0) return Infinity;
  // 平均速率 = pct / elapsedMs %/ms
  // 用完剩余 = (100 - pct) / rate ms
  const burnOutMs = (100 - pct) * elapsedMs / pct;
  return Math.round(burnOutMs / 60000);
}

function buildFeeLine(sessionCtx) {
  const cache = readCache();
  const ss = readSessionStats(sessionCtx?.transcript_path);

  let tokIn = '--', tokOut = '--', cacheHit = '--', sessionCost = '--', today = '--', runOut = '--';

  if (ss) {
    tokIn = fmtNum(ss.in);  // 现在 ss.in 已经含 cache_creation + cache_read
    tokOut = fmtNum(ss.out);
    cacheHit = ss.in > 0 ? pct(ss.cacheRead / ss.in * 100) : '--';
  }

  // session 费用直接读 ccusage 当前 5h block 的 costUSD（避免自己维护价表）
  const activeBlockCost = cache?.blocks?.blocks?.[0]?.costUSD;
  if (typeof activeBlockCost === 'number') sessionCost = fmtUsd(activeBlockCost);

  const usage = readOmcUsage();
  const runOutMin = calcWeeklyRunOutMinutes(usage);
  if (runOutMin != null) runOut = fmtMin(runOutMin);

  const todayEntry = cache?.daily?.daily?.[0];
  if (todayEntry) today = fmtUsd(todayEntry.totalCost);

  return `[Fee💰] | token: ${C.green(tokIn)} in · ${C.red(tokOut)} out | cache: ${C.purple(cacheHit)} | session ${C.yellow(sessionCost)} | today ${C.orange(today)} | Run out in ${C.cyan(runOut)}`;
}

function runOmcHud(stdinRaw) {
  return new Promise((resolve) => {
    if (!existsSync(OMC_HUD)) return resolve('');
    let buf = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const p = spawn('node', [OMC_HUD], { stdio: ['pipe', 'pipe', 'inherit'] });
      const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} finish(buf); }, OMC_TIMEOUT_MS);
      p.stdout.on('data', d => { buf += d; });
      p.on('close', () => { clearTimeout(timer); finish(buf); });
      p.on('error', () => { clearTimeout(timer); finish(buf); });
      p.stdin.write(stdinRaw);
      p.stdin.end();
    } catch {
      finish('');
    }
  });
}

async function main() {
  const stdinRaw = await readStdin();
  let sessionCtx = {};
  try { sessionCtx = JSON.parse(stdinRaw); } catch {}

  const omcOut = await runOmcHud(stdinRaw);

  let feeLine = '';
  try { feeLine = buildFeeLine(sessionCtx); }
  catch { feeLine = '[Fee💰] | err'; }

  const omcTrimmed = (omcOut || '').replace(/\n+$/, '');
  // 用 NBSP ( ) 占位行做间隔——Claude Code 会 trim 普通空白行，但 NBSP 不被视为空白
  const SPACER = ' ';
  const sep = omcTrimmed ? `\n${SPACER}\n` : '';
  process.stdout.write(omcTrimmed + sep + feeLine + `\n${SPACER}\n`);
}

main().catch(() => {
  process.stdout.write('[Fee💰] | wrapper crashed\n');
});
