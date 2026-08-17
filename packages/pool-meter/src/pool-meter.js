#!/usr/bin/env node
// pool-meter: metering auth reverse proxy in front of eliza pool proxy (18807)
// - validates x-api-key against pool-keys.json (multi-key, labeled)
// - forwards UNMODIFIED to 127.0.0.1:18807 (strips x-api-key)
// - streams SSE byte-for-byte (tee for usage parsing, never transforms)
// - appends JSONL usage logs (source of truth) + rolling totals.json (atomic)
// - v2: per-user x per-model x per-donor-account aggregates, cache-token aware,
//   rebuilt from the logs on boot; uptime + reputation scoring
// - GET /meter/stats (admin), GET /meter/me (any key, own usage only)
// No deps. Node stdlib only. No retries, no mutation of proxied bytes.
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const config = require('./lib/config.js');
const join = require('./lib/join.js');
const brokerClient = require('./lib/broker.js');
const page = require('./lib/join-page.js');
const { computeUtilization } = require('./lib/utilization.js');
const { Metrics, TOKEN_WEIGHTS, aliasFor } = require('./lib/metrics.js');
const pricing = require('./lib/pricing.js');
const { Reputation, PROBE_INTERVAL_MS } = require('./lib/reputation.js');
const { PoolShare } = require('./lib/poolshare.js');
const ledger = require('./lib/ledger.js');
const { ByoStore, PROVIDERS: BYO_PROVIDERS, knownProvider } = require('./lib/byo.js');
const { TraceStore, makeSseTextCollector } = require('./lib/trace.js');
const { applyOpenAiUsage, makeResponsesUsageParser } = require('./lib/openai-usage.js');
const account = require('./lib/account.js');
const accountPage = require('./lib/account-page.js');

const LISTEN_HOST = config.listenHost;
// Overridable so a staging copy can be exercised end-to-end on a scratch port
// without touching the live listener. Defaults to the production port.
const LISTEN_PORT = config.listenPort;
const UPSTREAM_HOST = config.upstreamHost;
const UPSTREAM_PORT = config.upstreamPort;
// OpenAI/Codex leg: pool-meter authenticates the SAME pool keys and forwards
// /openai/v1/* to the codex-proxy sibling (broker-emulation of Codex CLI).
// Receipt: projects/eliza-fleet/POOL-CODEX-2026-07-28.md R4.
const CODEX_HOST = process.env.CODEX_PROXY_HOST || '127.0.0.1';
const CODEX_PORT = parseInt(process.env.CODEX_PROXY_PORT || '18812', 10);
const KEYS_FILE = config.keysFile;
const DEFAULT_QUOTA = config.defaultQuota; // "leetmit" — all-time cap per key unless overridden
const LOG_DIR = config.logDir;
const TOTALS_FILE = path.join(LOG_DIR, 'totals.json');

fs.mkdirSync(LOG_DIR, { recursive: true });

// ---- keys (reload on change, cheap mtime check) ----
let keyMap = new Map(); // key -> {label, enabled, admin}
let keysMtime = 0;
function loadKeys() {
  try {
    const st = fs.statSync(KEYS_FILE);
    if (st.mtimeMs === keysMtime) return;
    const data = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    const m = new Map();
    for (const k of data.keys || []) {
      // `tier` drives both the quota gate and the model gate (lib/join.js is the
      // single source of truth). Keys minted before tiers existed have no tier
      // field and keep their previous unrestricted behavior.
      // `budgetUsd` is an OPTIONAL hard spend cap in dollars at API list
      // pricing. It is enforced only when present and positive; keys without
      // it are unchanged and gate on the effective-token quota alone.
      // `traces` is the per-key consent flag for trace capture. Pooled usage
      // defaults TRUE (donated quota is the deal); BYO traffic defaults FALSE
      // and only captures when the owner sets traces:true. Absent field ->
      // pooled default true, honored at capture time by the request path.
      if (k.key) m.set(k.key, { key: k.key, label: k.label || 'unlabeled', enabled: k.enabled !== false, admin: !!k.admin, tier: k.tier || null, donor: !!k.donor, quota: (typeof k.quota === 'number' && k.quota > 0) ? k.quota : DEFAULT_QUOTA, budgetUsd: (typeof k.budgetUsd === 'number' && k.budgetUsd > 0) ? k.budgetUsd : null, traces: (k.traces === false ? false : (k.traces === true ? true : null)) });
    }
    keyMap = m;
    keysMtime = st.mtimeMs;
  } catch (e) {
    console.error('keys load error:', e.message);
  }
}
loadKeys();
setInterval(loadKeys, 5000).unref();

// ---- totals (atomic write temp+rename) ----
let totals = {};
try { totals = JSON.parse(fs.readFileSync(TOTALS_FILE, 'utf8')); } catch (_) { totals = {}; }
let totalsDirty = false;
function bumpTotals(label, usage) {
  const t = totals[label] || (totals[label] = { requests: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_creation: 0, lastUsedAt: null });
  t.requests += 1;
  t.input_tokens += usage.input_tokens || 0;
  t.output_tokens += usage.output_tokens || 0;
  t.cache_read += usage.cache_read_input_tokens || 0;
  t.cache_creation += usage.cache_creation_input_tokens || 0;
  t.lastUsedAt = new Date().toISOString();
  totalsDirty = true;
}
function flushTotals() {
  if (!totalsDirty) return;
  totalsDirty = false;
  const tmp = TOTALS_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(totals, null, 2));
    fs.renameSync(tmp, TOTALS_FILE);
  } catch (e) { console.error('totals write error:', e.message); }
}
setInterval(flushTotals, 1000).unref();

// ---- v2 aggregates: per-user x per-model x per-donor-account ----
// The JSONL logs are the source of truth; this index is rebuilt from them at
// boot so a restart cannot lose history. See lib/metrics.js for why a baseline
// is diffed against totals.json (pruned logs must not refund quota).
const metrics = new Metrics({ logDir: LOG_DIR, totalsFile: TOTALS_FILE });
{
  const s = metrics.rebuild();
  console.log(`metrics: rebuilt from ${s.files} log files, ${s.records} records, ${s.skipped} skipped in ${s.ms}ms`);
  const carried = Object.keys(metrics.baseline);
  if (carried.length) console.log(`metrics: carried pre-log baseline for ${carried.length} label(s): ${carried.join(', ')}`);
}
setInterval(() => metrics.persist(), 15000).unref();

// ---- uptime + reputation ----
const reputation = new Reputation({ stateFile: path.join(LOG_DIR, 'reputation-state.json') });
setInterval(() => reputation.persist(), 30000).unref();

// ---- pool vs outside-pool capacity split ----
// Records the raw ingredients (weekly pct timeline + pool tokens served) on
// every broker poll. See lib/poolshare.js for why this publishes an upper
// bound rather than a point estimate today.
const poolShare = new PoolShare({
  stateFile: path.join(LOG_DIR, 'poolshare-state.json'),
  tokensPerPct: join.CAPACITY_TOKEN_VALUE,
});
setInterval(() => poolShare.persist(), 30000).unref();

// ---- payout ledger (PROTOTYPE) -------------------------------------------
// Holds no state: every figure is derived from the metrics index (itself
// rebuilt from the JSONL logs at boot), the keys file, and poolshare state.
// The snapshot below exists purely so the numbers are inspectable on disk
// without an admin key; it is written and never read back, so it can be
// deleted at any time and will reappear identical.
const LEDGER_SNAPSHOT_FILE = path.join(LOG_DIR, 'ledger-snapshot.json');
function buildLedgerReport({ identify = false } = {}) {
  return ledger.buildLedger({
    metrics,
    keys: join.listKeys ? join.listKeys() : [],
    poolShare,
    aliasFor,
    maskMember,
    identify,
  });
}
function persistLedgerSnapshot() {
  try {
    const snap = ledger.snapshot(buildLedgerReport({ identify: false }));
    const tmp = `${LEDGER_SNAPSHOT_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2));
    fs.renameSync(tmp, LEDGER_SNAPSHOT_FILE);
  } catch (e) { console.error('ledger: snapshot write failed:', e.message); }
}
setInterval(persistLedgerSnapshot, 120000).unref();
setTimeout(persistLedgerSnapshot, 20000).unref();

// ---- BYO credential store (Feature 1) + trace store (Feature 2) ----
// byoStore: encrypted-at-rest per-pool-key provider tokens, out of tree.
// traceStore: append-only JSONL capture, daily gzip rotation, 20G eviction cap.
const byoStore = new ByoStore({ secretsDir: config.secretsDir });
const traceStore = new TraceStore({
  dir: config.tracesDir,
  capBytes: config.tracesCapBytes,
  enabled: config.tracesEnabled,
});
console.log(`byo: store ready (creds out-of-tree, ${Object.keys(BYO_PROVIDERS).join('/')} providers)`);
console.log(`trace: store ${traceStore.enabled ? 'ENABLED' : 'disabled'} dir=${config.tracesDir} cap=${config.tracesCapBytes}B`);

// Decide whether to capture a trace for a given request.
//   pooled: default TRUE (donated quota is the deal), key.traces:false opts out.
//   byo:    default FALSE, key.traces:true opts in.
function shouldTrace(info, byo) {
  if (!traceStore.enabled) return false;
  if (byo) return info.traces === true;        // BYO: opt-in only
  return info.traces !== false;                // pooled: default on
}

function shutdown(code) {
  flushTotals();
  try { metrics.persist(); } catch (_) {}
  try { reputation.persist(); } catch (_) {}
  try { poolShare.persist(); } catch (_) {}
  if (code !== undefined) process.exit(code);
}
process.on('exit', () => shutdown());
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

// ---- jsonl log ----
function logRecord(rec) {
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(LOG_DIR, `usage-${day}.jsonl`);
  fs.appendFile(file, JSON.stringify(rec) + '\n', (e) => { if (e) console.error('jsonl append error:', e.message); });
  // Fold into the live index with the exact record that hit disk, so the
  // in-memory aggregates and a cold rebuild always agree.
  //
  // BYO records (rec.byo === true, label namespaced by byoLabel) are DELIBERATELY
  // kept out of the pooled metrics index / ledger / poolshare economics: they
  // burn the member's own token, not donated quota, so they must not appear as
  // pooled consumption or phantom members. They still land in the JSONL above
  // for audit and are separately rolled up from totals.json in /meter/stats.byo.
  if (rec.byo === true || (typeof rec.label === 'string' && rec.label.startsWith('\u0001byo\u0001'))) return;
  try { metrics.ingest(rec); } catch (e) { console.error('metrics ingest error:', e.message); }
}

// ---- usage extraction from SSE (tee, never transform) ----
// Parses "data: {...}" lines for message_start / message_delta usage.
function makeSseUsageParser(usage) {
  let buf = '';
  return function feed(chunk) {
    buf += chunk.toString('utf8');
    // keep buffer bounded; SSE lines are newline-delimited
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(payload); } catch (_) { continue; }
      try {
        if (obj.type === 'message_start' && obj.message && obj.message.usage) {
          const u = obj.message.usage;
          if (u.input_tokens != null) usage.input_tokens = u.input_tokens;
          if (u.output_tokens != null) usage.output_tokens = u.output_tokens;
          if (u.cache_creation_input_tokens != null) usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
          if (u.cache_read_input_tokens != null) usage.cache_read_input_tokens = u.cache_read_input_tokens;
        } else if (obj.type === 'message_delta' && obj.usage) {
          const u = obj.usage;
          if (u.output_tokens != null) usage.output_tokens = u.output_tokens;
          if (u.input_tokens != null) usage.input_tokens = u.input_tokens;
          if (u.cache_creation_input_tokens != null) usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
          if (u.cache_read_input_tokens != null) usage.cache_read_input_tokens = u.cache_read_input_tokens;
        }
      } catch (_) { /* metering must never break the stream */ }
    }
    if (buf.length > 1 << 20) buf = buf.slice(-65536); // safety bound
  };
}

// ---- public status pane (/status, /status.json) ----
// Read-only, no auth. The public shape is deliberately allowlisted.
// Broker is READ-ONLY from here and is never restarted or reconfigured by this
// service. Credentials come from config (env or out-of-tree secrets file) so
// nothing sensitive is ever committed.
const BROKER_HOST = config.brokerHost;
const BROKER_PORT = config.brokerPort;
const STATUS_TTL_MS = 5 * 60 * 1000;
const HEALTH_TTL_MS = 8 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SNAPSHOTS_FILE = path.join(LOG_DIR, 'usage-snapshots.jsonl');
const SNAPSHOT_MAX_LINES = 2000;
const METER_STARTED_AT = Date.now();
const EXPECTED_ANTHROPIC_ACCOUNTS = 6;
const STATUS_NOTICE = '';
let statusCache = { at: 0, data: null };
let statusInflight = null;

function fetchBrokerAccounts() {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: BROKER_HOST, port: BROKER_PORT, path: '/api/accounts', method: 'GET',
      headers: { Authorization: `Bearer ${config.brokerToken}` }, timeout: 10000,
    }, (bres) => {
      const chunks = [];
      let len = 0;
      bres.on('data', (c) => { if (len < (4 << 20)) { chunks.push(c); len += c.length; } });
      bres.on('end', () => {
        if (bres.statusCode !== 200) return reject(new Error(`broker http ${bres.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
      bres.on('error', reject);
    });
    r.on('timeout', () => r.destroy(new Error('broker timeout')));
    r.on('error', reject);
    r.end();
  });
}

// Live lease/health overlay from the broker's internal health endpoint.
// This is the authoritative "who is actually serving right now" source; the
// /api/accounts selection field can lag or disagree with real lease holders.
let healthCache = { at: 0, data: null };
function fetchBrokerHealth() {
  const now = Date.now();
  if (healthCache.data && now - healthCache.at < HEALTH_TTL_MS) return Promise.resolve(healthCache.data);
  return new Promise((resolve) => {
    const r = http.request({
      host: BROKER_HOST, port: BROKER_PORT, path: '/api/internal/account-pool/v1/health', method: 'GET',
      headers: { Authorization: `Bearer ${config.brokerInternalSecret}` }, timeout: 6000,
    }, (bres) => {
      const chunks = [];
      let len = 0;
      bres.on('data', (c) => { if (len < (2 << 20)) { chunks.push(c); len += c.length; } });
      bres.on('end', () => {
        if (bres.statusCode !== 200) return resolve(healthCache.data);
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          healthCache = { at: Date.now(), data };
          resolve(data);
        } catch (_) { resolve(healthCache.data); }
      });
      bres.on('error', () => resolve(healthCache.data));
    });
    r.on('timeout', () => { r.destroy(); resolve(healthCache.data); });
    r.on('error', () => resolve(healthCache.data));
    r.end();
  });
}

// Merge live lease state into a copy of the cached status rows.
function mergeLiveHealth(st, health) {
  const merged = { ...st, perAccount: st.perAccount.map((r) => ({ ...r })) };
  merged.liveLeases = null;
  if (!health || !health.accounts) return merged;
  let anthLeases = 0;
  for (const row of merged.perAccount) {
    if (!row.id) continue;
    const live = health.accounts[`anthropic-subscription:${row.id}`];
    if (!live) continue;
    row.activeLeaseCount = live.activeLeaseCount || 0;
    row.lastLeaseAt = typeof live.lastLeaseAt === 'number' ? live.lastLeaseAt : null;
    const rep = live.lastReportedStatus || null;
    row.lastReport = rep ? { ok: !!rep.ok, category: rep.category || null, reason: rep.reason || null, httpStatus: rep.httpStatus || null, atMs: rep.atMs || null } : null;
    anthLeases += row.activeLeaseCount;
    if (row.activeLeaseCount > 0) row.accountState = 'serving';
    else if (row.accountState === 'serving') row.accountState = 'standby';
  }
  const prov = (health.providers || []).find((p) => p.providerId === 'anthropic-subscription');
  merged.liveLeases = {
    anthropic: anthLeases,
    total: typeof health.activeLeases === 'number' ? health.activeLeases : anthLeases,
    lastSelection: prov && prov.lastSelection ? { accountId: prov.lastSelection.accountId, atMs: prov.lastSelection.atMs, reason: prov.lastSelection.reason } : null,
  };
  if (merged.liveLeases.lastSelection) {
    const sel = merged.perAccount.find((r) => r.id === merged.liveLeases.lastSelection.accountId);
    if (sel && sel.accountState !== 'serving' && sel.activeLeaseCount === 0) sel.accountState = 'last-selected';
  }
  return merged;
}

