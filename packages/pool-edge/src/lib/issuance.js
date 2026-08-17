/**
 * issuance.js — contributor grant introspection.
 *
 * There is no self-serve issuance in this worker, by design. Keys are issued
 * by the upstream pool's `/join` flow, which is invite-link gated like a
 * private tracker and ties the grant to an actual donated seat. (The lineage
 * template once carried a GitHub-OAuth issuance flow; it was deleted rather
 * than left dormant, because dormant auth code is the kind that gets
 * re-enabled by a future edit without anyone re-reading its threat model.)
 *
 * What lives here is `/keys/status`: a contributor reading their OWN edge
 * grant balance, which is edge-local state (prefixed edge tokens live in KV
 * here, not upstream) and has no equivalent on the pool.
 */

import { tierFor } from './grants.js';
import { looksLikeToken, readToken, tokenHash } from './tokens.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(status, payload, extra = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

/** GET /keys/status with the contributor's own token -> their own grant only. */
export async function handleGrantStatus(request, env, cors = {}) {
  const presented = readToken(request);
  if (!presented || !looksLikeToken(presented)) {
    return json(401, { error: 'present your contributor token' }, cors);
  }
  const hash = await tokenHash(presented);
  const record = await env.POOL_EDGE.get(`token:${hash}`, { type: 'json' });
  if (!record) return json(401, { error: 'contributor token is not valid' }, cors);

  const tier = tierFor(record.tier);
  const used = Number(record.weightedUsed || 0);
  return json(
    200,
    {
      grantId: record.grantId,
      login: record.login,
      tier: tier.name,
      revoked: record.revoked === true,
      weightedTokenGrant: tier.weightedTokens,
      weightedTokensUsed: used,
      weightedTokensRemaining: Math.max(0, tier.weightedTokens - used),
      requests: Number(record.requests || 0),
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt || null,
      traces: false,
      tracesNote: 'contributor traffic through this endpoint is not trace-captured.',
    },
    cors,
  );
}
