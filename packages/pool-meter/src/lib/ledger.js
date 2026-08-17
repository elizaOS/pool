'use strict';
// ledger.js — PROTOTYPE payout ledger.
//
// ===========================================================================
// THIS IS A LEDGER, NOT A PAYMENT SYSTEM.
// No money moves. No payout is owed, promised, scheduled or implied. Every
// dollar figure here is "what this traffic would have cost on metered API
// billing at Anthropic list prices" — the same estimate lib/pricing.js
// produces everywhere else. Nobody is invoiced it and nobody is paid it.
// ===========================================================================
//
// What it computes, and why each piece is defined the way it is:
//
//  EARNED (per donated seat). The value of tokens that seat actually served to
//  the pool, priced at API list. This is a FACT, not a model: the upstream
//  relays `anthropic-organization-id` and each broker account has a unique
//  organizationId, so every metered response maps to exactly one seat
//  (POOL-METER-V2). Records logged before that landed have no org header and
//  are reported in an explicit `unattributed` bucket rather than spread across
//  seats by guess.
//
//  CONSUMED (per member key). What that key's own traffic would have cost,
//  from the same priced aggregates. Linked to a seat via the key's
//  `contributedAccountId`; keys minted before /join have no linkage and are
//  consumption-only.
//
//  NET = earned - consumed, in dollars and in tokens.
//
//  OPERATOR POSITION = gross value served - sum of member earned. This is NOT
//  profit. It is the value the pool moved that is not currently credited to
//  any member, which today is dominated by pre-attribution history.
//
// ---------------------------------------------------------------------------
// TWO CONTRIBUTION CLASSES, ONE OF THEM NOT LIVE YET
// ---------------------------------------------------------------------------
// EXIT-NODE-DESIGN-2026-07-26 decision 2: seat donors and relay operators are
// separate contribution classes and should be paid separately. Someone with
// symmetric fiber and no spare subscription is still contributing.
//
// So a member's earnings are NOT a scalar computed from their seat. They are
// the sum over a `contributions[]` array, each entry tagged with its class.
// Only the `seat` class produces entries today; `relay` is declared, rated
// `null`, and reported inactive. Landing relay earnings later means pushing a
// second element into that array and setting a rate — no schema migration, no
// change to any consumer of this payload.
//
// ---------------------------------------------------------------------------
// THE POOL-VS-OUTSIDE SPLIT (STEER), AND WHERE IT DOES *NOT* BELONG
// ---------------------------------------------------------------------------
// A donor who burns 70% of their own account outside the pool contributes less
// real capacity than one whose account sits idle. True. But that fact must not
// be applied to `earnedUsd`, and this is worth being precise about:
//
//   earnedUsd values tokens the seat SERVED THROUGH THE POOL. That traffic is
//   100% pool-driven by construction. Scaling it by a pool-share fraction
//   would double-count the very thing it already measures, and — since the
//   split is currently only an UPPER BOUND (POOL-STATUS-GLOWUP: the weekly
//   meter is integer-quantized at ~2M tokens per point, ~840x above per-seat
//   pool volume) — it would also turn a hard number into a guess.
//
// Where the split genuinely belongs is the *other* contribution measure:
// capacity made available. That lives in each seat row as `capacity`, carrying
// the estimator's own bound/confidence/reason plus the raw ingredients
// (weekly-pct timeline, pool-served tokens, tokens-per-point factor and its
// source) so the split can be recomputed the moment a seat calibrates. It is
// reported next to earnings, never multiplied into them, and `capacity.bound`
// says which it is.
//
// ---------------------------------------------------------------------------
// PERSISTENCE
// ---------------------------------------------------------------------------
// This module holds NO state of its own. Every figure is a pure function of
// the metrics index (itself rebuilt from usage-*.jsonl at boot), the keys
// file, and the poolshare/attribution state. Delete every derived file on this
// box and the ledger comes back identical from the logs. A snapshot is written
// for observability only and is never read back.
//
// Node stdlib only.

const pricing = require('./pricing.js');
const money = require('./money.js');
const { viewCounter } = require('./metrics.js');

const LEDGER_VERSION = 2;

const PROTOTYPE_NOTICE =
  'PROTOTYPE. Estimated at Anthropic API list prices. No money moves, nothing is owed, ' +
  'and no payout is promised or scheduled. These are accounting figures for what pooled ' +
  'traffic would have cost on metered billing.';

