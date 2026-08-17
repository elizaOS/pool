'use strict';
// metrics.js — per-user x per-model metering with cache-token accounting.
//
// Design rules this module exists to enforce:
//
//  1. THE JSONL LOGS ARE THE SOURCE OF TRUTH. Aggregates are a derived index,
//     rebuilt from `usage-YYYY-MM-DD.jsonl` on every boot. A restart therefore
//     cannot lose history, and a corrupted aggregate file cannot poison it —
//     delete the aggregate, restart, it comes back identical.
//
//  2. QUOTA MUST NEVER SILENTLY REGRESS. Log files can be pruned, rotated, or
//     lost (days 2026-07-21..22 are in fact missing from this deployment while
//     totals.json still counts them). A pure log rebuild would hand those users
//     free quota back. So at boot we diff the rebuild against the legacy
//     totals.json and carry the shortfall forward as an explicit, auditable
//     `baseline`. Because totals.json keeps being written in lockstep with the
//     logs, the baseline is stable across restarts and self-heals if logs are
//     later pruned.
//
//  3. RAW COUNTERS STAY RAW. Weighting is applied at read time, never baked
//     into a stored counter, so the weights can be retuned without rewriting
//     history.
//
// Node stdlib only.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pricing = require('./pricing.js');

// ---- cost weights ----------------------------------------------------------
// Effective ("weighted") tokens, normalized to input-token cost = 1.0, using
// Anthropic's own pricing ratios: output ~5x input, cache read ~0.1x, cache
// write ~1.25x. Quota is denominated in effective tokens so a cache-heavy
// Claude Code session no longer burns quota ~10x faster than it actually costs.
const TOKEN_WEIGHTS = { input: 1.0, output: 5.0, cache_read: 0.1, cache_creation: 1.25 };

const MAX_DAYS_IN_MEMORY = 400;     // per-label day buckets retained
const MAX_MODEL_DAYS = 30;          // per-model day buckets retained
const MAX_REBUILD_BYTES = 512 << 20; // hard cap so a runaway log cannot OOM boot

function newCounter() {
  return {
    requests: 0,
    errors: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    latencySum: 0,
    latencyCount: 0,
    firstSeen: null,
    lastSeen: null,
    // Dollars are accumulated at ingest time, priced per record against the
    // rate card in force at that record's timestamp. They are NOT derived from
    // the aggregate afterwards, because an aggregate spanning several models
    // (or a pricing change) has no single correct rate to apply.
    costUsd: 0,
    unpricedRequests: 0,
    unpricedTokens: 0,
    approxPricedRequests: 0, // family-fallback rate card was used
  };
}

function addUsage(c, u, opts = {}) {
  c.requests += 1;
  if (opts.error) c.errors += 1;
  c.input += u.input || 0;
  c.output += u.output || 0;
  c.cacheRead += u.cacheRead || 0;
  c.cacheCreation += u.cacheCreation || 0;
  if (opts.cost) {
    c.costUsd += opts.cost.usd || 0;
    if (!opts.cost.priced) {
      c.unpricedRequests += 1;
      c.unpricedTokens += opts.cost.unpricedTokens || 0;
    } else if (opts.cost.exact === false) {
      c.approxPricedRequests += 1;
    }
  }
  if (typeof opts.latencyMs === 'number' && Number.isFinite(opts.latencyMs)) {
    c.latencySum += opts.latencyMs;
    c.latencyCount += 1;
  }
  if (opts.ts) {
    if (!c.firstSeen || opts.ts < c.firstSeen) c.firstSeen = opts.ts;
    if (!c.lastSeen || opts.ts > c.lastSeen) c.lastSeen = opts.ts;
  }
}

function mergeCounter(into, from) {
  into.requests += from.requests || 0;
  into.errors += from.errors || 0;
  into.input += from.input || 0;
  into.output += from.output || 0;
  into.cacheRead += from.cacheRead || 0;
  into.cacheCreation += from.cacheCreation || 0;
  into.latencySum += from.latencySum || 0;
  into.latencyCount += from.latencyCount || 0;
  into.costUsd += from.costUsd || 0;
  into.unpricedRequests += from.unpricedRequests || 0;
  into.unpricedTokens += from.unpricedTokens || 0;
  into.approxPricedRequests += from.approxPricedRequests || 0;
  if (from.firstSeen && (!into.firstSeen || from.firstSeen < into.firstSeen)) into.firstSeen = from.firstSeen;
  if (from.lastSeen && (!into.lastSeen || from.lastSeen > into.lastSeen)) into.lastSeen = from.lastSeen;
  return into;
}

