'use strict';
// money.js — the ledger's presentation boundary.
//
// ===========================================================================
// WHY THIS MODULE EXISTS
// ===========================================================================
// A ledger whose printed columns do not add up is worthless, however correct
// its internal floats are. This module is the single place where full-precision
// dollars become reported numbers, and it guarantees that the REPORTED numbers
// reconcile exactly — not merely to within a tolerance.
//
// The failure it was written to fix, observed on live data:
//
//   pricing.usd() rounds to a VARIABLE number of decimals — 6dp below $0.01,
//   4dp at or above it. That is a sensible display helper and a disastrous
//   accounting grid, because two figures in the same table land on different
//   grids. Every reported column was independently passed through it, so:
//
//     sum(displayed member consumed) = 43.55759  vs  gross 43.5576   (-1.0e-5)
//     operator                       = 43.557597 vs  gross - earned  (-3.0e-6)
//     and 5 of 23 member rows failed  earned - consumed == net,
//     e.g. 0 - 34.299 = -34.299 but the net column printed -34.299016.
//
//   The internal books were fine the whole time: attributed + unattributed
//   differed from gross by 1.7e-13. Purely a rounding-precision defect, and
//   purely in the reported layer — which is the only layer anyone reads.
//
// ===========================================================================
// THE RULE
// ===========================================================================
// 1. Carry full float precision internally, everywhere, right up to here.
// 2. Quantize ONCE, onto ONE grid: integer micro-dollars (1e-6 USD).
//    Integers, so summation is exact and associative — no float addition ever
//    touches a reported figure again.
// 3. Derive every dependent column from the quantized integers, never from the
//    raw floats. `net` is `earnedMicros - consumedMicros`, an integer
//    subtraction, so `earned - consumed == net` holds by construction rather
//    than by luck.
// 4. When a set of parts must sum to a total, apportion the TOTAL among the
//    parts (largest-remainder) instead of rounding each part independently.
//    Independent rounding is exactly what broke: N parts each off by up to
//    half a micro sum to a total off by up to N/2 micros.
// 5. The residual created by step 4 is assigned EXPLICITLY and reported, never
//    left to float. `apportion()` returns the adjustments it made.
//
// Why micro-dollars: pool traffic includes sub-cent per-request costs
// ($0.000042 is a real observed value), so a cent grid would quantize genuine
// figures to zero. 1e-6 holds every value the pricing module can produce, and
// stays exactly representable as a JS integer well past any plausible total
// (Number.MAX_SAFE_INTEGER is ~$9.0e9).
//
// Node stdlib only.

/** Dollars on the reported grid: 1 micro-dollar = $0.000001. */
const MICROS_PER_USD = 1e6;
const GRID_USD = 1 / MICROS_PER_USD;

/**
 * Raw USD float -> integer micro-dollars. This is the ONLY place a raw float
 * is allowed to become a reported number.
 */
function toMicros(usd) {
  const v = Number(usd);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * MICROS_PER_USD);
}

/**
 * Integer micro-dollars -> the JSON number that gets reported.
 * Passing through toFixed(6) kills the float-repr fuzz that would otherwise
 * reappear at the last step (34299016 / 1e6 is fine, but many are not —
 * 2980 / 1e6 must print 0.00298, not 0.0029800000000000004).
 */
function fromMicros(micros) {
  return Number((Math.round(micros) / MICROS_PER_USD).toFixed(6));
}

/**
 * Render micro-dollars as an EXACT string.
 *
 * Deliberately not pricing.fmtUsd(): that renders $34.299016 as "$34.30",
 * which is right for a dashboard hero number and wrong for a ledger, because a
 * column of 2dp strings does not add up to its own total. Here the string is a
 * lossless rendering of the integer, so a reader (and the regression pack) can
 * sum the printed strings and get the printed total.
 *
 * Trailing zeros are trimmed to at least 2dp, so round money still reads like
 * money: $12.50, $0.00, $34.299016, $0.000042.
 */
function fmt(micros) {
  const m = Math.round(micros);
  const neg = m < 0;
  const abs = Math.abs(m);
  const whole = Math.floor(abs / MICROS_PER_USD);
  const frac = String(abs % MICROS_PER_USD).padStart(6, '0').replace(/(\d\d)(0+)$/, (_, keep) => keep);
  const grouped = whole.toLocaleString('en-US');
  return `${neg ? '-' : ''}$${grouped}.${frac}`;
}