// Contribution classes. `active:false` entries are declared so the shape is
// stable before the feature lands — see EXIT-NODE-DESIGN-2026-07-26 decision 2.
const CONTRIBUTION_CLASSES = {
  seat: {
    name: 'seat',
    active: true,
    unit: 'tokens served',
    rate: 'anthropic api list price of the tokens this seat served',
    description: 'donated anthropic subscription seat; earns on tokens the pool served through it',
  },
  relay: {
    name: 'relay',
    active: false,
    unit: 'bytes relayed / requests carried',
    rate: null,
    description: 'exit-node bandwidth operator; carries encrypted traffic but donates no seat',
    status: 'designed, not implemented — see EXIT-NODE-DESIGN-2026-07-26 §4, §11 decision 2. ' +
      'Schema already sums earnings over contributions[], so relay rows slot in without migration.',
  },
};


// ---------------------------------------------------------------------------
// ROUNDING DISCIPLINE — see lib/money.js for the full rationale.
//
// Everything above the serialization step below works in unrounded floats.
// Every reported dollar figure is quantized exactly once, onto ONE grid
// (integer micro-dollars), and every dependent column is derived from those
// integers. That is what makes the printed table add up.
//
// The previous version passed each field through pricing.usd() independently.
// pricing.usd() switches between 4dp and 6dp depending on magnitude, so two
// figures in the same table landed on different grids and the columns missed
// by up to 1e-5 on live data. Do not reintroduce pricing.usd() here.
// ---------------------------------------------------------------------------
const { toMicros, fromMicros, fmt: fmtM, apportion } = money;

/** Earliest of two ISO stamps, either of which may be null. */
function earliest(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a < b ? a : b;
}

/**
 * Condense the poolshare estimator's per-seat report into the ledger's
 * capacity block. Reuses lane 2's work verbatim — bound, confidence, reason
 * and calibration state are passed through, never recomputed or overridden.
 */
function capacityBlock(share) {
  if (!share) {
    return {
      available: false,
      bound: null,
      reason: 'no weekly-capacity samples recorded for this seat yet',
      ingredients: null,
    };
  }
  const consumed = share.capacity.consumedPctObserved;
  const poolUpper = share.pool.sharePctUpperBound;
  return {
    available: true,
    // How much of the seat's weekly window is still unspent. Headroom is what
    // the pool can actually draw on; a seat the owner has burned to 95% is
    // contributing very little usable capacity regardless of what it served.
    headroomPct: Math.max(0, 100 - (share.capacity.currentPct || 0)),
    currentWeeklyPct: share.capacity.currentPct,
    consumedPctObserved: consumed,
    meterMoved: share.capacity.meterMoved,
    // Pool share of that consumption. UPPER bound unless the seat calibrated.
    poolSharePct: share.pool.sharePct,
    poolSharePctUpperBound: poolUpper,
    outsideSharePctLowerBound: share.outside.sharePctLowerBound,
    bound: share.calibration.bound,
    confidence: share.calibration.confidence,
    calibrationWindows: share.calibration.windows,
    estimable: share.calibration.estimable,
    reason: share.calibration.reason,
    // Raw ingredients so the split is recomputable later without re-deriving
    // anything from this service. This is the honest-gap deliverable.
    ingredients: {
      poolEffectiveTokens: share.pool.effectiveTokens,
      poolCostUsd: share.pool.costUsd,
      poolRequests: share.pool.requests,
      poolEstimatedPp: share.pool.estimatedPp,
      consumedPctObserved: consumed,
      tokensPerPct: share.calibration.tokensPerPct,
      tokensPerPctSource: share.calibration.source,
      quantizationPp: share.resolution.quantizationPp,
      belowResolutionFactor: share.resolution.belowResolutionFactor,
      windowResetAt: share.window.resetAt,
      observedFrom: share.window.observedFrom,
      samples: share.timeline.length,
      timeline: share.timeline,
    },
    note: 'capacity contribution is reported BESIDE earnings and is deliberately not multiplied ' +
      'into them: earned value measures tokens already served through the pool, which are pool-driven ' +
      'by construction. See POOL-STATUS-GLOWUP-2026-07-26 for why this is an upper bound today.',
  };
}

