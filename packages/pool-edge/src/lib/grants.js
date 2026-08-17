/**
 * grants.js — the tiers an edge grant can hold, and what a request costs.
 *
 * Tier names and budgets come from pool-edge.config.json via the rendered
 * EDGE_CONFIG. The token WEIGHTS do not: they must match the upstream
 * pool-meter's accounting exactly, or the edge counter and the pool's own
 * quota gate disagree about what a request "cost". If pool-meter ever makes
 * its weights configurable, this constant becomes config in the same release,
 * not before.
 *
 * Eligibility is a human decision expressed as an invite link (the
 * private-tracker model); there is no self-serve issuance in this worker and
 * no account-age rule for code to enforce.
 */

import { EDGE_CONFIG } from '../edge.gen.js';

export const TIERS = Object.freeze(
  Object.fromEntries(
    Object.entries(EDGE_CONFIG.tiers).map(([name, tier]) => [
      name,
      Object.freeze({
        name,
        weightedTokens: tier.weightedTokens,
        models: tier.models ? Object.freeze([...tier.models]) : null,
      }),
    ]),
  ),
);

/**
 * Weighted-token accounting, identical to the upstream pool-meter (source of
 * truth: pool-meter lib/metrics.js). Structural, not configurable.
 */
export const TOKEN_WEIGHTS = Object.freeze({
  input: 1.0,
  output: 5.0,
  cache_read: 0.1,
  cache_creation: 1.25,
});

export function weighUsage(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return Math.round(
    n(usage.input_tokens) * TOKEN_WEIGHTS.input +
      n(usage.output_tokens) * TOKEN_WEIGHTS.output +
      n(usage.cache_read_input_tokens) * TOKEN_WEIGHTS.cache_read +
      n(usage.cache_creation_input_tokens) * TOKEN_WEIGHTS.cache_creation,
  );
}

/** Unknown tier names on stored grants degrade to `contributor`, which the
 * config validator guarantees exists. */
export function tierFor(name) {
  return TIERS[name] || TIERS.contributor;
}

export function modelAllowed(tierName, model) {
  const tier = tierFor(tierName);
  if (!tier.models) return true;
  if (!model) return true;
  const m = String(model).toLowerCase();
  return tier.models.some((allowed) => m.startsWith(allowed));
}

/** KV key for an operator-minted grant record. Keyed on the numeric GitHub id,
 * never the login, which is renameable and reusable. */
export function grantKey(githubId) {
  return `grant:gh:${String(githubId)}`;
}
