const { PoolShare } = require(require('path').join(__dirname,'../src/lib/poolshare.js'));
const fs = require('fs');
const f = '/tmp/poolshare-unit-state.json';
try { fs.unlinkSync(f); } catch (_) {}
const V = 2_000_000;
const ps = new PoolShare({ stateFile: f, tokensPerPct: V });
const alias = (id) => 'acct-' + id;
let served = {};
// Mirrors metrics.servedSince(id, windowStart): already scoped to the current
// weekly window, so it is a true zero at window start.
const servedFor = (id, _windowStart) => ({ effective: served[id] || 0, usd: (served[id] || 0) * 1e-6, requests: Math.floor((served[id] || 0) / 100) });
const row = (id, weekly, reset) => ({ id, usage: { weeklyPct: weekly, resetsAt: reset || 9_000_000_000_000, weeklyModelBuckets: { Fable: { pct: weekly } } } });

let fails = 0;
function ok(cond, msg) { console.log((cond ? '  PASS ' : '  FAIL ') + msg); if (!cond) fails++; }

// A: real-world shape - tiny pool traffic, large third-party burn
served.A = 0; ps.recordPoll([row('A', 10)], { aliasFor: alias, servedFor });
served.A = 2384; ps.recordPoll([row('A', 30)], { aliasFor: alias, servedFor });
const a = ps.reportSeat('A');
console.log('\n[A] tiny pool traffic vs big third-party burn (production shape)');
console.log('   consumed pp:', a.capacity.consumedPctObserved, 'poolPp:', a.pool.estimatedPp, 'belowRes:', a.resolution.belowResolutionFactor + 'x');
console.log('   reason:', a.calibration.reason);
ok(a.pool.sharePct === null, 'no point estimate published');
ok(a.calibration.bound === 'upper', 'reported as upper bound');
ok(a.outside.sharePctLowerBound > 99, 'outside-pool share dominates (' + a.outside.sharePctLowerBound + '%)');

// B: pool-pure seat, pool traffic moves the meter 1:1
served.B = 0; ps.recordPoll([row('B', 0)], { aliasFor: alias, servedFor });
for (let i = 1; i <= 6; i++) { served.B = i * V; ps.recordPoll([row('B', i)], { aliasFor: alias, servedFor }); }
const b = ps.reportSeat('B');
console.log('\n[B] pool-pure seat, pool traffic alone moves the meter');
console.log('   windows:', b.calibration.windows, 'coverage:', b.calibration.meanCoverage, 'factor:', b.calibration.tokensPerPct, b.calibration.source);
ok(b.calibration.estimable, 'calibrates to a point estimate');
ok(Math.abs(b.pool.sharePct - 100) < 1, 'pool share ~100% (got ' + b.pool.sharePct + ')');
ok(b.calibration.confidence === 'high', 'high confidence at 6 windows');

// C: THE CONTAMINATION CASE - pool moves meter but owner burns 2x as much
served.C = 0; ps.recordPoll([row('C', 0)], { aliasFor: alias, servedFor });
for (let i = 1; i <= 6; i++) { served.C = i * V; ps.recordPoll([row('C', i * 2)], { aliasFor: alias, servedFor }); }
const c = ps.reportSeat('C');
console.log('\n[C] contaminated: pool causes half the burn, owner causes half');
console.log('   windows:', c.calibration.windows, 'coverage:', c.calibration.meanCoverage, 'source:', c.calibration.source);
console.log('   share:', c.pool.sharePct, 'upper:', c.pool.sharePctUpperBound, 'outside lower:', c.outside.sharePctLowerBound);
ok(c.pool.sharePct === null, 'refuses point estimate on contaminated windows');
ok(Math.abs(c.pool.sharePctUpperBound - 50) < 2, 'upper bound ~50% matches ground truth (got ' + c.pool.sharePctUpperBound + ')');

// D: weekly window reset clears the baseline
served.D = 0; ps.recordPoll([row('D', 80)], { aliasFor: alias, servedFor });
served.D = 500; ps.recordPoll([row('D', 0, 9_500_000_000_000)], { aliasFor: alias, servedFor });
const d = ps.reportSeat('D');
console.log('\n[D] weekly window reset');
ok(d.window.baselinePct === 0, 'baseline rebased to new window');

