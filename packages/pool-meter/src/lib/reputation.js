'use strict';
// reputation.js — uptime tracking and the ratio score behind /join's economy.
//
// Three separate things get measured here, and they are deliberately NOT fused
// into one number until the very last step:
//
//   1. METER UPTIME     — is the edge itself up, and is upstream 18807 answering?
//                         Measured by an active probe loop, persisted so a
//                         restart does not reset the record to a clean slate.
//   2. SEEDING UPTIME   — per donated account, what fraction of broker polls saw
//                         that seat healthy and enabled? This is the "is your
//                         seat actually in the swarm" number. A private tracker
//                         measures seeding time, not the donation event.
//   3. RATIO            — capacity contributed vs effective tokens consumed.
//
// Reputation = seeding uptime x ratio standing, bounded, with an explicit
// "insufficient data" state instead of a flattering default. New members are
// `provisional`, not 100%.
//
// Node stdlib only. Ring-buffered JSONL persistence, bounded on disk.

const fs = require('fs');
const path = require('path');

const PROBE_INTERVAL_MS = 30_000;
const PROBE_RETENTION = 5760;      // 30s x 5760 = 48h of edge probes
const SEED_RETENTION = 2880;       // broker polls retained per rollup window
const MIN_SAMPLES_FOR_SCORE = 20;  // below this, uptime is "provisional"
const MIN_SEEDING_DAYS = 7;        // tracker rule: 7 day minimum seeding period

function pct(n, d) {
  if (!d) return null;
  return Number(((n / d) * 100).toFixed(2));
}

function emptyWindow() {
  return { ok: 0, total: 0, lastOkAt: null, lastFailAt: null, lastError: null };
}