/** Cost-weighted effective tokens for a raw counter. */
function effectiveOf(c) {
  if (!c) return 0;
  return Math.round(
    (c.input || 0) * TOKEN_WEIGHTS.input +
    (c.output || 0) * TOKEN_WEIGHTS.output +
    (c.cacheRead || 0) * TOKEN_WEIGHTS.cache_read +
    (c.cacheCreation || 0) * TOKEN_WEIGHTS.cache_creation,
  );
}

/**
 * Public JSON shape for a counter. ALWAYS dual-unit: raw token counts by class
 * AND dollars at official Anthropic list pricing. `effectiveTokens` is retained
 * as a derived, model-agnostic view for quota backwards compatibility.
 */
function viewCounter(c) {
  const base = c || newCounter();
  const v = {
    requests: base.requests,
    errors: base.errors,
    // ---- unit 1: raw tokens by class ----
    inputTokens: base.input,
    outputTokens: base.output,
    cacheReadTokens: base.cacheRead,
    cacheCreationTokens: base.cacheCreation,
    rawTokens: base.input + base.output + base.cacheRead + base.cacheCreation,
    // ---- unit 2: dollars at API list pricing ----
    costUsd: pricing.usd(base.costUsd),
    costDisplay: pricing.fmtUsd(base.costUsd),
    // ---- legacy derived view ----
    effectiveTokens: effectiveOf(base),
    avgLatencyMs: base.latencyCount ? Math.round(base.latencySum / base.latencyCount) : null,
    firstSeen: base.firstSeen,
    lastSeen: base.lastSeen,
  };
  // Only surface caveat fields when they are non-zero, so clean data stays clean.
  if (base.unpricedRequests) {
    v.unpriced = { requests: base.unpricedRequests, tokens: base.unpricedTokens, note: 'model id had no rate card; excluded from costUsd' };
  }
  if (base.approxPricedRequests) {
    v.approxPriced = { requests: base.approxPricedRequests, note: 'priced via family fallback rate card, not an exact model match' };
  }
  return v;
}

function dayOf(iso) {
  return typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function pruneDays(map, keep) {
  const days = Object.keys(map);
  if (days.length <= keep) return;
  days.sort();
  for (const d of days.slice(0, days.length - keep)) delete map[d];
}

/** Stable, non-reversible public alias for a donor account id. */
function aliasFor(id) {
  if (!id) return 'acct-unknown';
  return 'acct-' + crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 6);
}

// Normalize the several usage key spellings that have existed in the logs.
function usageFrom(rec) {
  const u = (rec && rec.usage) || {};
  return {
    input: Number(u.input_tokens) || 0,
    output: Number(u.output_tokens) || 0,
    cacheRead: Number(u.cache_read_input_tokens != null ? u.cache_read_input_tokens : u.cache_read) || 0,
    cacheCreation: Number(u.cache_creation_input_tokens != null ? u.cache_creation_input_tokens : u.cache_creation) || 0,
  };
}

class Metrics {
  constructor({ logDir, totalsFile, snapshotFile }) {
    this.logDir = logDir;
    this.totalsFile = totalsFile;
    this.snapshotFile = snapshotFile || path.join(logDir, 'metrics-v2.json');
    this.labels = new Map();   // label -> { total, byModel:Map, byDay:{} , quotaBaseline }
    this.accounts = new Map(); // donor account id -> { total, byLabel:Map, byDay:{}, org, alias }
    this.orgToAccount = new Map(); // anthropic org id -> { id, email }
    this.models = new Map();   // model -> counter (pool-wide)
    this.baseline = {};        // label -> counter carried from pre-log history
    this.rebuiltAt = null;
    this.rebuildStats = { files: 0, records: 0, skipped: 0, ms: 0 };
    this.unattributed = newCounter(); // requests with no resolvable donor account
    this.dirty = false;
  }

