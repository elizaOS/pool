'use strict';
// ledger-unit.js — pure-logic checks for the PROTOTYPE payout ledger.
//
// Exercises the cases production cannot reach on demand: a seat claimed by two
// keys, a seat nobody claims, a member who consumes more than their seat
// earns, and the math-sanity invariant that a ledger must never violate
// (sum of member earned <= total value served).
//
// Runs against a synthetic Metrics instance built from synthetic log records,
// so it proves the rebuild-from-logs path at the same time.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Metrics, aliasFor } = require('../src/lib/metrics.js');
const { PoolShare } = require('../src/lib/poolshare.js');
const ledger = require('../src/lib/ledger.js');

let fails = 0;
function ok(cond, msg) { console.log((cond ? '  PASS ' : '  FAIL ') + msg); if (!cond) fails++; }
function near(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }

const maskMember = (l) => (l && l.length > 3 ? `${l.slice(0, 2)}***${l.slice(-1)}` : 'm**');

// ---- synthetic deployment --------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-unit-'));
const day = '2026-07-20';
const ORG = { A: 'org-aaa', B: 'org-bbb', C: 'org-ccc' };
const ACCT = { A: 'acct-id-A', B: 'acct-id-B', C: 'acct-id-C' };

function rec(label, org, model, input, output, ts) {
  return JSON.stringify({
    ts: ts || `${day}T12:00:00.000Z`, label, org, model, status: 200, latency_ms: 100,
    usage: { input_tokens: input, output_tokens: output },
  });
}

// Seat A serves alice + bob. Seat B serves carol. Seat C serves nobody's key.
// Some records carry no org header at all -> unattributed (pre-v2 shape).
fs.writeFileSync(path.join(dir, `usage-${day}.jsonl`), [
  rec('alice', ORG.A, 'claude-opus-5', 1_000_000, 100_000),   // $5.00 + $2.50 = $7.50
  rec('bob', ORG.A, 'claude-opus-5', 200_000, 20_000),        // $1.00 + $0.50 = $1.50
  rec('carol', ORG.B, 'claude-haiku-4.5', 1_000_000, 0),      // $1.00
  rec('dave', ORG.C, 'claude-opus-5', 100_000, 0),            // $0.50 (seat C, unclaimed)
  rec('legacy', null, 'claude-opus-5', 400_000, 0),           // $2.00 unattributed
  '',
].join('\n'));

const metrics = new Metrics({ logDir: dir, totalsFile: path.join(dir, 'totals.json') });
metrics.setAccountDirectory([
  { id: ACCT.A, organizationId: ORG.A, email: 'a@example.com' },
  { id: ACCT.B, organizationId: ORG.B, email: 'b@example.com' },
  { id: ACCT.C, organizationId: ORG.C, email: 'c@example.com' },
]);
metrics.rebuild();

const keys = [
  { label: 'alice', enabled: true, tier: 'donor', contributedAccountId: ACCT.A },
  { label: 'bob', enabled: true, tier: 'donor', contributedAccountId: ACCT.A }, // same seat!
  { label: 'carol', enabled: true, tier: 'donor', contributedAccountId: ACCT.B },
  { label: 'dave', enabled: true, tier: 'invited' },                            // consumer, no seat
  { label: 'ghost', enabled: false, tier: 'donor', contributedAccountId: 'acct-id-Z' }, // unknown seat
];

const psFile = path.join(dir, 'poolshare.json');
const poolShare = new PoolShare({ stateFile: psFile, tokensPerPct: 2_000_000 });

const L = ledger.buildLedger({ metrics, keys, poolShare, aliasFor, maskMember });