function agoText(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 15000) return 'just now';
  if (ms < 60000) return `${Math.round(ms / 1000)}s ago`;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ${mins % 60}m ago`;
  return `${Math.floor(h / 24)}d ${h % 24}h ago`;
}

function clampPct(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, v));
}

function durationText(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  if (ms <= 0) return 'now';
  const mins = Math.max(1, Math.round(ms / 60000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d) return `~${d}d ${h}h`;
  if (h) return `~${h}h ${m}m`;
  return `~${m}m`;
}

function resetText(ms) {
  const d = durationText(ms);
  return d === 'now' ? 'reset due' : (d ? `resets in ${d.replace(/^~/, '')}` : null);
}

function readSnapshots() {
  try {
    return fs.readFileSync(SNAPSHOTS_FILE, 'utf8').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

function appendSnapshot(st) {
  const snap = {
    ts: Date.now(),
    accounts: st.perAccount.map((a) => ({
      name: a.name, weeklyUsedPct: a.weeklyUsedPct, fableUsedPct: a.fableUsedPct,
      weeklyResetAt: a.weeklyResetAt,
    })),
  };
  try {
    fs.appendFileSync(SNAPSHOTS_FILE, JSON.stringify(snap) + '\n');
    const lines = fs.readFileSync(SNAPSHOTS_FILE, 'utf8').split('\n').filter(Boolean);
    if (lines.length > SNAPSHOT_MAX_LINES) {
      const tmp = SNAPSHOTS_FILE + '.tmp';
      fs.writeFileSync(tmp, lines.slice(-SNAPSHOT_MAX_LINES).join('\n') + '\n');
      fs.renameSync(tmp, SNAPSHOTS_FILE);
    }
    console.log(`status: usage snapshot appended (${Math.min(lines.length, SNAPSHOT_MAX_LINES)} retained)`);
  } catch (e) { console.error('status: snapshot write error:', e.message); }
}

// Which upstream provider served a model. The pool has exactly two legs:
// the anthropic subscription pool (claude-*) and the ChatGPT/Codex pool
// (gpt-*). Anything unrecognizable is legacy anthropic-era traffic.
function providerOfModel(model) {
  return /^gpt-/.test(String(model || '')) ? 'openai' : 'anthropic';
}

function aggregateMeterTotals() {
  // Dual-unit pool aggregate, built from the v2 index so tokens and dollars
  // come from the same source. Anonymous: totals only, never per-label.
  const day = new Date().toISOString().slice(0, 10);
  const all = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
  const today = { date: day, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
  const byModel = new Map();
  for (const name of metrics.allLabels()) {
    const t = metrics.totalFor(name);
    all.requests += t.requests; all.inputTokens += t.input; all.outputTokens += t.output;
    all.cacheReadTokens += t.cacheRead; all.cacheCreationTokens += t.cacheCreation; all.costUsd += t.costUsd || 0;
    const l = metrics.labels.get(name);
    if (!l) continue;
    const d = l.byDay[day];
    if (d) {
      today.requests += d.requests; today.inputTokens += d.input; today.outputTokens += d.output;
      today.cacheReadTokens += d.cacheRead; today.cacheCreationTokens += d.cacheCreation; today.costUsd += d.costUsd || 0;
    }
  }
  // Pool-wide spend by model: public and aggregate, no labels attached.
  // Provider split rides along so the status page can show the anthropic and
  // openai/codex legs separately without a second data source.
  const byProvider = {
    anthropic: { provider: 'anthropic', requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
    openai: { provider: 'openai', requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
  };
  for (const [model, c] of metrics.models) {
    const provider = providerOfModel(model);
    byModel.set(model, {
      model,
      provider,
      requests: c.requests,
      inputTokens: c.input,
      outputTokens: c.output,
      cacheReadTokens: c.cacheRead,
      cacheCreationTokens: c.cacheCreation,
      costUsd: pricing.usd(c.costUsd),
      costDisplay: pricing.fmtUsd(c.costUsd),
    });
    const p = byProvider[provider];
    p.requests += c.requests; p.inputTokens += c.input; p.outputTokens += c.output;
    p.cacheReadTokens += c.cacheRead; p.cacheCreationTokens += c.cacheCreation; p.costUsd += c.costUsd || 0;
  }
  for (const p of Object.values(byProvider)) {
    p.costDisplay = pricing.fmtUsd(p.costUsd);
    p.costUsd = pricing.usd(p.costUsd);
  }
  const models = Array.from(byModel.values()).sort((a, b) => b.costUsd - a.costUsd);
  all.costDisplay = pricing.fmtUsd(all.costUsd);
  all.costUsd = pricing.usd(all.costUsd);
  today.costDisplay = pricing.fmtUsd(today.costUsd);
  today.costUsd = pricing.usd(today.costUsd);
  return {
    today,
    allTime: all,
    byModel: models,
    byProvider,
    pricing: { lastVerified: pricing.LAST_VERIFIED, source: pricing.PRICING_SOURCE, note: 'USD at provider API list pricing (Anthropic for claude-*, OpenAI for gpt-*); what this traffic would have cost on metered API billing' },
  };
}

function getModelBuckets(u) {
  const source = u.weeklyModelBuckets || {};
  const result = { available: false, fable: null, sonnet: null };
  for (const [key, value] of Object.entries(source)) {
    const pct = clampPct(value && (value.pct ?? value.utilization));
    const bucket = pct === null ? null : { usedPct: pct, resetAt: typeof value.resetsAt === 'number' ? value.resetsAt : null };
    if (/fable/i.test(key)) result.fable = bucket;
    if (/sonnet/i.test(key)) result.sonnet = bucket;
  }
  result.available = !!(result.fable || result.sonnet);
  return result;
}

function calculateBurn(row, snapshots, now) {
  if (row.fableUsedPct === null || row.weeklyResetAt === null) return { ratePctPerHour: null, sampleHours: null };
  const candidates = [];
  for (const snap of snapshots) {
    const old = (snap.accounts || []).find((a) => a.name === row.name);
    if (!old || typeof snap.ts !== 'number' || snap.ts >= now) continue;
    // Broker reset timestamps can jitter by seconds across refreshes. A five-minute
    // tolerance identifies the same weekly boundary without crossing a real window.
    if (typeof old.weeklyResetAt !== 'number' || Math.abs(old.weeklyResetAt - row.weeklyResetAt) > 5 * 60000) continue;
    if (typeof old.fableUsedPct !== 'number' || old.fableUsedPct > row.fableUsedPct) continue;
    candidates.push({ ts: snap.ts, used: old.fableUsedPct });
  }
  if (!candidates.length) return { ratePctPerHour: null, sampleHours: null };
  candidates.sort((a, b) => a.ts - b.ts);
  const oldest = candidates[0];
  const hours = (now - oldest.ts) / 3600000;
  if (hours <= 0) return { ratePctPerHour: null, sampleHours: null };
  return { ratePctPerHour: Math.max(0, (row.fableUsedPct - oldest.used) / hours), sampleHours: hours };
}

function applyUrgency(st, snapshots) {
  const now = Date.now();
  let totalRate = 0;
  let knownRates = 0;
  for (const row of st.perAccount) {
    const burn = calculateBurn(row, snapshots, now);
    row.burnRatePctPerHour = burn.ratePctPerHour === null ? null : Number(burn.ratePctPerHour.toFixed(2));
    row.burnSampleHours = burn.sampleHours === null ? null : Number(burn.sampleHours.toFixed(2));
    const resetMs = row.weeklyResetAt === null ? null : row.weeklyResetAt - now;
    row.weeklyResetIn = resetText(resetMs);
    row.sessionResetIn = row.sessionResetAt === null ? null : resetText(row.sessionResetAt - now);
    let exhaustMs = null;
    if (row.fableUsedPct !== null && burn.ratePctPerHour > 0) exhaustMs = ((100 - row.fableUsedPct) / burn.ratePctPerHour) * 3600000;
    row.projectedExhaustionIn = exhaustMs === null ? null : durationText(exhaustMs);
    row.projectedBeforeReset = exhaustMs !== null && resetMs !== null ? exhaustMs < resetMs : null;
    if (row.fableUsedPct !== null && row.fableUsedPct >= 100) row.state = 'EXHAUSTED';
    else if (row.projectedBeforeReset === true) row.state = 'BURNING HOT';
    else if (row.fableUsedPct !== null && row.fableUsedPct <= 5) row.state = 'FRESH';
    else row.state = 'OK';
    if (burn.ratePctPerHour === null) row.exhaustionMessage = 'at current burn: estimating...';
    else if (burn.ratePctPerHour === 0 || row.projectedBeforeReset === false) row.exhaustionMessage = 'at current burn: will NOT run out before reset';
    else row.exhaustionMessage = `at current burn: runs out in ${durationText(exhaustMs)}`;
    if (burn.ratePctPerHour !== null) { totalRate += burn.ratePctPerHour; knownRates += 1; }
  }
  const rank = { EXHAUSTED: 0, 'BURNING HOT': 1, OK: 2, FRESH: 3 };
  st.perAccount.sort((a, b) => rank[a.state] - rank[b.state] || b.fableUsedPct - a.fableUsedPct);
  const next = st.perAccount.filter((a) => a.weeklyResetAt && a.weeklyResetAt > now).sort((a, b) => a.weeklyResetAt - b.weeklyResetAt)[0];
  const poolMs = totalRate > 0 ? st.fable.leftPct / totalRate * 3600000 : null;
  st.urgency = {
    burnRatePctPerHour: knownRates ? Number(totalRate.toFixed(2)) : null,
    projectedDepletionIn: poolMs === null ? null : durationText(poolMs),
    depletionMessage: !knownRates ? 'pool-wide burn: estimating...' : (totalRate === 0 ? 'pool-wide burn is currently flat' : `pool-wide capacity at current burn: ${durationText(poolMs)}`),
    nextRefill: next ? { account: next.name, in: durationText(next.weeklyResetAt - now), capacityAddedPct: 100 } : null,
  };
  // Public-safe aggregate series for the status sparkline. No broker identifiers.
  st.burnTrend = snapshots.slice(-24).map((snap) => {
    const values = (snap.accounts || []).map((a) => a.fableUsedPct).filter((v) => typeof v === 'number');
    return values.length && typeof snap.ts === 'number'
      ? { at: new Date(snap.ts).toISOString(), remainingPct: Number(values.reduce((sum, v) => sum + (100 - v), 0).toFixed(1)) }
      : null;
  }).filter(Boolean);
  st.burnTrend.push({ at: new Date(now).toISOString(), remainingPct: st.fable.leftPct });
}

// Build only public-safe, anonymized fields. Never spread broker objects here.
function buildStatus(raw, snapshots) {
  const prov = (raw.providers || []).find((p) => p.providerId === 'anthropic-subscription');
  if (!prov) throw new Error('anthropic-subscription provider missing');
  const accounts = (prov.accounts || []).filter((a) => a && a.enabled !== false);
  if (!accounts.length) throw new Error('no enabled accounts');
  const activeId = prov.selection ? prov.selection.activeAccountId : null;
  const now = Date.now();
  let fableLeft = 0;
  let allLeft = 0;
  let fableFromBucket = true;
  let lastRefreshed = 0;
  const rows = accounts.map((a, i) => {
    const u = a.usage || {};
    if (typeof u.refreshedAt === 'number') lastRefreshed = Math.max(lastRefreshed, u.refreshedAt);
    const weeklyAll = clampPct(u.weeklyPct);
    const modelBuckets = getModelBuckets(u);
    const fableUsed = modelBuckets.fable ? modelBuckets.fable.usedPct : weeklyAll;
    if (!modelBuckets.fable) fableFromBucket = false;
    if (fableUsed !== null) fableLeft += 100 - fableUsed;
    if (weeklyAll !== null) allLeft += 100 - weeklyAll;
    const weeklyResetAt = modelBuckets.fable && modelBuckets.fable.resetAt !== null
      ? modelBuckets.fable.resetAt
      : (typeof u.weeklyResetsAt === 'number' ? u.weeklyResetsAt : (typeof u.resetsAt === 'number' ? u.resetsAt : null));
    const sessionPct = clampPct(u.sessionPct);
    const isActive = !!(a.id && activeId && a.id === activeId);
    const obs = a.observability || {};
    const hd = a.healthDetail || {};
    return {
      name: `account-${i + 1}`,
      id: a.id || null,
      label: a.label || a.email || null,
      authHealth: a.health || null,
      authLastError: hd.lastError || null,
      activeLeaseCount: typeof obs.activeLeaseCount === 'number' ? obs.activeLeaseCount : 0,
      lastLeaseAt: typeof obs.lastLeaseAt === 'number' ? obs.lastLeaseAt : null,
      lastReport: null,
      accountState: fableUsed !== null && fableUsed >= 100 ? 'exhausted' : (isActive ? 'serving' : 'standby'),
      sessionUsedPct: sessionPct,
      sessionHeadroomPct: sessionPct === null ? null : Math.round(100 - sessionPct),
      sessionResetAt: typeof u.sessionResetsAt === 'number' ? u.sessionResetsAt : null,
      sessionResetIn: null,
      weeklyUsedPct: weeklyAll === null ? null : Number(weeklyAll.toFixed(1)),
      weeklyHeadroomPct: weeklyAll === null ? null : Number((100 - weeklyAll).toFixed(1)),
      weeklyResetAt,
      weeklyResetIn: null,
      fableUsedPct: fableUsed === null ? null : Number(fableUsed.toFixed(1)),
      modelBuckets: modelBuckets.available ? modelBuckets : { available: false, note: 'model split unavailable' },
    };
  });
  const codingProv = (raw.providers || []).find((p) => p.providerId === 'openai-codex');
  const codingAccounts = codingProv ? (codingProv.accounts || []).filter((a) => a && a.enabled !== false) : [];
  let codingRefresh = 0;
  const codingSessions = codingAccounts.map((a, i) => {
    const u = a.usage || {};
    if (typeof u.refreshedAt === 'number') codingRefresh = Math.max(codingRefresh, u.refreshedAt);
    const pct = clampPct(u.sessionPct);
    const weekly = clampPct(u.weeklyPct);
    return {
      name: `coding-${i + 1}`,
      // Same one-way alias scheme as the anthropic seats: stable, public-safe,
      // lets a donor find their own row without identifying anyone.
      seat: aliasFor(a.id || null),
      provider: 'openai',
      state: a.id && codingProv.selection && a.id === codingProv.selection.activeAccountId ? 'serving' : 'standby',
      sessionUsedPct: pct,
      sessionHeadroomPct: pct === null ? null : Math.round(100 - pct),
      weeklyUsedPct: weekly,
    };
  });
  const st = {
    updatedAt: new Date(now).toISOString(),
    usageRefreshedAt: lastRefreshed ? new Date(lastRefreshed).toISOString() : null,
    notice: STATUS_NOTICE,
    pool: { accounts: accounts.length, expectedAccounts: EXPECTED_ANTHROPIC_ACCOUNTS, missingAccounts: Math.max(0, EXPECTED_ANTHROPIC_ACCOUNTS - accounts.length), capacityPct: accounts.length * 100 },
    fable: { leftPct: Number(fableLeft.toFixed(1)), ofPct: accounts.length * 100, source: fableFromBucket ? 'Fable weekly window' : 'combined weekly window fallback' },
    allModels: { leftPct: Number(allLeft.toFixed(1)), ofPct: accounts.length * 100 },
    codingPool: { accounts: codingAccounts.length, usageRefreshedAt: codingRefresh ? new Date(codingRefresh).toISOString() : null, sessions: codingSessions },
    perAccount: rows,
    meter: aggregateMeterTotals(),
  };
  applyUrgency(st, snapshots);
  return st;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let ELIZA_MARK_SVG = '';
try { ELIZA_MARK_SVG = fs.readFileSync(path.join(PUBLIC_DIR, 'eliza-mark.svg'), 'utf8').replace('<svg ', '<svg class="mark" aria-hidden="true" '); } catch (_) {}

function fmtNum(n) { return Number(n || 0).toLocaleString('en-US'); }

function renderStatusHtmlOld(st) {
  const pct = (n) => n === null || n === undefined ? '—' : `${Math.round(n)}%`;
  const localReset = (ts) => {
    if (!ts) return '—';
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ts));
  };
  const stateLabel = (r) => r.state === 'BURNING HOT' ? 'hot' : r.state.toLowerCase();
  const rows = st.perAccount.map((r) => `<tr>
    <td><b>${esc(r.name)}</b><small>${esc(r.accountState)}</small></td>
    <td><span class="state ${esc(stateLabel(r))}">${esc(stateLabel(r))}</span></td>
    <td class="num">${pct(r.sessionHeadroomPct)}<small>${pct(r.sessionUsedPct)} used</small></td>
    <td class="num">${pct(r.weeklyHeadroomPct)}<small>${pct(r.weeklyUsedPct)} used</small></td>
    <td class="num fable">${pct(r.fableUsedPct === null ? null : 100-r.fableUsedPct)}<small>${pct(r.fableUsedPct)} used</small></td>
    <td><b>${esc(localReset(r.weeklyResetAt))}</b><small>${esc(r.weeklyResetIn || 'clock unavailable')}</small></td>
    <td class="num">${r.burnRatePctPerHour === null ? '—' : `${r.burnRatePctPerHour}%/h`}<small>${r.projectedBeforeReset ? `out ${esc(r.projectedExhaustionIn)}` : 'holds to reset'}</small></td>
  </tr>`).join('');
  const points = (st.burnTrend || []).slice(-24);
  let spark = '<span class="calibrating">collecting samples</span>';
  if (points.length > 1) {
    const vals = points.map((p) => p.remainingPct);
    const lo = Math.min(...vals), hi = Math.max(...vals), span = Math.max(1, hi-lo);
    const coords = vals.map((v,i) => `${(i/(vals.length-1)*300).toFixed(1)},${(42-(v-lo)/span*36).toFixed(1)}`).join(' ');
    spark = `<svg viewBox="0 0 300 48" role="img" aria-label="Fable remaining capacity trend"><polyline points="${coords}"/></svg>`;
  }
  const h = st.health;
  const next = st.urgency.nextRefill;
  const updated = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(new Date(st.updatedAt));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0b0d0c"><title>Pool status</title><style>
:root{color-scheme:dark;--bg:#0b0d0c;--pane:#111412;--ink:#edf1ea;--muted:#818981;--line:#293029;--green:#8ee0a8;--amber:#e9bc66;--red:#ef7d72}*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;color:var(--ink);font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}main{width:min(1040px,calc(100% - 28px));margin:clamp(18px,6vh,70px) auto}.pane{border:1px solid var(--line);background:var(--pane)}header{display:flex;justify-content:space-between;align-items:center;padding:13px 17px;border-bottom:1px solid var(--line);color:var(--muted)}.brand{color:var(--ink);font-weight:700}.live{color:${h.brokerReachable?'var(--green)':'var(--red)' }}.live:before{content:'●';margin-right:7px;font-size:9px}.hero{display:grid;grid-template-columns:1fr auto;gap:36px;padding:30px 32px;border-bottom:1px solid var(--line)}.label,small{display:block;color:var(--muted);font-size:10px;font-weight:400;text-transform:uppercase;letter-spacing:.06em}.capacity{display:flex;align-items:baseline;gap:12px;margin-top:3px}.capacity strong{font:600 clamp(54px,9vw,92px)/1 ui-monospace,SFMono-Regular,monospace;letter-spacing:-.08em;color:var(--green)}.capacity span{color:var(--muted)}.metrics{display:grid;grid-template-columns:repeat(3,minmax(110px,1fr));align-content:center}.metric{padding:5px 20px;border-left:1px solid var(--line)}.metric b{display:block;margin-top:6px;font-size:17px;font-weight:550}.trend{display:grid;grid-template-columns:140px 1fr;align-items:center;gap:24px;padding:13px 18px;border-bottom:1px solid var(--line)}svg{display:block;width:100%;height:48px}polyline{fill:none;stroke:var(--green);stroke-width:2;vector-effect:non-scaling-stroke}.calibrating{color:var(--muted)}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;white-space:nowrap}th{padding:10px 13px;color:var(--muted);font-size:10px;text-align:left;text-transform:uppercase;letter-spacing:.06em;font-weight:500;border-bottom:1px solid var(--line)}td{padding:12px 13px;border-bottom:1px solid var(--line);vertical-align:middle}tbody tr:last-child td{border-bottom:0}td small{margin-top:2px;letter-spacing:0;text-transform:none}.num{text-align:right}.fable{color:var(--green);font-weight:700}.state{display:inline-block;padding:2px 6px;border:1px solid var(--line);text-transform:uppercase;font-size:10px}.state.hot{color:var(--amber);border-color:#6a542e}.state.exhausted{color:var(--red);border-color:#6a3631}.state.fresh,.state.ok{color:var(--green)}footer{display:flex;justify-content:space-between;gap:20px;padding:11px 17px;border-top:1px solid var(--line);color:var(--muted);font-size:10px}a{color:var(--muted);text-underline-offset:3px}.notice{color:var(--amber)}@media(max-width:720px){main{width:100%;margin:0}.pane{border-width:0}.hero{grid-template-columns:1fr;padding:24px 17px}.metrics{grid-template-columns:repeat(3,1fr)}.metric{padding:5px 10px}.metric:first-child{border-left:0}.trend{grid-template-columns:100px 1fr}footer{flex-direction:column;gap:5px}}
</style></head><body><main><section class="pane"><header><span class="brand">POOL / FABLE</span><span class="live">${h.brokerReachable?'LIVE':'DEGRADED'}</span></header><div class="hero"><div><span class="label">aggregate weekly capacity remaining</span><div class="capacity"><strong>${Math.round(st.fable.leftPct)}%</strong><span>/ ${st.fable.ofPct}%</span></div></div><div class="metrics"><div class="metric"><span class="label">burn</span><b>${st.urgency.burnRatePctPerHour === null?'—':`${st.urgency.burnRatePctPerHour}%/h`}</b></div><div class="metric"><span class="label">runway</span><b>${esc(st.urgency.projectedDepletionIn || '—')}</b></div><div class="metric"><span class="label">next reset</span><b>${next?esc(next.in):'—'}</b></div></div></div><div class="trend"><div><span class="label">capacity trend</span><b>${points.length>1?`${points.length} samples`:'calibrating'}</b></div>${spark}</div><div class="table-wrap"><table><thead><tr><th>account</th><th>state</th><th class="num">session left</th><th class="num">weekly left</th><th class="num">fable left</th><th>weekly reset (EDT)</th><th class="num">burn</th></tr></thead><tbody>${rows}</tbody></table></div><footer><span class="notice">${esc(st.notice)} ${st.pool.accounts}/${st.pool.expectedAccounts} online.</span><span>updated ${esc(updated)} · ${h.snapshotAge} old · <a href="/status.json">json</a></span></footer></section></main></body></html>\n`;
}
function compactAge(ms) {
  if (ms < 60000) return '<1m';
  return durationText(ms).replace(/^~/, '');
}

function maskLabel(label) {
  if (!label) return null;
  const at = label.indexOf('@');
  if (at <= 0) return label.slice(0, 2) + '\u2022\u2022\u2022';
  const local = label.slice(0, at);
  const domain = label.slice(at);
  if (local.length <= 2) return local[0] + '\u2022\u2022' + domain;
  return local[0] + '\u2022\u2022\u2022' + local[local.length - 1] + domain;
}

// ---- inline chart helpers -------------------------------------------------
// Everything here emits plain SVG strings. No chart library, no outside
// requests: the page must render identically on a locked-down network and in a
// headless screenshot, so zero CDNs is a hard requirement, not a preference.

const MODEL_COLORS = ['#ff5800', '#fbbf24', '#4ade80', '#38bdf8', '#a78bfa', '#f472b6', '#94a3b8'];

