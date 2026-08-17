import assert from 'node:assert/strict';
import test from 'node:test';

import worker, { extractWeightedUsage } from '../src/worker.js';
import { mintToken, tokenHash } from '../src/lib/tokens.js';
import { baseEnv, fakeFetch, makeCtx, req, sse, POOL_HOST } from './harness.js';

const realFetch = globalThis.fetch;

async function seedGrant(env, overrides = {}) {
  const token = mintToken();
  const hash = await tokenHash(token);
  await env.POOL_EDGE.put(
    `token:${hash}`,
    JSON.stringify({
      grantId: 'edge-1-test',
      githubId: '1',
      login: 'dev',
      tier: 'contributor',
      weightedUsed: 0,
      requests: 0,
      revoked: false,
      ...overrides,
    }),
  );
  return { token, hash };
}

function upstreamOk(bodyText = JSON.stringify({ usage: { input_tokens: 100, output_tokens: 10 } })) {
  return fakeFetch({
    'pool.example.com': () =>
      new Response(bodyText, { status: 200, headers: { 'content-type': 'application/json' } }),
  });
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test('admin paths 404 opaquely and never reach upstream', async () => {
  const env = baseEnv();
  const spy = upstreamOk();
  globalThis.fetch = spy;
  for (const path of ['/admin/invite', '/ledger.json', '/meter/stats', '/byo/credentials']) {
    const response = await worker.fetch(req('GET', path), env, makeCtx());
    assert.equal(response.status, 404, path);
  }
  assert.equal(spy.calls.length, 0, 'no forbidden request may be forwarded');
});

test('inference without a token is rejected before upstream', async () => {
  const env = baseEnv();
  const spy = upstreamOk();
  globalThis.fetch = spy;
  const response = await worker.fetch(req('POST', '/v1/messages'), env, makeCtx());
  assert.equal(response.status, 401);
  assert.equal(spy.calls.length, 0);
});

test('an upstream pool key is never accepted as a contributor token', async () => {
  const env = baseEnv();
  const spy = upstreamOk();
  globalThis.fetch = spy;
  const response = await worker.fetch(
    req('POST', '/v1/messages', { headers: { 'x-api-key': env.POOL_EDGE_KEY } }),
    env,
    makeCtx(),
  );
  assert.equal(response.status, 401);
  assert.equal(spy.calls.length, 0);
});

test('a valid grant proxies and substitutes the pool key', async () => {
  const env = baseEnv();
  const { token } = await seedGrant(env);
  const spy = upstreamOk();
  globalThis.fetch = spy;
  const ctx = makeCtx();
  const response = await worker.fetch(
    req('POST', '/v1/messages', {
      headers: { 'x-api-key': token, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
    }),
    env,
    ctx,
  );
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].headers.get('x-api-key'), env.POOL_EDGE_KEY);
  assert.equal(spy.calls[0].url, `${POOL_HOST}/v1/messages`);
  assert.ok(response.headers.get('x-army-grant-remaining'));
});

