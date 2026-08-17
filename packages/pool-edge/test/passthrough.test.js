/**
 * passthrough.test.js — the adopted upstream surfaces.
 *
 * The property that matters most here is negative: a passthrough must never
 * carry a credential in either direction. It cannot send the edge's pool key
 * upstream (which would make any path collision free inference), and it cannot
 * forward a caller's key (which would reach the keyed, de-anonymized /status
 * view through a hostname that is supposed to be anonymous).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/worker.js';
import { resetProbeCache } from '../src/lib/upstream.js';
import { baseEnv, fakeFetch, makeCtx, req } from './harness.js';

const realFetch = globalThis.fetch;

const JOIN_HTML =
  '<!doctype html><html><head><title>join the pool</title>' +
  '</head><body><h1>join the pool</h1><p>read the terms of service before donating a seat.</p>' +
  '<a href="/join/revoke">revoke</a><a href="/status">status</a></body></html>';

const STATUS_HTML = '<!doctype html><html><body><h1>account pool</h1><b>pool capacity</b></body></html>';

/** Upstream that echoes back what it received, so tests can assert on it. */
function upstreamSpy(handlers = {}) {
  return fakeFetch({
    'pool.example.com': (url, init) => {
      const path = new URL(url).pathname;
      if (handlers[path]) return handlers[path](url, init);
      return new Response(JOIN_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  });
}

test.beforeEach(() => {
  resetProbeCache();
});

test.afterEach(() => {
  globalThis.fetch = realFetch;
  resetProbeCache();
});

// ------------------------------------------------------------------- render

test('the join page renders through the edge hostname', async () => {
  const spy = upstreamSpy();
  globalThis.fetch = spy;
  const response = await worker.fetch(req('GET', '/join?i=invite-code'), baseEnv(), makeCtx());

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/u);
  const html = await response.text();
  assert.match(html, /join the pool/u);
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].url, 'https://pool.example.com/join?i=invite-code');
});

test('the invite code survives the hop, and so does an added query param', async () => {
  const spy = upstreamSpy();
  globalThis.fetch = spy;
  await worker.fetch(req('POST', '/join/start?i=abc123&provider=openai'), baseEnv(), makeCtx());

  const forwarded = new URL(spy.calls[0].url);
  assert.equal(forwarded.searchParams.get('i'), 'abc123');
  // Forwarded whole rather than allowlisted per-param, so the next flag the
  // upstream flow adds does not silently break here.
  assert.equal(forwarded.searchParams.get('provider'), 'openai');
});