  // ---- accessors ----------------------------------------------------------
  label(name, create = true) {
    let l = this.labels.get(name);
    if (!l && create) {
      l = { total: newCounter(), byModel: new Map(), byDay: {}, byStatusClass: {} };
      this.labels.set(name, l);
    }
    return l;
  }

  account(id, create = true) {
    let a = this.accounts.get(id);
    if (!a && create) {
      a = { id, alias: aliasFor(id), total: newCounter(), byLabel: new Map(), byModel: new Map(), byDay: {} };
      this.accounts.set(id, a);
    }
    return a;
  }

  /** Teach the metrics layer which anthropic org id belongs to which donor seat. */
  setAccountDirectory(rows) {
    for (const r of rows || []) {
      if (!r || !r.id) continue;
      if (r.organizationId) this.orgToAccount.set(String(r.organizationId), { id: r.id, email: r.email || r.label || null });
      const a = this.account(r.id);
      a.email = r.email || r.label || null;
      a.org = r.organizationId || a.org || null;
    }
  }

  resolveAccountId(rec) {
    if (rec.acct) return String(rec.acct);
    if (rec.org) {
      const hit = this.orgToAccount.get(String(rec.org));
      if (hit) return hit.id;
      return `org:${rec.org}`; // unknown org: still attributable, just unnamed
    }
    return null;
  }

  // ---- ingestion ----------------------------------------------------------
  /** Fold one usage record (log line shape) into every aggregate. */
  ingest(rec) {
    if (!rec || !rec.label) return;
    // BYO records (own-token traffic) are metered separately in pool-meter and
    // must never enter the pooled index / ledger / poolshare economics, whether
    // seen live or replayed from the JSONL at boot. They carry byo:true and a
    // byoLabel namespace (\u0001byo\u0001). Guard both here so a cold rebuild
    // and the live path agree.
    if (rec.byo === true || (typeof rec.label === 'string' && rec.label.startsWith('\u0001byo\u0001'))) return;
    const u = usageFrom(rec);
    const ts = typeof rec.ts === 'string' ? rec.ts : new Date().toISOString();
    const day = dayOf(ts);
    const status = Number(rec.status) || 0;
    const isError = !!rec.error || status >= 400 || status === 0;
    // Prefer the model the edge actually served, but never let its placeholder
    // 'unknown' (sent on streaming responses) shadow the model the client asked
    // for. Only fall back to 'unknown' when neither source names a model.
    const actual = rec.actual_model && rec.actual_model !== 'unknown' ? rec.actual_model : null;
    const model = actual || rec.model || 'unknown';
    // Price once, at the rate card in force at THIS record's timestamp, then
    // fold the same dollar figure into every aggregate this record touches.
    // Historical cost therefore stays stable across pricing changes.
    const cost = pricing.costOf(u, model, ts);
    const opts = { ts, error: isError, latencyMs: Number(rec.latency_ms), cost };

    const l = this.label(rec.label);
    addUsage(l.total, u, opts);

    let m = l.byModel.get(model);
    if (!m) { m = { total: newCounter(), byDay: {} }; l.byModel.set(model, m); }
    addUsage(m.total, u, opts);
    if (!m.byDay[day]) m.byDay[day] = newCounter();
    addUsage(m.byDay[day], u, opts);
    pruneDays(m.byDay, MAX_MODEL_DAYS);

    if (!l.byDay[day]) l.byDay[day] = newCounter();
    addUsage(l.byDay[day], u, opts);
    pruneDays(l.byDay, MAX_DAYS_IN_MEMORY);

    const cls = status ? `${Math.floor(status / 100)}xx` : 'err';
    l.byStatusClass[cls] = (l.byStatusClass[cls] || 0) + 1;

    let pm = this.models.get(model);
    if (!pm) { pm = newCounter(); this.models.set(model, pm); }
    addUsage(pm, u, opts);

    // ---- donor attribution ----
    const acctId = this.resolveAccountId(rec);
    if (acctId) {
      const a = this.account(acctId);
      if (rec.org && !a.org) a.org = String(rec.org);
      addUsage(a.total, u, opts);
      if (!a.byDay[day]) a.byDay[day] = newCounter();
      addUsage(a.byDay[day], u, opts);
      pruneDays(a.byDay, MAX_DAYS_IN_MEMORY);
      let bl = a.byLabel.get(rec.label);
      if (!bl) { bl = newCounter(); a.byLabel.set(rec.label, bl); }
      addUsage(bl, u, opts);
      let bm = a.byModel.get(model);
      if (!bm) { bm = newCounter(); a.byModel.set(model, bm); }
      addUsage(bm, u, opts);
    } else {
      addUsage(this.unattributed, u, opts);
    }
    this.dirty = true;
  }

