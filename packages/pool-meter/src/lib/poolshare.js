'use strict';
// poolshare.js — per-seat "how much of this account's burn went through the
// pool, vs the owner using their own subscription directly?"
//
// WHY THIS IS HARD, STATED UP FRONT
// ---------------------------------
// We know two things about a donated seat, measured in incompatible units:
//
//   A. Anthropic's weekly capacity percentage, relayed by the broker. This is
//      the ONLY view of the owner's total burn (pool + everything they do
//      outside it). It is opaque, nonlinear, and — measured over 2,362 live
//      samples — reported as an INTEGER. One percentage point is the smallest
//      change that can ever be observed.
//
//   B. Tokens served through the pool for that seat, exact, via the 1:1
//      anthropic-organization-id -> account mapping.
//
// poolShare = (pool's share of consumed pct) / (total consumed pct). Getting a
// point estimate requires converting B into A's units, i.e. a calibration
// factor of tokens-per-percentage-point.
//
// The honest reading of the current data: that factor cannot be measured yet.
// A calibration window needs pool traffic to visibly move the weekly meter,
// and to do so while nothing else is hitting the seat. Pool traffic on the
// only org-attributed seat so far is ~2.4k effective tokens against a
// declared 2,000,000 tokens per point — roughly 840x below the resolution of
// the instrument. No amount of arithmetic recovers a signal that never
// crossed the quantization floor.
//
// SO WHAT THIS MODULE ACTUALLY SHIPS
// ----------------------------------
//   1. The raw ingredients, per seat, recorded continuously from the existing
//      60s broker poll: a weekly-pct timeline with pool-served tokens
//      overlaid. That is the sparkline the honest-gap rule asks for, and it is
//      the exact dataset a real calibration needs.
//   2. Live calibration-window detection. It is not stubbed: it looks for
//      windows where the meter stepped while pool traffic plausibly caused the
//      step. Today it finds none and says so. If pool volume grows, this
//      starts producing a measured factor with no code change.
//   3. A rigorous UPPER BOUND on pool share, which IS derivable today.
//      `CAPACITY_TOKEN_VALUE` (2M tokens per point) is documented as
//      deliberately conservative — a real Max weekly window is larger, so the
//      true tokens-per-point is HIGHER. Dividing pool tokens by a factor that
//      is too small OVERSTATES the pool's percentage points. That makes the
//      resulting share a genuine ceiling, not a guess: pool share is *at most*
//      this, therefore outside use is *at least* the remainder.
//
// A labelled ceiling beats a fabricated point estimate. Everything below is
// reported with the bound and the confidence attached, never as a bare number.
//
// Node stdlib only. Bounded on disk.

const fs = require('fs');

const MAX_SAMPLES_PER_SEAT = 480;   // sparse: only on change, or a 15m heartbeat
const HEARTBEAT_MS = 15 * 60 * 1000;
const MAX_CALIBRATIONS = 50;
const WINDOW_JITTER_MS = 5 * 60 * 1000; // broker reset stamps jitter by seconds
const WEEK_MS = 7 * 24 * 3600 * 1000;
const QUANTIZATION_PP = 1;          // observed: weekly pct is always an integer
// A calibration window is only usable if pool traffic alone plausibly accounts
// for essentially the WHOLE step — the STEER's "windows where ONLY pool traffic
// hit that seat" condition. Anything less is contaminated by the owner's own
// usage: the step is then larger than the pool caused, the derived
// tokens-per-point comes out too small, and pool share is inflated.
//
// A 50% threshold is not enough. A window that is half third-party passes it and
// then reports a pool-only seat, which is exactly the failure this guard
// exists to prevent. Require near-purity instead.
const MIN_CALIBRATION_COVERAGE = 0.8;
// Coverage far above 1.0 means the declared factor badly understates reality,
// or traffic landed outside the sampled interval. Usable as a bound, not as a
// point estimate.
const MAX_POINT_COVERAGE = 1.25;

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