class Reputation {
  constructor({ stateFile, startedAt = Date.now() }) {
    this.stateFile = stateFile;
    this.startedAt = startedAt;
    this.state = {
      version: 1,
      // cumulative across all restarts
      meter: { starts: 0, cumulativeUptimeMs: 0, firstSeenAt: null, lastShutdownAt: null },
      upstream: emptyWindow(),
      probes: [],   // [{ t, ok, ms, err }]
      seats: {},    // accountId -> { alias, email, polls, ok, firstSeenAt, lastOkAt, lastSeenAt, days:{d:{ok,total}}, gaps }
      polls: { total: 0, ok: 0, lastAt: null },
    };
    this.load();
    this.state.meter.starts += 1;
    if (!this.state.meter.firstSeenAt) this.state.meter.firstSeenAt = new Date(startedAt).toISOString();
    this.dirty = true;
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (raw && raw.version === 1) {
        this.state = {
          ...this.state,
          ...raw,
          meter: { ...this.state.meter, ...(raw.meter || {}) },
          upstream: { ...emptyWindow(), ...(raw.upstream || {}) },
          probes: Array.isArray(raw.probes) ? raw.probes.slice(-PROBE_RETENTION) : [],
          seats: raw.seats || {},
          polls: { ...this.state.polls, ...(raw.polls || {}) },
        };
      }
    } catch (_) { /* first boot */ }
  }

  persist() {
    if (!this.dirty) return;
    this.dirty = false;
    const snap = { ...this.state, meter: { ...this.state.meter, cumulativeUptimeMs: this.cumulativeUptimeMs() } };
    const tmp = `${this.stateFile}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(snap));
      fs.renameSync(tmp, this.stateFile);
    } catch (e) { console.error('reputation: persist failed:', e.message); }
  }

  cumulativeUptimeMs() {
    return (this.state.meter.cumulativeUptimeMs || 0) + (Date.now() - this.startedAt);
  }

  // ---- upstream probes ----------------------------------------------------
  recordProbe({ ok, ms, err }) {
    const w = this.state.upstream;
    w.total += 1;
    if (ok) { w.ok += 1; w.lastOkAt = new Date().toISOString(); }
    else { w.lastFailAt = new Date().toISOString(); w.lastError = err || 'unknown'; }
    this.state.probes.push({ t: Date.now(), ok: ok ? 1 : 0, ms: typeof ms === 'number' ? Math.round(ms) : null });
    if (this.state.probes.length > PROBE_RETENTION) this.state.probes = this.state.probes.slice(-PROBE_RETENTION);
    this.dirty = true;
  }

  probeWindow(hours) {
    const cutoff = Date.now() - hours * 3600000;
    let ok = 0; let total = 0; let msSum = 0; let msN = 0;
    for (const p of this.state.probes) {
      if (p.t < cutoff) continue;
      total += 1;
      if (p.ok) ok += 1;
      if (typeof p.ms === 'number') { msSum += p.ms; msN += 1; }
    }
    return { ok, total, uptimePct: pct(ok, total), avgLatencyMs: msN ? Math.round(msSum / msN) : null };
  }

  // ---- per-seat (donor account) seeding uptime ----------------------------
  /**
   * Fold one broker poll into per-seat seeding history. `rows` are the broker's
   * anthropic accounts. A seat counts as seeding when it is enabled and its
   * health is not a hard failure — a rate-limited seat is still IN the pool
   * (it is contributing, just currently drained), whereas a revoked or errored
   * credential is not.
   */
  recordBrokerPoll(rows, { aliasFor } = {}) {
    const nowIso = new Date().toISOString();
    const day = nowIso.slice(0, 10);
    this.state.polls.total += 1;
    this.state.polls.ok += 1;
    this.state.polls.lastAt = nowIso;
    for (const r of rows || []) {
      if (!r || !r.id) continue;
      let s = this.state.seats[r.id];
      if (!s) {
        s = { alias: aliasFor ? aliasFor(r.id) : r.id.slice(0, 8), polls: 0, ok: 0, firstSeenAt: nowIso, lastOkAt: null, lastSeenAt: null, days: {}, health: null };
        this.state.seats[r.id] = s;
      }
      if (aliasFor) s.alias = aliasFor(r.id);
      const enabled = r.enabled !== false;
      const health = r.health || 'unknown';
      // 'rate-limited' means drained-but-present: still seeding.
      const seeding = enabled && health !== 'error' && health !== 'revoked' && health !== 'disabled';
      s.polls += 1;
      s.lastSeenAt = nowIso;
      s.health = health;
      if (seeding) { s.ok += 1; s.lastOkAt = nowIso; }
      const d = s.days[day] || (s.days[day] = { ok: 0, total: 0 });
      d.total += 1;
      if (seeding) d.ok += 1;
      const days = Object.keys(s.days);
      if (days.length > 90) { days.sort(); for (const old of days.slice(0, days.length - 90)) delete s.days[old]; }
      if (s.polls > SEED_RETENTION * 4) { // keep the cumulative ratio, shrink the counters
        s.ok = Math.round((s.ok / s.polls) * SEED_RETENTION);
        s.polls = SEED_RETENTION;
      }
    }
    this.dirty = true;
  }

  recordBrokerPollFailure() {
    this.state.polls.total += 1;
    this.state.polls.lastAt = new Date().toISOString();
    this.dirty = true;
  }

  seatUptime(accountId) {
    const s = this.state.seats[accountId];
    if (!s) return { available: false, uptimePct: null, samples: 0, provisional: true, seedingDays: 0 };
    const seedingDays = s.firstSeenAt ? (Date.now() - Date.parse(s.firstSeenAt)) / 86400000 : 0;
    return {
      available: true,
      alias: s.alias,
      uptimePct: pct(s.ok, s.polls),
      samples: s.polls,
      provisional: s.polls < MIN_SAMPLES_FOR_SCORE,
      seedingDays: Number(seedingDays.toFixed(2)),
      metMinimumSeeding: seedingDays >= MIN_SEEDING_DAYS,
      health: s.health,
      firstSeenAt: s.firstSeenAt,
      lastOkAt: s.lastOkAt,
      recentDays: Object.entries(s.days).sort().slice(-14).map(([date, d]) => ({ date, uptimePct: pct(d.ok, d.total), samples: d.total })),
    };
  }

  /**
   * Reputation for one pool member.
   *
   *   ratio       = contributed capacity value / effective tokens consumed
   *   score       = 100 * seedingUptime x ratioStanding x seedingTenure
   *
   * Every input is surfaced alongside the score. A member with no contribution
   * is a pure consumer, which is a legitimate state (invited tier) and is
   * reported as such rather than as a bad score.
   */
  memberScore({ accountId, contributedPct, consumedEffective, capacityTokenValue, tier }) {
    const seat = accountId ? this.seatUptime(accountId) : { available: false, uptimePct: null, provisional: true, seedingDays: 0, samples: 0 };
    const contributedValue = (Number(contributedPct) || 0) * (Number(capacityTokenValue) || 0);
    const consumed = Number(consumedEffective) || 0;
    const isDonor = !!accountId;

    let ratio = null;
    if (isDonor) ratio = consumed > 0 ? Number((contributedValue / consumed).toFixed(3)) : (contributedValue > 0 ? Infinity : 0);

    // Ratio standing saturates at 1.0 — being 10x net-positive is not 10x better
    // than being 2x net-positive, it just means you are comfortably seeding.
    const RATIO_TARGET = 1.0;
    const ratioStanding = ratio === null ? null : (ratio === Infinity ? 1 : Math.max(0, Math.min(1, ratio / RATIO_TARGET)));

    const uptimeFactor = seat.uptimePct === null ? null : seat.uptimePct / 100;
    // Tenure ramps over the 7 day minimum seeding period.
    const tenureFactor = isDonor ? Math.max(0, Math.min(1, (seat.seedingDays || 0) / MIN_SEEDING_DAYS)) : null;

    let score = null;
    let state;
    if (!isDonor) {
      state = 'consumer';
    } else if (seat.provisional || seat.samples < MIN_SAMPLES_FOR_SCORE) {
      state = 'provisional';
    } else {
      score = Math.round(100 * uptimeFactor * (0.35 + 0.65 * ratioStanding) * (0.4 + 0.6 * tenureFactor));
      if (score >= 80) state = 'trusted';
      else if (score >= 55) state = 'good';
      else if (score >= 30) state = 'watch';
      else state = 'at-risk';
    }

    return {
      state,
      score,
      isDonor,
      tier: tier || null,
      seeding: {
        uptimePct: seat.uptimePct,
        samples: seat.samples,
        days: seat.seedingDays,
        metMinimum: !!seat.metMinimumSeeding,
        minimumDays: MIN_SEEDING_DAYS,
        health: seat.health || null,
      },
      ratio: {
        value: ratio === Infinity ? null : ratio,
        infinite: ratio === Infinity,
        contributedPct: Number(contributedPct) || 0,
        contributedTokenValue: contributedValue,
        consumedEffectiveTokens: consumed,
        netPositive: ratio === null ? null : (ratio === Infinity || ratio >= 1),
      },
      explain: !isDonor
        ? 'no donated seat: consumption-only member, scored by quota not ratio'
        : (state === 'provisional'
          ? `only ${seat.samples} seeding samples so far (need ${MIN_SAMPLES_FOR_SCORE}); showing no score rather than a flattering default`
          : 'score = seeding uptime x ratio standing x tenure ramp, each reported above'),
    };
  }

  report() {
    const now = Date.now();
    return {
      meter: {
        startedAt: new Date(this.startedAt).toISOString(),
        currentUptimeSeconds: Math.round((now - this.startedAt) / 1000),
        cumulativeUptimeHours: Number((this.cumulativeUptimeMs() / 3600000).toFixed(2)),
        restarts: this.state.meter.starts,
        firstSeenAt: this.state.meter.firstSeenAt,
      },
      upstream: {
        allTime: { ...this.state.upstream, uptimePct: pct(this.state.upstream.ok, this.state.upstream.total) },
        last1h: this.probeWindow(1),
        last24h: this.probeWindow(24),
      },
      brokerPolls: { ...this.state.polls, successPct: pct(this.state.polls.ok, this.state.polls.total) },
      seats: Object.keys(this.state.seats).length,
    };
  }
}

module.exports = { Reputation, PROBE_INTERVAL_MS, MIN_SEEDING_DAYS, MIN_SAMPLES_FOR_SCORE };