  // ---- boot rebuild -------------------------------------------------------
  rebuild() {
    const started = Date.now();
    this.labels.clear();
    this.accounts.clear();
    this.models.clear();
    this.unattributed = newCounter();
    let files = 0;
    let records = 0;
    let skipped = 0;
    let bytes = 0;

    let names = [];
    try {
      names = fs.readdirSync(this.logDir).filter((f) => /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
    } catch (_) { names = []; }

    for (const name of names) {
      const file = path.join(this.logDir, name);
      let raw;
      try {
        const st = fs.statSync(file);
        if (bytes + st.size > MAX_REBUILD_BYTES) { skipped += 1; continue; }
        bytes += st.size;
        raw = fs.readFileSync(file, 'utf8');
      } catch (_) { skipped += 1; continue; }
      files += 1;
      for (const line of raw.split('\n')) {
        if (!line) continue;
        let rec;
        try { rec = JSON.parse(line); } catch (_) { skipped += 1; continue; }
        this.ingest(rec);
        records += 1;
      }
    }

    this.reconcileBaseline();
    this.rebuiltAt = new Date().toISOString();
    this.rebuildStats = { files, records, skipped, ms: Date.now() - started };
    return this.rebuildStats;
  }

  /**
   * Diff the log rebuild against legacy totals.json. Anything totals.json knows
   * about that the logs no longer prove is carried forward as `baseline`, so
   * quota can never regress just because a log file went missing.
   */
  reconcileBaseline() {
    let legacy = {};
    try { legacy = JSON.parse(fs.readFileSync(this.totalsFile, 'utf8')); } catch (_) { legacy = {}; }
    const baseline = {};
    for (const [name, t] of Object.entries(legacy || {})) {
      if (!t || typeof t !== 'object') continue;
      const derived = (this.labels.get(name) || {}).total || newCounter();
      const b = {
        requests: Math.max(0, (Number(t.requests) || 0) - derived.requests),
        input: Math.max(0, (Number(t.input_tokens) || 0) - derived.input),
        output: Math.max(0, (Number(t.output_tokens) || 0) - derived.output),
        cacheRead: Math.max(0, (Number(t.cache_read) || 0) - derived.cacheRead),
        cacheCreation: Math.max(0, (Number(t.cache_creation) || 0) - derived.cacheCreation),
      };
      if (b.requests || b.input || b.output || b.cacheRead || b.cacheCreation) {
        // totals.json records no model, so these tokens CANNOT be priced. They
        // are surfaced as `unpriced` rather than silently costed at zero, which
        // would understate spend for anyone carrying a baseline.
        const tokens = b.input + b.output + b.cacheRead + b.cacheCreation;
        baseline[name] = {
          ...newCounter(),
          ...b,
          firstSeen: null,
          lastSeen: t.lastUsedAt || null,
          unpricedRequests: b.requests,
          unpricedTokens: tokens,
        };
      }
    }
    this.baseline = baseline;
    return baseline;
  }

  /** All-time counter for a label, INCLUDING the pre-log baseline. */
  totalFor(name) {
    const out = newCounter();
    const l = this.labels.get(name);
    if (l) mergeCounter(out, l.total);
    const b = this.baseline[name];
    if (b) mergeCounter(out, b);
    return out;
  }

  /** Effective (weighted) tokens used by a label. This is what quota gates on. */
  effective(name) {
    return effectiveOf(this.totalFor(name));
  }

  /** Dollars spent by a label at API list pricing. Gates the optional budgetUsd. */
  costUsdFor(name) {
    return this.totalFor(name).costUsd || 0;
  }

  allLabels() {
    return Array.from(new Set([...this.labels.keys(), ...Object.keys(this.baseline)]));
  }

  // ---- reporting ----------------------------------------------------------
  daySeries(byDay, days) {
    const out = [];
    const now = Date.now();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
      out.push({ date: d, ...viewCounter(byDay[d]) });
    }
    return out;
  }

