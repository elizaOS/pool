/**
 * army-pool-edge — contributor-compute edge template.
 *
 * The upstream pool (a pool-meter instance, see docs/POOL-API.md) is the
 * metering and credential authority. This Worker is a narrow, contributor-
 * facing front door in front of it. It exists for four reasons a plain CNAME
 * cannot give an operator:
 *
 *   1. Surface reduction. The pool origin also serves /admin, /ledger, /meter/*
 *      and /byo. A CNAME publishes all of it on a public hostname. Here, only
 *      the inference path and the public human pages exist.
 *   2. Fan-out control. One shared key handed to the internet is unrevocable in
 *      practice. Here every contributor gets their own opaque token, mapped to
 *      a pool key that never leaves the edge, revocable individually.
 *   3. Abuse handling at the edge, before upstream capacity is spent.
 *   4. A kill switch that does not require touching the pool or DNS.
 *
 * It deliberately does NOT re-implement metering. Pool-side per-key quota
 * remains the hard ceiling; the edge counter is a fast, cheap early stop.
 *
 * All instance identity (name, origins, tiers, token prefix) comes from
 * src/edge.gen.js, rendered from pool-edge.config.json. No identity string is
 * hardcoded in this tree; the forbidden-strings test enforces it.
 */

import { EDGE_CONFIG } from './edge.gen.js';
import {
  bodyTooLarge,
  corsHeaders,
  downstreamHeaders,
  isForbidden,
  normalizePath,
  resolveRoute,
  upstreamHeaders,
} from './lib/policy.js';
import { grantKey, modelAllowed, tierFor, weighUsage } from './lib/grants.js';
import { looksLikeToken, readToken, tokenHash } from './lib/tokens.js';
import { handleGrantStatus } from './lib/issuance.js';
import { handlePassthrough } from './lib/passthrough.js';
import { statusModel } from './lib/status.js';
import { upstreamStatus } from './lib/upstream.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function errorBody(type, message) {
  return JSON.stringify({ type: 'error', error: { type, message } });
}