test('the status page and its json twin both render', async () => {
  globalThis.fetch = upstreamSpy({
    '/status': () =>
      new Response(STATUS_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    '/status.json': () =>
      new Response(JSON.stringify({ pool: { accounts: 9 } }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
  });
  const env = baseEnv();

  const html = await worker.fetch(req('GET', '/status'), env, makeCtx());
  assert.equal(html.status, 200);
  assert.match(await html.text(), /account pool/iu);

  const json = await worker.fetch(req('GET', '/status.json'), env, makeCtx());
  assert.equal(json.status, 200);
  assert.equal((await json.json()).pool.accounts, 9);
});

test('the docs page is served through the edge', async () => {
  globalThis.fetch = upstreamSpy({
    '/docs': () =>
      new Response('# pool', { status: 200, headers: { 'content-type': 'text/markdown' } }),
  });
  const docs = await worker.fetch(req('GET', '/docs'), baseEnv(), makeCtx());
  assert.equal(docs.status, 200);
  assert.match(docs.headers.get('content-type'), /markdown/u);
});

test('the account session routes are exact passthroughs', async () => {
  const spy = upstreamSpy({
    '/account': () => new Response('<h1>sign in</h1>', { headers: { 'content-type': 'text/html' } }),
    '/account/session': () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
    '/account/whoami': () => new Response('{"ok":false}', { headers: { 'content-type': 'application/json' } }),
    '/account/logout': () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
  });
  globalThis.fetch = spy;
  const env = baseEnv();

  for (const [method, path] of [
    ['GET', '/account'],
    ['POST', '/account/session'],
    ['POST', '/account/whoami'],
    ['POST', '/account/logout'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    assert.notEqual((await worker.fetch(req(method, path), env, makeCtx())).status, 404, `${method} ${path}`);
  }
  assert.equal(spy.calls.length, 4);
});

test('legacy account claim and unreviewed account routes stay sealed', async () => {
  const spy = upstreamSpy();
  globalThis.fetch = spy;
  const env = baseEnv();

  for (const [method, path] of [
    ['GET', '/account/claim'],
    ['POST', '/account/claim'],
    ['GET', '/account/admin'],
    ['GET', '/account/session'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await worker.fetch(req(method, path), env, makeCtx())).status, 404, `${method} ${path}`);
  }
  assert.equal(spy.calls.length, 0);
});

// ------------------------------------------------------- credential hygiene

test('no pool key is ever attached to a passthrough', async () => {
  const spy = upstreamSpy();
  globalThis.fetch = spy;
  const env = baseEnv({ POOL_EDGE_KEY: 'sk-pool-SECRET-0001' });

  for (const path of ['/join?i=x', '/status', '/status.json', '/docs']) {
    // eslint-disable-next-line no-await-in-loop
    await worker.fetch(req('GET', path), env, makeCtx());
  }

  for (const call of spy.calls) {
    assert.equal(call.headers.get('x-api-key'), null, `${call.url} must be anonymous`);
    assert.equal(call.headers.get('authorization'), null);
  }
});

test('a caller cannot smuggle a key to the keyed status view', async () => {
  const spy = upstreamSpy({
    '/status': () => new Response(STATUS_HTML, { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  globalThis.fetch = spy;

  await worker.fetch(
    req('GET', '/status?key=somepoolkey', { headers: { 'x-api-key': 'anotherpoolkey' } }),
    baseEnv(),
    makeCtx(),
  );

  const forwarded = new URL(spy.calls[0].url);
  // Both channels the upstream accepts for the de-anonymized view are closed.
  assert.equal(forwarded.searchParams.get('key'), null, 'the ?key= credential is stripped');
  assert.equal(spy.calls[0].headers.get('x-api-key'), null, 'the header credential is stripped');
});

test('the query survives when only the key param is removed', async () => {
  const spy = upstreamSpy();
  globalThis.fetch = spy;
  await worker.fetch(req('GET', '/join?i=abc&key=secret&fresh=1'), baseEnv(), makeCtx());

  const forwarded = new URL(spy.calls[0].url);
  assert.equal(forwarded.searchParams.get('i'), 'abc');
  assert.equal(forwarded.searchParams.get('fresh'), '1');
  assert.equal(forwarded.searchParams.get('key'), null);
});

// ------------------------------------------------------------ error shapes

test('a bad invite errors gracefully instead of 500ing at the edge', async () => {
  globalThis.fetch = upstreamSpy({
    '/join/start': () =>
      new Response(JSON.stringify({ error: 'invite malformed' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
  });

  const response = await worker.fetch(req('POST', '/join/start?i=not-a-real-invite'), baseEnv(), makeCtx());

  // The upstream's own refusal reaches the caller unchanged. The edge neither
  // swallows it into a 200 nor rewrites it into a 500 of its own.
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'invite malformed');
});

test('an unreachable origin is a 502 shaped like what the caller asked for', async () => {
  globalThis.fetch = async () => {
    throw new Error('connection refused');
  };
  const env = baseEnv();

  const browser = await worker.fetch(
    req('GET', '/join?i=x', { headers: { accept: 'text/html' } }),
    env,
    makeCtx(),
  );
  assert.equal(browser.status, 502);
  assert.match(browser.headers.get('content-type'), /text\/html/u);

  const xhr = await worker.fetch(
    req('POST', '/join/start?i=x', { headers: { accept: 'application/json' } }),
    env,
    makeCtx(),
  );
  assert.equal(xhr.status, 502);
  assert.match(xhr.headers.get('content-type'), /application\/json/u);
  assert.ok((await xhr.json()).error);
});

// ------------------------------------------------------------- redirects

test('an upstream redirect is rewritten onto the edge hostname', async () => {
  globalThis.fetch = upstreamSpy({
    '/docs': () =>
      new Response(null, { status: 302, headers: { location: 'https://pool.example.com/status' } }),
  });

  const response = await worker.fetch(req('GET', '/docs'), baseEnv(), makeCtx());
  assert.equal(response.status, 302);
  // Relative, so the browser stays on the edge hostname rather than being
  // bounced to the origin hostname mid-flow.
  assert.equal(response.headers.get('location'), '/status');
});

test('a redirect to a sealed upstream path is not rewritten into an edge 404', async () => {
  globalThis.fetch = upstreamSpy({
    '/join': () =>
      new Response(null, { status: 302, headers: { location: 'https://pool.example.com/ledger' } }),
  });

  const response = await worker.fetch(req('GET', '/join?i=x'), baseEnv(), makeCtx());
  // /ledger is sealed here. Rewriting it to a relative path would send the
  // caller to our own 404; left absolute, it at least resolves where it means.
  assert.equal(response.headers.get('location'), 'https://pool.example.com/ledger');
});

// ------------------------------------------------------------ availability

test('the join and status pages stay up while the kill switch is on', async () => {
  globalThis.fetch = upstreamSpy({
    '/status': () => new Response(STATUS_HTML, { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  const env = baseEnv({ KILL_SWITCH: 'on' });

  // The switch pauses inference. A paused endpoint whose status page also goes
  // dark is indistinguishable from an outage to the person trying to find out
  // what happened, so these deliberately keep serving.
  assert.equal((await worker.fetch(req('GET', '/join?i=x'), env, makeCtx())).status, 200);
  assert.equal((await worker.fetch(req('GET', '/status'), env, makeCtx())).status, 200);
});

test('the SSE leg is marked no-buffer and is not read at the edge', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"status":"pending"}\n\n'));
      controller.close();
    },
  });
  globalThis.fetch = upstreamSpy({
    '/join/events': () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });

  const response = await worker.fetch(req('GET', '/join/events?sessionId=abc'), baseEnv(), makeCtx());
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /event-stream/u);
  // Buffering this would break the device-OAuth flow in a way no status code
  // reveals, so the anti-buffering headers are pinned.
  assert.match(response.headers.get('cache-control'), /no-transform/u);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  assert.match(await response.text(), /pending/u);
});

test('a stale upstream content-length cannot describe the re-framed body', async () => {
  globalThis.fetch = upstreamSpy({
    '/status': () =>
      new Response(STATUS_HTML, {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'content-length': '999999',
          'content-encoding': 'gzip',
          server: 'nginx/1.24.0',
        },
      }),
  });

  const response = await worker.fetch(req('GET', '/status'), baseEnv(), makeCtx());
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(response.headers.get('server'), null, 'origin software is not advertised');
});

// -------------------------------------------------------- method exactness

test('passthrough is method-exact, not a prefix rule', async () => {
  const spy = upstreamSpy();
  globalThis.fetch = spy;
  const env = baseEnv();

  // A prefix rule on /join would have swept in whatever the upstream adds under
  // it next, unreviewed. These are simply not in the table.
  for (const [method, path] of [
    ['DELETE', '/join'],
    ['GET', '/join/admin'],
    ['POST', '/status'],
    ['GET', '/join/events/all'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const response = await worker.fetch(req(method, path), env, makeCtx());
    assert.equal(response.status, 404, `${method} ${path} is not allowlisted`);
  }
  assert.equal(spy.calls.length, 0, 'nothing unallowlisted reached upstream');
});