  /** Per-key self-serve payload. Never contains any other key's data. */
  labelReport(name, { days = 7, quota = null, tier = null, admin = false, budgetUsd = null } = {}) {
    const l = this.labels.get(name);
    const total = this.totalFor(name);
    const byDay = l ? l.byDay : {};
    const today = new Date().toISOString().slice(0, 10);
    const byModel = [];
    if (l) {
      for (const [model, m] of l.byModel) {
        byModel.push({ model, ...viewCounter(m.total), today: viewCounter(m.byDay[today]) });
      }
      byModel.sort((a, b) => b.effectiveTokens - a.effectiveTokens);
    }
    const used = effectiveOf(total);
    const spent = total.costUsd || 0;
    return {
      label: name,
      tier,
      admin,
      units: 'every counter reports raw tokens by class AND USD at Anthropic list pricing',
      pricing: { lastVerified: pricing.LAST_VERIFIED, source: pricing.PRICING_SOURCE },
      weights: TOKEN_WEIGHTS,
      quota: {
        effectiveTokens: quota,
        used,
        remaining: quota === null ? null : Math.max(0, quota - used),
        usedPct: quota ? Number(((used / quota) * 100).toFixed(2)) : null,
        exhausted: quota === null ? false : used >= quota,
        note: 'quota is denominated in cost-weighted effective tokens, not raw tokens',
      },
      budget: {
        budgetUsd,
        spentUsd: pricing.usd(spent),
        spentDisplay: pricing.fmtUsd(spent),
        remainingUsd: budgetUsd === null ? null : pricing.usd(Math.max(0, budgetUsd - spent)),
        usedPct: budgetUsd ? Number(((spent / budgetUsd) * 100).toFixed(2)) : null,
        exhausted: budgetUsd === null ? false : spent >= budgetUsd,
        enforced: budgetUsd !== null,
        note: budgetUsd === null
          ? 'no budgetUsd cap set for this key; spend is reported but not enforced'
          : 'requests are refused once spendUsd reaches budgetUsd',
      },
      allTime: viewCounter(total),
      baselineCarried: this.baseline[name] ? viewCounter(this.baseline[name]) : null,
      today: viewCounter(byDay[today]),
      byModel,
      series: this.daySeries(byDay, days),
      statusClasses: l ? l.byStatusClass : {},
    };
  }

  /** Admin payload: everyone, every model, plus donor attribution. */
  statsReport({ days = 7, quotaFor = () => null, tierFor = () => null, budgetFor = () => null } = {}) {
    const today = new Date().toISOString().slice(0, 10);
    const users = [];
    for (const name of this.allLabels()) {
      const l = this.labels.get(name);
      const total = this.totalFor(name);
      const quota = quotaFor(name);
      const used = effectiveOf(total);
      const budgetUsd = budgetFor(name);
      const spent = total.costUsd || 0;
      const byModel = [];
      if (l) {
        for (const [model, m] of l.byModel) byModel.push({ model, rateKey: pricing.resolveRates(model).key, ...viewCounter(m.total) });
        byModel.sort((a, b) => b.costUsd - a.costUsd || b.effectiveTokens - a.effectiveTokens);
      }
      users.push({
        label: name,
        tier: tierFor(name),
        quota,
        used,
        remaining: quota === null ? null : Math.max(0, quota - used),
        usedPct: quota ? Number(((used / quota) * 100).toFixed(2)) : null,
        costUsd: pricing.usd(spent),
        costDisplay: pricing.fmtUsd(spent),
        budgetUsd,
        budgetRemainingUsd: budgetUsd === null ? null : pricing.usd(Math.max(0, budgetUsd - spent)),
        budgetUsedPct: budgetUsd ? Number(((spent / budgetUsd) * 100).toFixed(2)) : null,
        allTime: viewCounter(total),
        today: viewCounter(l ? l.byDay[today] : null),
        byModel,
        series: this.daySeries(l ? l.byDay : {}, days),
        statusClasses: l ? l.byStatusClass : {},
      });
    }
    users.sort((a, b) => b.costUsd - a.costUsd || b.used - a.used);

    const models = [];
    for (const [model, c] of this.models) {
      const r = pricing.resolveRates(model);
      models.push({
        model,
        rateKey: r.key,
        exactRate: r.exact,
        ratesUsdPerMTok: r.rates || null,
        ...viewCounter(c),
      });
    }
    models.sort((a, b) => b.costUsd - a.costUsd);

    const pool = newCounter();
    for (const name of this.allLabels()) mergeCounter(pool, this.totalFor(name));

    return {
      version: 2,
      generatedAt: new Date().toISOString(),
      units: 'every counter reports raw tokens by class AND USD at Anthropic list pricing',
      pricing: {
        lastVerified: pricing.LAST_VERIFIED,
        source: pricing.PRICING_SOURCE,
        cacheCreationAssumption: '5m cache write rate unless a 1h breakdown is reported',
        notModelled: ['batch discount', 'fast mode premium', 'data residency multiplier'],
      },
      weights: TOKEN_WEIGHTS,
      rebuild: { at: this.rebuiltAt, ...this.rebuildStats },
      pool: { ...viewCounter(pool), users: users.length, models: models.length },
      today: { date: today },
      users,
      models,
      accounts: this.accountReport({ days }),
      unattributed: viewCounter(this.unattributed),
    };
  }