export function jsonError(status, type, message, extra = {}) {
  return new Response(errorBody(type, message), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

/** Opaque 404: a probe cannot tell "not a route" from "route you may not have". */
function notFound() {
  return jsonError(404, 'not_found_error', 'no such endpoint');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = normalizePath(url.pathname);
    const origin = request.headers.get('origin');
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Tripwire before routing: an admin path never gets far enough to be a bug.
    if (isForbidden(pathname)) return notFound();

    const route = resolveRoute(request.method, pathname);
    if (!route) return notFound();

    switch (route.kind) {
      case 'health':
        return handleHealth(env, ctx);
      case 'redirect':
        return Response.redirect(new URL(route.to, url).toString(), 302);
      case 'passthrough':
        // Public pool pages. Deliberately NOT gated on the kill switch: the
        // switch pauses inference, and a paused endpoint whose status page also
        // goes dark is indistinguishable from an outage to the person trying to
        // find out what happened. /status stays up and keeps telling the truth.
        return handlePassthrough(request, env, route, url);
      case 'grant-status':
        return handleGrantStatus(request, env, cors);
      case 'proxy':
        return handleProxy(request, env, ctx, route, url);
      default:
        return notFound();
    }
  },
};

/**
 * `/health` — machine-readable state.
 *
 * `ok` deliberately stays true whenever the edge itself is answering. It is the
 * liveness of THIS worker, not a rollup of the whole path: flipping it on an
 * upstream blip would tell a monitor to restart or reroute something that is
 * not broken. Path health is `upstreamOk`, reported separately and honestly.
 */
async function handleHealth(env, ctx) {
  const upstream = await upstreamStatus(env, ctx);
  const model = statusModel(env, upstream);
  return new Response(
    JSON.stringify({
      ok: true,
      service: EDGE_CONFIG.edgeName,
      upstreamOk: model.upstreamOk,
      issuance: model.issuance,
      killSwitch: model.killSwitch,
      timestamp: new Date().toISOString(),
    }),
    {
      headers: { ...JSON_HEADERS, 'cache-control': 'no-store' },
    },
  );
}

async function handleProxy(request, env, ctx, route, url) {
  if (env.KILL_SWITCH === 'on') {
    return jsonError(
      503,
      'overloaded_error',
      'this pool edge is paused. Contribution work is unaffected; bring your own key or retry later.',
      { 'retry-after': '900' },
    );
  }

  const presented = readToken(request);
  if (!presented || !looksLikeToken(presented)) {
    return jsonError(
      401,
      'authentication_error',
      `no contributor token. Keys are invite-only: see ${EDGE_CONFIG.publicOrigin}/join`,
    );
  }

  const hash = await tokenHash(presented);
  const raw = await env.POOL_EDGE.get(`token:${hash}`, { type: 'json' });
  if (!raw || raw.revoked === true) {
    return jsonError(401, 'authentication_error', 'contributor token is not valid');
  }

  const tier = tierFor(raw.tier);

  // Edge quota: a cheap early stop so a runaway loop does not spend upstream
  // capacity for the seconds it takes pool-side accounting to catch it. The
  // pool's own per-key quota is still the authoritative hard ceiling.
  const used = Number(raw.weightedUsed || 0);
  if (used >= tier.weightedTokens) {
    const note = EDGE_CONFIG.grantIncreaseNote ? ` ${EDGE_CONFIG.grantIncreaseNote}` : '';
    return jsonError(
      429,
      'rate_limit_error',
      `contributor grant exhausted (${tier.weightedTokens.toLocaleString('en-US')} weighted tokens).${note}`,
      { 'x-army-grant-remaining': '0' },
    );
  }

  if (bodyTooLarge(request)) {
    return jsonError(413, 'invalid_request_error', 'request body exceeds the edge limit');
  }

  // Model gate for restricted tiers. Only restricted tiers pay the buffering
  // cost; everyone else keeps a pure streaming pass-through.
  let body = request.body;
  if (tier.models && route.upstream === '/v1/messages') {
    const text = await request.text();
    let model = null;
    try {
      model = JSON.parse(text).model || null;
    } catch {
      // error-policy: an unparseable body is upstream's to reject, not ours to guess.
    }
    if (!modelAllowed(tier.name, model)) {
      return jsonError(
        403,
        'permission_error',
        `tier '${tier.name}' cannot use ${model}. allowed: ${tier.models.join(', ')}.`,
      );
    }
    body = text;
  }

  const requestId = crypto.randomUUID();
  const upstream = new URL(route.upstream + url.search, env.UPSTREAM_BASE_URL);
  const poolKey = env.POOL_EDGE_KEY;
  if (!poolKey) {
    // Fail closed and loudly: a missing binding must never degrade to
    // unauthenticated pass-through.
    return jsonError(500, 'api_error', 'edge is not configured');
  }

  let response;
  try {
    response = await fetch(upstream.toString(), {
      method: request.method,
      headers: upstreamHeaders(request, poolKey, { requestId }),
      body,
    });
  } catch {
    // error-policy: upstream transport failure is reported, never masked as 200.
    return jsonError(502, 'api_error', 'upstream pool is unreachable');
  }

  if (!route.meter) {
    return new Response(response.body, {
      status: response.status,
      headers: downstreamHeaders(response),
    });
  }

  const remaining = Math.max(0, tier.weightedTokens - used);
  const headers = downstreamHeaders(response, {
    'x-army-grant-remaining': String(remaining),
    'x-army-request-id': requestId,
  });

  // Tee the stream so accounting never sits in the latency path.
  const [toClient, toMeter] = response.body ? response.body.tee() : [null, null];
  if (toMeter) {
    ctx.waitUntil(accountUsage(env, hash, raw, toMeter, response.headers.get('content-type')));
  }
  return new Response(toClient, { status: response.status, headers });
}

/**
 * Read usage off the response copy and add it to the edge counter.
 * SSE and non-SSE both carry `usage`; we parse whichever shape arrives.
 */
export async function accountUsage(env, hash, record, stream, contentType) {
  let weighted = 0;
  try {
    const text = await new Response(stream).text();
    weighted = extractWeightedUsage(text, contentType);
  } catch {
    // error-policy: unreadable accounting must not refund quota silently.
    weighted = 0;
  }
  if (weighted <= 0) return;
  // Read-modify-write on KV is last-writer-wins. Undercounting here is bounded
  // by concurrency and the pool-side quota still backstops it; we accept that
  // rather than paying for a Durable Object on a grant-sized budget.
  const current = await env.POOL_EDGE.get(`token:${hash}`, { type: 'json' });
  const base = current || record;
  const next = {
    ...base,
    weightedUsed: Number(base.weightedUsed || 0) + weighted,
    lastUsedAt: new Date().toISOString(),
    requests: Number(base.requests || 0) + 1,
  };
  await env.POOL_EDGE.put(`token:${hash}`, JSON.stringify(next));
}

export function extractWeightedUsage(text, contentType) {
  if (!text) return 0;
  if (contentType && contentType.includes('text/event-stream')) {
    let total = 0;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const event = JSON.parse(payload);
        if (event.usage) total += weighUsage(event.usage);
        if (event.message && event.message.usage) total += weighUsage(event.message.usage);
      } catch {
        // error-policy: a malformed SSE frame is skipped, not treated as zero-cost overall.
      }
    }
    return total;
  }
  try {
    const parsed = JSON.parse(text);
    return weighUsage(parsed.usage);
  } catch {
    return 0;
  }
}

export { grantKey };
