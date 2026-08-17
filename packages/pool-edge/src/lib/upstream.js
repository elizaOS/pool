/**
 * upstream.js — cached, single-flight reachability probe for the pool origin.
 *
 * A status endpoint is a request amplifier: every check would otherwise become
 * one request against the pool. So the probe is capped at one outbound request
 * per PROBE_TTL_MS per isolate, shared across isolates through the Cloudflare
 * cache, and de-duplicated in-flight so a burst of concurrent checks collapses
 * to a single fetch.
 *
 * The probe endpoint is deliberately NOT an inference leg. `/meter/pricing`
 * returns pool-meter's in-memory pricing table: it proves the meter process is
 * answering and that our pool key is still accepted, and it costs the pool no
 * model tokens and no broker round trip.
 */

export const PROBE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 4_000;
const PROBE_PATH = '/meter/pricing';

/** Synthetic key for the CF cache. Never leaves the edge, never served. */
const CACHE_KEY = 'https://army-pool-edge.internal/probe/upstream';

let memo = { at: 0, value: null };
let inflight = null;

/** Test seam: the suite resets module state between cases. */
export function resetProbeCache() {
  memo = { at: 0, value: null };
  inflight = null;
}

/**
 * @returns {Promise<{ok: boolean, checkedAt: string, ageSeconds: number, cached: boolean}>}
 * Never throws and never rejects: a status endpoint that 500s because the
 * thing it reports on is down is a worse status endpoint than one that says
 * "unreachable".
 */
export async function upstreamStatus(env, ctx) {
  const now = Date.now();
  if (memo.value && now - memo.at < PROBE_TTL_MS) return decorate(memo, now, true);
  if (inflight) return inflight;

  inflight = (async () => {
    const fromCache = await readCache();
    if (fromCache && Date.now() - fromCache.at < PROBE_TTL_MS) {
      memo = fromCache;
      return decorate(memo, Date.now(), true);
    }
    const value = await probe(env);
    memo = { at: Date.now(), value };
    const write = writeCache(memo);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(write);
    else await write;
    return decorate(memo, Date.now(), false);
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

function decorate(entry, now, cached) {
  return {
    ok: entry.value.ok,
    checkedAt: new Date(entry.at).toISOString(),
    ageSeconds: Math.max(0, Math.round((now - entry.at) / 1000)),
    cached,
  };
}

async function probe(env) {
  const base = env.UPSTREAM_BASE_URL;
  if (!base) return { ok: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const headers = new Headers({ accept: 'application/json' });
    if (env.POOL_EDGE_KEY) headers.set('x-api-key', env.POOL_EDGE_KEY);
    const response = await fetch(new URL(PROBE_PATH, base).toString(), {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    // Any HTTP answer below 500 means the origin is alive and routing. A 5xx is
    // the origin telling us it is not well, and we report that rather than
    // rounding it up to "reachable" because a socket opened.
    // The body is never read and never surfaced.
    return { ok: response.status < 500 };
  } catch {
    // error-policy: transport failure and timeout are both "not reachable".
    // Nothing here is masked as healthy.
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

async function readCache() {
  const cache = globalThis.caches && globalThis.caches.default;
  if (!cache) return null;
  try {
    const hit = await cache.match(CACHE_KEY);
    if (!hit) return null;
    const parsed = await hit.json();
    if (!parsed || typeof parsed.at !== 'number') return null;
    return { at: parsed.at, value: { ok: parsed.ok === true } };
  } catch {
    return null;
  }
}

async function writeCache(entry) {
  const cache = globalThis.caches && globalThis.caches.default;
  if (!cache) return;
  try {
    const ttl = Math.ceil(PROBE_TTL_MS / 1000);
    await cache.put(
      CACHE_KEY,
      new Response(JSON.stringify({ at: entry.at, ok: entry.value.ok }), {
        headers: {
          'content-type': 'application/json',
          'cache-control': `max-age=${ttl}`,
        },
      }),
    );
  } catch {
    // A cache write failure costs us one extra probe per isolate, nothing more.
  }
}
