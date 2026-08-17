/**
 * status.test.js — `/health`, the probe, and the sealed surface.
 *
 * `/health` is consumed by machines, so its original shape must survive every
 * future edit. The human status page lives upstream (`/status`, passed
 * through); its coverage lives in passthrough.test.js.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/worker.js';
import { statusModel } from '../src/lib/status.js';
import { PROBE_TTL_MS, resetProbeCache, upstreamStatus } from '../src/lib/upstream.js';
import { baseEnv, fakeFetch, makeCtx, req } from './harness.js';

const realFetch = globalThis.fetch;

/** A probe target that answers, so the edge reads as serving. */
function probeOk() {
  return fakeFetch({
    '/meter/pricing': () => new Response('{}', { status: 200 }),
  });
}

test.beforeEach(() => {
  resetProbeCache();
});

test.afterEach(() => {
  globalThis.fetch = realFetch;
  resetProbeCache();
});

// ---------------------------------------------------------------- /health

test('health keeps its contract: ok + service from the config', async () => {
  globalThis.fetch = probeOk();
  const response = await worker.fetch(req('GET', '/health'), baseEnv(), makeCtx());
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/u);

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, 'example-pool-edge');
});

test('health adds upstream, issuance, kill switch and a timestamp', async () => {
  globalThis.fetch = probeOk();
  const response = await worker.fetch(req('GET', '/health'), baseEnv(), makeCtx());
  const body = await response.json();

  assert.equal(body.upstreamOk, true);
  assert.equal(body.killSwitch, 'off');
  assert.ok(!Number.isNaN(Date.parse(body.timestamp)), 'timestamp parses as a date');
});

test('issuance reports invite, and cannot be flipped by env', async () => {
  globalThis.fetch = probeOk();
  // Keys come from an invite link to the upstream /join flow, the
  // private-tracker model. The edge has no config that could open or close
  // issuance, so /health must not imply it does.
  const env = baseEnv({ GITHUB_CLIENT_ID: 'leftover', GITHUB_CLIENT_SECRET: 'leftover' });
  const body = await (await worker.fetch(req('GET', '/health'), env, makeCtx())).json();
  assert.equal(body.issuance, 'invite');
});

test('health reports the kill switch without going unhealthy', async () => {
  globalThis.fetch = probeOk();
  const env = baseEnv({ KILL_SWITCH: 'on' });
  const body = await (await worker.fetch(req('GET', '/health'), env, makeCtx())).json();

  assert.equal(body.killSwitch, 'on');
  // `ok` is this worker's own liveness. A paused pool is a deliberate operator
  // state, not an outage, and must not page anyone.
  assert.equal(body.ok, true);
});

test('health stays ok when the upstream pool is unreachable', async () => {
  globalThis.fetch = fakeFetch({
    '/meter/pricing': () => {
      throw new Error('connection refused');
    },
  });
  const body = await (await worker.fetch(req('GET', '/health'), baseEnv(), makeCtx())).json();

  assert.equal(body.ok, true, 'edge liveness is not a rollup of the whole path');
  assert.equal(body.upstreamOk, false, 'but path health is reported honestly');
});

// ------------------------------------------------------- secret containment

test('no secret reaches /health', async () => {
  globalThis.fetch = probeOk();
  const env = baseEnv({
    POOL_EDGE_KEY: 'sk-pool-SECRET-VALUE-0001',
    UPSTREAM_BASE_URL: 'https://pool.example.com',
  });

  const json = await (await worker.fetch(req('GET', '/health'), env, makeCtx())).text();

  assert.ok(!json.includes('sk-pool-SECRET-VALUE-0001'), 'pool key never rendered');
  assert.ok(!json.includes('pool.example.com'), 'upstream origin never disclosed');
});

test('the status model is built from a closed vocabulary, not from env strings', () => {
  const model = statusModel(
    baseEnv({ POOL_EDGE_KEY: 'sk-leak-me', UPSTREAM_BASE_URL: 'https://origin.example' }),
    { ok: true, checkedAt: new Date().toISOString(), ageSeconds: 3 },
  );
  const serialized = JSON.stringify(model);

  assert.ok(!serialized.includes('sk-leak-me'));
  assert.ok(!serialized.includes('origin.example'));
  assert.equal(model.configured, true, 'presence is reported as a boolean, not a value');
});