function fmtCompact(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(v >= 1e10 ? 0 : 1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + 'k';
  return String(Math.round(v));
}

/**
 * Donut built from stroke-dasharray circles rather than arc <path> math.
 * A degenerate slice (zero, or one model at 100%) silently produces a broken
 * arc path but is harmless with dasharray, so this cannot render a mangled
 * chart on the day the pool serves exactly one model.
 */
function donutSvg(slices, opts) {
  const o = opts || {};
  const size = o.size || 172;
  const w = o.width || 21;
  const cx = size / 2;
  const r = (size - w) / 2 - 1;
  const C = 2 * Math.PI * r;
  const usable = slices.filter((s) => s.value > 0);
  const total = usable.reduce((a, s) => a + s.value, 0);
  const ring = `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="#1d1d1d" stroke-width="${w}"/>`;
  if (!(total > 0)) {
    return `<svg class="donut" viewBox="0 0 ${size} ${size}" role="img" aria-label="no metered traffic yet">${ring}</svg>`;
  }
  let acc = 0;
  const segs = usable.map((s) => {
    const frac = s.value / total;
    const full = frac * C;
    const dash = usable.length > 1 ? Math.max(1, full - 2) : full;
    const el = `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${w}"`
      + ` stroke-dasharray="${dash.toFixed(2)} ${(C - dash).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}"`
      + ` transform="rotate(-90 ${cx} ${cx})"><title>${esc(s.label)}</title></circle>`;
    acc += full;
    return el;
  }).join('');
  return `<svg class="donut" viewBox="0 0 ${size} ${size}" role="img" aria-label="request mix by model">${ring}${segs}</svg>`;
}

/** Filled sparkline for the pool capacity trend. */
function sparkSvg(values, max) {
  const vals = (values || []).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (vals.length < 2) return '';
  const w = 300;
  const h = 46;
  const top = Math.max(max || 0, ...vals) || 1;
  const step = w / (vals.length - 1);
  const pts = vals.map((v, i) => [i * step, h - (v / top) * (h - 5) - 2]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = `${line} L ${w} ${h} L 0 ${h} Z`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">`
    + `<defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="#ff5800" stop-opacity=".38"/><stop offset="1" stop-color="#ff5800" stop-opacity="0"/>`
    + `</linearGradient></defs>`
    + `<path d="${area}" fill="url(#sg)"/><path d="${line}" fill="none" stroke="#ff5800" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

// ---- ElizaOS-themed status page (v3: public recruiting dashboard) ----------
function renderStatusHtml(st, authed) {
  const now = Date.now();
  const rel = (ts) => {
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
    const ms = ts - now;
    if (ms <= 0) return 'due';
    const mins = Math.max(1, Math.round(ms / 60000));
    const d = Math.floor(mins / 1440);
    const hh = Math.floor((mins % 1440) / 60);
    const mm = mins % 60;
    if (d) return `${d}d ${hh}h`;
    if (hh) return `${hh}h ${mm}m`;
    return `${mm}m`;
  };
  const localReset = (ts) => {
    if (!ts) return '';
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(ts));
  };
  const meterCell = (used, cls, extraCls) => {
    const td = `td class="num${extraCls ? ' ' + extraCls : ''}"`;
    if (used === null || used === undefined) return `<${td}>\u2014</td>`;
    const u = Math.max(0, Math.min(100, used));
    return `<${td}><span class="meter"><span class="track"><i class="${cls}" style="width:${u}%"></i></span><b>${Math.round(u)}%</b></span></td>`;
  };

  const h = st.health;
  const live = st.liveLeases;
  const totalLeases = live ? live.anthropic : null;
  const meter = st.meter || { today: {}, allTime: {}, byModel: [] };
  const allTime = meter.allTime || {};
  const today = meter.today || {};
  const models = meter.byModel || [];
  const byProvider = meter.byProvider || {};
  const provAnth = byProvider.anthropic || null;
  const provOai = byProvider.openai || null;
  const codingPool = st.codingPool || { accounts: 0, sessions: [] };

  const totalTokens = (allTime.inputTokens || 0) + (allTime.outputTokens || 0)
    + (allTime.cacheReadTokens || 0) + (allTime.cacheCreationTokens || 0);
  const capLeft = st.fable.ofPct ? Math.max(0, Math.min(100, (st.fable.leftPct / st.fable.ofPct) * 100)) : null;

  // ---- model mix -----------------------------------------------------------
  const TOP = 6;
  const ranked = [...models].sort((a, b) => b.requests - a.requests);
  const shown = ranked.slice(0, TOP);
  const rest = ranked.slice(TOP);
  if (rest.length) {
    shown.push({
      model: `${rest.length} other`,
      requests: rest.reduce((a, m) => a + m.requests, 0),
      inputTokens: rest.reduce((a, m) => a + m.inputTokens, 0),
      outputTokens: rest.reduce((a, m) => a + m.outputTokens, 0),
      cacheReadTokens: rest.reduce((a, m) => a + m.cacheReadTokens, 0),
      cacheCreationTokens: rest.reduce((a, m) => a + m.cacheCreationTokens, 0),
      costUsd: rest.reduce((a, m) => a + (m.costUsd || 0), 0),
      costDisplay: pricing.fmtUsd(rest.reduce((a, m) => a + (m.costUsd || 0), 0)),
    });
  }
  const mixTotalReq = shown.reduce((a, m) => a + m.requests, 0);
  const tokensOf = (m) => (m.inputTokens || 0) + (m.outputTokens || 0) + (m.cacheReadTokens || 0) + (m.cacheCreationTokens || 0);
  const maxTok = Math.max(1, ...shown.map(tokensOf));
  const donut = donutSvg(shown.map((m, i) => ({ label: m.model, value: m.requests, color: MODEL_COLORS[i % MODEL_COLORS.length] })));
  const legend = shown.map((m, i) => {
    const color = MODEL_COLORS[i % MODEL_COLORS.length];
    const reqPct = mixTotalReq ? (m.requests / mixTotalReq) * 100 : 0;
    const tok = tokensOf(m);
    const ptag = m.provider === 'openai' ? ' <em class="ptag oai">openai</em>' : '';
    return `<li>
      <span class="sw" style="background:${color}"></span>
      <span class="mname" title="${esc(m.model)}${m.provider ? ' \u00b7 served via ' + esc(m.provider) + ' pool' : ''}">${esc(m.model)}${ptag}</span>
      <span class="mreq">${fmtNum(m.requests)} <small>${reqPct.toFixed(reqPct < 10 ? 1 : 0)}%</small></span>
      <span class="mbar"><i style="width:${((tok / maxTok) * 100).toFixed(1)}%;background:${color}"></i></span>
      <span class="mtok">${fmtCompact(tok)}</span>
      <span class="mcost">${esc(m.costDisplay || '\u2014')}</span>
    </li>`;
  }).join('');

  // ---- seat reliability + pool vs outside-pool split -----------------------
  const splitBySeat = poolShare.publicBySeat();
  const aliasToRow = new Map();
  for (const r of st.perAccount) if (r.id) aliasToRow.set(aliasFor(r.id), r);
  const seatIds = Object.keys(reputation.state.seats);
  const seatRows = seatIds.map((id) => {
    const u = reputation.seatUptime(id);
    return { u, row: aliasToRow.get(u.alias) || null, split: splitBySeat[u.alias] || null };
  }).sort((a, b) => (b.u.uptimePct || 0) - (a.u.uptimePct || 0) || String(a.u.alias).localeCompare(String(b.u.alias)));

  const seatCards = seatRows.map(({ u, row, split }) => {
    const up = u.uptimePct;
    const dot = u.provisional ? 'prov' : (up === null ? 'prov' : up >= 99 ? 'ok' : up >= 90 ? 'warn' : 'err');
    const health = row ? row.authHealth : u.health;
    const serving = row && (row.accountState === 'serving' || (row.activeLeaseCount || 0) > 0);
    const stateTxt = serving ? 'serving' : (row && row.fableUsedPct !== null && row.fableUsedPct >= 100 ? 'drained' : (health === 'rate-limited' ? 'rate limited' : 'standby'));

    let splitHtml;
    if (!split || split.consumedPctObserved === null || split.consumedPctObserved === undefined) {
      splitHtml = '<div class="nosplit">collecting first samples for this weekly window</div>';
    } else if (split.poolSharePctUpperBound === null) {
      // The weekly meter has not moved a whole point yet, so a share cannot be
      // computed in either direction. Show the ingredients instead of a bar
      // that would imply a split we have not measured.
      splitHtml = `<div class="split">
        <div class="split-head"><span>pool vs outside</span><span class="bd wait" title="Anthropic reports weekly capacity in whole percentage points. This seat has not burned a full point yet, so neither a pool share nor an outside share can be computed.">no signal yet</span></div>
        <div class="split-meta">${split.poolEffectiveTokens ? fmtCompact(split.poolEffectiveTokens) + ' eff tokens via pool \u00b7 ' : ''}weekly meter has not moved a full point yet</div>
      </div>`;
    } else {
      const poolPct = split.estimable ? split.poolSharePct : split.poolSharePctUpperBound;
      const outPct = split.outsideSharePctLowerBound;
      const badge = split.estimable
        ? `<span class="bd est" title="calibrated from ${split.calibrationWindows} observed meter step(s); confidence ${split.confidence}">estimate \u00b7 ${esc(split.confidence)}</span>`
        : '<span class="bd bound" title="pool traffic on this seat has not yet moved Anthropic\'s whole-percent capacity meter, so no point estimate is possible. This is a ceiling derived from a deliberately conservative tokens-per-percent constant: true pool share is at or below it.">upper bound</span>';
      const fmtShare = (v) => (v === null || v === undefined ? '\u2014' : (v < 0.01 && v > 0 ? '<0.01' : Number(v).toFixed(v < 10 ? 2 : 0)) + '%');
      splitHtml = `<div class="split">
        <div class="split-head"><span>pool vs outside</span>${badge}</div>
        <div class="split-bar" role="img" aria-label="pool share ${fmtShare(poolPct)}, outside share ${fmtShare(outPct)}"><i style="width:${Math.max(Number(poolPct) || 0, (Number(poolPct) || 0) > 0 ? 1.5 : 0)}%"></i></div>
        <div class="split-lbl"><span class="p">pool ${split.estimable ? '' : '\u2264'}${fmtShare(poolPct)}</span><span class="o">outside ${split.estimable ? '' : '\u2265'}${fmtShare(outPct)}</span></div>
        <div class="split-meta">${fmtCompact(split.poolEffectiveTokens)} eff tokens via pool \u00b7 ${split.consumedPctObserved}pp burned this window</div>
      </div>`;
    }

    return `<div class="seat">
      <div class="seat-top">
        <span class="dot ${dot}" title="seeding uptime ${up === null ? 'unknown' : up + '%'}"></span>
        <b class="alias">${esc(u.alias)}</b>
        <span class="seat-state ${serving ? 'on' : ''}">${esc(stateTxt)}</span>
      </div>
      <div class="seat-nums">
        <div><span>seeding uptime</span><b>${up === null ? '\u2014' : up + '%'}</b></div>
        <div><span>samples</span><b>${fmtNum(u.samples)}${u.provisional ? '<em> prov</em>' : ''}</b></div>
        <div><span>seeding</span><b>${u.seedingDays >= 1 ? u.seedingDays.toFixed(1) + 'd' : Math.round((u.seedingDays || 0) * 24) + 'h'}</b></div>
      </div>
      ${splitHtml}
    </div>`;
  }).join('') || '<div class="nosplit">no donated seats yet</div>';

  // ---- account table (unchanged semantics) ---------------------------------
  const hasFable = st.perAccount.some((r) => r.modelBuckets && r.modelBuckets.available && r.modelBuckets.fable);
  const sorted = [...st.perAccount].sort((a, b) => {
    const av = typeof a.weeklyResetAt === 'number' ? a.weeklyResetAt : Infinity;
    const bv = typeof b.weeklyResetAt === 'number' ? b.weeklyResetAt : Infinity;
    return av - bv;
  });
  const rows = sorted.map((r) => {
    const name = authed ? (r.label || r.name) : (r.id ? aliasFor(r.id) : r.name);
    const leaseN = typeof r.activeLeaseCount === 'number' ? r.activeLeaseCount : 0;
    const serving = r.accountState === 'serving' || leaseN > 0;
    const exhausted = r.fableUsedPct !== null && r.fableUsedPct >= 100;
    const badgeCls = serving ? 'serving' : exhausted ? 'exhausted' : 'standby';
    const badgeTxt = serving ? 'active' : exhausted ? 'exhausted' : (r.accountState === 'last-selected' ? 'selected' : 'standby');
    const authOk = r.authHealth === 'ok' || r.authHealth === null;
    const fableUsed = (r.modelBuckets && r.modelBuckets.available && r.modelBuckets.fable) ? r.modelBuckets.fable.usedPct : null;
    const lastLease = r.lastLeaseAt ? agoText(now - r.lastLeaseAt) : 'never';
    const weeklyRel = rel(r.weeklyResetAt);
    const sessionRel = rel(r.sessionResetAt);
    return `<tr class="${serving ? 'is-serving' : ''}${exhausted ? ' is-exhausted' : ''}">
      <td class="acct">${esc(name)}</td>
      <td class="sm-hide"><span class="prov anth">claude</span></td>
      <td><span class="badge ${badgeCls}">${badgeTxt}</span></td>
      <td class="num leases sm-hide"><b>${leaseN}</b></td>
      <td class="reset"><b>${weeklyRel === null ? '\u2014' : esc(weeklyRel)}</b><small>${esc(localReset(r.weeklyResetAt))}${r.weeklyResetAt ? ' ET' : ''}</small></td>
      ${meterCell(r.sessionUsedPct, 'u-session', 'xs-hide')}
      ${meterCell(r.weeklyUsedPct, 'u-weekly')}
      ${hasFable ? meterCell(fableUsed, 'u-fable', 'xs-hide') : ''}
      <td class="num xs-hide">${sessionRel === null ? '\u2014' : esc(sessionRel)}</td>
      <td class="xs-hide muted">${esc(lastLease)}</td>
      <td class="num sm-hide"><span class="dot2 ${authOk ? 'ok' : 'err'}" title="${authOk ? 'auth ok' : 'auth ' + esc(r.authHealth)}"></span></td>
    </tr>`;
  }).join('');

  // ChatGPT/Codex seats join the same table. The broker reports session (5h)
  // and weekly windows for these but no fable bucket, leases, or reset
  // timestamps yet — those cells honestly show a dash rather than pretend.
  const codexRows = (codingPool.sessions || []).map((s) => {
    const serving = s.state === 'serving';
    return `<tr class="${serving ? 'is-serving' : ''}">
      <td class="acct">${esc(s.seat || s.name)}</td>
      <td class="sm-hide"><span class="prov oai">chatgpt</span></td>
      <td><span class="badge ${serving ? 'serving' : 'standby'}">${serving ? 'active' : 'standby'}</span></td>
      <td class="num leases sm-hide"><b>\u2014</b></td>
      <td class="reset"><b>\u2014</b><small></small></td>
      ${meterCell(s.sessionUsedPct, 'u-session', 'xs-hide')}
      ${meterCell(s.weeklyUsedPct, 'u-weekly')}
      ${hasFable ? '<td class="num xs-hide">\u2014</td>' : ''}
      <td class="num xs-hide">\u2014</td>
      <td class="xs-hide muted">\u2014</td>
      <td class="num sm-hide"><span class="dot2 ok" title="auth ok"></span></td>
    </tr>`;
  }).join('');

  // ---- per-seat served usage (public: aliases + aggregates only) -----------
  const codexAliasSet = new Set((codingPool.sessions || []).map((s) => s.seat).filter(Boolean));
  const anthAliasSet = new Set(st.perAccount.map((r) => (r.id ? aliasFor(r.id) : null)).filter(Boolean));
  const seatServed = metrics.publicSeatReport();
  const seatProvider = (alias) => (codexAliasSet.has(alias) ? 'openai' : (anthAliasSet.has(alias) ? 'anthropic' : null));
  const servedRows = seatServed.map((s) => {
    const prov = seatProvider(s.seat);
    const provBadge = prov === 'openai'
      ? '<span class="prov oai">chatgpt</span>'
      : prov === 'anthropic' ? '<span class="prov anth">claude</span>' : '<span class="prov gone">former</span>';
    const lastUsed = s.lastSeen ? agoText(now - new Date(s.lastSeen).getTime()) : 'never';
    return `<tr>
      <td class="acct">${esc(s.seat)}</td>
      <td>${provBadge}</td>
      <td class="num">${fmtNum(s.requests)}</td>
      <td class="num sm-hide">${fmtCompact(s.inputTokens)}</td>
      <td class="num sm-hide">${fmtCompact(s.outputTokens)}</td>
      <td class="num xs-hide">${fmtCompact(s.cacheReadTokens)}</td>
      <td class="num">${fmtCompact(s.rawTokens)}</td>
      <td class="num"><b>${esc(s.costDisplay)}</b></td>
      <td class="muted xs-hide">${esc(lastUsed)}</td>
    </tr>`;
  }).join('');

  const updated = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date());
  const next = st.urgency.nextRefill;
  const upstreamPct = (() => { try { return reputation.probeWindow(24).uptimePct; } catch (_) { return null; } })();
  const spark = sparkSvg((st.burnTrend || []).map((p) => p.remainingPct), st.fable.ofPct);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0a0a0a"><link rel="icon" type="image/svg+xml" href="/eliza-mark.svg"><title>Eliza Account Pool \u2014 status</title><style>
:root{color-scheme:dark;--bg:#0a0a0a;--card:#141414;--card2:#181818;--ink:#f5f5f5;--muted:#8a8a8a;--dim:#6b6b6b;--line:#262626;--orange:#ff5800;--green:#4ade80;--red:#f87171;--amber:#fbbf24;--blue:#38bdf8}
*{box-sizing:border-box}html{background:var(--bg)}
body{margin:0;color:var(--ink);font:14px/1.5 -apple-system,'Segoe UI',Inter,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{width:min(1120px,calc(100% - 28px));margin:0 auto;padding:18px 0 56px}
.top{display:flex;align-items:center;gap:12px;padding:12px 0 14px;border-bottom:1px solid var(--line)}
.top svg.mark{width:30px;height:35px;flex:none}
.top h1{margin:0;font-size:17px;font-weight:650;letter-spacing:-.01em}
.top h1 small{display:block;font-size:10.5px;font-weight:500;color:var(--muted);letter-spacing:.05em;text-transform:uppercase}
.live{margin-left:auto;display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:${h.brokerReachable ? 'var(--green)' : 'var(--red)'}}
.live i{width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 8px currentColor}
.notice{margin:14px 0 0;padding:9px 13px;border:1px solid #3a2a12;background:#1a1206;border-radius:10px;font-size:12px;color:#e8c99a}
.hero{display:grid;grid-template-columns:1.15fr 1fr;gap:12px;margin:14px 0 12px}
.mega{display:grid;grid-template-columns:auto 1fr;gap:30px;align-items:center;margin:12px 0;padding:22px 26px;background:linear-gradient(135deg,#161616 0%,#101010 55%,#141010 100%);border:1px solid var(--line);border-radius:16px;position:relative;overflow:hidden}
.mega:before{content:'';position:absolute;top:-40%;right:-10%;width:55%;height:180%;background:radial-gradient(closest-side,rgba(255,88,0,.09),transparent);pointer-events:none}
.gauge-wrap{position:relative;width:190px;height:190px;flex:none}
.gauge-wrap svg{width:190px;height:190px;display:block;transform:rotate(-90deg)}
.gauge-bg{fill:none;stroke:#242424;stroke-width:13}
.gauge-fg{fill:none;stroke:url(#gaugeGrad);stroke-width:13;stroke-linecap:round;transition:stroke-dashoffset .6s ease}
.gauge-c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.gauge-c b{font-size:44px;font-weight:700;letter-spacing:-.04em;font-variant-numeric:tabular-nums;color:var(--ink);line-height:1}
.gauge-c span{margin-top:5px;font-size:9.5px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.mega-right{min-width:0}
.mega-usd{font-size:clamp(34px,5vw,52px);font-weight:700;letter-spacing:-.035em;color:var(--orange);font-variant-numeric:tabular-nums;line-height:1.05}
.mega-usd small{display:block;font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:7px}
.mega-sub{margin-top:6px;font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.mega-sub b{color:var(--ink);font-weight:600}
.mega-pills{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.pill{display:flex;flex-direction:column;gap:2px;padding:8px 14px;background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:10px;min-width:96px}
.pill span{font-size:9px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.07em}
.pill b{font-size:16px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.pill b.burn-hot{color:var(--amber)}
.mega .spark{margin-top:12px;height:38px}
@media(max-width:760px){.mega{grid-template-columns:1fr;gap:18px;padding:18px}.gauge-wrap{margin:0 auto}}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.lbl{display:block;font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.big{margin-top:6px;font-size:46px;line-height:1.02;font-weight:680;letter-spacing:-.035em;color:var(--orange);font-variant-numeric:tabular-nums}
.hero .sub{margin-top:8px;font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.hero .sub b{color:var(--ink);font-weight:600}
.hero .fine{margin-top:9px;font-size:10.5px;color:var(--dim);line-height:1.45}
.cap-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.cap-head b{font-size:30px;font-weight:680;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.cap-bar{margin-top:9px;height:9px;border-radius:99px;background:#242424;overflow:hidden}
.cap-bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#ff5800,#ffa050)}
.cap-foot{margin-top:7px;font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
.spark{display:block;width:100%;height:46px;margin-top:10px}
.stats{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:12px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 13px}
.stat span{display:block;font-size:9.5px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.07em}
.stat b{display:block;margin-top:4px;font-size:19px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.stat b.o{color:var(--orange)}.stat b.g{color:var(--green)}
h2{margin:0 0 12px;font-size:12px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
h2 em{font-style:normal;color:var(--dim);font-weight:500;text-transform:none;letter-spacing:0}
.panel{margin-bottom:12px}
.mix{display:grid;grid-template-columns:190px 1fr;gap:20px;align-items:center}
.donut-wrap{position:relative;width:172px;height:172px;margin:0 auto}
.donut{width:172px;height:172px;display:block}
.dc{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;pointer-events:none}
.dc b{font-size:22px;font-weight:680;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.dc span{font-size:9.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;margin-top:2px}
ul.legend{list-style:none;margin:0;padding:0;font-variant-numeric:tabular-nums}
ul.legend li{display:grid;grid-template-columns:12px minmax(96px,1.5fr) 74px 1fr 52px 62px;align-items:center;gap:9px;padding:6px 0;border-bottom:1px solid #1e1e1e;font-size:12.5px}
ul.legend li:last-child{border-bottom:0}
.sw{width:9px;height:9px;border-radius:2px}
.mname{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mreq{text-align:right;color:var(--ink)}.mreq small{color:var(--dim);font-size:10.5px}
.mbar{height:6px;border-radius:99px;background:#212121;overflow:hidden}
.mbar i{display:block;height:100%;border-radius:99px;opacity:.85}
.mtok{text-align:right;color:var(--muted);font-size:11.5px}
.mcost{text-align:right;font-weight:650}
.seats{display:grid;grid-template-columns:repeat(auto-fill,minmax(248px,1fr));gap:10px}
.seat{background:var(--card2);border:1px solid var(--line);border-radius:12px;padding:12px 13px}
.seat-top{display:flex;align-items:center;gap:8px}
.alias{font-size:13px;font-weight:650;letter-spacing:-.01em}
.seat-state{margin-left:auto;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}
.seat-state.on{color:var(--orange)}
.dot{width:9px;height:9px;border-radius:50%;flex:none}
.dot.ok{background:var(--green);box-shadow:0 0 7px rgba(74,222,128,.7)}
.dot.warn{background:var(--amber)}.dot.err{background:var(--red);box-shadow:0 0 7px var(--red)}.dot.prov{background:#4b4b4b}
.seat-nums{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:10px 0 2px}
.seat-nums span{display:block;font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.seat-nums b{font-size:14px;font-weight:650;font-variant-numeric:tabular-nums}
.seat-nums em{font-style:normal;font-size:9px;color:var(--dim);font-weight:500}
.split{margin-top:10px;padding-top:9px;border-top:1px solid #232323}
.split-head{display:flex;align-items:center;gap:6px;font-size:9.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.bd{margin-left:auto;padding:1px 6px;border-radius:99px;font-size:8.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;cursor:help}
.bd.bound{background:#2a2210;color:#e0b968;border:1px solid #3d3216}
.bd.est{background:#0f2a1a;color:var(--green);border:1px solid #1c4430}
.bd.wait{background:#1c1c1c;color:var(--dim);border:1px solid #2c2c2c}
.split-bar{margin-top:7px;height:8px;border-radius:99px;background:#3a3a3a;overflow:hidden}
.split-bar i{display:block;height:100%;border-radius:99px;background:var(--orange);min-width:0}
.split-lbl{display:flex;justify-content:space-between;margin-top:5px;font-size:10.5px;font-variant-numeric:tabular-nums}
.split-lbl .p{color:var(--orange);font-weight:650}.split-lbl .o{color:var(--muted)}
.split-meta{margin-top:5px;font-size:9.5px;color:var(--dim);font-variant-numeric:tabular-nums}
.nosplit{margin-top:9px;font-size:11px;color:var(--dim)}
.method{margin-top:11px;font-size:10.5px;color:var(--dim);line-height:1.5}
.table-wrap{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow-x:auto}
table{width:100%;border-collapse:collapse;white-space:nowrap;font-size:13px}
th{padding:11px 14px;font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;text-align:left;border-bottom:1px solid var(--line)}
th.num{text-align:right}th.sorted{color:var(--orange)}
td{padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:middle;font-variant-numeric:tabular-nums}
tbody tr:last-child td{border-bottom:0}
tbody tr.is-serving td{background:rgba(255,88,0,.07)}
tbody tr.is-serving td:first-child{box-shadow:inset 3px 0 0 var(--orange)}
tbody tr.is-exhausted td{opacity:.55}
td.num{text-align:right}td.muted{color:var(--muted)}
.acct{font-weight:600}
.badge{display:inline-block;padding:3px 10px;border-radius:99px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;border:1px solid var(--line);color:var(--muted)}
.badge.serving{background:var(--orange);border-color:var(--orange);color:#fff}
.badge.exhausted{border-color:var(--red);color:var(--red)}
.leases b{font-size:16px;font-weight:700}
tr.is-serving .leases b{color:var(--orange)}
.reset b{display:block;font-weight:650}.reset small{display:block;font-size:10px;color:var(--muted)}
.meter{display:inline-flex;align-items:center;gap:8px}
.meter b{min-width:36px;text-align:right;font-weight:600}
.track{display:inline-block;width:60px;height:5px;border-radius:99px;background:#242424;overflow:hidden}
.track i{display:block;height:100%;border-radius:99px;background:var(--muted)}
.track .u-fable{background:var(--orange)}.track .u-weekly{background:#c2410c}.track .u-session{background:#525252}
.dot2{display:inline-block;width:9px;height:9px;border-radius:50%}
.dot2.ok{background:var(--green)}.dot2.err{background:var(--red);box-shadow:0 0 7px var(--red)}
.prov{display:inline-block;padding:2px 8px;border-radius:99px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;border:1px solid var(--line)}
.prov.anth{color:var(--orange);border-color:#3d2212;background:rgba(255,88,0,.08)}
.prov.oai{color:var(--blue);border-color:#123240;background:rgba(56,189,248,.08)}
.prov.gone{color:var(--dim);background:#161616}
.ptag{font-style:normal;font-size:8.5px;font-weight:700;color:var(--blue);letter-spacing:.05em;text-transform:uppercase;margin-left:5px;vertical-align:1px}
.provsplit{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
.provcard{display:flex;flex-direction:column;gap:2px;padding:10px 14px;background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:10px}
.provcard span{font-size:9px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.07em}
.provcard b{font-size:17px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.provcard small{font-size:10.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.provcard.anth b{color:var(--orange)}.provcard.oai b{color:var(--blue)}
@media(max-width:560px){.provsplit{grid-template-columns:1fr}}
.foot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;margin-top:18px;font-size:11px;color:var(--muted)}
.foot a{color:var(--muted)}
@media(max-width:900px){.stats{grid-template-columns:repeat(3,1fr)}.hero{grid-template-columns:1fr}}
@media(max-width:680px){.xs-hide{display:none}.track{width:44px}td,th{padding:10px 10px}
 .mix{grid-template-columns:1fr;gap:14px}
 ul.legend li{grid-template-columns:11px 1fr 62px 46px 56px;gap:8px}
 .mbar{display:none}}
@media(max-width:430px){main{width:calc(100% - 22px);padding-top:14px}
 .stats{grid-template-columns:repeat(2,1fr)}
 .big{font-size:38px}
 .card{padding:14px}
 .seats{grid-template-columns:1fr}
 ul.legend li{font-size:12px}
 /* The seat cards above already carry lease + auth state, so the table can
    drop those columns and fit the phone instead of scrolling sideways. */
 .sm-hide{display:none}
 td,th{padding:9px 8px}
 .track{width:38px}
 .meter{gap:6px}.meter b{min-width:30px}
 .reset small{font-size:9.5px}}
</style></head><body><main>
<div class="top">${ELIZA_MARK_SVG}<h1>Eliza Account Pool<small>shared claude + chatgpt capacity \u00b7 elizaOS</small></h1><span class="live"><i></i>${h.brokerReachable ? 'live' : 'degraded'}</span></div>
${st.notice ? `<p class="notice">${esc(st.notice)}</p>` : ''}
<section class="mega">
  <div class="gauge-wrap">
    <svg viewBox="0 0 190 190">
      <defs><linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ff5800"/><stop offset="100%" stop-color="#ffa050"/></linearGradient></defs>
      <circle class="gauge-bg" cx="95" cy="95" r="82"/>
      <circle class="gauge-fg" cx="95" cy="95" r="82" stroke-dasharray="515.2" stroke-dashoffset="${capLeft === null ? 515.2 : (515.2 * (1 - Math.max(0, Math.min(100, capLeft)) / 100)).toFixed(1)}"/>
    </svg>
    <div class="gauge-c"><b>${capLeft === null ? '\u2014' : Math.round(capLeft) + '%'}</b><span>claude capacity left</span></div>
  </div>
  <div class="mega-right">
    <div class="mega-usd"><small>value served at api list pricing</small>${esc(allTime.costDisplay || '$0')}</div>
    <div class="mega-sub"><b>${esc(today.costDisplay || '$0')}</b> today \u00b7 <b>${fmtNum(allTime.requests || 0)}</b> requests \u00b7 <b>${fmtCompact(totalTokens)}</b> tokens \u00b7 nobody is invoiced this, it runs on donated seats</div>
    <div class="mega-pills">
      <div class="pill"><span>burn</span><b class="${st.urgency.burnRatePctPerHour !== null && st.urgency.burnRatePctPerHour >= 5 ? 'burn-hot' : ''}">${st.urgency.burnRatePctPerHour === null ? '\u2014' : st.urgency.burnRatePctPerHour + '%/h'}</b></div>
      <div class="pill"><span>runway</span><b>${st.urgency.projectedDepletionIn ? esc(st.urgency.projectedDepletionIn) : 'flat'}</b></div>
      <div class="pill"><span>next reset</span><b>${next ? esc(next.in) : '\u2014'}</b></div>
      <div class="pill"><span>claude seats</span><b>${st.pool.accounts}</b></div>
      <div class="pill"><span>chatgpt seats</span><b>${codingPool.accounts || 0}</b></div>
      <div class="pill"><span>leases</span><b>${totalLeases === null ? '\u2014' : totalLeases}</b></div>
      <div class="pill"><span>upstream 24h</span><b>${upstreamPct === null ? '\u2014' : upstreamPct + '%'}</b></div>
    </div>
    <div class="provsplit">
      <div class="provcard anth"><span>anthropic leg \u00b7 claude-*</span><b>${esc((provAnth && provAnth.costDisplay) || '$0')}</b><small>${fmtNum((provAnth && provAnth.requests) || 0)} requests \u00b7 ${fmtCompact(provAnth ? provAnth.inputTokens + provAnth.outputTokens + provAnth.cacheReadTokens + provAnth.cacheCreationTokens : 0)} tokens</small></div>
      <div class="provcard oai"><span>openai leg \u00b7 gpt-* via codex</span><b>${esc((provOai && provOai.costDisplay) || '$0')}</b><small>${fmtNum((provOai && provOai.requests) || 0)} requests \u00b7 ${fmtCompact(provOai ? provOai.inputTokens + provOai.outputTokens + provOai.cacheReadTokens + provOai.cacheCreationTokens : 0)} tokens</small></div>
    </div>
    ${spark}
  </div>
</section>
<div class="table-wrap" style="margin-top:14px;margin-bottom:12px"><table>
<thead><tr>
<th>seat</th><th class="sm-hide">provider</th><th>status</th><th class="num sm-hide">leases</th><th class="sorted">weekly reset \u2191</th>
<th class="num xs-hide">session used</th><th class="num">weekly used</th>
${hasFable ? '<th class="num xs-hide">fable used</th>' : ''}
<th class="num xs-hide">session reset</th><th class="xs-hide">last activity</th><th class="num sm-hide">auth</th>
</tr></thead>
<tbody>${rows}${codexRows}</tbody>
</table></div>
<section class="card panel">
  <h2>seat usage <em>\u2014 value served per donated account, both providers</em></h2>
  <div class="table-wrap" style="border:0;border-radius:0"><table>
  <thead><tr><th>seat</th><th>provider</th><th class="num">requests</th><th class="num sm-hide">input</th><th class="num sm-hide">output</th><th class="num xs-hide">cache read</th><th class="num">total tokens</th><th class="num">value served</th><th class="xs-hide">last used</th></tr></thead>
  <tbody>${servedRows || '<tr><td colspan="9" class="muted">no attributed traffic yet</td></tr>'}</tbody>
  </table></div>
  <p class="method">Seat ids are the same stable one-way hashes used above \u2014 no account emails, org ids, or member keys appear here. Attribution is exact: Anthropic responses carry the serving org id, Codex responses carry the leased seat id, and both map 1:1 to donated accounts. \u201cformer\u201d marks traffic served by a seat no longer in the pool.</p>
</section>
<section class="card panel">
  <h2>model mix <em>\u2014 requests, tokens and cost by model</em></h2>
  <div class="mix">
    <div class="donut-wrap">${donut}<div class="dc"><b>${fmtNum(mixTotalReq)}</b><span>requests</span></div></div>
    <ul class="legend">${legend || '<li><span class="mname">no metered traffic yet</span></li>'}</ul>
  </div>
</section>
<section class="card panel">
  <h2>seat reliability <em>\u2014 anonymized donor seats (anthropic leg; the pool-vs-outside split reads Anthropic's weekly meter)</em></h2>
  <div class="seats">${seatCards}</div>
  <p class="method">Seat ids are stable one-way hashes. <b>Seeding uptime</b> is the share of 60s broker polls that saw the seat present and not credential-failed. <b>Pool vs outside</b> compares tokens metered through this edge against Anthropic's weekly capacity meter, which only reports whole percentage points \u2014 until a seat's pool traffic crosses that 1pp floor we publish a conservative ceiling, not a point estimate. Full per-seat timelines are in <a href="/status.json">status.json</a>.</p>
</section>
<div class="foot"><span>updated ${esc(updated)} ET \u00b7 usage \u2264 ${Math.round(STATUS_TTL_MS / 60000)}m cache \u00b7 auto-refresh 12s \u00b7 pricing verified ${esc((meter.pricing && meter.pricing.lastVerified) || 'n/a')}</span><span><a href="/status.json">json</a> \u00b7 <a href="/docs">docs</a></span></div>
</main><script>
(function(){var t=setTimeout(function r(){fetch(location.href,{cache:'no-store'}).then(function(x){return x.text()}).then(function(html){var d=new DOMParser().parseFromString(html,'text/html');var m=d.querySelector('main');if(m)document.querySelector('main').replaceWith(m);t=setTimeout(r,12000)}).catch(function(){t=setTimeout(r,12000)})},12000);document.addEventListener('visibilitychange',function(){if(document.hidden){clearTimeout(t)}else{location.reload()}})})();
</script></body></html>\n`;
}

function withHealth(st, brokerReachable, stale) {
  const now = Date.now();
  const refreshAt = st.usageRefreshedAt ? Date.parse(st.usageRefreshedAt) : NaN;
  return {
    ...st,
    health: {
      brokerReachable,
      stale,
      snapshotAgeSeconds: Math.max(0, Math.round((now - statusCache.at) / 1000)),
      snapshotAge: compactAge(Math.max(0, now - statusCache.at)),
      lastRefreshAgeSeconds: Number.isFinite(refreshAt) ? Math.max(0, Math.round((now - refreshAt) / 1000)) : null,
      lastRefreshAge: Number.isFinite(refreshAt) ? compactAge(Math.max(0, now - refreshAt)) : 'Unavailable',
      meterUptimeSeconds: Math.round((now - METER_STARTED_AT) / 1000),
      meterUptime: compactAge(now - METER_STARTED_AT),
    },
  };
}

function getStatus(opts = {}) {
  const now = Date.now();
  let base;
  if (!opts.force && statusCache.data && now - statusCache.at < STATUS_TTL_MS) {
    base = Promise.resolve({ st: statusCache.data, reachable: true, stale: false });
  } else {
    if (!statusInflight) {
      statusInflight = fetchBrokerAccounts().then((raw) => {
        const history = readSnapshots();
        const st = buildStatus(raw, history);
        statusCache = { at: Date.now(), data: st };
        appendSnapshot(st);
        console.log('status: refreshed from broker');
        return { st, reachable: true, stale: false };
      }).catch((e) => {
        console.error('status: broker fetch failed:', e.message);
        if (statusCache.data) return { st: statusCache.data, reachable: false, stale: true };
        throw e;
      }).finally(() => { statusInflight = null; });
    }
    base = statusInflight;
  }
  // Overlay live lease/health data (short 8s cache) so "active" is never stale
  // even when the heavier usage snapshot is served from the 5-minute cache.
  return base.then(({ st, reachable, stale }) => fetchBrokerHealth().then((health) => {
    const merged = mergeLiveHealth(st, health);
    // The usage snapshot (broker capacity) is fine on a 5-minute cache, but the
    // meter totals (requests / tokens / USD) are pure in-memory aggregates and
    // cheap to rebuild. Recompute them on EVERY status render so the dollar
    // figure moves in real time instead of freezing for the cache TTL.
    merged.meter = aggregateMeterTotals();
    return { st: withHealth(merged, reachable && (health ? true : reachable), stale) };
  }));
}

function publicStatusJson(st) {
  // Public, anonymized reliability record. Seats appear as stable hashed
  // aliases so a donor can find their own row without anyone else learning
  // which email or account id it is.
  const rep = reputation.report();
  const shareBySeat = poolShare.publicBySeat();
  const seats = Object.keys(reputation.state.seats).map((id) => {
    const u = reputation.seatUptime(id);
    const share = shareBySeat[u.alias] || null;
    return {
      seat: u.alias,
      seedingUptimePct: u.uptimePct,
      seedingDays: u.seedingDays,
      metMinimumSeeding: u.metMinimumSeeding,
      provisional: u.provisional,
      samples: u.samples,
      // Additive: pool vs outside-pool usage split for this seat. Anonymized
      // (alias only) and explicitly bounded — see `bound` and `confidence`.
      usageSplit: share,
    };
  }).sort((a, b) => (b.seedingUptimePct || 0) - (a.seedingUptimePct || 0));
  const shareReport = poolShare.report();
  const publicCodexAliases = new Set(((st.codingPool && st.codingPool.sessions) || []).map((s) => s.seat).filter(Boolean));
  const publicAnthropicAliases = new Set(st.perAccount.map((r) => (r.id ? aliasFor(r.id) : null)).filter(Boolean));
  const publicSeatUsage = metrics.publicSeatReport().map((s) => ({
    ...s,
    provider: publicCodexAliases.has(s.seat) ? 'openai' : (publicAnthropicAliases.has(s.seat) ? 'anthropic' : 'former'),
  }));

  // Pre-existing leak, fixed in v2: mergeLiveHealth() copies the broker's raw
  // lastSelection.accountId (a real account UUID) onto the status object, and
  // the public serializer was spreading it through untouched. Replace it with
  // the same one-way alias used everywhere else.
  const liveLeases = st.liveLeases
    ? {
      ...st.liveLeases,
      lastSelection: st.liveLeases.lastSelection
        ? { seat: aliasFor(st.liveLeases.lastSelection.accountId), atMs: st.liveLeases.lastSelection.atMs, reason: st.liveLeases.lastSelection.reason }
        : null,
    }
    : st.liveLeases;

  return {
    ...st,
    liveLeases,
    // Additive: per-donated-seat served usage, both providers. Aliases only —
    // same one-way hashes as everywhere else on the public surface.
    seatUsage: publicSeatUsage,
    reliability: {
      meterUptimeSeconds: rep.meter.currentUptimeSeconds,
      meterCumulativeUptimeHours: rep.meter.cumulativeUptimeHours,
      meterRestarts: rep.meter.restarts,
      upstream: { last1h: rep.upstream.last1h, last24h: rep.upstream.last24h, allTimePct: rep.upstream.allTime.uptimePct },
      brokerPollSuccessPct: rep.brokerPolls.successPct,
      seats,
      note: 'seat aliases are stable one-way hashes; seeding uptime is the fraction of broker polls that saw the seat present and not credential-failed',
    },
    usageSplit: {
      calibratedSeats: shareReport.calibratedSeats,
      declaredTokensPerPct: shareReport.declaredTokensPerPct,
      method: shareReport.method,
      note: shareReport.note,
      caveat: shareReport.caveat,
    },
    perAccount: st.perAccount.map((row) => {
      const { sessionResetAt, weeklyResetAt, id, label, authLastError, ...safe } = row;
      if (id) safe.seat = aliasFor(id);
      if (safe.modelBuckets && safe.modelBuckets.available) {
        safe.modelBuckets = {
          available: true,
          fable: safe.modelBuckets.fable ? { usedPct: safe.modelBuckets.fable.usedPct } : null,
          sonnet: safe.modelBuckets.sonnet ? { usedPct: safe.modelBuckets.sonnet.usedPct } : null,
        };
      }
      return safe;
    }),
  };
}

function handleStatus(res, fmt, authed, opts = {}) {
  getStatus(opts).then(({ st }) => {
    const body = fmt === 'json' ? JSON.stringify(publicStatusJson(st), null, 2) : renderStatusHtml(st, authed);
    res.writeHead(200, { 'content-type': fmt === 'json' ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(body);
  }).catch(() => {
    const body = fmt === 'json' ? JSON.stringify({ error: 'status temporarily unavailable' }) : '<!doctype html><html><body style="background:#0d0e11;color:#9a9eaa;font-family:monospace"><p>status temporarily unavailable</p></body></html>';
    res.writeHead(503, { 'content-type': fmt === 'json' ? 'application/json' : 'text/html; charset=utf-8', 'retry-after': '60' });
    res.end(body);
  });
}

// ---- /join: donate a seat, get a metered key ----------------------------
// Abuse posture (this URL hands out API keys, so it is treated as hostile):
//   - OPEN JOIN (directive 2026-07-31 22:12): the gate is a verified
//     elizacloud Steward session, fail-closed. No invite required. Invites
//     survive as an OPTIONAL elevation path (grant the invite's tier).
//   - one active key per steward userId for open joins; re-join returns the
//     existing account state, never a duplicate key
//   - per-IP, per-user and (when present) per-invite rate limits on starts
//   - one live flow per invite AND per user; stale flows expire
//   - never logs the oauth code, the access/refresh token, or the minted key

const RATE_WINDOW_MS = 60 * 60 * 1000;
// Env-overridable ONLY so the e2e suites can exercise each limit in isolation
// (every test request shares 127.0.0.1). Production runs the defaults.
const MAX_STARTS_PER_IP = Number(process.env.POOL_METER_MAX_STARTS_PER_IP) > 0 ? Number(process.env.POOL_METER_MAX_STARTS_PER_IP) : 8;
const MAX_STARTS_PER_INVITE = 5;
const MAX_STARTS_PER_USER = Number(process.env.POOL_METER_MAX_STARTS_PER_USER) > 0 ? Number(process.env.POOL_METER_MAX_STARTS_PER_USER) : 5;
// Open joins land on the standard tier (lib/join.js DEFAULT_TIER, 'invited'):
// real quota, no donor privileges. Donor elevation stays invite-mediated.
const OPEN_JOIN_TIER = join.DEFAULT_TIER;
const ipStarts = new Map(); // ip -> number[] (timestamps)
const userStarts = new Map(); // steward userId -> number[] (timestamps)
// One live open-join flow per steward user, mirroring the per-invite rule.
// userId -> { sessionId, at }
const userFlows = new Map();
// sessionId -> { inviteId, userId, tier, labelBase, ip, startedAt, minted, closed }
const joinSessions = new Map();

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [ip, list] of ipStarts) {
    const kept = list.filter((ts) => ts > cutoff);
    if (kept.length) ipStarts.set(ip, kept);
    else ipStarts.delete(ip);
  }
  for (const [uid, list] of userStarts) {
    const kept = list.filter((ts) => ts > cutoff);
    if (kept.length) userStarts.set(uid, kept);
    else userStarts.delete(uid);
  }
  // Broker flows hard-timeout at 15m; drop our mirrors a little after that.
  for (const [sid, s] of joinSessions) {
    if (Date.now() - s.startedAt > 20 * 60 * 1000) joinSessions.delete(sid);
  }
  for (const [uid, f] of userFlows) {
    if (Date.now() - f.at > 15 * 60 * 1000) userFlows.delete(uid);
  }
}, 60 * 1000).unref();

function clientIp(req) {
  // nginx sets X-Real-IP; it is the only hop in front of us, so this is not
  // spoofable from outside without also controlling nginx.
  const xr = req.headers['x-real-ip'];
  if (typeof xr === 'string' && xr.trim()) return xr.trim();
  return req.socket.remoteAddress || 'unknown';
}

function rateLimitIp(ip) {
  const now = Date.now();
  const list = (ipStarts.get(ip) || []).filter((ts) => now - ts < RATE_WINDOW_MS);
  if (list.length >= MAX_STARTS_PER_IP) return false;
  list.push(now);
  ipStarts.set(ip, list);
  return true;
}

function rateLimitUser(userId) {
  const now = Date.now();
  const list = (userStarts.get(userId) || []).filter((ts) => now - ts < RATE_WINDOW_MS);
  if (list.length >= MAX_STARTS_PER_USER) return false;
  list.push(now);
  userStarts.set(userId, list);
  return true;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end(html);
}

function readBody(req, cap = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > cap) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// Live capacity contributed per broker account id, used for earned quota and
// the public ledger. Cached briefly; the broker is a read-only dependency here.
let utilCache = { at: 0, data: null };
function getUtilization() {
  const now = Date.now();
  if (utilCache.data && now - utilCache.at < 60 * 1000) return Promise.resolve(utilCache.data);
  return brokerClient.listAccounts()
    .then((raw) => {
      const u = computeUtilization(raw, totals);
      utilCache = { at: Date.now(), data: u };
      return u;
    })
    .catch(() => utilCache.data || computeUtilization({ providers: [] }, totals));
}

// ---- reputation: who is seeding, who is leeching -------------------------
// Joins three independent sources and keeps them separable in the output:
//   broker  -> which seat exists, its health, its contributed weekly capacity
//   metrics -> effective tokens consumed by that member's key
//   uptime  -> what fraction of polls that seat was actually in the pool
function buildReputationReport({ identify = false } = {}) {
  return Promise.all([getUtilization(), Promise.resolve(join.listKeys ? join.listKeys() : [])])
    .then(([util, keys]) => {
      const members = [];
      for (const k of keys) {
        if (k.enabled === false) continue;
        const accountId = k.contributedAccountId || k.accountId || null;
        const contributedPct = accountId && util.perSeat ? (util.perSeat[accountId] || 0) : 0;
        const consumed = metrics.effective(k.label);
        const rep = reputation.memberScore({
          accountId,
          contributedPct,
          consumedEffective: consumed,
          capacityTokenValue: join.CAPACITY_TOKEN_VALUE,
          tier: k.tier || null,
        });
        const spentUsd = metrics.costUsdFor(k.label);
        members.push({
          member: identify ? k.label : maskMember(k.label),
          ...(identify ? { accountId, label: k.label } : {}),
          seatAlias: accountId ? aliasFor(accountId) : null,
          quota: k.quota || null,
          budgetUsd: k.budgetUsd || null,
          consumedEffectiveTokens: consumed,
          consumedUsd: pricing.usd(spentUsd),
          consumedDisplay: pricing.fmtUsd(spentUsd),
          servedByTheirSeat: accountId ? metrics.servedBy(accountId) : 0,
          servedByTheirSeatUsd: accountId ? pricing.usd(metrics.servedUsdBy(accountId)) : 0,
          reputation: rep,
        });
      }
      members.sort((a, b) => (b.reputation.score || -1) - (a.reputation.score || -1));
      return {
        version: 2,
        generatedAt: new Date().toISOString(),
        model: 'private tracker: ratio = capacity contributed / effective tokens consumed; seeding uptime is measured continuously, not at donation time',
        uptime: reputation.report(),
        utilization: {
          available: util.available,
          utilizationPct: util.utilizationPct,
          seats: util.seats,
          formula: util.formula,
          honesty: util.honesty,
        },
        members,
        seats: Object.keys(reputation.state.seats).map((id) => ({
          ...(identify ? { accountId: id } : {}),
          ...reputation.seatUptime(id),
          servedEffectiveTokens: metrics.servedBy(id),
          servedUsd: pricing.usd(metrics.servedUsdBy(id)),
          servedDisplay: pricing.fmtUsd(metrics.servedUsdBy(id)),
        })),
      };
    });
}

// Public-facing member handle: enough to recognize yourself, not enough to dox.
function maskMember(label) {
  if (!label) return 'member';
  if (label.length <= 3) return `${label[0]}\u2022\u2022`;
  return `${label.slice(0, 2)}\u2022\u2022\u2022${label.slice(-1)}`;
}

// ---- upstream probe loop (uptime evidence, not vibes) --------------------
// GET /health on 18807. Read-only; this never touches the broker or restarts
// anything. Failures are recorded, not acted on.
function probeUpstream() {
  const started = Date.now();
  const r = http.request({
    host: UPSTREAM_HOST, port: UPSTREAM_PORT, path: '/health', method: 'GET', timeout: 8000,
  }, (pres) => {
    pres.resume();
    pres.on('end', () => reputation.recordProbe({ ok: pres.statusCode >= 200 && pres.statusCode < 500, ms: Date.now() - started }));
  });
  r.on('timeout', () => { r.destroy(); reputation.recordProbe({ ok: false, ms: Date.now() - started, err: 'timeout' }); });
  r.on('error', (e) => reputation.recordProbe({ ok: false, ms: Date.now() - started, err: e.code || e.message }));
  r.end();
}
setTimeout(probeUpstream, 3000).unref();
setInterval(probeUpstream, PROBE_INTERVAL_MS).unref();

// ---- broker directory + seeding uptime poll ------------------------------
// Read-only GET /api/accounts. Teaches metrics the org-id -> account mapping
// (so token attribution resolves) and feeds per-seat seeding uptime.
let directoryLoaded = false;
function pollBrokerDirectory() {
  return brokerClient.listAccounts()
    .then((raw) => {
      const prov = (raw.providers || []).find((p) => p.providerId === 'anthropic-subscription');
      const rows = prov ? (prov.accounts || []) : [];
      metrics.setAccountDirectory(rows);
      // Codex seats too: the codex-proxy attributes served requests by the
      // leased ChatGPT account id (logged in the same `org` JSONL field), and
      // the broker's openai-codex accounts carry that id as organizationId.
      // Feeding them into the same directory resolves codex attribution to
      // real seats instead of provisional org:<id> buckets.
      const codexProv = (raw.providers || []).find((p) => p.providerId === 'openai-codex');
      if (codexProv) metrics.setAccountDirectory(codexProv.accounts || []);
      reputation.recordBrokerPoll(rows, { aliasFor });
      // The boot rebuild runs before the broker answers, so historical records
      // carrying an org header were bucketed under a provisional `org:<id>`
      // key. Once the directory is known, replay the logs once so attribution
      // resolves to real seats. Cheap (logs are small) and idempotent.
      if (!directoryLoaded && rows.length) {
        directoryLoaded = true;
        const s = metrics.rebuild();
        console.log(`metrics: re-indexed with account directory (${s.records} records, ${s.ms}ms)`);
      }
      // Sample each seat's weekly pct alongside pool-served tokens.
      //
      // Ordering matters and is load-bearing: this MUST run after the re-index
      // above. On the first poll after a restart the directory has only just
      // arrived, so before the replay every seat still reports 0 served
      // tokens. Sampling first would anchor each seat's weekly baseline at
      // zero and permanently understate pool-served tokens for the rest of
      // that weekly window.
      poolShare.recordPoll(rows, {
        aliasFor,
        // Scoped to the weekly window the seat is currently in, so a restart
        // cannot erase tokens the seat already served inside it.
        servedFor: (id, windowStart) => metrics.servedSince(id, windowStart),
      });
      return rows.length;
    })
    .catch((e) => { reputation.recordBrokerPollFailure(); console.error('broker poll failed:', e.message); return 0; });
}
setTimeout(() => pollBrokerDirectory().then((n) => n && console.log(`metrics: account directory loaded (${n} seats)`)), 1500).unref();
setInterval(pollBrokerDirectory, 60000).unref();

function handleJoinRoutes(req, res, urlPath, query) {
  // ---- landing page ----
  // OPEN JOIN (directive 2026-07-31 22:12): no invite required. A bare GET
  // /join renders the sign-in + join flow at the default tier. ?i= remains an
  // OPTIONAL elevation path: a valid invite grants its tier; an invalid one
  // is refused loudly (403) rather than silently degraded to default, so a
  // donor with a broken link knows before donating a seat.
  if (req.method === 'GET' && urlPath === '/join') {
    const token = query.get('i');
    let tier = OPEN_JOIN_TIER;
    let invited = false;
    if (token) {
      const v = join.verifyInvite(token);
      if (!v.ok) {
        return sendHtml(res, 403, page.joinLanding({ inviteError: `invite ${v.reason}` }));
      }
      tier = v.tier;
      invited = true;
    }
    return getUtilization().then((util) => {
      sendHtml(res, 200, page.joinLanding({
        tier,
        invited,
        utilization: util,
        stewardBase: account.STEWARD_BASE,
        tenant: account.ACCOUNT_TENANT,
      }));
    });
  }

  // ---- start a device-oauth flow ----
  if (req.method === 'POST' && urlPath === '/join/start') {
    const token = query.get('i');
    const ip = clientIp(req);
    // Steward gate FIRST (directive 2026-07-31 22:12, open join): the ONLY
    // mandatory gate is a verified Eliza Cloud identity. The pool session
    // cookie exists only downstream of lib/account.js verification against
    // the elizacloud Steward tenant (introspection + guest gate + tenant
    // pin), so requiring it here means: no verified elizacloud identity, no
    // flow, no key, no broker contact. Fail closed.
    const sess = account.sessionFromRequest(req);
    if (!sess) {
      join.logEvent({ event: 'start_rejected', reason: 'no steward session', ip });
      return sendJson(res, 401, { error: 'sign in with your eliza cloud account first', needsAuth: true });
    }
    // Invite is now OPTIONAL: present and valid => elevates to the invite's
    // tier and stays single-use. Present but INVALID => refused loudly (403),
    // never silently downgraded, so a donor with a stale link finds out
    // before linking a seat.
    let v = null;
    if (token) {
      v = join.verifyInvite(token);
      if (!v.ok) {
        join.logEvent({ event: 'start_rejected', reason: v.reason, ip, userId: sess.userId });
        return sendJson(res, 403, { error: `invite ${v.reason}` });
      }
    }
    // Cookie-authenticated mutating route => origin-gated, same discipline as
    // /account/claim. Browser posts from our own page carry a matching
    // Origin; the pool.eliza.army worker strips Origin entirely (arrives
    // headerless, which checkOrigin treats as non-browser); SameSite=Lax
    // already keeps the cookie off cross-site POSTs. Belt and suspenders.
    if (!account.checkOrigin(req)) {
      join.logEvent({ event: 'start_rejected', reason: 'bad origin', ip, userId: sess.userId, ...(v ? { inviteId: v.invite.id } : {}) });
      return sendJson(res, 403, { error: 'bad origin' });
    }
    // Provider is pure input validation; refuse nonsense BEFORE it consumes a
    // rate-limit slot. Alias `openai`/`codex`/`chatgpt` -> openai-codex;
    // default stays anthropic-subscription so old links behave identically.
    const rawProvider = (query.get('provider') || 'anthropic-subscription').toLowerCase();
    const providerAlias = {
      anthropic: 'anthropic-subscription', 'anthropic-subscription': 'anthropic-subscription',
      claude: 'anthropic-subscription',
      openai: 'openai-codex', 'openai-codex': 'openai-codex', codex: 'openai-codex', chatgpt: 'openai-codex',
    };
    const provider = providerAlias[rawProvider];
    if (!provider) {
      return sendJson(res, 400, { error: `unsupported provider '${rawProvider}'. Use anthropic or openai/codex.` });
    }
    if (!rateLimitIp(ip)) {
      join.logEvent({ event: 'start_rejected', reason: 'ip rate limit', ip, userId: sess.userId, ...(v ? { inviteId: v.invite.id } : {}) });
      return sendJson(res, 429, { error: 'too many attempts from this address, try again later' });
    }
    if (!rateLimitUser(sess.userId)) {
      join.logEvent({ event: 'start_rejected', reason: 'user rate limit', ip, userId: sess.userId });
      return sendJson(res, 429, { error: 'too many attempts for this account, try again later' });
    }
    // Open-join abuse guards (no invite): one active key per steward userId.
    // A re-join returns the existing account state instead of minting a
    // duplicate; /account is where the key lives. Invites are an explicit
    // operator grant and bypass this (they can add a second, elevated key).
    if (!v) {
      const existing = join.activeKeyOwnedBy(sess.userId);
      if (existing) {
        join.logEvent({ event: 'start_rejected', reason: 'already joined', ip, userId: sess.userId, label: existing.label });
        return sendJson(res, 409, {
          error: 'this eliza cloud account already has an active pool key. manage it at /account.',
          alreadyJoined: true,
          label: existing.label,
          tier: existing.tier || null,
          accountUrl: '/account',
        });
      }
      // One live open-join flow per user, mirroring the per-invite rule.
      const live = userFlows.get(sess.userId);
      if (live && Date.now() - live.at < 15 * 60 * 1000) {
        join.logEvent({ event: 'start_rejected', reason: 'flow already in progress', ip, userId: sess.userId });
        return sendJson(res, 429, { error: 'a login for this account is already in progress' });
      }
    }
    const labelBase = v
      ? (v.invite.note || `donor-${v.invite.id.slice(0, 6)}`)
      : (sess.email ? sess.email.split('@')[0] : `member-${sess.userId.slice(-6)}`);
    const tier = v ? v.tier : OPEN_JOIN_TIER;
    return brokerClient
      .startOAuth({ label: `pool-join ${labelBase}`, mode: 'device', provider })
      .then((flow) => {
        if (v) {
          const claim = join.claimFlowStart(v.invite.id, flow.sessionId, MAX_STARTS_PER_INVITE);
          if (!claim.ok) {
            // Do not leave an orphan flow on the broker if we refuse it here.
            brokerClient.cancel(flow.sessionId, provider);
            return sendJson(res, 429, { error: claim.reason });
          }
        } else {
          userFlows.set(sess.userId, { sessionId: flow.sessionId, at: Date.now() });
        }
        joinSessions.set(flow.sessionId, {
          inviteId: v ? v.invite.id : null,
          tier,
          labelBase,
          provider,
          ip,
          // Steward identity of the donor, REQUIRED since 2026-07-31: the
          // verified elizacloud session gates this route, so every new key
          // is born owned. Verified cookie only; nothing client-supplied.
          ownerUserId: sess.userId,
          startedAt: Date.now(),
          minted: null,
          closed: false,
        });
        join.logEvent({ event: 'flow_started', inviteId: v ? v.invite.id : null, userId: sess.userId, sessionId: flow.sessionId, ip, tier, provider, open: !v });
        sendJson(res, 200, {
          sessionId: flow.sessionId,
          authUrl: flow.authUrl,
          needsCodeSubmission: !!flow.needsCodeSubmission,
          ...(flow.userCode ? { userCode: flow.userCode } : {}),
          qr: page.qrSvg(flow.authUrl),
        });
      })
      .catch((err) => {
        join.logEvent({ event: 'flow_start_failed', inviteId: v ? v.invite.id : null, userId: sess.userId, ip, error: String(err.message).slice(0, 200) });
        sendJson(res, 502, { error: `could not start the login: ${String(err.message).slice(0, 200)}` });
      });
  }

  // ---- SSE mirror of the broker flow, plus the mint on success ----
  if (req.method === 'GET' && urlPath === '/join/events') {
    const sessionId = query.get('sessionId');
    const s = sessionId ? joinSessions.get(sessionId) : null;
    if (!s) { return sendJson(res, 404, { error: 'unknown session' }); }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const write = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) {} };
    const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);

    const flowProvider = s.provider || 'anthropic-subscription';
    const close = brokerClient.watchFlow(
      sessionId,
      (state) => {
        if (state.status === 'pending') { write({ status: 'pending' }); return; }
        if (state.status === 'success') {
          // Mint exactly once per session even if the broker re-emits.
          if (s.minted) { write(s.minted); return; }
          // Fail-closed backstop: /join/start refuses sessions without a
          // verified Steward identity, so an unowned flow cannot normally
          // reach this point. If state was somehow corrupted, refuse the
          // mint rather than create a floating pre-account key.
          if (!s.ownerUserId) {
            join.logEvent({ event: 'mint_refused_unowned', inviteId: s.inviteId });
            write({ status: 'error', error: 'your sign-in could not be confirmed, so no key was minted. reload /join and try again.' });
            return;
          }
          const accountId = state.account && state.account.id ? state.account.id : null;
          getUtilization()
            .then((util) => {
              const contributedPct = accountId && util.perSeat[accountId] !== undefined
                ? util.perSeat[accountId]
                : 0;
              const rec = join.mintKey({
                labelBase: s.labelBase,
                tier: s.tier === 'donor' ? 'donor' : s.tier,
                contributedAccountId: accountId,
                inviteId: s.inviteId,
                contributedPct,
                provider: flowProvider,
                ownerUserId: s.ownerUserId,
                // Open joins (no invite) enforce one active key per steward
                // user INSIDE the keys-file lock: a concurrent duplicate
                // returns the existing record instead of minting.
                uniqueOwner: !s.inviteId,
              });
              if (rec.duplicate) {
                // The seat linked, but this account already holds an active
                // key; do NOT hand the raw key out again (it was shown once,
                // at its own mint). Point at /account instead.
                join.logEvent({ event: 'mint_deduped', userId: s.ownerUserId, label: rec.label });
                if (s.ownerUserId) userFlows.delete(s.ownerUserId);
                const dup = {
                  status: 'already-joined',
                  label: rec.label,
                  tier: rec.tier,
                  accountUrl: '/account',
                };
                s.minted = dup;
                write(dup);
                return;
              }
              if (s.inviteId) join.consumeInvite(s.inviteId, rec.label);
              if (s.ownerUserId) userFlows.delete(s.ownerUserId);
              // Audit record deliberately omits the key itself.
              join.logEvent({
                event: 'key_minted',
                inviteId: s.inviteId,
                label: rec.label,
                tier: rec.tier,
                quota: rec.quota,
                contributedAccountId: accountId,
                contributedPct,
                provider: flowProvider,
                open: !s.inviteId,
                ownedByAccount: !!s.ownerUserId,
              });
              loadKeys();
              statusCache = { at: 0, data: null };
              utilCache = { at: 0, data: null };
              const payload = {
                status: 'success',
                poolKey: rec.key,
                label: rec.label,
                tier: rec.tier,
                quotaText: Number(rec.quota).toLocaleString('en-US'),
                statusUrl: '/status?fresh=1',
                setup: page.setupBlurb(rec.key),
              };
              s.minted = payload;
              write(payload);
            })
            .catch((err) => {
              console.error('join: mint failed:', err.message);
              join.logEvent({ event: 'mint_failed', inviteId: s.inviteId, error: String(err.message).slice(0, 200) });
              write({ status: 'error', error: 'your account was linked but the key could not be minted. ping shadow, do not retry.' });
            });
          return;
        }
        if (s.inviteId) join.releaseFlow(s.inviteId, sessionId);
        if (s.ownerUserId) userFlows.delete(s.ownerUserId);
        join.logEvent({ event: 'flow_ended', inviteId: s.inviteId, status: state.status });
        write({ status: state.status, error: state.error || null });
      },
      () => { clearInterval(keepAlive); try { res.end(); } catch (_) {} },
      flowProvider,
    );
    req.on('close', () => { clearInterval(keepAlive); close(); });
    return undefined;
  }

  // ---- submit the code#state blob ----
  if (req.method === 'POST' && urlPath === '/join/submit-code') {
    return readJsonBody(req).then((body) => {
      if (!body || typeof body.sessionId !== 'string' || typeof body.code !== 'string') {
        return sendJson(res, 400, { error: 'bad request' });
      }
      const s = joinSessions.get(body.sessionId);
      if (!s) return sendJson(res, 404, { error: 'unknown session' });
      // The code is a bearer credential. It is forwarded and never logged.
      return brokerClient
        .submitCode(body.sessionId, body.code.trim(), s.provider)
        .then(() => sendJson(res, 200, { accepted: true }))
        .catch((err) => sendJson(res, 400, { error: String(err.message).slice(0, 200) }));
    }).catch(() => sendJson(res, 400, { error: 'bad request' }));
  }

  // ---- cancel (also fired by sendBeacon on tab close, so no orphan flows) ----
  if (req.method === 'POST' && urlPath === '/join/cancel') {
    return readJsonBody(req).then((body) => {
      const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId : null;
      if (!sessionId) return sendJson(res, 400, { error: 'bad request' });
      const s = joinSessions.get(sessionId);
      return brokerClient.cancel(sessionId, s && s.provider).then((cancelled) => {
        if (s) {
          if (s.inviteId) join.releaseFlow(s.inviteId, sessionId);
          if (s.ownerUserId) userFlows.delete(s.ownerUserId);
          join.logEvent({ event: 'flow_cancelled', inviteId: s.inviteId, sessionId });
          joinSessions.delete(sessionId);
        }
        sendJson(res, 200, { cancelled });
      });
    }).catch(() => sendJson(res, 400, { error: 'bad request' }));
  }

  // ---- revocation ----
  if (urlPath === '/join/revoke') {
    if (req.method === 'GET') return sendHtml(res, 200, page.revokePage({}));
    if (req.method === 'POST') {
      return readBody(req).then((raw) => {
        const params = new URLSearchParams(raw);
        const key = (params.get('key') || '').trim();
        if (!key) return sendHtml(res, 400, page.revokePage({ message: 'paste a key first', ok: false }));
        const rec = join.listKeys().find((k) => k.key === key);
        if (!rec) {
          // Same response either way: this endpoint must not be a key oracle.
          return sendHtml(res, 200, page.revokePage({ message: 'if that key exists it is now disabled, and the donation is flagged for operator removal.', ok: true }));
        }
        join.disableKeyByLabel(rec.label);
        loadKeys();
        const acct = rec.contributedAccountId || null;
        const acctProvider = rec.contributedProvider || 'anthropic-subscription';
        join.logEvent({ event: 'revoke_requested', label: rec.label, contributedAccountId: acct, provider: acctProvider });
        if (!acct) {
          return sendHtml(res, 200, page.revokePage({ message: 'that pool key is now disabled. it was not tied to a broker account, so there was no donated account to remove.', ok: true }));
        }
        return brokerClient.deleteAccount(acct, acctProvider).then((outcome) => {
          join.markBrokerRevoked(rec.label, {
            accountId: acct,
            method: 'delete',
            verified: !!outcome.verified,
            alreadyAbsent: !!outcome.alreadyAbsent,
          });
          join.logEvent({
            event: 'broker_account_deleted',
            label: rec.label,
            contributedAccountId: acct,
            verified: !!outcome.verified,
            alreadyAbsent: !!outcome.alreadyAbsent,
          });
          statusCache = { at: 0, data: null };
          utilCache = { at: 0, data: null };
          // Report what was actually confirmed, not what we hoped for. The
          // broker's DELETE is unconditionally optimistic, so an unverified
          // removal must not be described to the donor as a completed one.
          const logoutHint = acctProvider === 'openai-codex'
            ? 'signing out of that ChatGPT/Codex account (or rotating its credential) is still the belt-and-suspenders move'
            : 'running /logout in claude on it is still the belt-and-suspenders move';
          const message = outcome.alreadyAbsent
            ? `your pool key is disabled. that account was already out of the pool, so there was no credential left to remove. ${logoutHint}.`
            : outcome.verified
              ? `your pool key is disabled and the donated credential is gone from the broker, confirmed against the live account list. for belt-and-suspenders safety, ${logoutHint}.`
              : `your pool key is disabled and the broker accepted the removal, but we could not re-read the account list to confirm it. ${acctProvider === 'openai-codex' ? 'sign out of that ChatGPT/Codex account now' : 'run /logout in claude on that account now'}, which invalidates the stored credential independently.`;
          return sendHtml(res, 200, page.revokePage({ message, ok: outcome.verified || outcome.alreadyAbsent }));
        }).catch((err) => {
          join.markBrokerRevocationFailed(rec.label, { accountId: acct, error: String(err.message).slice(0, 200) });
          join.logEvent({ event: 'broker_account_delete_failed', label: rec.label, contributedAccountId: acct, error: String(err.message).slice(0, 200) });
          return sendHtml(res, 200, page.revokePage({ message: 'your pool key is disabled, but broker account removal failed. run /logout in claude on that account now, which invalidates the stored refresh token independently.', ok: false }));
        });
      }).catch(() => sendHtml(res, 400, page.revokePage({ message: 'bad request', ok: false })));
    }
  }

  // ---- public anonymized ledger ----
  if (req.method === 'GET' && (urlPath === '/ledger' || urlPath === '/ledger.json')) {
    return getUtilization().then((util) => {
      const rows = join.listKeys()
        .filter((k) => k.donor)
        .map((k) => {
          const consumed = usedTokens(k.label);
          const contributedPct = k.contributedAccountId && util.perSeat[k.contributedAccountId] !== undefined
            ? util.perSeat[k.contributedAccountId]
            : null;
          return {
            donor: k.label.length > 3 ? `${k.label.slice(0, 3)}\u2022\u2022\u2022` : k.label,
            tier: k.tier || 'donor',
            contributedPct,
            consumedTokens: consumed,
            quota: k.quota || DEFAULT_QUOTA,
            // Net-positive = made more capacity available than they have drawn.
            netPositive: consumed < (k.quota || DEFAULT_QUOTA) / 2,
          };
        });
      if (urlPath === '/ledger.json') {
        return sendJson(res, 200, {
          utilization: {
            available: util.available,
            utilizationPct: util.utilizationPct,
            consumedPct: util.consumedPct,
            theoreticalPct: util.theoreticalPct,
            seats: util.seats,
            tokensServed: util.tokensServed,
            formula: util.formula,
            caveats: util.honesty,
          },
          donors: rows,
        });
      }
      return sendHtml(res, 200, page.ledgerPage({ rows, util, tiers: join.TIERS }));
    });
  }

  return false; // not a join route
}

