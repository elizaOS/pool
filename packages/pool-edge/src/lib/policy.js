/**
 * policy.js — what this edge is allowed to be.
 *
 * The whole security argument for putting a Worker in front of the pool instead
 * of CNAMEing straight to it lives in this file: the pool-meter origin serves
 * an admin surface (/admin/*), an operator surface (/meter/*, /ledger) and a
 * BYO credential surface (/byo/*). None of that belongs on a contributor-facing
 * hostname. This module is a positive allowlist: a path that is not named here
 * does not exist at the edge.
 *
 * The pool's own human surfaces (/join, /status, /docs) are ADOPTED rather
 * than re-implemented: they are served as byte-for-byte passthrough, with the
 * pool key NEVER attached. A passthrough route is anonymous by construction,
 * so it can never become free inference if a path ever collides with an
 * inference leg.
 *
 * Nothing in this file is configurable except the CORS origin list and the
 * extra asset passthroughs, both of which come from the rendered EDGE_CONFIG.
 * Sealed prefixes, header hygiene and body limits are structural.
 */

import { EDGE_CONFIG } from '../edge.gen.js';

/** Inference + edge-local routes. The pool key is substituted on these. */
export const ROUTES = Object.freeze({
  // inference legs, forwarded upstream with the contributor's mapped pool key
  'POST /v1/messages': { kind: 'proxy', upstream: '/v1/messages', meter: true },
  'POST /v1/messages/count_tokens': {
    kind: 'proxy',
    upstream: '/v1/messages/count_tokens',
    meter: false,
  },
  'GET /v1/models': { kind: 'proxy', upstream: '/v1/models', meter: false },
  // a contributor may read their OWN pool-side burn, and nothing else
  'GET /me': { kind: 'proxy', upstream: '/meter/me', meter: false },
  // edge-local
  'GET /health': { kind: 'health' },
  'GET /keys/status': { kind: 'grant-status' },
  // The root sends people to the pool's status page rather than serving a
  // second, homegrown one.
  'GET /': { kind: 'redirect', to: '/status' },
});

/**
 * Upstream human surfaces served verbatim through this hostname.
 *
 * Method-exact and path-exact on purpose. A prefix rule here would be the one
 * mistake that matters: `/join*` would sweep in any future upstream route
 * under that prefix without anyone re-reading it. Add the exact route.
 *
 * `stream: true` marks the SSE leg so nothing in the response path is allowed
 * to buffer it.
 *
 * These paths are the pool-meter service's own public pages (see docs/
 * POOL-API.md for the shapes this table depends on). Extra static assets the
 * upstream pages reference (a brand mark, a favicon) are configured per
 * instance via `passthroughAssets`, GET-exact only.
 */
export const PASSTHROUGH = Object.freeze({
  // invite-gated seat donation, the private-tracker flow
  'GET /join': { kind: 'passthrough' },
  'POST /join/start': { kind: 'passthrough' },
  'GET /join/events': { kind: 'passthrough', stream: true },
  'POST /join/submit-code': { kind: 'passthrough' },
  'POST /join/cancel': { kind: 'passthrough' },
  'GET /join/revoke': { kind: 'passthrough' },
  'POST /join/revoke': { kind: 'passthrough' },
  // account sign-in surface: /join/start can require a verified pool session
  // cookie, so donors must be able to mint/inspect/drop that cookie through
  // the edge. Exact paths only; /account/claim is intentionally absent
  // (legacy claim stays on the origin host).
  'GET /account': { kind: 'passthrough' },
  'POST /account/session': { kind: 'passthrough' },
  'POST /account/whoami': { kind: 'passthrough' },
  'POST /account/logout': { kind: 'passthrough' },
  // public pool status, human and machine
  'GET /status': { kind: 'passthrough' },
  'GET /status.json': { kind: 'passthrough' },
  // the env contract
  'GET /docs': { kind: 'passthrough' },
  // per-instance static assets the upstream pages reference
  ...Object.fromEntries(
    EDGE_CONFIG.passthroughAssets.map((path) => [`GET ${path}`, { kind: 'passthrough' }]),
  ),
});

/**
 * Explicitly denied even if a future edit widens the allowlist by accident.
 * Belt and braces: the allowlist is the control, this is the tripwire.
 *
 * `/meter` is sealed as a whole prefix. The edge still reads `/meter/me` and
 * `/meter/pricing` upstream, but it does so by mapping an allowlisted public
 * path to them, never by letting a caller name a `/meter` path.
 *
 * NOT configurable. The config validator refuses passthroughAssets under
 * these prefixes, and no config key can remove one.
 */
const FORBIDDEN_PREFIXES = ['/admin', '/ledger', '/meter', '/byo'];

/**
 * A forbidden root is blocked at its exact path, as a path prefix, AND with a
 * file extension appended. The extension case is not hypothetical: pool-meter
 * serves BOTH `/ledger` and `/ledger.json`, and a `startsWith(prefix + '/')`
 * check silently lets the `.json` twin through. A lookalike like `/ledgerboard`
 * stays outside the tripwire so the block reads precisely.
 */
export function isForbidden(pathname) {
  const p = normalizePath(pathname);
  return FORBIDDEN_PREFIXES.some((prefix) => {
    if (p === prefix) return true;
    if (!p.startsWith(prefix)) return false;
    const rest = p.slice(prefix.length);
    return rest.startsWith('/') || /^\.[A-Za-z0-9]+$/u.test(rest);
  });
}