// ------------------------------------------------------------ probe caching

test('the cached probe collapses a burst of health checks into one upstream fetch', async () => {
  const fetchImpl = probeOk();
  globalThis.fetch = fetchImpl;
  const env = baseEnv();

  await Promise.all(
    Array.from({ length: 20 }, () => worker.fetch(req('GET', '/health'), env, makeCtx())),
  );

  const probes = fetchImpl.calls.filter((call) => call.url.includes('/meter/pricing'));
  assert.equal(probes.length, 1, 'single-flight: concurrent checks share one probe');
});

test('sequential checks inside the TTL reuse the cached probe', async () => {
  const fetchImpl = probeOk();
  globalThis.fetch = fetchImpl;
  const env = baseEnv();

  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await worker.fetch(req('GET', '/health'), env, makeCtx());
  }

  assert.equal(fetchImpl.calls.length, 1, 'one probe per TTL window, not one per check');
});

test('the probe never touches an inference endpoint', async () => {
  const fetchImpl = probeOk();
  globalThis.fetch = fetchImpl;
  await worker.fetch(req('GET', '/health'), baseEnv(), makeCtx());

  for (const call of fetchImpl.calls) {
    assert.ok(!call.url.includes('/v1/messages'), 'a status check must cost zero model tokens');
  }
  assert.equal(PROBE_TTL_MS, 30_000);
});

test('a probe failure resolves as unreachable instead of rejecting', async () => {
  globalThis.fetch = fakeFetch({
    '/meter/pricing': () => {
      throw new Error('boom');
    },
  });
  const result = await upstreamStatus(baseEnv(), makeCtx());
  assert.equal(result.ok, false);
  assert.ok(!Number.isNaN(Date.parse(result.checkedAt)));
});

test('a 5xx from the origin is reported as unreachable, not rounded up', async () => {
  globalThis.fetch = fakeFetch({
    '/meter/pricing': () => new Response('nope', { status: 503 }),
  });
  assert.equal((await upstreamStatus(baseEnv(), makeCtx())).ok, false);
});

test('a 401 from the origin still means the origin is alive', async () => {
  globalThis.fetch = fakeFetch({
    '/meter/pricing': () => new Response('unauthorized', { status: 401 }),
  });
  assert.equal((await upstreamStatus(baseEnv(), makeCtx())).ok, true);
});

// ---------------------------------------------------------- sealed surfaces

test('the operator surface stays sealed', async () => {
  globalThis.fetch = probeOk();
  const env = baseEnv();
  const sealed = [
    '/admin/invite',
    '/admin',
    '/ledger',
    '/ledger.json',
    '/meter/stats',
    '/meter/traces',
    '/meter/me',
    '/meter/pricing',
    '/byo',
    '/byo/credentials',
  ];

  for (const path of sealed) {
    // eslint-disable-next-line no-await-in-loop
    const response = await worker.fetch(req('GET', path), env, makeCtx());
    assert.equal(response.status, 404, `${path} must stay sealed`);
    // eslint-disable-next-line no-await-in-loop
    const body = await response.text();
    assert.match(body, /no such endpoint/u, `${path} must 404 opaquely`);
  }
});

test('no self-serve issuance route exists', async () => {
  globalThis.fetch = probeOk();
  const env = baseEnv();
  for (const path of ['/keys/new', '/keys/callback']) {
    // eslint-disable-next-line no-await-in-loop
    const response = await worker.fetch(req('GET', path), env, makeCtx());
    assert.equal(response.status, 404, `${path} must not exist`);
  }
});

test('the root redirects to the pool status page', async () => {
  globalThis.fetch = probeOk();
  const response = await worker.fetch(req('GET', '/'), baseEnv(), makeCtx());
  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get('location')).pathname, '/status');
});