class PoolShare {
  /**
   * @param {object} o
   * @param {string} o.stateFile      persisted ring buffers
   * @param {number} o.tokensPerPct   declared CAPACITY_TOKEN_VALUE (conservative)
   */
  constructor({ stateFile, tokensPerPct }) {
    this.stateFile = stateFile;
    this.declaredTokensPerPct = Number(tokensPerPct) || 2_000_000;
    this.state = { version: 1, seats: {} };
    this.load();
    this.dirty = false;
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (raw && raw.version === 1 && raw.seats) this.state = raw;
    } catch (_) { /* first boot */ }
  }

  persist() {
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = `${this.stateFile}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.stateFile);
    } catch (e) { console.error('poolshare: persist failed:', e.message); }
  }

  seat(id, alias) {
    let s = this.state.seats[id];
    if (!s) {
      s = { alias, windowKey: null, windowResetAt: null, baseline: null, samples: [], calibrations: [] };
      this.state.seats[id] = s;
    }
    if (alias) s.alias = alias;
    return s;
  }

  /**
   * Fold one broker poll into every seat's timeline.
   *
   * @param {Array} rows        broker anthropic accounts
   * @param {object} o
   * @param {Function} o.aliasFor      accountId -> public alias
   * @param {Function} o.servedFor     accountId -> {effective, raw, usd, requests}
   */
  recordPoll(rows, { aliasFor, servedFor } = {}) {
    const now = Date.now();
    for (const r of rows || []) {
      if (!r || !r.id) continue;
      const u = r.usage || {};
      const weekly = num(u.weeklyPct);
      if (weekly === null) continue;
      const buckets = u.weeklyModelBuckets || {};
      let fable = null;
      let resetAt = num(u.resetsAt);
      for (const [k, v] of Object.entries(buckets)) {
        if (!/fable/i.test(k) || !v) continue;
        fable = num(v.pct ?? v.utilization);
        if (num(v.resetsAt) !== null) resetAt = num(v.resetsAt);
      }
      // Tokens served during THIS weekly window, derived from the stored
      // per-day index rather than from a counter sampled at first sight. A
      // restart mid-window must not lose what the seat already served, and
      // the meter may well have booted long after the window opened.
      const windowStart = resetAt === null ? null : resetAt - WEEK_MS;
      const served = (servedFor && servedFor(r.id, windowStart)) || { effective: 0, raw: 0, usd: 0, requests: 0 };
      const s = this.seat(r.id, aliasFor ? aliasFor(r.id) : r.id.slice(0, 8));

      // Weekly windows are identified by their reset stamp, tolerant of jitter.
      const key = resetAt === null ? 'unknown' : String(Math.round(resetAt / WINDOW_JITTER_MS));
      if (s.windowKey !== key) {
        // New weekly window (or first ever sighting of this seat).
        //
        // The capacity baseline is whatever the meter reads right now: we
        // cannot know what it did before we looked.
        //
        // The TOKEN baseline is different. A restart mid-window must not
        // re-anchor served tokens to the current cumulative total, or every
        // token served earlier in the same window silently vanishes from the
        // split. Carry the previous baseline forward whenever the weekly
        // window itself has not actually changed.
        const sameWindow = s.windowKey !== null && s.windowResetAt !== null && resetAt !== null
          && Math.abs(s.windowResetAt - resetAt) <= WINDOW_JITTER_MS;
        const carry = sameWindow && s.baseline ? s.baseline : null;
        s.windowKey = key;
        s.windowResetAt = resetAt;
        s.baseline = carry || {
          at: now,
          weekly,
          fable,
          // Served figures are already scoped to this weekly window by
          // `servedSince`, so the token zero point is a true zero.
          eff: 0,
          raw: 0,
          usd: 0,
          req: 0,
        };
        if (!carry) s.samples = [];
        this.dirty = true;
      }
      s.windowResetAt = resetAt;

      const last = s.samples[s.samples.length - 1];
      const changed = !last || last.p !== weekly || last.e !== served.effective;
      const stale = !last || (now - last.t) >= HEARTBEAT_MS;
      if (changed || stale) {
        s.samples.push({ t: now, p: weekly, f: fable, e: served.effective, u: served.usd, r: served.requests });
        if (s.samples.length > MAX_SAMPLES_PER_SEAT) {
          // Thin the oldest half by every other sample: keeps window shape,
          // halves the footprint, never drops the newest data.
          const head = s.samples.slice(0, s.samples.length >> 1).filter((_, i) => i % 2 === 0);
          s.samples = head.concat(s.samples.slice(s.samples.length >> 1));
        }
        if (last) this.detectCalibration(s, last, s.samples[s.samples.length - 1]);
        this.dirty = true;
      }
    }
  }

  /**
   * Did the meter step in a way pool traffic can explain?
   *
   * Requires: a real step (>= the quantization floor), pool tokens moving in
   * the same interval, and the pool's declared-factor contribution covering at
   * least MIN_CALIBRATION_COVERAGE of that step. The coverage test is what
   * keeps a coincidental step caused by the owner's own usage out of the
   * calibration set — without it, every outside burst would masquerade as
   * evidence and the factor would collapse toward zero.
   */
  detectCalibration(s, prev, cur) {
    const dPct = cur.p - prev.p;
    const dEff = cur.e - prev.e;
    if (dPct < QUANTIZATION_PP || dEff <= 0) return;
    // Coverage uses the declared (conservative) factor, which itself overstates
    // the pool's share of the step. So this test is generous to the pool and
    // still rejects contaminated windows.
    const coverage = (dEff / this.declaredTokensPerPct) / dPct;
    if (coverage < MIN_CALIBRATION_COVERAGE) return;
    s.calibrations.push({ at: cur.t, dPct, dEff, tokensPerPct: Math.round(dEff / dPct), coverage: Number(coverage.toFixed(3)) });
    if (s.calibrations.length > MAX_CALIBRATIONS) s.calibrations = s.calibrations.slice(-MAX_CALIBRATIONS);
  }

  /** Per-seat analysis. `null` seat id -> all seats. */
  reportSeat(id) {
    const s = this.state.seats[id];
    if (!s || !s.baseline || !s.samples.length) return null;
    const base = s.baseline;
    const cur = s.samples[s.samples.length - 1];

    const consumedPct = Math.max(0, cur.p - base.weekly);
    const poolEff = Math.max(0, cur.e - base.eff);
    const poolUsd = Math.max(0, (cur.u || 0) - (base.usd || 0));
    const poolReq = Math.max(0, (cur.r || 0) - (base.req || 0));

    // Measured factor if we have one; otherwise the declared conservative
    // constant, which is what makes the result a ceiling rather than a guess.
    const measured = s.calibrations.length
      ? Math.round(s.calibrations.reduce((a, c) => a + c.tokensPerPct, 0) / s.calibrations.length)
      : null;
    const meanCoverage = s.calibrations.length
      ? s.calibrations.reduce((a, c) => a + c.coverage, 0) / s.calibrations.length
      : null;
    // Only windows that look pool-pure support a point estimate. Otherwise fall
    // back to the declared constant, which yields a defensible ceiling instead
    // of a confident wrong answer.
    const pointWorthy = measured !== null && meanCoverage !== null
      && meanCoverage >= MIN_CALIBRATION_COVERAGE && meanCoverage <= MAX_POINT_COVERAGE;
    const tokensPerPct = pointWorthy ? measured : this.declaredTokensPerPct;
    const poolPp = poolEff / tokensPerPct;

    const aboveResolution = poolPp >= QUANTIZATION_PP;
    // A share is only meaningful once the weekly meter has actually moved.
    // If it has not, the denominator is zero: the honest answer is "unknown",
    // NOT 100%. Reporting 100% here would render a full pool bar on a seat
    // whose owner may simply not have used it yet, which is the opposite of
    // what the number is supposed to convey.
    const meterMoved = consumedPct > 0;
    const estimable = pointWorthy && aboveResolution && meterMoved;

    const shareUpper = meterMoved
      ? Math.min(100, Number(((poolPp / consumedPct) * 100).toFixed(2)))
      : null;

    let confidence = 'none';
    if (estimable) {
      if (s.calibrations.length >= 5) confidence = 'high';
      else if (s.calibrations.length >= 3) confidence = 'medium';
      else confidence = 'low';
    }

    const shortfall = poolPp > 0 ? Math.round(QUANTIZATION_PP / poolPp) : null;
    const magnitude = poolPp >= QUANTIZATION_PP ? 'near' : ('~' + shortfall + 'x below');
    let reason;
    if (pointWorthy) {
      reason = aboveResolution
        ? 'calibrated from observed meter steps that pool traffic alone explains'
        : 'calibrated, but this window\'s pool traffic is still below the 1pp resolution of the weekly meter';
    } else if (measured !== null) {
      reason = 'meter steps were seen but they are not cleanly attributable to pool traffic alone, so the measured factor is not trusted for a point estimate; showing a conservative upper bound instead';
    } else if (!meterMoved) {
      reason = poolEff > 0
        ? 'this seat has served pool traffic but its weekly meter has not moved a whole percentage point yet, so no share can be computed in either direction'
        : 'no burn and no pool traffic observed for this seat in the current weekly window';
    } else if (poolEff === 0) {
      reason = 'no pool traffic attributed to this seat in the current weekly window';
    } else {
      reason = 'pool traffic is ' + magnitude + ' the meter\'s 1pp resolution, so no calibration window has occurred; showing a conservative upper bound instead';
    }

    return {
      seat: s.alias,
      window: {
        resetAt: s.windowResetAt,
        observedFrom: new Date(base.at).toISOString(),
        baselinePct: base.weekly,
        fromWindowStart: base.weekly === 0,
      },
      capacity: { currentPct: cur.p, consumedPctObserved: consumedPct, meterMoved },
      pool: {
        effectiveTokens: poolEff,
        costUsd: Number(poolUsd.toFixed(6)),
        requests: poolReq,
        estimatedPp: Number(poolPp.toFixed(6)),
        sharePct: estimable ? shareUpper : null,
        sharePctUpperBound: shareUpper,
      },
      outside: {
        sharePctLowerBound: shareUpper === null ? null : Number((100 - shareUpper).toFixed(2)),
      },
      calibration: {
        estimable,
        bound: estimable ? 'point' : 'upper',
        confidence,
        windows: s.calibrations.length,
        meanCoverage: meanCoverage === null ? null : Number(meanCoverage.toFixed(3)),
        tokensPerPct,
        source: pointWorthy ? 'observed' : 'declared-conservative',
        reason,
      },
      resolution: {
        quantizationPp: QUANTIZATION_PP,
        poolSignalPp: Number(poolPp.toFixed(6)),
        belowResolutionFactor: poolPp > 0 ? Number((QUANTIZATION_PP / poolPp).toFixed(1)) : null,
      },
      // Raw ingredients: the honest-gap deliverable. Weekly pct over time with
      // pool-served tokens overlaid, so anyone can audit the claim themselves.
      timeline: s.samples.map((x) => ({ at: x.t, weeklyPct: x.p, fablePct: x.f, poolEffectiveTokens: Math.max(0, x.e - base.eff) })),
    };
  }

  report() {
    const seats = [];
    for (const id of Object.keys(this.state.seats)) {
      const r = this.reportSeat(id);
      if (r) seats.push(r);
    }
    seats.sort((a, b) => (b.pool.effectiveTokens || 0) - (a.pool.effectiveTokens || 0));
    const calibrated = seats.filter((s) => s.calibration.estimable).length;
    return {
      seats,
      method: 'pool-served tokens (exact, via org-id attribution) compared against Anthropic weekly capacity pct (integer-quantized, opaque)',
      calibratedSeats: calibrated,
      declaredTokensPerPct: this.declaredTokensPerPct,
      note: calibrated === 0
        ? 'No seat has a measured tokens-per-percent factor yet, so no point estimate is published. Shares are UPPER BOUNDS derived from a deliberately conservative constant: true capacity per point is larger, so real pool share is at or below the figure shown. Per-seat timelines expose the raw inputs.'
        : 'Seats with a measured calibration factor publish a point estimate; the rest publish conservative upper bounds.',
      caveat: 'pool-served means metered through this edge; capacity pct is Anthropic\'s own nonlinear meter and is not a token count',
    };
  }

  /** Compact per-seat map for the public status pane. */
  publicBySeat() {
    const out = {};
    for (const r of this.report().seats) {
      out[r.seat] = {
        poolSharePct: r.pool.sharePct,
        poolSharePctUpperBound: r.pool.sharePctUpperBound,
        outsideSharePctLowerBound: r.outside.sharePctLowerBound,
        bound: r.calibration.bound,
        confidence: r.calibration.confidence,
        calibrationWindows: r.calibration.windows,
        estimable: r.calibration.estimable,
        consumedPctObserved: r.capacity.consumedPctObserved,
        poolEffectiveTokens: r.pool.effectiveTokens,
        poolRequests: r.pool.requests,
        sparkline: r.timeline.slice(-40).map((p) => p.weeklyPct),
      };
    }
    return out;
  }
}

module.exports = { PoolShare, QUANTIZATION_PP };
