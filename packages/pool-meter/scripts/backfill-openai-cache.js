#!/usr/bin/env node
'use strict';
// backfill-openai-cache.js — one-time repair of the OpenAI cached-token
// double-count in historical usage JSONL.
//
// THE BUG: pool-meter's OpenAI→Anthropic usage conversion copied
// input_tokens_details.cached_tokens into cache_read_input_tokens WITHOUT
// subtracting it from input_tokens. OpenAI's input_tokens INCLUDES the cached
// subset; Anthropic's excludes it. Result: every gpt-* row logged cached
// tokens twice (weight 1.0 inside input + weight 0.1 as cache_read).
//
// THE REPAIR: for affected rows, input_tokens -= cache_read_input_tokens
// (clamped at 0). Only rows where model matches /^gpt-/.
//
// IDEMPOTENCY: "input >= cache_read" alone cannot distinguish a broken row
// from a legitimately-fixed row that happens to have more uncached than cached
// input, and running the subtraction twice would corrupt data. So this script
// uses a CUTOVER MARKER instead:
//   - it refuses to run while pool-meter.service is active (the service must
//     be stopped so the fixed code's rows and this rewrite can't interleave);
//   - it records every file it has processed in a marker file
//     (.openai-cache-backfill-state.json) and will never touch a file twice;
//   - rows with ts >= the cutover recorded at first run are skipped even
//     inside an unprocessed file (they were written by fixed code).
//
// Each file is backed up to <file>.bak-openai-cache-backfill before rewrite
// (precedent: usage-2026-07-29.jsonl.bak-model-backfill).
//
// Usage: node scripts/backfill-openai-cache.js [--dry-run] [logdir]

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DRY = process.argv.includes('--dry-run');
const LOG_DIR = process.argv.filter((a) => !a.startsWith('--'))[2] ||
  path.join(process.env.HOME, '.moltbot/logs/pool-meter');
const STATE_FILE = path.join(LOG_DIR, '.openai-cache-backfill-state.json');
const BAK_SUFFIX = '.bak-openai-cache-backfill';

// Safety gate: never rewrite files the live service is appending to.
if (!DRY) {
  let active = '';
  try { active = execSync('systemctl is-active pool-meter.service 2>/dev/null || true').toString().trim(); } catch (_) {}
  if (active === 'active') {
    console.error('REFUSING: pool-meter.service is active. Stop it first (systemctl stop pool-meter).');
    process.exit(2);
  }
}

let state = { cutover: null, processed: [] };
if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
if (!state.cutover) state.cutover = new Date().toISOString();

const files = fs.readdirSync(LOG_DIR)
  .filter((f) => /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
  .sort();

// weights mirror lib/metrics.js TOKEN_WEIGHTS
const W = { input: 1.0, output: 5.0, cache_read: 0.1, cache_creation: 1.25 };

const perLabel = {}; // label -> { rows, inputRemoved, effectiveRefund }
let totalRows = 0, totalFixed = 0, totalSkippedPostCutover = 0;

for (const f of files) {
  const full = path.join(LOG_DIR, f);
  if (state.processed.includes(f)) { console.log(`skip (already processed): ${f}`); continue; }
  const raw = fs.readFileSync(full, 'utf8');
  const lines = raw.split('\n');
  let fixed = 0, gptRows = 0;
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { return line; }
    const model = rec.model || '';
    if (!/^gpt-/.test(model)) return line;
    gptRows++;
    const u = rec.usage;
    if (!u) return line;
    const input = Number(u.input_tokens) || 0;
    const cached = Number(u.cache_read_input_tokens) || 0;
    if (cached <= 0) return line;
    if (rec.ts && rec.ts >= state.cutover) { totalSkippedPostCutover++; return line; }
    if (input < cached) return line; // already-fixed shape, leave alone
    const newInput = Math.max(0, input - cached);
    u.input_tokens = newInput;
    fixed++;
    const label = rec.label || '?';
    const s = perLabel[label] || (perLabel[label] = { rows: 0, inputRemoved: 0, effectiveRefund: 0 });
    s.rows++;
    s.inputRemoved += (input - newInput);
    // effective tokens refunded: those tokens were weighted 1.0 as input but
    // remain weighted 0.1 as cache_read, so the refund is 0.9x per token.
    s.effectiveRefund += (input - newInput) * (W.input - 0); // full input weight removed; cache_read side was ALREADY counted separately and stays
    return JSON.stringify(rec);
  });
  totalRows += gptRows;
  totalFixed += fixed;
  if (fixed === 0) { console.log(`no broken rows: ${f} (${gptRows} gpt rows)`); state.processed.push(f); continue; }
  if (DRY) { console.log(`DRY: would fix ${fixed}/${gptRows} gpt rows in ${f}`); continue; }
  fs.copyFileSync(full, full + BAK_SUFFIX);
  fs.writeFileSync(full + '.tmp', out.join('\n'));
  fs.renameSync(full + '.tmp', full);
  state.processed.push(f);
  console.log(`fixed ${fixed}/${gptRows} gpt rows in ${f} (backup: ${f}${BAK_SUFFIX})`);
}

// ---- totals.json must shrink by the same amount ---------------------------
// Metrics.reconcileBaseline() diffs totals.json against the log rebuild and
// carries any excess as an unpriced "baseline" so pruned logs can never refund
// quota. Shrinking the JSONL without shrinking totals.json would therefore
// resurrect every removed token as baseline and cancel the refund. Subtract
// exactly what was removed per label, from the same run, atomically.
const TOTALS = path.join(LOG_DIR, 'totals.json');
if (!DRY && totalFixed > 0 && fs.existsSync(TOTALS)) {
  fs.copyFileSync(TOTALS, TOTALS + BAK_SUFFIX);
  const totals = JSON.parse(fs.readFileSync(TOTALS, 'utf8'));
  for (const [label, s] of Object.entries(perLabel)) {
    if (totals[label] && typeof totals[label].input_tokens === 'number') {
      totals[label].input_tokens = Math.max(0, totals[label].input_tokens - s.inputRemoved);
    }
  }
  fs.writeFileSync(TOTALS + '.tmp', JSON.stringify(totals, null, 2));
  fs.renameSync(TOTALS + '.tmp', TOTALS);
  console.log(`totals.json adjusted (backup: totals.json${BAK_SUFFIX})`);
}

if (!DRY) fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

console.log('\n---- summary ----');
console.log(`cutover: ${state.cutover}`);
console.log(`gpt rows seen: ${totalRows}, fixed: ${totalFixed}, post-cutover skipped: ${totalSkippedPostCutover}`);
for (const [label, s] of Object.entries(perLabel)) {
  console.log(`  ${label}: ${s.rows} rows, input tokens removed ${s.inputRemoved.toLocaleString()}, effective-token refund ${s.effectiveRefund.toLocaleString()} (weight 1.0 each; cached side stays at 0.1)`);
}
