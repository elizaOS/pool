'use strict';
// money-unit.js — the reconciliation guarantee.
//
// The prior ledger passed every one of its own tests while printing a table
// that did not add up, because the tests checked internal floats and the
// synthetic fixtures used round numbers ($7.50, $1.00) that survive any
// rounding scheme. Both mistakes are corrected here:
//
//   1. Every assertion is made on the REPORTED values — and on the rendered
//      display STRINGS, which is what a human actually reads.
//   2. The fixtures are deliberately hostile: thirds, repeating decimals,
//      sub-cent dust, values straddling the $0.01 boundary where the old
//      pricing.usd() switched between 4dp and 6dp, and quantities engineered
//      to force a residual that must be assigned rather than dropped.

const fs = require('fs');
const os = require('os');
const path = require('path');
const money = require('../src/lib/money.js');
const ledger = require('../src/lib/ledger.js');
const { Metrics, aliasFor } = require('../src/lib/metrics.js');

let fails = 0;
function ok(cond, msg) { console.log((cond ? '  PASS ' : '  FAIL ') + msg); if (!cond) fails++; }

const maskMember = (l) => (l && l.length > 3 ? `${l.slice(0, 2)}***${l.slice(-1)}` : 'm**');

// ---------------------------------------------------------------------------
console.log('\n[1] micro-dollar grid primitives');
// ---------------------------------------------------------------------------
ok(money.toMicros(34.299016) === 34299016, 'toMicros is exact on a real live value');
ok(money.fromMicros(34299016) === 34.299016, 'fromMicros round-trips');
ok(money.fromMicros(2980) === 0.00298, 'fromMicros kills float-repr fuzz (0.0029800000000000004)');
ok(money.toMicros(0) === 0 && money.fromMicros(0) === 0, 'zero survives the round trip');
ok(money.toMicros(undefined) === 0 && money.toMicros(NaN) === 0, 'non-finite input degrades to 0, never NaN');
ok(money.toMicros(-9.004021) === -9004021, 'negatives (underwater members) quantize correctly');

// Display strings must be LOSSLESS, or a column of them cannot be summed.
ok(money.fmt(34299016) === '$34.299016', 'fmt renders full precision, not $34.30');
ok(money.fmt(0) === '$0.00', 'zero reads like money');
ok(money.fmt(12500000) === '$12.50', 'round money keeps 2dp, no trailing noise');
ok(money.fmt(-48) === '-$0.000048', 'sub-cent negative renders exactly');
ok(money.fmt(1234567890) === '$1,234.56789', 'thousands separator + exact fraction');
for (const v of [0, 1, 48, 2980, 500, 9004021, 34299016, -1, -34299016, 1234567890]) {
  if (money.parseFmt(money.fmt(v)) !== v) ok(false, `fmt/parse round-trip failed for ${v}`);
}
ok(true, 'fmt -> parseFmt round-trips losslessly across the value range');

// ---------------------------------------------------------------------------
console.log('\n[2] apportion: parts sum to the total EXACTLY, residual assigned');
// ---------------------------------------------------------------------------
// Three equal parts of $1.00 is the classic case: 333333 x 3 = 999999, one
// micro short. Independent rounding loses it; apportionment must not.
const thirds = money.apportion([1 / 3, 1 / 3, 1 / 3], 1000000, ['a', 'b', 'c']);
ok(thirds.micros.reduce((a, b) => a + b, 0) === 1000000, 'three thirds of $1.00 sum to exactly $1.00');
ok(thirds.exact === true, 'apportion reports itself exact');
ok(thirds.adjustments.length === 1, 'the single residual micro is recorded as an adjustment');
ok(thirds.adjustments[0].deltaUsd === 0.000001, 'adjustment is one micro-dollar, disclosed');
ok(thirds.residualMicros === 0, 'no residual left floating');

