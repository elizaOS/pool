/**
 * status.js — the machine-readable state model behind `/health`.
 *
 * A small, closed vocabulary of enum-ish values and booleans. Nothing here
 * interpolates a value from env, only the PRESENCE of one
 * (`configured: true`), which is what makes "no secret can reach /health" a
 * property of the design rather than a habit someone has to remember.
 */

import { EDGE_CONFIG } from '../edge.gen.js';

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

/**
 * Collapse env + probe into the small set of facts `/health` reports.
 *
 * `issuance` is always `invite`. Keys are not self-serve: they come from an
 * invite link to the upstream `/join` flow, the private-tracker model. It is a
 * constant on purpose: the edge has no config that could turn issuance on or
 * off, so it must not imply it does.
 */
export function statusModel(env, upstream) {
  const paused = env.KILL_SWITCH === 'on';
  const configured = Boolean(env.POOL_EDGE_KEY);
  return {
    service: EDGE_CONFIG.edgeName,
    edge: 'up',
    paused,
    upstreamOk: Boolean(upstream && upstream.ok),
    upstreamCheckedAt: upstream ? upstream.checkedAt : null,
    upstreamAgeSeconds: upstream ? upstream.ageSeconds : null,
    issuance: 'invite',
    killSwitch: paused ? 'on' : 'off',
    configured,
    // Inference only actually serves when all three hold.
    serving: !paused && configured && Boolean(upstream && upstream.ok),
  };
}