// ---- /account family: Steward-backed pool accounts (2026-07-30) ------------
// Cookie-authenticated, read-mostly. The ONLY writes this slice permits are
// session mint/clear and claiming a key by proving possession of the raw key.
// Destructive actions (revoke) deliberately stay on their existing paths.

/** Aggregate everything a verified user owns into one read-only payload.
 *  Scoped HARD to ownerUserId === userId; there is no parameter that can
 *  widen it to another user's keys, mirroring the /meter/me discipline. */
function buildAccountView(userId, email) {
  const owned = join.keysOwnedBy(userId);
  flushTotals();
  const keys = owned.map((k) => ({
    label: k.label,
    tier: k.tier || null,
    enabled: k.enabled !== false,
    quota: k.admin ? null : (typeof k.quota === 'number' ? k.quota : DEFAULT_QUOTA),
    used: metrics.effective(k.label),
    donor: !!k.donor,
    createdAt: k.created || null,
  }));
  let used = 0, quota = 0, spent = 0;
  for (const k of keys) {
    used += k.used;
    if (typeof k.quota === 'number') quota += k.quota;
  }
  for (const k of owned) spent += metrics.costUsdFor(k.label);
  const seatKeys = owned.filter((k) => k.contributedAccountId);
  return getUtilization().then((util) => {
    const seats = seatKeys.map((k) => {
      const pct = util && util.perSeat ? util.perSeat[k.contributedAccountId] : undefined;
      return {
        label: k.label,
        provider: k.contributedProvider || 'anthropic-subscription',
        contributedPct: pct === undefined ? null : pct,
        live: pct !== undefined,
        revoked: !!k.brokerRevokedAt,
      };
    });
    return {
      userId,
      email: email || null,
      usage: {
        used,
        quota: quota || null,
        remaining: quota ? Math.max(0, quota - used) : null,
        spentUsd: pricing.usd(spent),
        spentDisplay: pricing.fmtUsd(spent),
      },
      keys,
      seats,
    };
  });
}