/**
 * Build the full ledger.
 *
 * @param {object}   o
 * @param {object}   o.metrics    live Metrics instance
 * @param {Array}    o.keys       raw rows from pool-keys.json (join.listKeys())
 * @param {object}   o.poolShare  live PoolShare instance (may be null)
 * @param {Function} o.aliasFor   accountId -> stable public alias
 * @param {Function} o.maskMember label -> masked public handle
 * @param {boolean}  o.identify   admin de-anonymization
 */
function buildLedger({ metrics, keys = [], poolShare = null, aliasFor, maskMember, identify = false }) {
  const generatedAt = new Date().toISOString();
  const pool = metrics.poolTotal();
  const unattributed = metrics.unattributedView();
  // Unrounded throughout the math. Rounding happens once, at serialization.
  // Mixing a 4dp-rounded gross with unrounded per-seat parts made the
  // "nothing evaporates" invariant fail by ~1e-5 on live data even though the
  // books balanced to 1e-13 — a false alarm that is worse than no check.
  const grossServedUsd = pool.costUsdRaw != null ? pool.costUsdRaw : (pool.costUsd || 0);

  // ---- 1. map seats -> the keys that claim them --------------------------
  // A seat can legitimately be claimed by more than one key (a donor with two
  // keys, or a re-mint after revocation). Crediting the seat's full earnings
  // to each of them would break `sum(member earned) <= gross served`, so the
  // seat's value is SPLIT EQUALLY among its claimants and the split is
  // disclosed on every row. Enabled keys take precedence; if a seat is only
  // claimed by disabled keys the value still lands on them, because a ledger
  // records history rather than erasing it.
  const claimsBySeat = new Map();
  for (const k of keys) {
    const acctId = k.contributedAccountId || k.accountId || null;
    if (!acctId) continue;
    if (!claimsBySeat.has(acctId)) claimsBySeat.set(acctId, []);
    claimsBySeat.get(acctId).push(k);
  }
  const shareOfSeat = new Map(); // `${acctId}\u0000${label}` -> fraction
  for (const [acctId, claimants] of claimsBySeat) {
    const enabled = claimants.filter((k) => k.enabled !== false);
    const sharers = enabled.length ? enabled : claimants;
    for (const k of sharers) shareOfSeat.set(`${acctId}\u0000${k.label}`, 1 / sharers.length);
  }

  // ---- 2. member rows -----------------------------------------------------
  const members = [];
  // Raw accumulators exist only for the token columns and the pre-quantization
  // seat/consumption partitions; reported dollar totals are summed from the
  // integers in the quantization pass, never from these.
  let sumTokensServed = 0;
  let sumTokensConsumed = 0;
  const seenLabels = new Set();

  // Raw-value pass. Rows are built with FULL PRECISION floats in `_raw` and
  // carry no reported dollar field yet; the quantization pass below fills
  // those in from a single grid. Keeping the two phases separate is what makes
  // the reconciliation guarantee structural instead of aspirational.
  const rowForLabel = (label, key) => {
    const consumedCounter = metrics.totalFor(label);
    const consumedUsd = consumedCounter.costUsd || 0;
    const acctId = key ? (key.contributedAccountId || key.accountId || null) : null;

    // contributions[] is the extension point. One entry per contribution
    // class. Relay entries append here later with no other change.
    const contributions = [];
    let earnedUsd = 0;
    let tokensServedEff = 0;
    let tokensServedRaw = 0;
    let servedSince = null;

    if (acctId) {
      const seat = metrics.seatSummary(acctId);
      const frac = shareOfSeat.get(`${acctId}\u0000${label}`) || 0;
      const claimants = (claimsBySeat.get(acctId) || []).length;
      const seatUsd = seat ? seat.costUsd : 0;
      const entry = {
        class: 'seat',
        ref: aliasFor(acctId),
        ...(identify ? { accountId: acctId } : {}),
        rate: CONTRIBUTION_CLASSES.seat.rate,
        _rawEarnedUsd: seatUsd * frac,
        _seatId: acctId,
        tokensServed: seat ? Math.round(seat.effectiveTokens * frac) : 0,
        rawTokensServed: seat ? Math.round(seat.rawTokens * frac) : 0,
        requestsServed: seat ? Math.round(seat.requests * frac) : 0,
        seatShare: Number(frac.toFixed(4)),
        sharedWithClaimants: claimants > 1 ? claimants : null,
        since: seat ? seat.firstSeen : null,
        seatKnown: !!seat,
        note: claimants > 1
          ? `this seat is claimed by ${claimants} keys; its served value is split equally so member earnings can never exceed the value actually served`
          : null,
      };
      contributions.push(entry);
      earnedUsd += entry._rawEarnedUsd;
      tokensServedEff += entry.tokensServed;
      tokensServedRaw += entry.rawTokensServed;
      servedSince = earliest(servedSince, entry.since);
    }

    sumTokensServed += tokensServedEff;
    sumTokensConsumed += consumedCounter.input + consumedCounter.output
      + consumedCounter.cacheRead + consumedCounter.cacheCreation;

    const consumedView = viewCounter(consumedCounter);
    const cls = acctId ? 'seat-donor' : 'consumer';

    return {
      member: identify ? label : maskMember(label),
      ...(identify ? { label } : {}),
      seatAlias: acctId ? aliasFor(acctId) : null,
      ...(identify && acctId ? { accountId: acctId } : {}),
      class: cls,
      contributionClasses: contributions.map((c) => c.class),
      tier: key ? (key.tier || null) : null,
      status: key ? (key.enabled === false ? 'disabled' : 'active') : 'no-key',
      // The four reported dollar columns are filled in by the quantization
      // pass below, from integer micro-dollars, so that
      //   earned - consumed == net
      // holds on the REPORTED values by construction.
      _raw: { earnedUsd, consumedUsd },
      tokensServed: tokensServedEff,
      tokensConsumed: consumedView.effectiveTokens,
      netTokens: tokensServedEff - consumedView.effectiveTokens,
      rawTokensServed: tokensServedRaw,
      rawTokensConsumed: consumedView.rawTokens,
      requestsConsumed: consumedView.requests,
      since: earliest(servedSince, consumedCounter.firstSeen),
      lastActivity: consumedCounter.lastSeen,
      contributions,
      // Consumption that cannot be priced (baseline carried from totals.json,
      // which records no model). Surfaced so a low consumedUsd is never read
      // as "spent nothing" when it really means "could not be priced".
      consumedUnpriced: consumedView.unpriced || null,
      valuation: 'estimate at api list prices; prototype, not a payable balance',
    };
  };

  for (const k of keys) {
    if (!k || !k.label) continue;
    if (seenLabels.has(k.label)) continue; // one row per label; extra keys fold in via seat split
    seenLabels.add(k.label);
    members.push(rowForLabel(k.label, k));
  }
  // Labels that appear in the logs but have no key today (revoked, renamed,
  // one-off test keys). They consumed real value; dropping them would make the
  // consumption side of the ledger silently under-report.
  for (const label of metrics.allLabels()) {
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    const row = rowForLabel(label, null);
    row.status = 'retired';
    row.note = 'label appears in usage history but no active key maps to it';
    members.push(row);
  }
  // NOTE: rows are deliberately NOT sorted here. Sorting is by netUsd, which
  // does not exist until the quantization pass assigns it; sorting on the raw
  // floats first and the integers later could disagree on near-ties. The sort
  // happens once, after quantization.

  // ---- 3. seat rows -------------------------------------------------------
  const shareReport = poolShare ? poolShare.report() : null;
  const shareByAlias = new Map();
  if (shareReport) for (const s of shareReport.seats) shareByAlias.set(s.seat, s);

  const seats = [];
  let attributedUsd = 0;
  let attributedEff = 0;
  for (const summary of metrics.allSeatSummaries()) {
    attributedUsd += summary.costUsd || 0;
    attributedEff += summary.effectiveTokens || 0;
    const claimants = claimsBySeat.get(summary.accountId) || [];
    seats.push({
      seatAlias: summary.alias,
      ...(identify ? { accountId: summary.accountId, email: summary.email || null, organizationId: summary.organizationId || null } : {}),
      class: 'seat',
      _rawEarnedUsd: summary.costUsd || 0,
      _accountId: summary.accountId,
      tokensServed: summary.effectiveTokens,
      rawTokensServed: summary.rawTokens,
      requestsServed: summary.requests,
      since: summary.firstSeen,
      lastServed: summary.lastSeen,
      claimedBy: claimants.map((k) => (identify ? k.label : maskMember(k.label))),
      unclaimed: claimants.length === 0,
      _claimed: claimants.length > 0,
      uncreditedReason: claimants.length
        ? null
        : 'no pool key declares this seat via contributedAccountId, so its earnings are not credited to any member',
      // STEER: pool vs outside-pool usage on this donor's own account.
      capacity: capacityBlock(shareByAlias.get(summary.alias) || null),
    });
  }
  seats.sort((a, b) => b._rawEarnedUsd - a._rawEarnedUsd);

  // ==========================================================================
  // 4. QUANTIZATION PASS — the single presentation boundary.
  //
  // Up to this point every dollar figure is an unrounded float. From here on,
  // every reported figure is derived from integer micro-dollars. Nothing below
  // may round a float independently; see lib/money.js.
  // ==========================================================================
  const unattributedUsd = unattributed.costUsdRaw != null ? unattributed.costUsdRaw : (unattributed.costUsd || 0);

  // -- 4a. The one anchor figure. Everything else is apportioned against it,
  //        so gross is the only number quantized on its own.
  const grossMicros = toMicros(grossServedUsd);

  // -- 4b. Partition gross into (attributed to seats) + (unattributed).
  //        Apportioning rather than rounding each side independently is what
  //        guarantees the two reported figures sum to the reported gross.
  const splitP = apportion([attributedUsd, unattributedUsd], grossMicros,
    ['attributedToSeats', 'unattributed']);
  const attributedMicros = splitP.micros[0];
  const unattributedMicros = splitP.micros[1];

  // -- 4c. Seat earnings sum to exactly the attributed figure.
  const seatP = apportion(seats.map((s) => s._rawEarnedUsd), attributedMicros,
    seats.map((s) => s.seatAlias));
  seats.forEach((s, i) => {
    const m = seatP.micros[i];
    s.earnedUsd = fromMicros(m);
    s.earnedDisplay = fmtM(m);
    s.earnedMicros = m;
    // Credited value is the same integer or zero — derived from the quantized
    // figure, never re-rounded from the float, so `credited <= earned` cannot
    // fail by a rounding hair.
    s.creditedUsd = s._claimed ? fromMicros(m) : 0;
    s.creditedMicros = s._claimed ? m : 0;
    delete s._rawEarnedUsd; delete s._claimed; delete s._accountId;
  });

  // -- 4d. Member consumption sums to exactly gross.
  //        Every served dollar was consumed by exactly one label (verified
  //        upstream: RAW sum over labels == RAW gross to 0.0), so the
  //        consumption column is a true partition of gross and is apportioned
  //        against it. This is the column that was off by 1e-5.
  const consP = apportion(members.map((m) => m._raw.consumedUsd), grossMicros,
    members.map((m) => m.member));

  // -- 4e. Member earnings sum to exactly the credited seat total.
  //        Bounded by the seat integers, so sum(member earned) <= attributed
  //        <= gross holds on the REPORTED integers, not just the floats.
  const creditedMicros = seats.reduce((a, s) => a + s.creditedMicros, 0);
  const earnP = apportion(members.map((m) => m._raw.earnedUsd), creditedMicros,
    members.map((m) => m.member));

  let sumEarnedMicros = 0;
  let sumConsumedMicros = 0;
  members.forEach((m, i) => {
    const em = earnP.micros[i];
    const cm = consP.micros[i];
    sumEarnedMicros += em;
    sumConsumedMicros += cm;
    m.earnedUsd = fromMicros(em);
    m.earnedDisplay = fmtM(em);
    m.consumedUsd = fromMicros(cm);
    m.consumedDisplay = fmtM(cm);
    // NET IS AN INTEGER SUBTRACTION OF THE TWO REPORTED COLUMNS.
    // Not round(rawEarned - rawConsumed) — that is precisely how the old code
    // printed "0 - 34.299 = -34.299016".
    const nm = em - cm;
    m.netUsd = fromMicros(nm);
    m.netDisplay = fmtM(nm);
    m.micros = { earned: em, consumed: cm, net: nm };
    // Contribution entries are apportioned within the member's own earned
    // total so the sub-table adds up to its row too.
    if (m.contributions.length) {
      const cP = apportion(m.contributions.map((c) => c._rawEarnedUsd), em,
        m.contributions.map((c) => c.class));
      m.contributions.forEach((c, j) => {
        c.earnedUsd = fromMicros(cP.micros[j]);
        c.earnedDisplay = fmtM(cP.micros[j]);
        c.earnedMicros = cP.micros[j];
        delete c._rawEarnedUsd; delete c._seatId;
      });
    }
    delete m._raw;
  });
  members.sort((a, b) => b.netUsd - a.netUsd || b.earnedUsd - a.earnedUsd);

  // ---- honest unattributed bucket ----------------------------------------
  const unattributedBucket = {
    valueUsd: fromMicros(unattributedMicros),
    valueDisplay: fmtM(unattributedMicros),
    valueMicros: unattributedMicros,
    tokensServed: unattributed.effectiveTokens,
    rawTokensServed: unattributed.rawTokens,
    requests: unattributed.requests,
    shareOfGrossPct: grossMicros > 0 ? Number(((unattributedMicros / grossMicros) * 100).toFixed(2)) : null,
    reason: 'served before per-seat attribution existed: these requests carry no ' +
      'anthropic-organization-id, so the seat that served them is unknown',
    handling: 'held in this bucket and credited to nobody. Back-filling it across seats would be ' +
      'a guess dressed as a payout, so it is left visibly uncredited.',
    unpriced: unattributed.unpriced || null,
  };

  // ---- 5. totals + operator position -------------------------------------
  // All integer arithmetic on the already-quantized columns. Every total below
  // is literally the sum of the numbers printed above it.
  const sumNetMicros = sumEarnedMicros - sumConsumedMicros;
  const operatorMicros = grossMicros - sumEarnedMicros;

  const byClass = {};
  for (const [name, def] of Object.entries(CONTRIBUTION_CLASSES)) {
    const rows = members.filter((m) => m.contributionClasses.includes(name));
    const cm = rows.reduce((a, m) => a + m.contributions
      .filter((c) => c.class === name).reduce((x, c) => x + c.earnedMicros, 0), 0);
    byClass[name] = {
      ...def,
      members: rows.length,
      earnedUsd: fromMicros(cm),
      earnedDisplay: fmtM(cm),
      earnedMicros: cm,
    };
  }

  // Provenance for the rounding itself: which rows absorbed a residual unit.
  const rounding = money.roundingNote([
    { name: 'gross -> attributed + unattributed', rows: 2, ...splitP },
    { name: 'attributed -> per-seat earned', rows: seats.length, ...seatP },
    { name: 'credited seat value -> per-member earned', rows: members.length, ...earnP },
    { name: 'gross -> per-member consumed', rows: members.length, ...consP },
  ]);

  // ---- 6. invariants, asserted in the payload not just in the tests -------
  // These are checked on the QUANTIZED INTEGERS — the same values the payload
  // reports and a human reads. Integer equality, no epsilon: a tolerance here
  // would be admitting the columns might not add up.
  //
  // The old version checked the raw floats with a relative epsilon. Those
  // checks passed (the floats reconciled to 1.7e-13) while the reported table
  // was visibly wrong by 1e-5. Checking the layer nobody reads is how a broken
  // ledger reports itself healthy.
  const displayedSeatEarnedMicros = seats.reduce((a, s) => a + s.earnedMicros, 0);
  const invariants = {
    // The load-bearing one: a member can never be credited more than the pool
    // actually served. Violating it would mean the ledger is inventing value.
    sumMemberEarnedLteGrossServed: sumEarnedMicros <= grossMicros,
    // Every served dollar is either credited to a seat or sitting in the
    // unattributed bucket. Nothing evaporates. Exact on the reported figures.
    attributedPlusUnattributedEqualsGross:
      attributedMicros + unattributedMicros === grossMicros,
    // Sum of seat earnings credited to members cannot exceed seat earnings.
    sumMemberEarnedLteAttributed: sumEarnedMicros <= attributedMicros,
    // Reported per-seat column sums to the reported attributed total.
    seatColumnSumsToAttributed: displayedSeatEarnedMicros === attributedMicros,
    // Reported per-member consumption column sums to the reported gross.
    consumedColumnSumsToGross: sumConsumedMicros === grossMicros,
    // Every member row's own three reported numbers are self-consistent.
    everyMemberRowAddsUp: members.every((m) => m.micros.earned - m.micros.consumed === m.micros.net),
    // Operator line is exactly the reported gross minus the reported earnings.
    operatorIsGrossMinusEarned: operatorMicros === grossMicros - sumEarnedMicros,
    netIsEarnedMinusConsumed: sumNetMicros === sumEarnedMicros - sumConsumedMicros,
  };
  invariants.allHold = Object.values(invariants).every((v) => v === true);
  invariants.checkedOn = 'quantized micro-dollar integers — the same values reported above, '
    + 'not the internal floats. exact equality, no tolerance.';

  return {
    version: LEDGER_VERSION,
    prototype: true,
    generatedAt,
    disclaimer: PROTOTYPE_NOTICE,
    valuation: {
      basis: 'anthropic api list pricing',
      lastVerified: pricing.LAST_VERIFIED,
      source: pricing.PRICING_SOURCE,
      note: 'pool traffic runs on donated subscription seats, so nobody is actually invoiced these ' +
        'dollars. this is what the traffic WOULD have cost on metered billing — the useful figure ' +
        'for valuing a donated seat, and explicitly not a balance owed.',
    },
    classes: CONTRIBUTION_CLASSES,
    totals: {
      grossValueServedUsd: fromMicros(grossMicros),
      grossValueServedDisplay: fmtM(grossMicros),
      attributedToSeatsUsd: fromMicros(attributedMicros),
      attributedToSeatsDisplay: fmtM(attributedMicros),
      attributedPct: grossMicros > 0 ? Number(((attributedMicros / grossMicros) * 100).toFixed(2)) : null,
      unattributed: unattributedBucket,
      sumMemberEarnedUsd: fromMicros(sumEarnedMicros),
      sumMemberEarnedDisplay: fmtM(sumEarnedMicros),
      sumMemberConsumedUsd: fromMicros(sumConsumedMicros),
      sumMemberConsumedDisplay: fmtM(sumConsumedMicros),
      sumMemberNetUsd: fromMicros(sumNetMicros),
      sumMemberNetDisplay: fmtM(sumNetMicros),
      operatorPositionUsd: fromMicros(operatorMicros),
      operatorPositionDisplay: fmtM(operatorMicros),
      micros: {
        gross: grossMicros,
        attributed: attributedMicros,
        unattributed: unattributedMicros,
        sumMemberEarned: sumEarnedMicros,
        sumMemberConsumed: sumConsumedMicros,
        sumMemberNet: sumNetMicros,
        operatorPosition: operatorMicros,
        note: 'integer micro-dollars (1e-6 USD). the reported USD columns are these integers '
          + 'divided by 1e6, so any reconciliation can be re-checked in exact integer arithmetic.',
      },
      operatorPositionNote:
        'gross value served minus the sum of member earnings. NOT profit and NOT revenue — it is ' +
        'the value the pool moved that no member is credited for, today dominated by the ' +
        'pre-attribution unattributed bucket.',
      tokens: {
        servedEffectiveToMembers: sumTokensServed,
        consumedRawByMembers: sumTokensConsumed,
        poolServedEffective: pool.effectiveTokens,
        attributedEffective: attributedEff,
        unattributedEffective: unattributed.effectiveTokens,
      },
      byClass,
      members: members.length,
      seats: seats.length,
      seatsClaimed: seats.filter((s) => !s.unclaimed).length,
    },
    rounding,
    invariants,
    members,
    seats,
    coverage: {
      attributionMethod: 'anthropic-organization-id response header mapped to broker account organizationId',
      seatsKnown: seats.length,
      seatsWithTraffic: seats.filter((s) => s.requestsServed > 0).length,
      keysLinkedToSeats: claimsBySeat.size,
      keysTotal: keys.length,
      note: claimsBySeat.size === 0
        ? 'no pool key currently declares a contributedAccountId, so every seat is unclaimed and ' +
          'member earnings total zero. keys minted through /join carry the linkage automatically; ' +
          'the pre-/join keys in use today do not. this is a data gap, not a code gap.'
        : `${claimsBySeat.size} key(s) declare a donated seat`,
      usageSplit: shareReport
        ? {
          calibratedSeats: shareReport.calibratedSeats,
          declaredTokensPerPct: shareReport.declaredTokensPerPct,
          method: shareReport.method,
          note: shareReport.note,
        }
        : null,
    },
    derivedFrom: {
      rebuildableFromLogs: true,
      note: 'the ledger stores no state of its own. every figure is derived from the metrics index ' +
        '(rebuilt from usage-*.jsonl at boot), the keys file, and poolshare/attribution state. ' +
        'deleting every derived file on this box reproduces these numbers exactly from the logs.',
      metricsRebuild: { at: metrics.rebuiltAt, ...metrics.rebuildStats },
      sources: ['usage-*.jsonl (authoritative)', 'totals.json (baseline carry-forward)',
        'pool-keys.json (seat linkage)', 'poolshare-state.json (weekly-pct timeline)',
        'broker GET /api/accounts (org-id directory, read-only)'],
    },
  };
}