// ---- 1. prototype labeling -------------------------------------------------
console.log('\n[1] prototype labeling — no money movement, no promises');
ok(L.prototype === true, 'payload declares prototype:true');
ok(/no money moves/i.test(L.disclaimer), 'disclaimer states no money moves');
ok(/nothing is owed/i.test(L.disclaimer), 'disclaimer states nothing is owed');
// Every promissory word in the payload must be NEGATED. A blanket ban on the
// words themselves is the wrong test: "nothing is owed" is exactly the copy we
// want, and a ban would push the honest disclaimer out of the payload. So
// check each occurrence in context instead.
const PROMISSORY = /\b(owed|owes|payable|balance due|will be paid|paid out|payout|entitled)\b/gi;
const NEGATED = /\b(no|not|nothing|never|isn't|is not|nobody|neither|without)\b/i;
const unnegated = [];
for (const m of JSON.stringify(L).matchAll(PROMISSORY)) {
  const ctx = JSON.stringify(L).slice(Math.max(0, m.index - 80), m.index + 40);
  if (!NEGATED.test(ctx)) unnegated.push(ctx);
}
ok(unnegated.length === 0,
  `every promissory word appears only under a negation (${unnegated.length} bare use(s))`);
if (unnegated.length) unnegated.forEach((c) => console.log('      bare: ...' + c + '...'));
ok(L.valuation.basis === 'anthropic api list pricing', 'valuation basis named explicitly');
ok(L.members.every((m) => /prototype/i.test(m.valuation)), 'every member row is labelled prototype');

// ---- 2. earned / consumed / net -------------------------------------------
console.log('\n[2] per-seat earned, per-member consumed, net position');
const byMember = Object.fromEntries(L.members.map((m) => [m.member, m]));
const alice = byMember[maskMember('alice')];
const bob = byMember[maskMember('bob')];
const carol = byMember[maskMember('carol')];
const dave = byMember[maskMember('dave')];

// Seat A served $9.00 total ($7.50 alice + $1.50 bob) and is claimed by TWO
// enabled keys, so each is credited half: $4.50.
ok(near(alice.earnedUsd, 4.5), `alice earns half of seat A ($4.50, got $${alice.earnedUsd})`);
ok(near(bob.earnedUsd, 4.5), `bob earns the other half ($4.50, got $${bob.earnedUsd})`);
ok(near(alice.consumedUsd, 7.5), `alice consumed $7.50 (got $${alice.consumedUsd})`);
ok(near(alice.netUsd, -3.0), `alice net = 4.50 - 7.50 = -$3.00 (got $${alice.netUsd})`);
ok(near(bob.netUsd, 3.0), `bob net = 4.50 - 1.50 = +$3.00 (got $${bob.netUsd})`);
ok(near(carol.earnedUsd, 1.0) && near(carol.consumedUsd, 1.0) && near(carol.netUsd, 0),
  'carol is exactly break-even (earned $1.00, consumed $1.00)');
ok(dave.earnedUsd === 0 && dave.class === 'consumer', 'dave has no seat: consumer class, earns 0');
ok(near(dave.consumedUsd, 0.5), `dave still shows consumption ($0.50, got $${dave.consumedUsd})`);

// ---- 3. shared-seat disclosure --------------------------------------------
console.log('\n[3] a seat claimed by two keys must not be double-credited');
ok(alice.contributions[0].sharedWithClaimants === 2, 'alice row discloses 2 claimants');
ok(alice.contributions[0].seatShare === 0.5, 'seat share is 0.5, stated explicitly');
ok(/split equally/i.test(alice.contributions[0].note || ''), 'split is explained in the row');
ok(near(alice.earnedUsd + bob.earnedUsd, 9.0), 'the two halves sum to the seat\'s full $9.00, no more');

// ---- 4. THE math-sanity invariant -----------------------------------------
console.log('\n[4] math sanity: sum(member earned) <= total value served');
const gross = L.totals.grossValueServedUsd;
const sumEarned = L.members.reduce((a, m) => a + m.earnedUsd, 0);
console.log(`   gross served $${gross} | sum member earned $${sumEarned.toFixed(6)} | operator $${L.totals.operatorPositionUsd}`);
ok(sumEarned <= gross + 1e-9, `sum member earned ($${sumEarned.toFixed(4)}) <= gross served ($${gross})`);
ok(L.invariants.sumMemberEarnedLteGrossServed, 'invariant asserted in the payload');
ok(L.invariants.attributedPlusUnattributedEqualsGross, 'attributed + unattributed == gross (nothing evaporates)');
ok(L.invariants.sumMemberEarnedLteAttributed, 'member earnings never exceed seat-attributed value');
ok(L.invariants.allHold, 'all invariants hold');
ok(near(L.totals.operatorPositionUsd, gross - sumEarned),
  'operator position = gross - sum(member earned)');
ok(!/profit|revenue is/i.test(L.totals.operatorPositionNote.replace(/NOT profit and NOT revenue/, '')),
  'operator line is not described as profit');

// ---- 5. honest unattributed bucket ----------------------------------------
console.log('\n[5] unattributed bucket (pre-v2 history)');
const un = L.totals.unattributed;
ok(near(un.valueUsd, 2.0), `pre-attribution traffic held at $2.00 (got $${un.valueUsd})`);
ok(un.requests === 1, 'one unattributed request');
ok(/no anthropic-organization-id|carry no\s+anthropic-organization-id/i.test(un.reason), 'reason names the missing org header');
ok(/credited to nobody/i.test(un.handling), 'explicitly credited to nobody');
ok(!L.members.some((m) => m.earnedUsd > 0 && /legacy/.test(m.member || '')),
  'unattributed value is not back-filled onto any member');
ok(L.members.some((m) => m.status === 'retired'),
  'a label with usage but no key still appears (consumption not dropped)');

// ---- 6. unclaimed seat -----------------------------------------------------
console.log('\n[6] a donated seat nobody claims');
const seatC = L.seats.find((s) => s.seatAlias === aliasFor(ACCT.C));
ok(!!seatC, 'seat C appears in the seat table');
ok(seatC.unclaimed === true, 'seat C is flagged unclaimed');
ok(near(seatC.earnedUsd, 0.5), `seat C earned $0.50 of value (got $${seatC.earnedUsd})`);
ok(seatC.creditedUsd === 0, 'but $0.00 is credited to any member');
ok(/no pool key declares this seat/i.test(seatC.uncreditedReason || ''), 'reason is stated');

// ---- 7. relay class reserved for later, no migration needed ---------------
console.log('\n[7] two contribution classes (EXIT-NODE-DESIGN decision 2)');
ok(L.classes.seat.active === true, 'seat class is active');
ok(L.classes.relay.active === false, 'relay class declared but inactive');
ok(L.classes.relay.rate === null, 'relay rate is null, not a fabricated number');
ok(/not implemented/i.test(L.classes.relay.status), 'relay status says not implemented');
ok(L.members.every((m) => Array.isArray(m.contributions)),
  'earnings sum over a contributions[] array, so relay rows append without migration');
ok(L.totals.byClass.relay.earnedUsd === 0 && L.totals.byClass.relay.members === 0,
  'relay class totals present and zero');

// ---- 8. STEER: pool-vs-outside split rides along, never multiplied in -----
console.log('\n[8] STEER: pool vs outside-pool usage split');
// Feed the estimator a seat whose owner burns far more than the pool does.
const rows = [{ id: ACCT.B, usage: { weeklyPct: 0, resetsAt: 9e12, weeklyModelBuckets: {} } }];
poolShare.recordPoll(rows, { aliasFor, servedFor: () => ({ effective: 0, usd: 0, requests: 0 }) });
rows[0].usage.weeklyPct = 40;
poolShare.recordPoll(rows, { aliasFor, servedFor: () => ({ effective: 1_000_000, usd: 1, requests: 5 }) });
const L2 = ledger.buildLedger({ metrics, keys, poolShare, aliasFor, maskMember });
const seatB = L2.seats.find((s) => s.seatAlias === aliasFor(ACCT.B));
ok(seatB.capacity.available === true, 'seat B carries a capacity block');
ok(seatB.capacity.bound === 'upper', 'uncalibrated seat is labelled an UPPER bound');
ok(seatB.capacity.poolSharePct === null, 'no point estimate published without calibration');
ok(seatB.capacity.poolSharePctUpperBound !== null, 'an upper bound IS published');
ok(seatB.capacity.outsideSharePctLowerBound > 95,
  `mostly-third-party seat: outside >= ${seatB.capacity.outsideSharePctLowerBound}%`);
// The whole point: the split must NOT scale earned value.
const seatBEarnedBefore = L.seats.find((s) => s.seatAlias === aliasFor(ACCT.B)).earnedUsd;
ok(near(seatB.earnedUsd, seatBEarnedBefore),
  'earnedUsd is unchanged by the split — served tokens are pool-driven by construction');
ok(near(seatB.earnedUsd, 1.0), `seat B still earns its full $1.00 served (got $${seatB.earnedUsd})`);
ok(!!seatB.capacity.ingredients && Array.isArray(seatB.capacity.ingredients.timeline),
  'raw ingredients (weekly-pct timeline) included so the split is recomputable later');
ok(seatB.capacity.ingredients.tokensPerPctSource === 'declared-conservative',
  'tokens-per-point factor names its source as the conservative declared constant');
ok(typeof seatB.capacity.headroomPct === 'number',
  'headroom (unspent weekly capacity) reported — the part a donor\'s outside use really does reduce');
ok(/not multiplied/i.test(seatB.capacity.note), 'row explains why the split is not folded into earnings');

// ---- 9. myEarnings block ---------------------------------------------------
console.log('\n[9] myEarnings for /meter/me');
const mine = ledger.myEarnings({ metrics, key: keys[0], poolShare, aliasFor, ledgerShare: 0.5 });
ok(mine !== null, 'donor key gets a myEarnings block');
ok(mine.prototype === true && /no money moves/i.test(mine.disclaimer), 'block is labelled prototype');
ok(near(mine.earnedUsd, 4.5), `matches the ledger row ($4.50, got $${mine.earnedUsd})`);
ok(near(mine.netUsd, alice.netUsd), 'net matches the admin ledger exactly');
ok(mine.seatAlias === aliasFor(ACCT.A) && !/acct-id-A/.test(JSON.stringify(mine)),
  'seat referenced by alias, never by raw account id');
ok(ledger.myEarnings({ metrics, key: keys[3], poolShare, aliasFor }) === null,
  'a key with no seat gets null, not a misleading zero row');
ok(mine.otherClasses.relay.active === false, 'relay class surfaced to the member as inactive');

// ---- 10. privacy -----------------------------------------------------------
console.log('\n[10] privacy: default payload is anonymized');
const raw = JSON.stringify(L);
ok(!raw.includes('a@example.com') && !raw.includes(ACCT.A),
  'no emails and no raw account ids without ?identify=1');
ok(!raw.includes('"alice"'), 'member labels are masked by default');
const ID = ledger.buildLedger({ metrics, keys, poolShare, aliasFor, maskMember, identify: true });
ok(JSON.stringify(ID).includes('alice') && JSON.stringify(ID).includes(ACCT.A),
  'identify:1 deanonymizes for admins');

// ---- 11. rebuildable from logs --------------------------------------------
console.log('\n[11] persistence: rebuildable from logs, no ledger state of its own');
const m2 = new Metrics({ logDir: dir, totalsFile: path.join(dir, 'totals.json') });
m2.setAccountDirectory([
  { id: ACCT.A, organizationId: ORG.A }, { id: ACCT.B, organizationId: ORG.B }, { id: ACCT.C, organizationId: ORG.C },
]);
m2.rebuild();
const L3 = ledger.buildLedger({ metrics: m2, keys, poolShare: null, aliasFor, maskMember });
ok(near(L3.totals.grossValueServedUsd, L.totals.grossValueServedUsd),
  'a cold rebuild from the same logs reproduces gross served exactly');
ok(JSON.stringify(L3.members.map((m) => [m.member, m.earnedUsd, m.consumedUsd]))
  === JSON.stringify(L.members.map((m) => [m.member, m.earnedUsd, m.consumedUsd])),
'every member row reproduces exactly from a cold rebuild');
ok(L3.derivedFrom.rebuildableFromLogs === true && Array.isArray(L3.derivedFrom.sources),
  'payload documents its own provenance');
ok(L3.seats.every((s) => s.capacity.available === false),
  'with no poolshare state, capacity degrades to unavailable rather than fabricating a split');

// ---- 12. degenerate inputs -------------------------------------------------
console.log('\n[12] degenerate inputs');
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-empty-'));
const m0 = new Metrics({ logDir: emptyDir, totalsFile: path.join(emptyDir, 'totals.json') });
m0.rebuild();
const L0 = ledger.buildLedger({ metrics: m0, keys: [], poolShare: null, aliasFor, maskMember });
ok(L0.totals.grossValueServedUsd === 0 && L0.members.length === 0, 'empty pool produces an empty ledger, not a crash');
ok(L0.invariants.allHold, 'invariants hold on an empty ledger');
ok(L0.totals.attributedPct === null, 'no fake 0% / 100% on a zero denominator');
ok(/no pool key currently declares/i.test(L0.coverage.note), 'coverage explains the zero-linkage state');
const Lnokeys = ledger.buildLedger({ metrics, keys: [], poolShare, aliasFor, maskMember });
ok(Lnokeys.members.every((m) => m.earnedUsd === 0),
  'when no key declares a seat, member earnings are zero — never guessed from traffic');
ok(near(Lnokeys.totals.operatorPositionUsd, Lnokeys.totals.grossValueServedUsd),
  'and the entire gross sits in the operator line, visibly uncredited');

// ---- cleanup ---------------------------------------------------------------
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
try { fs.rmSync(emptyDir, { recursive: true, force: true }); } catch (_) {}

console.log('\n' + (fails ? fails + ' FAILURES' : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);