// E: purely third-party burn must never fabricate a calibration
served.E = 0; ps.recordPoll([row('E', 0)], { aliasFor: alias, servedFor });
for (let i = 1; i <= 6; i++) { served.E = i * 1000; ps.recordPoll([row('E', i * 5)], { aliasFor: alias, servedFor }); }
const e = ps.reportSeat('E');
console.log('\n[E] third-party-only burn');
ok(e.calibration.windows === 0, 'no calibration windows fabricated');
ok(!e.calibration.estimable, 'not estimable');

// F: upper bound must never exceed 100
served.F = 0; ps.recordPoll([row('F', 0)], { aliasFor: alias, servedFor });
served.F = 500 * V; ps.recordPoll([row('F', 1)], { aliasFor: alias, servedFor });
const fr = ps.reportSeat('F');
console.log('\n[F] pool tokens far exceeding observed burn');
ok(fr.pool.sharePctUpperBound <= 100, 'share clamped to <=100 (got ' + fr.pool.sharePctUpperBound + ')');
ok(fr.outside.sharePctLowerBound >= 0, 'outside share never negative');

// I: THE ZERO-DENOMINATOR CASE. Pool served traffic but the weekly meter has
// not moved a whole point. A share is undefined; publishing 100% would paint a
// full pool bar on a seat we know nothing about.
served.I = 0; ps.recordPoll([row('I', 34)], { aliasFor: alias, servedFor });
served.I = 2935; ps.recordPoll([row('I', 34)], { aliasFor: alias, servedFor });
const ir = ps.reportSeat('I');
console.log('\n[I] pool traffic but weekly meter has not moved');
console.log('   consumed pp:', ir.capacity.consumedPctObserved, 'meterMoved:', ir.capacity.meterMoved);
console.log('   reason:', ir.calibration.reason);
ok(ir.pool.sharePctUpperBound === null, 'no share invented from a zero denominator');
ok(ir.outside.sharePctLowerBound === null, 'no outside share invented either');
ok(ir.pool.effectiveTokens === 2935, 'pool tokens still reported as raw ingredient');

// J: RESTART MID-WINDOW must not erase tokens already served in that window.
// This was a real bug: the baseline re-anchored to the current cumulative
// total on every restart, so a seat's pool contribution silently reset to 0.
served.J = 0; ps.recordPoll([row('J', 5)], { aliasFor: alias, servedFor });
served.J = 40_000_000; ps.recordPoll([row('J', 25)], { aliasFor: alias, servedFor });
const beforeRestart = ps.reportSeat('J').pool.effectiveTokens;
ps.dirty = true; ps.persist();
const psR = new PoolShare({ stateFile: f, tokensPerPct: V });
// same weekly window (identical resetsAt), cumulative counter unchanged
psR.recordPoll([row('J', 25)], { aliasFor: alias, servedFor });
const afterRestart = psR.reportSeat('J').pool.effectiveTokens;
console.log('\n[J] restart mid-window');
console.log('   pool tokens before restart:', beforeRestart, 'after:', afterRestart);
ok(beforeRestart === 40_000_000, 'tokens counted before restart');
ok(afterRestart === beforeRestart, 'tokens survive a mid-window restart');

// G: persistence round-trip
ps.dirty = true; ps.persist();
const ps2 = new PoolShare({ stateFile: f, tokensPerPct: V });
console.log('\n[G] persistence');
ok(ps2.reportSeat('B') && ps2.reportSeat('B').calibration.windows === 6, 'state survives restart');

// H: public payload shape is anonymized
const pub = ps.publicBySeat();
console.log('\n[H] public payload');
console.log('   ', JSON.stringify(pub['acct-A']));
const raw = JSON.stringify(pub);
ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(raw), 'no UUIDs in public payload');
ok(Object.keys(pub).every((k) => k.startsWith('acct-')), 'all keys are aliases');
ok(Array.isArray(pub['acct-A'].sparkline), 'sparkline present for the honest-gap view');

console.log('\n' + (fails ? fails + ' FAILURES' : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);