/** Parse a string produced by fmt() back to micro-dollars. Used by the tests. */
function parseFmt(s) {
  const m = /^(-?)\$([\d,]+)\.(\d+)$/.exec(String(s).trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const whole = Number(m[2].replace(/,/g, ''));
  const frac = Number(m[3].padEnd(6, '0').slice(0, 6));
  return sign * (whole * MICROS_PER_USD + frac);
}

/**
 * Apportion an integer total among parts weighted by their raw float values,
 * such that the returned integers sum to EXACTLY `totalMicros`.
 *
 * Largest-remainder (Hamilton) method: floor every part, then hand the leftover
 * units one at a time to the parts with the largest discarded fractions. Each
 * part lands within 1 micro ($0.000001) of its exact share, and the column sums
 * to the total with zero residual.
 *
 * The alternative — round each part independently and let the total be whatever
 * it turns out to be — is the bug this whole module exists to prevent.
 *
 * Returns the integers plus an explicit record of which rows absorbed the
 * residual, so the adjustment is auditable instead of invisible.
 *
 * @param {number[]} rawParts   full-precision USD values, may be 0
 * @param {number}   totalMicros integer micro-dollars to distribute
 * @param {string[]} [labels]   row names, for the adjustment record
 */
function apportion(rawParts, totalMicros, labels = []) {
  const n = rawParts.length;
  const target = Math.round(totalMicros);
  if (n === 0) {
    return { micros: [], residualMicros: target, adjustments: [], exact: target === 0 };
  }

  const rawTotal = rawParts.reduce((a, b) => a + (Number(b) || 0), 0);

  // Degenerate: parts are all zero but the total is not. Refusing to invent a
  // distribution is the honest move — the caller gets the residual back and
  // must place it somewhere it can defend.
  if (rawTotal === 0) {
    return {
      micros: new Array(n).fill(0),
      residualMicros: target,
      adjustments: [],
      exact: target === 0,
      note: target !== 0
        ? 'parts sum to zero but the total does not; residual returned to the caller rather than spread arbitrarily'
        : undefined,
    };
  }

  const exactShares = rawParts.map((p) => ((Number(p) || 0) / rawTotal) * target);
  const floors = exactShares.map((s) => Math.floor(s));
  let distributed = floors.reduce((a, b) => a + b, 0);
  let leftover = target - distributed;

  // Order by discarded fraction, descending. Ties break on the larger raw part,
  // then on index, so the result is deterministic for identical inputs — a
  // ledger that reshuffles its pennies between two identical reads is its own
  // kind of untrustworthy.
  const order = exactShares
    .map((s, i) => ({ i, frac: s - Math.floor(s), raw: Number(rawParts[i]) || 0 }))
    .sort((a, b) => b.frac - a.frac || b.raw - a.raw || a.i - b.i);

  const micros = floors.slice();
  const adjustments = [];
  const step = leftover >= 0 ? 1 : -1;
  let k = 0;
  while (leftover !== 0 && order.length) {
    const { i } = order[k % order.length];
    micros[i] += step;
    adjustments.push({
      row: labels[i] != null ? labels[i] : `#${i}`,
      deltaMicros: step,
      deltaUsd: fromMicros(step),
    });
    leftover -= step;
    k++;
  }

  return {
    micros,
    residualMicros: 0,
    adjustments,
    exact: micros.reduce((a, b) => a + b, 0) === target,
  };
}

/**
 * Standard provenance block describing how the reported numbers were rounded.
 * Attached to the payload so the grid is documented where the numbers are,
 * not only in a design doc nobody reads next to the table.
 */
function roundingNote(partitions) {
  const totalAdjustments = partitions.reduce((a, p) => a + (p.adjustments || []).length, 0);
  return {
    gridUsd: GRID_USD,
    unit: 'micro-dollar (1e-6 USD)',
    method: 'full precision carried internally; quantized once at the presentation boundary. '
      + 'Partitioned columns are apportioned by largest-remainder against the rounded total, so a '
      + 'reported column sums to its reported total exactly. Dependent columns (net, operator '
      + 'position) are computed from the quantized integers, not re-derived from the raw floats.',
    displayIsExact: true,
    displayNote: 'display strings are lossless renderings of the same integers, so the printed '
      + 'column adds up to the printed total. They are not 2dp-rounded.',
    residualPolicy: 'any residual from quantization is assigned explicitly to named rows and listed '
      + 'below; it is never dropped and never left to float.',
    totalAdjustments,
    maxAdjustmentUsd: GRID_USD,
    partitions: partitions.map((p) => ({
      name: p.name,
      rows: p.rows,
      exact: p.exact,
      residualMicros: p.residualMicros || 0,
      adjustments: p.adjustments || [],
    })),
  };
}

module.exports = {
  MICROS_PER_USD, GRID_USD,
  toMicros, fromMicros, fmt, parseFmt, apportion, roundingNote,
};
