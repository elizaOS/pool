'use strict';
// utilization.js — the number the whole thesis rests on, computed honestly.
//
// Thesis: pooling does not split a pie, it harvests idle time. One person uses
// a fraction of their 5-hour window; N seats with staggered weekly resets can
// approach full utilization of capacity that would otherwise expire unused.
//
// Definition used here:
//   consumed_capacity_pct = sum over seats of that seat's weekly used %
//   theoretical_capacity_pct = 100 * number_of_seats
//   utilization = consumed / theoretical
//
// This is deliberately the CONSERVATIVE reading. Important caveats, surfaced in
// the UI rather than buried:
//   1. Weekly used % is Anthropic's own opaque metric. It is not tokens, and it
//      is not linear in tokens. We cannot convert it to tokens without guessing,
//      so we do not.
//   2. It counts ALL usage on a donated seat, including any the owner drove
//      themselves before or outside the pool. It therefore overstates the
//      pool's own harvest.
//   3. It is a point-in-time reading of the current weekly window. Seats whose
//      windows reset at different times are at different points in their cycle,
//      so a single snapshot understates steady-state utilization.
// Because of (1) we report utilization in capacity-percent terms and report
// tokens served separately, rather than fusing them into one fake number.

function computeUtilization(brokerAccounts, meterTotals) {
  const provider = (brokerAccounts.providers || []).find(
    (p) => p.providerId === 'anthropic-subscription',
  );
  const seats = provider ? (provider.accounts || []).filter((a) => a && a.enabled !== false) : [];

  let consumedPct = 0;
  let measurable = 0;
  const perSeat = {};
  for (const seat of seats) {
    const weekly = seat.usage && typeof seat.usage.weeklyPct === 'number' ? seat.usage.weeklyPct : null;
    if (weekly === null) continue;
    const clamped = Math.max(0, Math.min(100, weekly));
    consumedPct += clamped;
    measurable++;
    if (seat.id) perSeat[seat.id] = clamped;
  }

  let tokensServed = 0;
  for (const t of Object.values(meterTotals || {})) {
    tokensServed +=
      (Number(t.input_tokens) || 0) +
      (Number(t.output_tokens) || 0) +
      (Number(t.cache_read) || 0) +
      (Number(t.cache_creation) || 0);
  }

  const theoretical = measurable * 100;
  const available = measurable > 0;
  const utilizationPct = available ? Number(((consumedPct / theoretical) * 100).toFixed(1)) : null;

  return {
    available,
    seats: seats.length,
    measurableSeats: measurable,
    consumedPct: Number(consumedPct.toFixed(1)),
    theoreticalPct: theoretical,
    utilizationPct,
    tokensServed,
    perSeat,
    formula:
      'utilization = (sum of each seat\u2019s weekly used %) / (100 \u00d7 seats measured). ' +
      `right now: ${consumedPct.toFixed(1)}% / ${theoretical}% across ${measurable} seats.`,
    honesty: available
      ? 'caveats: weekly % is anthropic\u2019s own opaque metric, not tokens, and not linear in ' +
        'tokens. it counts all usage on a donated seat including the owner\u2019s own, so it ' +
        'overstates what the pool harvested. and it is a point-in-time read of windows that ' +
        'reset at different times, so it understates steady state. tokens served is reported ' +
        'separately rather than fused into this number, because converting between the two ' +
        'would require inventing a conversion rate.'
      : 'the broker is not reporting per-seat weekly usage right now, so utilization cannot be ' +
        'computed. showing nothing rather than a made-up number.',
    caveat: available
      ? `${consumedPct.toFixed(1)}% of ${theoretical}% weekly capacity`
      : 'broker usage unavailable',
  };
}

module.exports = { computeUtilization };
