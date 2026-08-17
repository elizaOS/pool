/**
 * passthrough.js — serve the pool's own human surfaces through the edge host.
 *
 * `/join`, `/status`, `/docs` and friends already exist upstream and already
 * implement the invite-only model this endpoint wants. Adopting them beats
 * re-implementing them: one page to fix when the copy is wrong, one flow to
 * audit when the ToS changes.
 *
 * The security posture of a passthrough is different from an inference proxy,
 * and the difference is the whole reason this lives in its own module:
 *
 *  - **No pool key is ever attached.** Not conditionally, not for the status
 *    pane, not "just for the keyed view". The key is not read in this file. A
 *    path collision between the passthrough table and an inference leg can
 *    therefore never become free inference, it can only become an anonymous
 *    request, which upstream will reject on its own.
 *  - **No caller credential is forwarded.** See passthroughHeaders. The keyed
 *    `/status` view (which de-anonymizes seat labels for a valid pool key) is
 *    deliberately unreachable from this hostname.
 *  - **The body is streamed, never buffered.** `/join/events` is a long-lived
 *    SSE mirror of a device-OAuth flow. Buffering it would silently break the
 *    join flow in a way no status code reveals.
 */

import { passthroughHeaders, passthroughQuery, passthroughResponseHeaders, isPublicPath } from './policy.js';

/** Upstream is typically a Node http server behind nginx; SSE legs can idle
 * for minutes. */
const PASSTHROUGH_TIMEOUT_MS = 120_000;
const STREAM_TIMEOUT_MS = 600_000;

/**
 * Forward one request to the upstream pool verbatim, minus credentials.
 *
 * @param {Request} request
 * @param {object} env
 * @param {{stream?: boolean}} route
 * @param {URL} url
 */
export async function handlePassthrough(request, env, route, url) {
  const base = env.UPSTREAM_BASE_URL;
  if (!base) {
    // error-policy: an unconfigured edge says so. It does not render a page
    // that pretends the pool is down.
    return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'edge is not configured' } }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const target = new URL(url.pathname + passthroughQuery(url.search), base);
  const controller = new AbortController();
  const budget = route.stream ? STREAM_TIMEOUT_MS : PASSTHROUGH_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), budget);

  let response;
  try {
    response = await fetch(target.toString(), {
      method: request.method,
      headers: passthroughHeaders(request),
      // GET/HEAD carry no body; anything else is streamed straight through.
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    // error-policy: an unreachable origin is reported as an origin problem, in
    // the caller's own content type. It is never masked as a 200 empty page.
    return upstreamDown(request);
  }

  // The SSE leg must not have its timer fire mid-stream; clearing it here means
  // the budget covers time-to-first-byte, which is the part that can hang.
  clearTimeout(timer);

  const headers = passthroughResponseHeaders(response);
  rewriteLocation(headers, base);
  if (route.stream) {
    // Belt and braces against any intermediary that would like to buffer.
    headers.set('cache-control', 'no-cache, no-transform');
    headers.set('x-accel-buffering', 'no');
  }

  return new Response(response.body, { status: response.status, headers });
}

/**
 * Keep redirects on the edge hostname.
 *
 * Upstream may answer some routes with an absolute `Location` on its own host.
 * Passing that back would bounce a contributor off the edge mid-flow.
 * Rewritten only when the target is a path this edge actually serves; anything
 * else is left alone rather than rewritten into a 404 on our side.
 */
export function rewriteLocation(headers, base) {
  const location = headers.get('location');
  if (!location) return;
  let parsed;
  try {
    parsed = new URL(location, base);
  } catch {
    return;
  }
  const upstreamHost = new URL(base).host;
  if (parsed.host !== upstreamHost) return;
  if (!isPublicPath(parsed.pathname)) return;
  headers.set('location', parsed.pathname + parsed.search);
}

/**
 * A 502 shaped like whatever the caller asked for. The join page's fetch()
 * calls want JSON; a browser navigating to /status wants something readable.
 */
function upstreamDown(request) {
  const accept = request.headers.get('accept') || '';
  if (accept.includes('text/html')) {
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>pool unreachable</title>' +
        '<body style="background:#0a0a0a;color:#f5f5f5;font:14px/1.6 -apple-system,sans-serif;padding:40px">' +
        '<p>the pool is not answering right now. nothing is lost, try again in a minute.</p>',
      { status: 502, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
    );
  }
  return new Response(JSON.stringify({ error: 'the pool is not answering right now, try again in a minute' }), {
    status: 502,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