/** Collapse duplicate slashes and strip a trailing slash (except root). */
export function normalizePath(pathname) {
  const collapsed = String(pathname || '/').replace(/\/{2,}/gu, '/');
  if (collapsed.length > 1 && collapsed.endsWith('/')) return collapsed.slice(0, -1);
  return collapsed;
}

export function resolveRoute(method, pathname) {
  const p = normalizePath(pathname);
  if (isForbidden(p)) return null;
  const key = `${String(method).toUpperCase()} ${p}`;
  return ROUTES[key] || PASSTHROUGH[key] || null;
}

/** Is this exact path reachable at all, by any method? Used for Location rewrites. */
export function isPublicPath(pathname) {
  const p = normalizePath(pathname);
  if (isForbidden(p)) return false;
  const suffix = ` ${p}`;
  return [...Object.keys(ROUTES), ...Object.keys(PASSTHROUGH)].some((k) => k.endsWith(suffix));
}

/**
 * Headers we forward upstream on an INFERENCE leg. Everything else is dropped,
 * so a caller cannot smuggle an admin header, a cookie, a forwarded-host, or a
 * trace opt-in past the edge. The contributor's own credential is never
 * forwarded; the Worker substitutes the mapped pool key.
 */
const FORWARD_HEADERS = [
  'content-type',
  'accept',
  'anthropic-version',
  'anthropic-beta',
  'accept-encoding',
];

export function upstreamHeaders(request, poolKey, { requestId }) {
  const out = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value) out.set(name, value);
  }
  out.set('x-api-key', poolKey);
  // Traces should be OFF for the edge's pool key pool-side (mint it with
  // traces:false). We also refuse to let a caller flip any trace/consent
  // header from the edge.
  out.delete('authorization');
  out.delete('cookie');
  out.set('x-army-request-id', requestId);
  return out;
}

/**
 * Headers we forward on a PASSTHROUGH leg.
 *
 * Two rules, both load-bearing:
 *
 *  1. No credential crosses this edge, in either direction. `x-api-key` and
 *     `authorization` are dropped and a `?key=` query param is stripped
 *     (see passthroughQuery). The upstream /status pane de-anonymizes account
 *     labels for a valid pool key; this hostname stays an anonymous surface,
 *     and an operator who wants the keyed view uses the pool host directly.
 *     This also guarantees the edge's own pool key can never be implicated in
 *     a passthrough response.
 *  2. `accept-encoding` is NOT forwarded. Letting the origin compress means
 *     handing back a body whose `content-encoding` no longer matches what the
 *     platform will do to it. Cloudflare compresses on the way out; upstream
 *     ships plain bytes.
 *
 * `cookie` and `last-event-id` ARE forwarded: the join flow needs them, and a
 * passthrough that silently eats session headers is a trap for whoever changes
 * the upstream next.
 */
const PASSTHROUGH_FORWARD_HEADERS = [
  'content-type',
  'content-length',
  'accept',
  'accept-language',
  'cookie',
  'last-event-id',
  'user-agent',
];

export function passthroughHeaders(request) {
  const out = new Headers();
  for (const name of PASSTHROUGH_FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value) out.set(name, value);
  }
  out.delete('x-api-key');
  out.delete('authorization');
  return out;
}

/**
 * Query string forwarded on a passthrough. Invite, session and provider params
 * all matter to the join flow, so the string is forwarded whole rather than
 * allowlisted per-param, which would break the next flag upstream adds. `key`
 * is the one exception: it is a credential (see rule 1 above).
 */
export function passthroughQuery(search) {
  const params = new URLSearchParams(search || '');
  if (!params.has('key')) return search || '';
  params.delete('key');
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

/** Response headers we return to the caller. Nothing upstream-identifying. */
const STRIP_RESPONSE_HEADERS = [
  'set-cookie',
  'x-powered-by',
  'server',
  'anthropic-organization-id',
  'request-id',
  'x-request-id',
];

export function downstreamHeaders(upstreamResponse, extra = {}) {
  const out = new Headers(upstreamResponse.headers);
  for (const name of STRIP_RESPONSE_HEADERS) out.delete(name);
  for (const [k, v] of Object.entries(extra)) out.set(k, v);
  return out;
}

/**
 * Response headers for a passthrough.
 *
 * `set-cookie` is preserved here (unlike the inference path) because these are
 * the pool's own first-party pages on a first-party hostname, and stripping a
 * session cookie the flow depends on would be an invisible break.
 *
 * Hop-by-hop and transport-shape headers are dropped: the body is re-framed by
 * the Worker runtime, so a stale `content-length` or `content-encoding` from
 * the origin describes bytes that no longer exist.
 */
const STRIP_PASSTHROUGH_RESPONSE_HEADERS = [
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'x-powered-by',
  'server',
  'anthropic-organization-id',
];

export function passthroughResponseHeaders(upstreamResponse) {
  const out = new Headers(upstreamResponse.headers);
  for (const name of STRIP_PASSTHROUGH_RESPONSE_HEADERS) out.delete(name);
  return out;
}

/** Max request body accepted at the edge (pool-meter's own cap is 32MB). */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

export function bodyTooLarge(request) {
  const len = Number(request.headers.get('content-length') || 0);
  return Number.isFinite(len) && len > MAX_BODY_BYTES;
}

/** Browser callers are only ever the configured first-party origins. */
export const ALLOWED_ORIGINS = Object.freeze([...EDGE_CONFIG.allowedOrigins]);

export function corsHeaders(origin) {
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}