/**
 * The `myEarnings` block for /meter/me. Returns null when the key declares no
 * seat, which is the honest answer for every pre-/join key.
 */
function myEarnings({ metrics, key, poolShare, aliasFor, ledgerShare = 1 }) {
  const acctId = key ? (key.contributedAccountId || key.accountId || null) : null;
  if (!acctId) return null;
  const seat = metrics.seatSummary(acctId);
  const consumed = metrics.totalFor(key.label);
  const consumedUsd = consumed.costUsd || 0;
  const earnedUsd = (seat ? seat.costUsd : 0) * ledgerShare;
  const tokensServed = seat ? Math.round(seat.effectiveTokens * ledgerShare) : 0;
  const share = poolShare ? poolShare.reportSeat(acctId) : null;
  const consumedView = viewCounter(consumed);

  // Same presentation boundary as the admin ledger: quantize each figure once
  // onto the micro-dollar grid, then derive net by INTEGER subtraction of the
  // two reported columns. A member reading their own row must be able to check
  // earned - consumed = net by hand and have it come out right.
  const earnedMicros = toMicros(earnedUsd);
  const consumedMicros = toMicros(consumedUsd);
  const netMicros = earnedMicros - consumedMicros;

  return {
    prototype: true,
    disclaimer: PROTOTYPE_NOTICE,
    seatAlias: aliasFor(acctId),
    class: 'seat',
    contributions: [{
      class: 'seat',
      ref: aliasFor(acctId),
      rate: CONTRIBUTION_CLASSES.seat.rate,
      earnedUsd: fromMicros(earnedMicros),
      earnedDisplay: fmtM(earnedMicros),
      earnedMicros,
      tokensServed,
      requestsServed: seat ? Math.round(seat.requests * ledgerShare) : 0,
      seatShare: Number(Number(ledgerShare).toFixed(4)),
    }],
    earnedUsd: fromMicros(earnedMicros),
    earnedDisplay: fmtM(earnedMicros),
    consumedUsd: fromMicros(consumedMicros),
    consumedDisplay: fmtM(consumedMicros),
    netUsd: fromMicros(netMicros),
    netDisplay: fmtM(netMicros),
    micros: { earned: earnedMicros, consumed: consumedMicros, net: netMicros },
    rounding: {
      gridUsd: money.GRID_USD,
      note: 'figures are quantized once to micro-dollars; net is the integer difference of the '
        + 'two columns above, so this row adds up exactly as displayed.',
    },
    tokensServed,
    tokensConsumed: consumedView.effectiveTokens,
    netTokens: tokensServed - consumedView.effectiveTokens,
    since: earliest(seat ? seat.firstSeen : null, consumed.firstSeen),
    capacity: capacityBlock(share),
    valuation: {
      basis: 'anthropic api list pricing',
      lastVerified: pricing.LAST_VERIFIED,
      note: 'estimate of what your seat\u2019s served traffic would have cost on metered billing. ' +
        'no money moves and nothing is owed — this is a prototype ledger.',
    },
    otherClasses: {
      relay: { ...CONTRIBUTION_CLASSES.relay, earnedUsd: 0 },
    },
  };
}