test('usage is metered back into the grant after the response streams', async () => {
  const env = baseEnv();
  const { token, hash } = await seedGrant(env);
  globalThis.fetch = upstreamOk();
  const ctx = makeCtx();
  const response = await worker.fetch(
    req('POST', '/v1/messages', {
      headers: { 'x-api-key': token, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
    }),
    env,
    ctx,
  );
  await response.text();
  await ctx.settle();
  const record = await env.POOL_EDGE.get(`token:${hash}`, { type: 'json' });
  assert.equal(record.weightedUsed, 100 * 1 + 10 * 5);
  assert.equal(record.requests, 1);
});

test('an exhausted grant is refused at the edge, not upstream', async () => {
  const env = baseEnv();
  const { token } = await seedGrant(env, { weightedUsed: 25_000_000 });
  const spy = upstreamOk();
  globalThis.fetch = spy;
  const response = await worker.fetch(
    req('POST', '/v1/messages', { headers: { 'x-api-key': token } }),
    env,
    makeCtx(),
  );
  assert.equal(response.status, 429);
  assert.equal(spy.calls.length, 0);
  assert.equal(response.headers.get('x-army-grant-remaining'), '0');
  // The operator-supplied grant-increase note from the config is appended.
  const body = await response.json();
  assert.match(body.error.message, /Merged work earns an increase/u);
});

test('a revoked grant stops working immediately', async () => {
  const env = baseEnv();
  const { token } = await seedGrant(env, { revoked: true });
  const spy = upstreamOk();
  globalThis.fetch = spy;
  const response = await worker.fetch(
    req('POST', '/v1/messages', { headers: { 'x-api-key': token } }),
    env,
    makeCtx(),
  );
  assert.equal(response.status, 401);
  assert.equal(spy.calls.length, 0);
});

test('a restricted tier cannot reach a disallowed model', async () => {
  const env = baseEnv();
  const { token } = await seedGrant(env, { tier: 'probation' });
  const spy = upstreamOk();
  globalThis.fetch = spy;
  const response = await worker.fetch(
    req('POST', '/v1/messages', {
      headers: { 'x-api-key': token, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
    }),
    env,
    makeCtx(),
  );
  assert.equal(response.status, 403);
  assert.equal(spy.calls.length, 0);
});

test('a restricted tier can reach an allowed model', async () => {
  const env = baseEnv();
  const { token } = await seedGrant(env, { tier: 'probation' });
  const spy = upstreamOk();
  globalThis.fetch = spy;
  const response = await worker.fetch(
    req('POST', '/v1/messages', {
      headers: { 'x-api-key': token, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-fable-5', messages: [] }),
    }),
    env,
    makeCtx(),
  );
  assert.equal(response.status, 200);
  assert.equal(spy.calls.length, 1);
});

test('the kill switch stops all inference without touching DNS', async () => {
  const env = baseEnv({ KILL_SWITCH: 'on' });
  const { token } = await seedGrant(env);
  const spy = upstreamOk();
  globalThis.fetch = spy;
  const response = await worker.fetch(
    req('POST', '/v1/messages', { headers: { 'x-api-key': token } }),
    env,
    makeCtx(),
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '900');
  assert.equal(spy.calls.length, 0);
});

test('a missing pool key binding fails closed instead of proxying anonymously', async () => {
  const env = baseEnv({ POOL_EDGE_KEY: '' });
  const { token } = await seedGrant(env);
  const spy = upstreamOk();
  globalThis.fetch = spy;
  const response = await worker.fetch(
    req('POST', '/v1/messages', { headers: { 'x-api-key': token } }),
    env,
    makeCtx(),
  );
  assert.equal(response.status, 500);
  assert.equal(spy.calls.length, 0);
});

test('upstream transport failure surfaces as 502, never as a healthy empty answer', async () => {
  const env = baseEnv();
  const { token } = await seedGrant(env);
  globalThis.fetch = async () => {
    throw new Error('connection refused');
  };
  const response = await worker.fetch(
    req('POST', '/v1/messages', { headers: { 'x-api-key': token } }),
    env,
    makeCtx(),
  );
  assert.equal(response.status, 502);
});

test('streaming usage is extracted from SSE frames', () => {
  const stream = sse([
    { type: 'message_start', message: { usage: { input_tokens: 2000, output_tokens: 1 } } },
    { type: 'content_block_delta' },
    { type: 'message_delta', usage: { output_tokens: 300 } },
  ]);
  assert.equal(
    extractWeightedUsage(stream, 'text/event-stream'),
    2000 * 1 + 1 * 5 + 300 * 5,
  );
});

test('malformed accounting payloads weigh zero rather than throwing', () => {
  assert.equal(extractWeightedUsage('not json', 'application/json'), 0);
  assert.equal(extractWeightedUsage('data: {bad\n\n', 'text/event-stream'), 0);
  assert.equal(extractWeightedUsage('', 'application/json'), 0);
});

test('health is edge-local and needs no upstream to answer', async () => {
  const env = baseEnv();
  const spy = fakeFetch({
    '/meter/pricing': () => new Response('{}', { status: 200 }),
  });
  globalThis.fetch = spy;
  const health = await worker.fetch(req('GET', '/health'), env, makeCtx());
  assert.equal(health.status, 200);
  // The service name comes from the config, not a hardcoded string.
  assert.equal((await health.json()).service, 'example-pool-edge');
});

test('a passthrough never carries the pool key, so it can never be free inference', async () => {
  const env = baseEnv();
  const spy = upstreamOk('<html>pool</html>');
  globalThis.fetch = spy;

  await worker.fetch(req('GET', '/status'), env, makeCtx());

  assert.equal(spy.calls.length, 1);
  // This is the invariant that makes the passthrough table safe to extend:
  // a path collision with an inference leg produces an anonymous request that
  // upstream rejects, never a credentialed one it would serve.
  assert.equal(spy.calls[0].headers.get('x-api-key'), null);
});
