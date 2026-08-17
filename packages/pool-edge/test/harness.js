/**
 * harness.js — minimal test harness + in-memory fakes for KV and upstream.
 * Node stdlib only (node:test, node:assert). No wrangler/miniflare required
 * so the suite runs anywhere, including in CI before any Cloudflare access.
 *
 * All hosts here are the template's example config values (rendered into
 * src/edge.gen.js). Nothing in this suite names a real deployment.
 */

export const EDGE_HOST = 'https://pool.army.example.com';
export const POOL_HOST = 'https://pool.example.com';
export const SITE_ORIGIN = 'https://army.example.com';

export class FakeKV {
  constructor(initial = {}) {
    this.store = new Map(Object.entries(initial));
    this.puts = 0;
  }

  async get(key, options) {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    if (options && options.type === 'json') return JSON.parse(raw);
    return raw;
  }

  async put(key, value) {
    this.puts += 1;
    this.store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }

  async delete(key) {
    this.store.delete(key);
  }
}

/** Captures every outbound fetch so tests can assert on what left the edge. */
export function fakeFetch(routes) {
  const calls = [];
  const impl = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init, headers: new Headers(init.headers || {}) });
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) return handler(url, init);
    }
    throw new Error(`[test] unexpected fetch: ${url}`);
  };
  impl.calls = calls;
  return impl;
}

export function makeCtx() {
  const pending = [];
  return {
    waitUntil: (promise) => pending.push(promise),
    settle: () => Promise.all(pending),
    pending,
  };
}

export function baseEnv(overrides = {}) {
  return {
    POOL_EDGE: new FakeKV(),
    UPSTREAM_BASE_URL: POOL_HOST,
    POOL_EDGE_KEY: 'test-pool-key-not-real',
    PUBLIC_BASE_URL: EDGE_HOST,
    KILL_SWITCH: 'off',
    ...overrides,
  };
}

export function req(method, path, { headers = {}, body } = {}) {
  return new Request(`${EDGE_HOST}${path}`, { method, headers, body });
}

export function sse(frames) {
  return frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('');
}