function handleAccountRoutes(req, res, urlPath) {
  // ---- the dashboard page: static, identical for every visitor ----
  if (req.method === 'GET' && urlPath === '/account') {
    return sendHtml(res, 200, accountPage.accountPage({
      stewardBase: account.STEWARD_BASE,
      tenant: account.ACCOUNT_TENANT,
    }));
  }

  // ---- establish a pool session from a verified Steward credential ----
  // Not cookie-authenticated (it CREATES the cookie), so no origin gate: the
  // credential in the body is the proof, and it cannot be sent cross-site by
  // a form post (JSON body + verification against Steward).
  if (req.method === 'POST' && urlPath === '/account/session') {
    return readJsonBody(req).then((body) => {
      if (!body || (typeof body.idToken !== 'string' && typeof body.accessToken !== 'string')) {
        return sendJson(res, 400, { ok: false, error: 'idToken or accessToken required' });
      }
      return account.verifyIdentity({ idToken: body.idToken, accessToken: body.accessToken })
        .then((v) => {
          if (!v.ok) {
            join.logEvent({ event: 'account_login_rejected', reason: v.reason, ip: clientIp(req) });
            return sendJson(res, 401, { ok: false, error: 'identity not verified' });
          }
          const token = account.mintSession({ userId: v.userId, email: v.email });
          join.logEvent({ event: 'account_login', userId: v.userId, method: v.method, ip: clientIp(req) });
          return buildAccountView(v.userId, v.email).then((view) =>
            sendJson2(res, 200, { ok: true, account: view }, { 'set-cookie': account.serializeCookie(token) }));
        });
    }).catch((e) => {
      console.error('account session error:', e.message);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
    });
  }

  // ---- who am I / dashboard data (cookie-authenticated, read-only) ----
  if (req.method === 'POST' && urlPath === '/account/whoami') {
    const sess = account.sessionFromRequest(req);
    if (!sess) return sendJson(res, 200, { ok: false });
    return buildAccountView(sess.userId, sess.email)
      .then((view) => sendJson(res, 200, { ok: true, account: view }))
      .catch((e) => {
        console.error('account whoami error:', e.message);
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
      });
  }

  if (req.method === 'POST' && urlPath === '/account/logout') {
    return sendJson2(res, 200, { ok: true }, { 'set-cookie': account.clearCookie() });
  }

  // ---- claim an existing key by proving possession of the raw key ----
  // Mutating + cookie-authenticated => origin-gated. The raw key is a lookup
  // credential only: never logged, never stored beyond the existing record.
  if (req.method === 'POST' && urlPath === '/account/claim') {
    const sess = account.sessionFromRequest(req);
    if (!sess) return sendJson(res, 401, { ok: false, error: 'not signed in' });
    if (!account.checkOrigin(req)) return sendJson(res, 403, { ok: false, error: 'bad origin' });
    return readJsonBody(req).then((body) => {
      if (!body || typeof body.key !== 'string') return sendJson(res, 400, { ok: false, error: 'key required' });
      const r = join.claimKeyByRawKey(body.key, sess.userId);
      if (!r.ok) {
        // Uniform error: this endpoint must not be a key-validity oracle.
        join.logEvent({ event: 'account_claim_rejected', userId: sess.userId, reason: r.reason });
        return sendJson(res, 400, { ok: false, error: 'that key cannot be claimed' });
      }
      join.logEvent({ event: 'account_key_claimed', userId: sess.userId, label: r.label, alreadyOwned: !!r.alreadyOwned });
      loadKeys();
      return sendJson(res, 200, { ok: true, label: r.label });
    }).catch(() => {
      if (!res.headersSent) sendJson(res, 400, { ok: false, error: 'bad request' });
    });
  }

  return false; // not an account route
}