  /**
   * Per-donor-account token attribution.
   *
   * This is REAL attribution, not an estimate: the upstream pool proxy relays
   * Anthropic's `anthropic-organization-id` response header, and each broker
   * account carries a unique organizationId, so every metered response maps
   * back to exactly one donated seat. Records written before this landed have
   * no org header and fall into `unattributed`.
   */
  /**
   * PUBLIC-safe per-seat served summary. Only the one-way hashed alias plus
   * aggregate counters: no account ids, no org ids, no emails, and crucially
   * no per-member labels (which the admin accountReport carries). Safe for the
   * unauthenticated /status surface.
   */
  publicSeatReport() {
    const rows = [];
    for (const [, a] of this.accounts) {
      const v = viewCounter(a.total);
      rows.push({
        seat: a.alias,
        requests: v.requests,
        inputTokens: v.inputTokens,
        outputTokens: v.outputTokens,
        cacheReadTokens: v.cacheReadTokens,
        cacheCreationTokens: v.cacheCreationTokens,
        rawTokens: v.rawTokens,
        costUsd: v.costUsd,
        costDisplay: v.costDisplay,
        lastSeen: v.lastSeen,
      });
    }
    rows.sort((x, y) => y.costUsd - x.costUsd);
    return rows;
  }

  accountReport({ days = 7, includeIdentity = false } = {}) {
    const today = new Date().toISOString().slice(0, 10);
    const rows = [];
    for (const [id, a] of this.accounts) {
      const byLabel = [];
      for (const [label, c] of a.byLabel) byLabel.push({ label, ...viewCounter(c) });
      byLabel.sort((x, y) => y.costUsd - x.costUsd);
      const byModel = [];
      for (const [model, c] of a.byModel) byModel.push({ model, rateKey: pricing.resolveRates(model).key, ...viewCounter(c) });
      byModel.sort((x, y) => y.costUsd - x.costUsd);
      rows.push({
        alias: a.alias,
        ...(includeIdentity ? { accountId: id, email: a.email || null, organizationId: a.org || null } : {}),
        served: viewCounter(a.total),
        today: viewCounter(a.byDay[today]),
        series: this.daySeries(a.byDay, days),
        byLabel,
        byModel,
      });
    }
    rows.sort((x, y) => y.served.costUsd - x.served.costUsd);
    return rows;
  }

  // ---- ledger support -----------------------------------------------------
  // Small, sharp accessors so lib/ledger.js never has to reach into the
  // internal Maps. Keeping the reach-in here means a change to the aggregate
  // shape breaks in one file instead of two.

  /**
   * Pool-wide total, INCLUDING every label's carried baseline. This is the
   * denominator the ledger's "sum of member earned <= total served value"
   * invariant is checked against, so it must be the same figure /meter/stats
   * reports as `pool` — computed the same way, from the same source.
   */
  // NOTE ON ROUNDING: these return the DISPLAY view (costUsd passed through
  // pricing.usd(), i.e. 4dp) plus a `costUsdRaw` carrying the unrounded
  // figure. Accounting identities must be checked against costUsdRaw:
  // comparing a 4dp-rounded total against a sum of unrounded parts produces a
  // ~1e-5 discrepancy that looks exactly like real leakage, which is how this
  // was caught in the first place.
  poolTotal() {
    const pool = newCounter();
    for (const name of this.allLabels()) mergeCounter(pool, this.totalFor(name));
    return { ...viewCounter(pool), costUsdRaw: pool.costUsd || 0 };
  }