/** Compact snapshot for observability. Written, never read back. */
function snapshot(ledger) {
  return {
    version: LEDGER_VERSION,
    prototype: true,
    authoritative: false,
    cacheOnly: 'observability snapshot; the ledger is recomputed from logs on every request',
    writtenAt: new Date().toISOString(),
    totals: ledger.totals,
    invariants: ledger.invariants,
    rounding: ledger.rounding,
    members: ledger.members.map((m) => ({
      member: m.member, seatAlias: m.seatAlias, class: m.class, status: m.status,
      earnedUsd: m.earnedUsd, consumedUsd: m.consumedUsd, netUsd: m.netUsd,
      micros: m.micros,
      tokensServed: m.tokensServed, tokensConsumed: m.tokensConsumed, since: m.since,
    })),
    seats: ledger.seats.map((s) => ({
      seatAlias: s.seatAlias, earnedUsd: s.earnedUsd, tokensServed: s.tokensServed,
      unclaimed: s.unclaimed, capacityBound: s.capacity.bound,
      poolSharePctUpperBound: s.capacity.poolSharePctUpperBound,
    })),
  };
}

module.exports = {
  LEDGER_VERSION, PROTOTYPE_NOTICE, CONTRIBUTION_CLASSES,
  buildLedger, myEarnings, snapshot, capacityBlock,
};