// sendJson with extra headers (set-cookie). Kept separate so the hot-path
// sendJson stays exactly as it was.
function sendJson2(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function send401(res) {
  const body = JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
  res.writeHead(401, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// ---- quota (all-time token limit per key; default 13,371,337 "leetmit") ----
// Cost-weighted effective tokens, normalized to input-token cost = 1.0.
// Anthropic pricing ratios: output ~5x input, cache read ~0.1x, cache write ~1.25x.
// Raw counters stay untouched in `totals`; only the quota math is weighted, so a
// cache-heavy Claude Code session no longer burns quota 10x faster than it costs.
// TOKEN_WEIGHTS now lives in lib/metrics.js (single source of truth, shared by
// the quota gate, /meter/stats, /meter/me and the reputation ratio math).
function usedTokens(label) {
  return metrics.effective(label);
}
// BYO traffic is metered under a distinct label namespace so it can NEVER count
// against a member's pooled quota (they burn their own money). The prefix is a
// control char so it can't collide with a real human-chosen label.
const BYO_LABEL_PREFIX = '\u0001byo\u0001';
function byoLabel(label) { return BYO_LABEL_PREFIX + label; }
function isByoLabel(label) { return typeof label === 'string' && label.startsWith(BYO_LABEL_PREFIX); }
function byoBucket(label) {
  // Raw byo totals for a member, read from totals.json (bumpTotals target).
  const t = totals[byoLabel(label)];
  if (!t) return { requests: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_creation: 0, lastUsedAt: null };
  return { requests: t.requests, input_tokens: t.input_tokens, output_tokens: t.output_tokens, cache_read: t.cache_read, cache_creation: t.cache_creation, lastUsedAt: t.lastUsedAt };
}
// Map a request path prefix to a BYO provider id. This is the resolution seam:
// if the member has a BYO credential for the provider a path targets, the
// request is forwarded to the provider's real API with THEIR token; else it
// falls through to the pooled lease path (anthropic today, codex via sibling).
function providerForPath(urlPath) {
  if (urlPath.startsWith('/openai/')) return 'openai';
  if (urlPath.startsWith('/openrouter/')) return 'openrouter';
  if (urlPath.startsWith('/v1/')) return 'anthropic';
  return null;
}
function sendQuotaExceeded(res, label, quota) {
  const body = JSON.stringify({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: `Pool quota exhausted: this key has used its ${quota.toLocaleString('en-US')}-token allowance. Contact the pool operator to request more quota or use your own provider key.`
    }
  });
  res.writeHead(429, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
  console.log(`quota exceeded: ${label} used=${usedTokens(label)} quota=${quota}`);
}

// Dollar spend at API list pricing, and its optional cap.
function usedUsd(label) {
  return metrics.costUsdFor(label);
}
function sendBudgetExceeded(res, label, budgetUsd, spent) {
  const body = JSON.stringify({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: `budget cap reached: ${pricing.fmtUsd(spent)} spent of ${pricing.fmtUsd(budgetUsd)} at api list pricing. ping shadow for more.`,
    },
  });
  res.writeHead(429, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
  console.log(`budget exceeded: ${label} spent=$${spent.toFixed(4)} budget=$${budgetUsd}`);
}

const server = http.createServer((req, res) => {
  // ---- public status pane (no auth, read-only, cached) ----
  const urlPath = req.url.split('?')[0];
  // Parsed once at handler scope: both the /join family and /status.json read
  // query params, and scoping this inside the /join branch made /status.json
  // throw a ReferenceError before it could render.
  const query = new URLSearchParams(req.url.split('?')[1] || '');
  if (req.method === 'GET' && urlPath === '/eliza-mark.svg') {
    try {
      const svg = fs.readFileSync(path.join(PUBLIC_DIR, 'eliza-mark.svg'));
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
      return res.end(svg);
    } catch (_) { res.writeHead(404); return res.end(); }
  }
  // ---- /account family (public page; cookie/steward-gated internally) ----
  if (urlPath === '/account' || urlPath.startsWith('/account/')) {
    let handled;
    try {
      handled = handleAccountRoutes(req, res, urlPath);
    } catch (e) {
      console.error('account route error:', e.message);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
      return;
    }
    if (handled !== false) {
      if (handled && typeof handled.catch === 'function') {
        handled.catch((e) => {
          console.error('account route error:', e.message);
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
        });
      }
      return;
    }
    // unknown /account/* path falls through to 404-ish auth wall below
  }

  // ---- /join family (public page; steward-gated internally, invite optional) ----
  if (urlPath === '/join' || urlPath.startsWith('/join/') || urlPath === '/ledger' || urlPath === '/ledger.json') {
    let handled;
    try {
      handled = handleJoinRoutes(req, res, urlPath, query);
    } catch (e) {
      console.error('join route error:', e.message);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      return;
    }
    if (handled !== false) {
      if (handled && typeof handled.catch === 'function') {
        handled.catch((e) => {
          console.error('join route error:', e.message);
          if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
        });
      }
      return;
    }
  }

  if (req.method === 'GET' && (urlPath === '/status' || urlPath === '/status.json')) {
    loadKeys();
    // Optional key (header or ?key=) reveals real account labels on the HTML view.
    const k = req.headers['x-api-key'] || query.get('key') || null;
    const ki = k ? keyMap.get(k) : undefined;
    const authed = !!(ki && ki.enabled !== false);
    return handleStatus(res, urlPath === '/status.json' ? 'json' : 'html', authed, query.get('fresh') === '1' ? { force: true } : {});
  }

  loadKeys();
  let apiKey = req.headers['x-api-key'];
  if (!apiKey && typeof req.headers['authorization'] === 'string') {
    const m = req.headers['authorization'].match(/^Bearer\s+(.+)$/i);
    if (m) apiKey = m[1].trim();
  }
  const info = apiKey ? keyMap.get(apiKey) : undefined;
  if (!info || !info.enabled) return send401(res);

  // ---- self-serve usage (ANY valid key, own data only) ----
  // Deliberately scoped to info.label with no way to name another key: a
  // non-admin key can never widen this to someone else's burn.
  if (req.method === 'GET' && (urlPath === '/meter/me' || urlPath === '/meter/usage')) {
    flushTotals();
    const days = Math.max(1, Math.min(90, Number(query.get('days')) || 7));
    const quota = info.admin ? null : (info.quota || null);
    const report = metrics.labelReport(info.label, {
      days, quota, tier: info.tier, admin: !!info.admin,
      budgetUsd: info.admin ? null : (info.budgetUsd || null),
    });
    // ---- myEarnings: the product thesis as a number, for THIS key ----
    // Only present when the key declares a donated seat. A key with no seat
    // gets an explicit null plus the reason, rather than a zeroed block that
    // would read as "your seat earned nothing".
    try {
      const keyRow = (join.listKeys ? join.listKeys() : []).find((k) => k.label === info.label) || null;
      const acctId = keyRow ? (keyRow.contributedAccountId || keyRow.accountId || null) : null;
      if (acctId) {
        // A seat claimed by several keys splits its earnings equally, exactly
        // as /meter/ledger does, so the two views can never disagree.
        const claimants = (join.listKeys ? join.listKeys() : [])
          .filter((k) => (k.contributedAccountId || k.accountId) === acctId);
        const enabled = claimants.filter((k) => k.enabled !== false);
        const sharers = enabled.length ? enabled : claimants;
        report.myEarnings = ledger.myEarnings({
          metrics, key: keyRow, poolShare, aliasFor,
          ledgerShare: sharers.length ? 1 / sharers.length : 1,
        });
      } else {
        report.myEarnings = null;
        report.myEarningsNote = 'this key is not linked to a donated seat, so it earns nothing. ' +
          'keys minted through /join carry the linkage automatically; older keys do not. ' +
          'earnings are a PROTOTYPE ledger figure — no money moves.';
      }
    } catch (e) {
      report.myEarnings = null;
      report.myEarningsNote = `earnings unavailable: ${e.message}`;
    }
    // ---- BYO bucket: the member's own-token traffic, metered separately and
    // NOT counted against pooled quota. Present for every key (zeros if unused).
    report.byo = {
      usage: byoBucket(info.label),
      credentials: byoStore.list(info.key || apiKey),
      note: 'BYO traffic burns YOUR provider token, not pooled quota. It does not count against your pool quota.',
    };
    report.traces = {
      pooled: info.traces !== false,
      byo: info.traces === true,
      note: 'pooled usage is logged and may be included in anonymized datasets (default on). BYO traffic is only logged if you opt in (set traces:true).',
    };
    report.endpoint = { self: '/meter/me', byo: '/byo/credentials', ledger: '/meter/ledger (admin)', pricing: '/meter/pricing', traces: '/meter/traces/stats (admin)', docs: `${config.publicBaseUrl}/docs` };
    return sendJson(res, 200, report);
  }

  // ---- stats endpoint v2 (admin only) ----
  if (req.method === 'GET' && urlPath === '/meter/stats') {
    if (!info.admin) return send401(res);
    flushTotals();
    const days = Math.max(1, Math.min(90, Number(query.get('days')) || 7));
    const quotaFor = (label) => {
      for (const k of keyMap.values()) if (k.label === label) return k.admin ? null : (k.quota || null);
      return null;
    };
    const tierFor = (label) => {
      for (const k of keyMap.values()) if (k.label === label) return k.tier || null;
      return null;
    };
    const budgetFor = (label) => {
      for (const k of keyMap.values()) if (k.label === label) return k.admin ? null : (k.budgetUsd || null);
      return null;
    };
    const report = metrics.statsReport({ days, quotaFor, tierFor, budgetFor });
    report.uptime = reputation.report();
    report.attribution = {
      method: 'anthropic-organization-id response header mapped to broker account organizationId',
      accountsKnown: metrics.orgToAccount.size,
      note: 'records logged before v2 have no org header and appear under `unattributed`',
    };
    // Full pool-vs-outside detail, including each seat's raw weekly-pct
    // timeline with pool tokens overlaid (the honest-gap deliverable).
    report.usageSplit = poolShare.report();
    // Legacy v1 fields kept so existing scrapers do not break.
    const effective = {};
    for (const label of metrics.allLabels()) effective[label] = usedTokens(label);
    report.legacy = { weights: TOKEN_WEIGHTS, effective, totals };
    if (query.get('identify') === '1') report.accounts = metrics.accountReport({ days, includeIdentity: true });
    // ---- BYO bucket rollup: own-token traffic per member, kept OUT of the
    // pooled totals above so pooled quota/economics are never inflated by it.
    const byo = { members: {}, totals: { requests: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_creation: 0 } };
    for (const [lbl, t] of Object.entries(totals)) {
      if (!isByoLabel(lbl)) continue;
      const member = lbl.slice(BYO_LABEL_PREFIX.length);
      byo.members[member] = { requests: t.requests, input_tokens: t.input_tokens, output_tokens: t.output_tokens, cache_read: t.cache_read, cache_creation: t.cache_creation, lastUsedAt: t.lastUsedAt };
      byo.totals.requests += t.requests; byo.totals.input_tokens += t.input_tokens;
      byo.totals.output_tokens += t.output_tokens; byo.totals.cache_read += t.cache_read;
      byo.totals.cache_creation += t.cache_creation;
    }
    report.byo = byo;
    return sendJson(res, 200, report);
  }

  // ---- trace store stats (admin only) ----
  if (req.method === 'GET' && urlPath === '/meter/traces/stats') {
    if (!info.admin) return send401(res);
    return sendJson(res, 200, traceStore.stats());
  }

  // ---- per-key trace opt-out / opt-in ----
  // Self-serve: any key can set its OWN traces flag. Admin can set anyone's by label.
  //   POST /meter/traces { "traces": false }            -> own key
  //   POST /meter/traces { "label": "x", "traces": false } -> admin only
  if (req.method === 'POST' && urlPath === '/meter/traces') {
    return readJsonBody(req).then((body) => {
      if (!body || typeof body.traces !== 'boolean') {
        return sendJson(res, 400, { error: 'body must be { traces: true|false }' });
      }
      const targetLabel = body.label ? String(body.label) : info.label;
      if (targetLabel !== info.label && !info.admin) return send401(res);
      const storeLib = require('./lib/store.js');
      let found = false;
      storeLib.update(join.KEYS_FILE, () => ({ keys: [] }), (data) => {
        for (const k of data.keys || []) {
          if (k.label === targetLabel) { k.traces = body.traces; found = true; }
        }
        return data;
      });
      if (!found) return sendJson(res, 404, { error: `no key with label ${targetLabel}` });
      keysMtime = 0; loadKeys(); // force reload so the flag applies immediately
      console.log(`trace: consent flag for '${targetLabel}' set traces=${body.traces} by '${info.label}'`);
      return sendJson(res, 200, { label: targetLabel, traces: body.traces });
    }).catch((e) => sendJson(res, 500, { error: e.message }));
  }

  // ---- payout ledger, PROTOTYPE (admin only) ----
  // Admin-gated because it joins per-member consumption to per-seat earnings,
  // which is exactly the cross-member view /meter/me exists to prevent a
  // normal key from seeing. Members get their own row via /meter/me.myEarnings.
  if (req.method === 'GET' && urlPath === '/meter/ledger') {
    if (!info.admin) return send401(res);
    flushTotals();
    try {
      return sendJson(res, 200, buildLedgerReport({ identify: query.get('identify') === '1' }));
    } catch (e) {
      console.error('ledger build failed:', e.message);
      return sendJson(res, 500, { error: e.message });
    }
  }

  // ---- pricing table (any valid key; it is public list pricing, not a secret) ----
  if (req.method === 'GET' && urlPath === '/meter/pricing') {
    return sendJson(res, 200, pricing.table());
  }

  // ---- reputation / ratio economy (admin) ----
  if (req.method === 'GET' && urlPath === '/meter/reputation') {
    if (!info.admin) return send401(res);
    return buildReputationReport({ identify: query.get('identify') === '1' })
      .then((r) => sendJson(res, 200, r))
      .catch((e) => sendJson(res, 503, { error: e.message }));
  }

  // ---- BYO credential registration (any valid key, own creds only) ----
  // POST /byo/credentials  {provider, token}  -> encrypt + store out-of-tree
  // GET  /byo/credentials                     -> list masked (no plaintext)
  // POST /byo/credentials/remove {provider}    -> delete
  // The token is NEVER logged, NEVER echoed back, NEVER written to pool-keys.json.
  if (urlPath === '/byo/credentials' || urlPath === '/byo/credentials/remove') {
    const poolKey = info.key || apiKey;
    if (req.method === 'GET' && urlPath === '/byo/credentials') {
      return sendJson(res, 200, {
        providers: Object.keys(BYO_PROVIDERS),
        credentials: byoStore.list(poolKey),
        note: 'BYO traffic burns YOUR provider token, not pooled quota. Register a token, then call the matching leg (/v1/* anthropic, /openai/* openai, /openrouter/* openrouter) with your pool key.',
      });
    }
    if (req.method === 'POST' && urlPath === '/byo/credentials') {
      return readJsonBody(req).then((body) => {
        if (!body) return sendJson(res, 400, { error: 'bad json' });
        try {
          const summary = byoStore.set(poolKey, body.provider, body.token);
          console.log(`byo: credential registered label=${info.label} provider=${summary.provider} ****${summary.last4}`);
          return sendJson(res, 200, { ok: true, ...summary });
        } catch (e) { return sendJson(res, 400, { error: e.message }); }
      }).catch((e) => sendJson(res, 500, { error: e.message }));
    }
    if (req.method === 'POST' && urlPath === '/byo/credentials/remove') {
      return readJsonBody(req).then((body) => {
        if (!body || !body.provider) return sendJson(res, 400, { error: 'provider required' });
        const removed = byoStore.remove(poolKey, body.provider);
        return sendJson(res, removed ? 200 : 404, { removed });
      }).catch((e) => sendJson(res, 500, { error: e.message }));
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  // ---- quota gate (before proxying; admin keys exempt) ----
  // BYO traffic bypasses the pooled quota gate entirely: a request that has a
  // BYO credential for its target provider burns the member's own token, so it
  // must not be blocked by (or counted against) the donated-quota budget.
  const byoProvider = providerForPath(urlPath);
  const useByo = byoProvider && byoStore.has(info.key || apiKey, byoProvider);
  if (!useByo && !info.admin && info.quota && usedTokens(info.label) >= info.quota) {
    return sendQuotaExceeded(res, info.label, info.quota);
  }

  // ---- budget gate: optional dollar cap, enforced ONLY when set ----
  // Same BYO carve-out as the quota gate: own-token traffic is not on our dime.
  if (!useByo && !info.admin && info.budgetUsd) {
    const spent = usedUsd(info.label);
    if (spent >= info.budgetUsd) return sendBudgetExceeded(res, info.label, info.budgetUsd, spent);
  }

  // ---- admin: invite minting + donor quota sync (same auth path as /meter/stats) ----
  // Non-admin keys are rejected here rather than falling through to the proxy,
  // which would forward a nonsense path upstream and answer with its 404.
  if (urlPath.startsWith('/admin/')) {
    if (!info.admin) return send401(res);
  }
  if (info.admin && req.method === 'POST' && urlPath === '/admin/invite') {
    return readJsonBody(req).then((body) => {
      if (!body) return sendJson(res, 400, { error: 'bad json' });
      const ttlHours = Number(body.ttlHours) > 0 ? Number(body.ttlHours) : 24;
      const inv = join.createInvite({
        tier: body.tier || 'donor',
        note: body.note || '',
        ttlMs: ttlHours * 3600000,
        createdBy: info.label,
      });
      join.logEvent({ event: 'invite_created', inviteId: inv.id, tier: inv.tier, by: info.label });
      sendJson(res, 200, {
        id: inv.id,
        tier: inv.tier,
        url: `https://pool.example.com/join?i=${inv.token}`,
        expiresAt: new Date(inv.expiresAt).toISOString(),
      });
    }).catch((e) => sendJson(res, 500, { error: e.message }));
  }
  if (info.admin && req.method === 'GET' && urlPath === '/admin/invites') {
    return sendJson(res, 200, { invites: join.listInvites() });
  }
  if (info.admin && req.method === 'POST' && urlPath === '/admin/invite/revoke') {
    return readJsonBody(req).then((body) => {
      if (!body || !body.id) return sendJson(res, 400, { error: 'id required' });
      const ok = join.revokeInvite(String(body.id));
      if (ok) join.logEvent({ event: 'invite_revoked', inviteId: String(body.id), by: info.label });
      sendJson(res, ok ? 200 : 404, { revoked: ok });
    }).catch((e) => sendJson(res, 500, { error: e.message }));
  }
  if (info.admin && req.method === 'POST' && urlPath === '/admin/sync-quotas') {
    return getUtilization().then((util) => {
      const changes = join.syncDonorQuotas(util.perSeat);
      if (changes.length) { loadKeys(); join.logEvent({ event: 'quotas_synced', changes }); }
      sendJson(res, 200, { changes });
    }).catch((e) => sendJson(res, 500, { error: e.message }));
  }

  // ---- tier model gate ----
  // Restricted tiers (demo) may only call cheap models. Enforced in the SAME
  // auth path as the quota gate, not a second one. Only restricted keys pay the
  // buffering cost; every other key keeps the untouched streaming path below.
  const tierModels = (!info.admin && info.tier) ? join.tierFor(info.tier).models : null;
  if (tierModels && req.method === 'POST' && req.url.startsWith('/v1/messages')) {
    return readBody(req, 32 * 1024 * 1024).then((raw) => {
      let model = null;
      try { model = JSON.parse(raw).model || null; } catch (_) { /* upstream will reject */ }
      if (!join.modelAllowed(info.tier, model)) {
        const body = JSON.stringify({
          type: 'error',
          error: {
            type: 'permission_error',
            message: `tier '${info.tier}' cannot use ${model}. allowed: ${tierModels.join(', ')}.`,
          },
        });
        res.writeHead(403, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
        console.log(`model denied: ${info.label} tier=${info.tier} model=${model}`);
        return;
      }
      proxyRequest(req, res, info, Buffer.from(raw));
    }).catch(() => {
      if (!res.headersSent) {
        const body = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'request body too large' } });
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(body);
      }
    });
  }

  // ---- BYO leg: forward with the member's OWN token, direct to the provider ----
  // Resolution order (Feature 1): a BYO credential for this pool key + the
  // provider the path targets wins over the pooled lease path. This is checked
  // for EVERY provider leg (anthropic /v1/*, openai /openai/*, openrouter
  // /openrouter/*) so pooled quota is never spent for BYO traffic.
  if (useByo) {
    return proxyByoRequest(req, res, info, byoProvider);
  }

  // ---- OpenAI/Codex leg (pooled) ----
  // Any pool key may burn pooled ChatGPT/Codex quota via /openai/v1/*. The
  // path prefix is stripped so the codex-proxy sees a clean /v1/responses.
  // Same auth + metering front door as the anthropic leg above.
  if (urlPath.startsWith('/openai/')) {
    return proxyCodexRequest(req, res, info);
  }

  // openrouter with no BYO credential is not a pooled leg — we have no
  // openrouter subscription to lease. Fail honestly instead of proxying a
  // request we can't authenticate.
  if (urlPath.startsWith('/openrouter/')) {
    const body = JSON.stringify({ error: { type: 'invalid_request_error', message: 'openrouter is BYO-only: register a token at POST /byo/credentials {provider:"openrouter", token:...} first.' } });
    res.writeHead(400, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    return res.end(body);
  }

  return proxyRequest(req, res, info, null);
});

// Forward an OpenAI Responses-API request to the codex-proxy sibling (18812),
// which leases an openai-codex account and emulates Codex CLI upstream. Usage is
// parsed from the Responses-API SSE (response.completed.usage) and recorded
// through the SAME bumpTotals/logRecord path as the anthropic leg.
function proxyCodexRequest(req, res, info) {
  const start = Date.now();
  const headers = { ...req.headers };
  delete headers['x-api-key'];
  delete headers['authorization'];
  delete headers['transfer-encoding'];
  delete headers['connection'];
  delete headers['keep-alive'];
  delete headers['te'];
  delete headers['trailer'];
  delete headers['upgrade'];
  delete headers['proxy-authenticate'];
  delete headers['proxy-authorization'];
  headers.host = `${CODEX_HOST}:${CODEX_PORT}`;
  // Strip the /openai prefix: /openai/v1/responses -> /v1/responses.
  const downstreamPath = req.url.replace(/^\/openai/, '') || '/';

  const reqMeta = { model: null, stream: false };
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  // Pooled codex trace capture (Feature 2): honors the per-key consent flag
  // (pooled default on). We tap the piped request stream non-destructively and
  // collect the Responses-API output text from the SSE copy we already parse.
  const wantTrace = shouldTrace(info, false);
  const reqTapChunks = []; let reqTapLen = 0; const REQ_TAP_CAP = 2 * 1024 * 1024;
  // Always inspect the bounded Responses request body. Codex SSE completion
  // events do not consistently echo the model, so relying on the response
  // left valid traffic in the unpriced `unknown` bucket. The client request
  // is the authoritative fallback for both model and stream mode.
  req.on('data', (c) => { if (reqTapLen < REQ_TAP_CAP) { reqTapChunks.push(c); reqTapLen += c.length; } });
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(reqTapChunks).toString('utf8'));
      if (!reqMeta.model && body && body.model) reqMeta.model = body.model;
      if (body && body.stream != null) reqMeta.stream = !!body.stream;
    } catch (_) {}
  });

  const upReq = http.request({
    host: CODEX_HOST,
    port: CODEX_PORT,
    method: req.method,
    path: downstreamPath,
    headers,
  }, (upRes) => {
    // SSE detection cannot rely on content-type: the codex-proxy streams the
    // Responses-API SSE straight from ChatGPT, which passes cloudflare headers
    // through but does NOT set `content-type: text/event-stream`. Trusting the
    // header alone sent every streamed codex response down the JSON.parse branch
    // (which fails on `event:`/`data:` frames), so usage was recorded as 0 and
    // pooled codex traffic burned no quota / priced at $0. We therefore sniff
    // the actual bytes of the first chunk, defaulting to the request's declared
    // stream intent (Codex requires stream:true) until they arrive.
    const ct = (upRes.headers['content-type'] || '');
    const isSse = ct.includes('text/event-stream');
    // Codex seat attribution (mirrors the anthropic leg's org header): the
    // codex-proxy tells us which leased ChatGPT account served the request via
    // x-codex-seat. Consume it for metering and STRIP it — an account id must
    // never reach a client.
    const codexSeat = upRes.headers['x-codex-seat'] || null;
    const outHeaders = {};
    const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'x-codex-seat']);
    for (const [k, v] of Object.entries(upRes.headers)) { if (!HOP.has(k.toLowerCase())) outHeaders[k] = v; }
    res.writeHead(upRes.statusCode, outHeaders);

    let ttfb = null;
    // Trace collection wants the assistant text; when we can't decide SSE-ness
    // up front we buffer both an SSE text collector and a raw copy and pick the
    // right one at finish() based on what the bytes turned out to be.
    const textCollector = wantTrace ? makeSseTextCollector() : null;
    let nonSseRespText = null;
    let sniffed = false;
    let sniffLooksSse = false;
    const feed = makeResponsesUsageParser(usage, reqMeta);
    const rawChunks = [];
    let rawLen = 0;
    const RES_CAP = 4 * 1024 * 1024;

    let finish = () => {
      finish = () => {};
      // If the stream looked like plain JSON, parse the buffered body now as the
      // authoritative usage source. If it was SSE (with or without the header),
      // feed() already populated usage from response.completed.
      if (!sniffLooksSse && rawChunks.length) {
        try {
          const raw = Buffer.concat(rawChunks).toString('utf8');
          if (wantTrace) nonSseRespText = raw;
          const body = JSON.parse(raw);
          const u = (body && body.response && body.response.usage) || (body && body.usage) || null;
          if (u) applyOpenAiUsage(usage, u);
          const m = (body && body.model) || (body && body.response && body.response.model);
          if (!reqMeta.model && m) reqMeta.model = m;
        } catch (_) { /* not JSON either; leave usage as parsed */ }
      }
      const streamed = isSse || sniffLooksSse || reqMeta.stream;
      const rec = {
        ts: new Date(start).toISOString(),
        label: info.label,
        method: req.method,
        path: req.url.split('?')[0],
        model: reqMeta.model,
        stream: streamed,
        status: upRes.statusCode,
        latency_ms: Date.now() - start,
        usage,
      };
      // Same JSONL field as the anthropic leg so metrics.resolveAccountId
      // attributes codex traffic to its donated seat (directory-mapped when
      // the broker knows the id, provisional org:<id> alias otherwise).
      if (codexSeat) rec.org = codexSeat;
      logRecord(rec);
      bumpTotals(info.label, usage);
      if (wantTrace) {
        let reqText = null; try { if (reqTapChunks.length) reqText = Buffer.concat(reqTapChunks).toString('utf8'); } catch (_) {}
        traceStore.capture({
          ts: rec.ts, label: info.label, provider: 'openai', byo: false, model: reqMeta.model,
          stream: streamed, status: upRes.statusCode, ttfb_ms: ttfb,
          latency_ms: rec.latency_ms, usage, request: reqText,
          response: sniffLooksSse ? (textCollector ? textCollector.text() : null) : nonSseRespText,
        });
      }
    };

    upRes.on('data', (chunk) => {
      if (ttfb == null) ttfb = Date.now() - start;
      if (!sniffed) {
        sniffed = true;
        const head = chunk.slice(0, 64).toString('utf8').replace(/^\uFEFF/, '').trimStart();
        sniffLooksSse = isSse || head.startsWith('event:') || head.startsWith('data:') || head.startsWith(':');
      }
      if (sniffLooksSse) {
        try { feed(chunk); } catch (_) {}
        if (textCollector) { try { textCollector.feed(chunk); } catch (_) {} }
      } else if (rawLen < RES_CAP) {
        rawChunks.push(chunk); rawLen += chunk.length;
      }
      res.write(chunk);
    });
    upRes.on('end', () => { res.end(); finish(); });
    upRes.on('error', () => { try { res.end(); } catch (_) {} finish(); });
  });

  upReq.on('error', (e) => {
    if (!res.headersSent) {
      const body = JSON.stringify({ error: { type: 'api_error', message: 'codex upstream unavailable' } });
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(body);
    } else { try { res.end(); } catch (_) {} }
    logRecord({ ts: new Date(start).toISOString(), label: info.label, method: req.method, path: req.url.split('?')[0], model: reqMeta.model, stream: reqMeta.stream, status: 502, latency_ms: Date.now() - start, usage: { input_tokens: 0, output_tokens: 0 }, error: e.code || e.message });
  });

  req.pipe(upReq);
}