  /** Value served that maps to no donated seat (pre-attribution history). */
  unattributedView() {
    return { ...viewCounter(this.unattributed), costUsdRaw: this.unattributed.costUsd || 0 };
  }

  /**
   * Flat per-seat served summary: what this seat earned, in both units.
   * Returns null for an unknown seat rather than a zeroed row, so the caller
   * can tell "served nothing" apart from "never existed".
   */
  seatSummary(accountId) {
    const a = this.accounts.get(accountId);
    if (!a) return null;
    const v = viewCounter(a.total);
    return {
      accountId,
      alias: a.alias,
      email: a.email || null,
      organizationId: a.org || null,
      costUsd: a.total.costUsd || 0,
      effectiveTokens: v.effectiveTokens,
      rawTokens: v.rawTokens,
      requests: v.requests,
      firstSeen: v.firstSeen,
      lastSeen: v.lastSeen,
    };
  }

  /** Every known seat, served-descending. */
  allSeatSummaries() {
    return Array.from(this.accounts.keys())
      .map((id) => this.seatSummary(id))
      .filter(Boolean)
      .sort((a, b) => b.costUsd - a.costUsd || b.effectiveTokens - a.effectiveTokens);
  }

  /** Tokens actually served BY a given donor account id (for ratio economy). */
  servedBy(accountId) {
    const a = this.accounts.get(accountId);
    return a ? effectiveOf(a.total) : 0;
  }

  /** Dollar value of what a donor's seat has served (for ratio economy). */
  servedUsdBy(accountId) {
    const a = this.accounts.get(accountId);
    return a ? (a.total.costUsd || 0) : 0;
  }

  /**
   * What a seat has served since `sinceMs`, summed from the per-day index.
   *
   * The pool-vs-outside split needs "tokens served during THIS weekly window",
   * which cannot be read off a live counter: the meter process may have
   * started long after the window did. Day granularity is the honest limit of
   * the stored data, so the boundary day is included whole. That can only
   * over-attribute to the current window, which keeps the derived pool share
   * an upper bound rather than turning it into an understatement.
   */
  servedSince(accountId, sinceMs) {
    const a = this.accounts.get(accountId);
    if (!a) return { effective: 0, usd: 0, requests: 0, partialDay: null };
    if (!Number.isFinite(sinceMs)) {
      return { effective: effectiveOf(a.total), usd: a.total.costUsd || 0, requests: a.total.requests || 0, partialDay: null };
    }
    const fromDay = new Date(sinceMs).toISOString().slice(0, 10);
    let eff = 0; let usd = 0; let reqs = 0;
    for (const [day, c] of Object.entries(a.byDay)) {
      if (day < fromDay) continue;
      eff += effectiveOf(c);
      usd += c.costUsd || 0;
      reqs += c.requests || 0;
    }
    return { effective: eff, usd, requests: reqs, partialDay: fromDay };
  }

  // ---- persistence (cache only; logs remain source of truth) --------------
  snapshot() {
    return {
      version: 2,
      writtenAt: new Date().toISOString(),
      rebuiltAt: this.rebuiltAt,
      rebuild: this.rebuildStats,
      weights: TOKEN_WEIGHTS,
      baseline: this.baseline,
      labels: Object.fromEntries(this.allLabels().map((n) => [n, viewCounter(this.totalFor(n))])),
      accounts: Object.fromEntries(Array.from(this.accounts, ([id, a]) => [a.alias, { served: viewCounter(a.total), organizationId: a.org || null, accountId: id }])),
      unattributed: viewCounter(this.unattributed),
    };
  }

  persist() {
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = `${this.snapshotFile}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2));
      fs.renameSync(tmp, this.snapshotFile);
    } catch (e) {
      console.error('metrics: snapshot write failed:', e.message);
    }
  }
}

module.exports = { Metrics, TOKEN_WEIGHTS, effectiveOf, viewCounter, newCounter, aliasFor, usageFrom };