// Seven parts of a prime total — worst case for leftover distribution.
const seven = money.apportion([1, 1, 1, 1, 1, 1, 1], 1000003, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
ok(seven.micros.reduce((a, b) => a + b, 0) === 1000003, 'seven equal parts of a prime total reconcile');
ok(Math.max(...seven.micros) - Math.min(...seven.micros) <= 1,
  'no part is off by more than one micro-dollar from its fair share');

// Wildly unequal magnitudes — the real shape of this pool (one $34 member,
// many sub-cent ones). A naive scheme starves the small rows or loses the dust.
const skewed = money.apportion([34.299016, 9.004021, 0.00048, 0.0000012], 43303518,
  ['whale', 'mid', 'tiny', 'dust']);
ok(skewed.micros.reduce((a, b) => a + b, 0) === 43303518, 'skewed magnitudes still sum exactly');
ok(skewed.micros[3] >= 0, 'a dust row is never assigned a negative share');

// Negative total (a pool of underwater members).
const neg = money.apportion([1, 1, 1], -1000000, ['a', 'b', 'c']);
ok(neg.micros.reduce((a, b) => a + b, 0) === -1000000, 'negative totals apportion exactly');

// Degenerate: zero parts, non-zero total. Must NOT invent a distribution.
const zero = money.apportion([0, 0], 500, ['a', 'b']);
ok(zero.micros.every((m) => m === 0) && zero.residualMicros === 500,
  'zero parts with a non-zero total returns the residual instead of fabricating shares');
ok(/residual returned to the caller/.test(zero.note || ''), 'and says so explicitly');
ok(money.apportion([], 0, []).exact === true, 'empty input is handled, not crashed');

// Determinism: identical input must not reshuffle pennies between reads.
const d1 = money.apportion([1 / 3, 1 / 3, 1 / 3], 1000000, ['a', 'b', 'c']);
const d2 = money.apportion([1 / 3, 1 / 3, 1 / 3], 1000000, ['a', 'b', 'c']);
ok(JSON.stringify(d1.micros) === JSON.stringify(d2.micros),
  'apportionment is deterministic across identical reads');

// ---------------------------------------------------------------------------
console.log('\n[3] end-to-end: a HOSTILE ledger whose columns must still add up');
// ---------------------------------------------------------------------------
// Token counts chosen so costs land on repeating decimals and sub-cent dust,
// and so several values straddle $0.01 — the exact magnitude boundary where
// the old pricing.usd() silently changed precision from 6dp to 4dp.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'money-unit-'));
const day = '2026-07-20';
const ORG = { A: 'org-aaa', B: 'org-bbb' };
const ACCT = { A: 'acct-id-A', B: 'acct-id-B' };
const rec = (label, org, model, input, output) => JSON.stringify({
  ts: `${day}T12:00:00.000Z`, label, org, model, status: 200, latency_ms: 100,
  usage: { input_tokens: input, output_tokens: output },
});

fs.writeFileSync(path.join(dir, `usage-${day}.jsonl`), [
  rec('alpha', ORG.A, 'claude-opus-5', 333333, 33333),   // repeating-decimal dollars
  rec('beta', ORG.A, 'claude-opus-5', 7, 3),             // dust: fractions of a micro
  rec('gamma', ORG.B, 'claude-haiku-4.5', 1, 1),         // sub-micro dust
  rec('delta', ORG.B, 'claude-sonnet-5', 999999, 1),     // straddles $0.01 boundary
  rec('epsilon', null, 'claude-opus-5', 123457, 7),      // unattributed, odd value
  rec('zeta', null, 'claude-fable-5', 11, 13),           // unattributed dust
  '',
].join('\n'));

const metrics = new Metrics({ logDir: dir, totalsFile: path.join(dir, 'totals.json') });
metrics.setAccountDirectory([
  { id: ACCT.A, organizationId: ORG.A }, { id: ACCT.B, organizationId: ORG.B },
]);
metrics.rebuild();

// Two keys share seat A (forcing a halving that lands off-grid), one claims B.
const keys = [
  { label: 'alpha', enabled: true, contributedAccountId: ACCT.A },
  { label: 'beta', enabled: true, contributedAccountId: ACCT.A },
  { label: 'gamma', enabled: true, contributedAccountId: ACCT.B },
  { label: 'delta', enabled: true },
];

const L = ledger.buildLedger({ metrics, keys, poolShare: null, aliasFor, maskMember });
const t = L.totals;

// ---- the checks that matter: on the REPORTED numbers ----
ok(t.attributedToSeatsUsd + t.unattributed.valueUsd === t.grossValueServedUsd,
  `reported attributed + unattributed === reported gross (${t.attributedToSeatsUsd} + ${t.unattributed.valueUsd} = ${t.grossValueServedUsd})`);

const sumSeatMicros = L.seats.reduce((a, s) => a + s.earnedMicros, 0);
ok(sumSeatMicros === t.micros.attributed, 'reported per-seat earned column sums to reported attributed total');

const sumConsMicros = L.members.reduce((a, m) => a + m.micros.consumed, 0);
ok(sumConsMicros === t.micros.gross, 'reported per-member consumed column sums to reported gross');

const sumEarnMicros = L.members.reduce((a, m) => a + m.micros.earned, 0);
ok(sumEarnMicros === t.micros.sumMemberEarned, 'reported per-member earned column sums to its reported total');
ok(sumEarnMicros <= t.micros.gross, 'sum of reported member earned <= reported gross served');

// NB: this must compare the micro-dollar INTEGERS, not the USD floats. Subtracting
// two correct USD values in IEEE754 does not yield the correct USD difference —
// e.g. 2.000014 - 0.000006 === 2.0000080000000002, so a correct net of 2.000008
// would fail a naive float assertion. The integer grid is the whole point of
// money.js; verifying it with float arithmetic would re-introduce the bug in the
// test. The printed-string check below is the independent cross-check.
ok(L.members.every((m) => m.micros.earned - m.micros.consumed === m.micros.net),
  'EVERY member row: reported earned - reported consumed === reported net (on the micro-dollar grid)');
ok(t.micros.operatorPosition === t.micros.gross - sumEarnMicros,
  'operator position === reported gross - reported member earnings');

// The strongest form: parse the rendered STRINGS and sum those.
const strSum = L.members.reduce((a, m) => a + money.parseFmt(m.consumedDisplay), 0);
ok(strSum === money.parseFmt(t.grossValueServedDisplay),
  'summing the printed DISPLAY STRINGS reproduces the printed gross exactly');
ok(L.members.every((m) => money.parseFmt(m.earnedDisplay) - money.parseFmt(m.consumedDisplay)
  === money.parseFmt(m.netDisplay)),
'every row reconciles when read straight off the printed strings');

// Contribution sub-tables must add up to their own row.
ok(L.members.every((m) => !m.contributions.length
  || m.contributions.reduce((a, c) => a + c.earnedMicros, 0) === m.micros.earned),
'each member\'s contributions[] sums to that member\'s reported earned total');

// Shared seat: halves must sum to the whole, on the reported integers.
const seatA = L.seats.find((s) => s.seatAlias === aliasFor(ACCT.A));
const claimA = L.members.filter((m) => m.seatAlias === aliasFor(ACCT.A));
ok(claimA.reduce((a, m) => a + m.micros.earned, 0) === seatA.earnedMicros,
  'a seat split between two keys: the reported halves sum to the reported seat total, no dust lost');

ok(L.invariants.allHold === true, 'all payload invariants hold on hostile data');
ok(/quantized micro-dollar integers/.test(L.invariants.checkedOn),
  'payload states invariants were checked on the reported integers, not the floats');

// ---- residual must be disclosed, never silent ----
ok(typeof L.rounding === 'object' && L.rounding.gridUsd === 0.000001,
  'payload documents its rounding grid');
ok(L.rounding.partitions.every((p) => p.exact === true),
  'every partition reports itself exact');
ok(L.rounding.partitions.every((p) => (p.residualMicros || 0) === 0),
  'no partition leaves an unassigned residual');
ok(Array.isArray(L.rounding.partitions[0].adjustments),
  'residual adjustments are enumerated per partition, so the assignment is auditable');
ok(L.rounding.maxAdjustmentUsd === 0.000001,
  'any single row is adjusted by at most one micro-dollar');

// ---------------------------------------------------------------------------
console.log('\n[4] the regression that would have caught the original bug');
// ---------------------------------------------------------------------------
// Assert directly that no reported figure sits on the old variable-precision
// grid. pricing.usd() rounds >= $0.01 to 4dp; a value like 34.299016 would come
// back as 34.2990 and the column would drift. If anyone reintroduces it, the
// reported value stops matching its own micro integer and this fails.
const drift = [];
for (const m of L.members) {
  if (money.toMicros(m.earnedUsd) !== m.micros.earned) drift.push(`${m.member}.earned`);
  if (money.toMicros(m.consumedUsd) !== m.micros.consumed) drift.push(`${m.member}.consumed`);
  if (money.toMicros(m.netUsd) !== m.micros.net) drift.push(`${m.member}.net`);
}
ok(drift.length === 0, `no reported USD field drifts from its micro-dollar integer (${drift.join(', ') || 'clean'})`);

// And prove the hostile fixture actually WAS hostile — i.e. that at least one
// value would have been mangled by 4dp rounding. A test whose fixture is too
// clean to fail is the trap that let the original bug ship.
const wouldDrift = L.members.some((m) => Math.abs(m.consumedUsd) >= 0.01
  && Number(m.consumedUsd.toFixed(4)) !== m.consumedUsd);
ok(wouldDrift, 'fixture is genuinely adversarial: >=1 value is mangled by 4dp rounding');

try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
console.log('\n' + (fails ? fails + ' FAILURES' : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);