// (OpenAI usage conversion — applyOpenAiUsage + makeResponsesUsageParser —
// lives in lib/openai-usage.js so the regression suite can exercise it
// directly. See that file for the OpenAI-vs-Anthropic cached-token semantics.)

// Forward to the pool proxy. `prebuffered` is non-null only when the tier model
// gate had to read the body first; in that case it is replayed verbatim so the
// upstream sees byte-identical input either way.
function proxyRequest(req, res, info, prebuffered) {
  // The Anthropic edge rejects chunked request bodies with a bare 400. nginx
  // forwards client requests to us with `transfer-encoding: chunked` (no
  // content-length), so a request that arrives chunked must be buffered here
  // and replayed upstream with an explicit content-length. Requests that
  // already carry a content-length stream straight through untouched.
  if (!prebuffered && req.headers['transfer-encoding'] && !req.headers['content-length']) {
    const chunks = [];
    let len = 0;
    const CAP = 20 * 1024 * 1024; // matches nginx client_max_body_size 20m
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      len += c.length;
      if (len > CAP) {
        aborted = true;
        const body = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'request body too large' } });
        res.writeHead(413, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
        try { req.destroy(); } catch (_) {}
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      proxyRequest(req, res, info, Buffer.concat(chunks));
    });
    req.on('error', () => { aborted = true; });
    return;
  }

  const start = Date.now();
  const headers = { ...req.headers };
  delete headers['x-api-key'];       // never forward the pool key upstream
  delete headers['authorization'];   // never forward bearer pool key upstream
  headers.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
  // Hop-by-hop request headers must not be relayed (RFC 7230 6.1). In
  // particular `transfer-encoding: chunked` arrives from nginx but the
  // Anthropic edge rejects a chunked request body with a bare 400, which
  // surfaced as intermittent 400s for pool keys. When we have the whole body
  // (prebuffered path) we always send an explicit content-length instead.
  delete headers['transfer-encoding'];
  delete headers['connection'];
  delete headers['keep-alive'];
  delete headers['te'];
  delete headers['trailer'];
  delete headers['upgrade'];
  delete headers['proxy-authenticate'];
  delete headers['proxy-authorization'];
  if (prebuffered) headers['content-length'] = String(prebuffered.length);

  // capture request body for model/stream detection while forwarding
  const reqMeta = { model: null, stream: false };
  const isMessages = req.url.startsWith('/v1/messages');
  // Pooled trace capture (Feature 2): pooled usage defaults to traced, honoring
  // the per-key opt-out. When tracing, capture the FULL request body (bounded
  // by the trace clip) instead of just the 512K head we need for model/stream.
  const wantTrace = shouldTrace(info, false);
  let reqBodyChunks = [];
  let reqBodyLen = 0;
  const REQ_CAP = wantTrace ? (2 * 1024 * 1024) : (512 * 1024);
  const captureReq = isMessages || wantTrace;

  const upReq = http.request({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    method: req.method,
    path: req.url,
    headers,
  }, (upRes) => {
    const ct = (upRes.headers['content-type'] || '');
    const isSse = ct.includes('text/event-stream');
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

    // Strip hop-by-hop headers before relaying. Forwarding upstream's
    // `connection`/`keep-alive`/`transfer-encoding` verbatim corrupts framing on
    // the downstream hop (nginx saw alternating 400s because a reused keepalive
    // connection inherited upstream's framing intent). RFC 7230 6.1: a proxy
    // MUST NOT forward these.
    {
      const outHeaders = {};
      const HOP = new Set([
        'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
        'te', 'trailer', 'transfer-encoding', 'upgrade',
      ]);
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (!HOP.has(k.toLowerCase())) outHeaders[k] = v;
      }
      res.writeHead(upRes.statusCode, outHeaders);
    }

    // ---- donor attribution ----
    // The upstream pool proxy relays Anthropic's own response headers, which
    // include `anthropic-organization-id`. Every broker account has a distinct
    // organizationId, so this is a genuine per-donated-seat attribution signal
    // rather than an estimate. `x-actual-model` is the model the edge really
    // served, which can differ from what the client asked for (aliases,
    // fallbacks), so it is recorded alongside the requested model.
    const org = upRes.headers['anthropic-organization-id'] || null;
    // The edge sends `x-actual-model: unknown` on streaming responses, where it
    // cannot resolve the served model before headers flush. Treating that as a
    // model name would bucket real traffic under a bogus "unknown" model, so
    // only a concrete value is allowed to override the requested model.
    const rawActual = upRes.headers['x-actual-model'] || null;
    const actualModel = rawActual && rawActual !== 'unknown' ? rawActual : null;
    const requestId = upRes.headers['request-id'] || null;

    let ttfb = null;
    const textCollector = (wantTrace && isSse) ? makeSseTextCollector() : null;
    let nonSseRespText = null;

    let finish = () => {
      finish = () => {};
      const rec = {
        ts: new Date(start).toISOString(),
        label: info.label,
        method: req.method,
        path: req.url.split('?')[0],
        model: reqMeta.model,
        stream: isSse || reqMeta.stream,
        status: upRes.statusCode,
        latency_ms: Date.now() - start,
        usage,
      };
      if (org) rec.org = org;
      if (actualModel && actualModel !== reqMeta.model) rec.actual_model = actualModel;
      if (requestId) rec.request_id = requestId;
      logRecord(rec);
      bumpTotals(info.label, usage);
      if (wantTrace) {
        let reqText = null;
        try { if (reqBodyChunks && reqBodyChunks.length) reqText = Buffer.concat(reqBodyChunks).toString('utf8'); } catch (_) {}
        if (reqText == null && prebuffered) { try { reqText = prebuffered.toString('utf8'); } catch (_) {} }
        traceStore.capture({
          ts: rec.ts, label: info.label, provider: 'anthropic', byo: false,
          model: reqMeta.model, stream: isSse || reqMeta.stream, status: upRes.statusCode,
          ttfb_ms: ttfb, latency_ms: rec.latency_ms, usage,
          request: reqText, response: textCollector ? textCollector.text() : nonSseRespText,
        });
      }
    };

    if (isSse) {
      const feed = makeSseUsageParser(usage);
      upRes.on('data', (chunk) => { if (ttfb == null) ttfb = Date.now() - start; feed(chunk); if (textCollector) { try { textCollector.feed(chunk); } catch (_) {} } res.write(chunk); }); // tee: parse copy, pass original bytes
      upRes.on('end', () => { res.end(); finish(); });
    } else {
      // buffer a copy for usage parse (responses are JSON, bounded)
      const chunks = [];
      let len = 0;
      const RES_CAP = 4 * 1024 * 1024;
      upRes.on('data', (chunk) => {
        if (ttfb == null) ttfb = Date.now() - start;
        if (len < RES_CAP) { chunks.push(chunk); len += chunk.length; }
        res.write(chunk);
      });
      upRes.on('end', () => {
        res.end();
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (wantTrace) nonSseRespText = raw;
          const body = JSON.parse(raw);
          if (body && body.usage) {
            usage.input_tokens = body.usage.input_tokens || 0;
            usage.output_tokens = body.usage.output_tokens || 0;
            usage.cache_creation_input_tokens = body.usage.cache_creation_input_tokens || 0;
            usage.cache_read_input_tokens = body.usage.cache_read_input_tokens || 0;
          }
          if (!reqMeta.model && body && body.model) reqMeta.model = body.model;
        } catch (_) { /* non-JSON or huge body: log zeros */ }
        finish();
      });
    }
    upRes.on('error', () => { try { res.end(); } catch (_) {} finish(); });
  });

  upReq.on('error', (e) => {
    if (!res.headersSent) {
      const body = JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream unavailable' } });
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(body);
    } else {
      try { res.end(); } catch (_) {}
    }
    logRecord({ ts: new Date(start).toISOString(), label: info.label, method: req.method, path: req.url.split('?')[0], model: reqMeta.model, stream: reqMeta.stream, status: 502, latency_ms: Date.now() - start, usage: { input_tokens: 0, output_tokens: 0 }, error: e.code || e.message });
  });

  // The body was already consumed by the tier model gate: replay it verbatim
  // instead of piping a stream that has no data left to emit.
  if (prebuffered) {
    if (isMessages) {
      try {
        const b = JSON.parse(prebuffered.toString('utf8'));
        reqMeta.model = b.model || null;
        reqMeta.stream = !!b.stream;
      } catch (_) {}
    }
    upReq.end(prebuffered);
    req.on('error', () => { try { upReq.destroy(); } catch (_) {} });
    req.on('aborted', () => { try { upReq.destroy(); } catch (_) {} });
    return;
  }

  req.on('data', (chunk) => {
    if (captureReq && reqBodyLen < REQ_CAP) { reqBodyChunks.push(chunk); reqBodyLen += chunk.length; }
    upReq.write(chunk);
  });
  req.on('end', () => {
    upReq.end();
    if (captureReq && reqBodyChunks.length) {
      try {
        const b = JSON.parse(Buffer.concat(reqBodyChunks).toString('utf8'));
        reqMeta.model = b.model || null;
        reqMeta.stream = !!b.stream;
      } catch (_) {}
      // Keep reqBodyChunks alive when tracing: finish() (on the response end)
      // reads them to record the request. Non-tracing path can drop them.
      if (!wantTrace) reqBodyChunks = [];
    }
  });
  req.on('error', () => { try { upReq.destroy(); } catch (_) {} });
  req.on('aborted', () => { try { upReq.destroy(); } catch (_) {} });
}

// ---- BYO leg: forward direct to the provider with the member's OWN token ----
// Feature 1. The pooled quota is untouched; usage is metered under a distinct
// byo label namespace (byoLabel) so /meter/me and /meter/stats show a separate
// 'byo' bucket. Trace capture honors the per-key opt-in (byo default FALSE).
//
// We PASS THE CLIENT BODY THROUGH VERBATIM and only swap auth + host, exactly
// like the pooled anthropic leg swaps auth (proxyRequest). The plaintext BYO
// token is set on the upstream request header and is NEVER logged or traced.
function proxyByoRequest(req, res, info, provider) {
  const start = Date.now();
  const prov = BYO_PROVIDERS[provider];
  if (!prov) { // defensive; providerForPath already gated this
    const body = JSON.stringify({ error: { type: 'api_error', message: 'byo provider misconfigured' } });
    res.writeHead(500, { 'content-type': 'application/json' }); return res.end(body);
  }
  const token = byoStore.get(info.key, provider);
  if (!token) {
    const body = JSON.stringify({ error: { type: 'invalid_request_error', message: `no BYO credential for provider '${provider}'` } });
    res.writeHead(400, { 'content-type': 'application/json' }); return res.end(body);
  }

  // Map the pool path to the provider's real path.
  //   anthropic: /v1/messages           -> /v1/messages          (keepPrefix)
  //   openai:    /openai/v1/responses   -> /v1/responses
  //   openrouter:/openrouter/api/v1/... -> /api/v1/...
  let upstreamPath = req.url;
  if (!prov.keepPrefix && prov.stripPrefix) {
    upstreamPath = req.url.replace(new RegExp('^' + prov.stripPrefix.replace(/[/]/g, '\\/')), '') || '/';
  }

  const headers = { ...req.headers };
  delete headers['x-api-key'];
  delete headers['authorization'];
  delete headers['transfer-encoding'];
  delete headers['connection'];
  delete headers['keep-alive'];
  delete headers['te'];
  delete headers['trailer'];
  delete headers['upgrade'];
  delete headers['proxy-authenticate'];
  delete headers['proxy-authorization'];
  delete headers['content-length']; // recomputed below when we buffer
  headers.host = prov.host;
  // Set the member's token in the provider's expected header/scheme.
  if (prov.authHeader === 'x-api-key') headers['x-api-key'] = token;
  else if (prov.scheme === 'bearer') headers['authorization'] = `Bearer ${token}`;
  else headers[prov.authHeader] = token;

  const wantTrace = shouldTrace(info, true);
  const reqMeta = { model: null, stream: false };
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const mLabel = byoLabel(info.label);

  // Buffer the request body (bounded) so we can set content-length for the TLS
  // upstream and, when tracing, capture the request. 20m matches nginx cap.
  const CAP = 20 * 1024 * 1024;
  const reqChunks = [];
  let reqLen = 0, aborted = false;
  req.on('data', (c) => {
    if (aborted) return;
    reqLen += c.length;
    if (reqLen > CAP) {
      aborted = true;
      const body = JSON.stringify({ error: { type: 'invalid_request_error', message: 'request body too large' } });
      res.writeHead(413, { 'content-type': 'application/json' }); res.end(body);
      try { req.destroy(); } catch (_) {}
      return;
    }
    reqChunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    const reqBody = Buffer.concat(reqChunks);
    headers['content-length'] = String(reqBody.length);
    try { const b = JSON.parse(reqBody.toString('utf8')); reqMeta.model = b.model || null; reqMeta.stream = !!b.stream; } catch (_) {}

    const upReq = https.request({
      host: prov.host, port: prov.port || 443, servername: prov.host,
      method: req.method, path: upstreamPath, headers, timeout: 600000,
    }, (upRes) => {
      const ct = (upRes.headers['content-type'] || '');
      const isSse = ct.includes('text/event-stream');
      const outHeaders = {};
      const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
      for (const [k, v] of Object.entries(upRes.headers)) { if (!HOP.has(k.toLowerCase())) outHeaders[k] = v; }
      res.writeHead(upRes.statusCode, outHeaders);

      let ttfb = null;
      const usageFeed = (provider === 'anthropic') ? makeSseUsageParser(usage) : makeResponsesUsageParser(usage, reqMeta);
      const textCollector = wantTrace ? makeSseTextCollector() : null;
      const nonStreamChunks = []; let nsLen = 0; const RES_CAP = 4 * 1024 * 1024;

      let finish = () => {
        finish = () => {};
        const rec = {
          ts: new Date(start).toISOString(), label: mLabel, method: req.method,
          path: req.url.split('?')[0], model: reqMeta.model, stream: isSse || reqMeta.stream,
          status: upRes.statusCode, latency_ms: Date.now() - start, usage, byo: true, provider,
        };
        logRecord(rec);
        bumpTotals(mLabel, usage);
        if (wantTrace) {
          let responseText = null;
          if (isSse && textCollector) responseText = textCollector.text();
          else if (nonStreamChunks.length) { try { responseText = Buffer.concat(nonStreamChunks).toString('utf8'); } catch (_) {} }
          traceStore.capture({
            ts: rec.ts, label: info.label, provider, byo: true, model: reqMeta.model,
            stream: isSse || reqMeta.stream, status: upRes.statusCode, ttfb_ms: ttfb,
            latency_ms: rec.latency_ms, usage,
            request: reqBody.toString('utf8'), response: responseText,
          });
        }
      };

      if (isSse) {
        upRes.on('data', (chunk) => {
          if (ttfb == null) ttfb = Date.now() - start;
          try { usageFeed(chunk); } catch (_) {}
          if (textCollector) { try { textCollector.feed(chunk); } catch (_) {} }
          res.write(chunk);
        });
        upRes.on('end', () => { res.end(); finish(); });
      } else {
        upRes.on('data', (chunk) => {
          if (ttfb == null) ttfb = Date.now() - start;
          if (nsLen < RES_CAP) { nonStreamChunks.push(chunk); nsLen += chunk.length; }
          res.write(chunk);
        });
        upRes.on('end', () => {
          res.end();
          try {
            const body = JSON.parse(Buffer.concat(nonStreamChunks).toString('utf8'));
            if (provider === 'anthropic' && body.usage) {
              usage.input_tokens = body.usage.input_tokens || 0;
              usage.output_tokens = body.usage.output_tokens || 0;
              usage.cache_creation_input_tokens = body.usage.cache_creation_input_tokens || 0;
              usage.cache_read_input_tokens = body.usage.cache_read_input_tokens || 0;
              if (!reqMeta.model && body.model) reqMeta.model = body.model;
            } else {
              const u = (body && body.usage) || (body && body.response && body.response.usage) || null;
              if (u) applyOpenAiUsage(usage, u);
              const m = (body && body.model) || (body && body.response && body.response.model);
              if (!reqMeta.model && m) reqMeta.model = m;
            }
          } catch (_) {}
          finish();
        });
      }
      upRes.on('error', () => { try { res.end(); } catch (_) {} finish(); });
    });

    upReq.on('timeout', () => { try { upReq.destroy(new Error('upstream timeout')); } catch (_) {} });
    upReq.on('error', (e) => {
      if (!res.headersSent) {
        const body = JSON.stringify({ error: { type: 'api_error', message: `byo upstream (${provider}) unavailable` } });
        res.writeHead(502, { 'content-type': 'application/json' }); res.end(body);
      } else { try { res.end(); } catch (_) {} }
      logRecord({ ts: new Date(start).toISOString(), label: mLabel, method: req.method, path: req.url.split('?')[0], model: reqMeta.model, stream: reqMeta.stream, status: 502, latency_ms: Date.now() - start, usage: { input_tokens: 0, output_tokens: 0 }, byo: true, provider, error: e.code || e.message });
    });

    upReq.end(reqBody);
  });
  req.on('error', () => { aborted = true; });
}

server.headersTimeout = 620000;
server.requestTimeout = 620000;
server.keepAliveTimeout = 75000;

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`pool-meter listening on ${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});
