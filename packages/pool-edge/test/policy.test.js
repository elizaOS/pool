import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bodyTooLarge,
  corsHeaders,
  downstreamHeaders,
  isForbidden,
  isPublicPath,
  normalizePath,
  passthroughHeaders,
  passthroughQuery,
  passthroughResponseHeaders,
  resolveRoute,
  upstreamHeaders,
} from '../src/lib/policy.js';
import { EDGE_HOST, SITE_ORIGIN } from './harness.js';

test('admin and operator surfaces are forbidden at the edge', () => {
  for (const path of [
    '/admin',
    '/admin/invite',
    '/ledger',
    '/ledger.json',
    '/meter',
    '/meter/stats',
    '/meter/traces/stats',
    '/meter/ledger',
    '/meter/me',
    '/meter/pricing',
    '/byo',
    '/byo/credentials',
  ]) {
    assert.equal(isForbidden(path), true, `${path} must be forbidden`);
  }
});

test('the adopted public pages are NOT forbidden', () => {
  for (const path of ['/join', '/join/revoke', '/status', '/status.json', '/docs']) {
    assert.equal(isForbidden(path), false, `${path} must be reachable`);
  }
});

test('a contributor still cannot name a /meter path, even the ones the edge uses', () => {
  // The edge reads /meter/me and /meter/pricing upstream, but only by mapping
  // an allowlisted public path onto them. Naming them directly is sealed.
  assert.equal(resolveRoute('GET', '/meter/me'), null);
  assert.equal(resolveRoute('GET', '/meter/pricing'), null);
  assert.equal(resolveRoute('GET', '/me').upstream, '/meter/me');
});

test('forbidden check survives path normalization tricks', () => {
  assert.equal(isForbidden('//admin//invite'), true);
  assert.equal(isForbidden('/admin/'), true);
  assert.equal(normalizePath('//v1//messages/'), '/v1/messages');
});

test('ledger.json is forbidden but a lookalike prefix is not silently blocked', () => {
  assert.equal(isForbidden('/ledgerboard'), false);
  assert.equal(isForbidden('/ledger.json'), true);
});

test('only the allowlisted routes resolve', () => {
  assert.ok(resolveRoute('POST', '/v1/messages'));
  assert.ok(resolveRoute('POST', '/v1/chat/completions'));
  assert.ok(resolveRoute('GET', '/keys/status'));
  assert.ok(resolveRoute('GET', '/join'));
  assert.ok(resolveRoute('POST', '/join/start'));
  assert.equal(resolveRoute('GET', '/v1/messages'), null, 'method is part of the key');
  assert.equal(resolveRoute('POST', '/admin/invite'), null);
  assert.equal(resolveRoute('GET', '/meter/stats'), null);
  assert.equal(resolveRoute('GET', '/anything-else'), null);
  assert.equal(resolveRoute('DELETE', '/join'), null, 'passthrough is method-exact too');
  assert.equal(resolveRoute('GET', '/join/anything-new'), null, 'not a prefix rule');
});

test('no self-serve issuance routes exist in the table', () => {
  assert.equal(resolveRoute('GET', '/keys/new'), null);
  assert.equal(resolveRoute('GET', '/keys/callback'), null);
});

test('upstream headers carry the pool key and drop caller credentials', () => {
  const request = new Request(`${EDGE_HOST}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      authorization: 'Bearer army_caller_token',
      cookie: 'session=abc',
      'x-api-key': 'army_caller_token',
      'x-forwarded-host': 'evil.example',
    },
  });
  const headers = upstreamHeaders(request, 'POOL-KEY', { requestId: 'rid-1' });
  assert.equal(headers.get('x-api-key'), 'POOL-KEY');
  assert.equal(headers.get('authorization'), null);
  assert.equal(headers.get('cookie'), null);
  assert.equal(headers.get('x-forwarded-host'), null);
  assert.equal(headers.get('anthropic-version'), '2023-06-01');
});

test('response headers strip upstream identity', () => {
  const upstream = new Response('{}', {
    headers: {
      'anthropic-organization-id': 'org_secret',
      'set-cookie': 'a=b',
      'request-id': 'req_abc',
      'content-type': 'application/json',
    },
  });
  const headers = downstreamHeaders(upstream, { 'x-army-grant-remaining': '5' });
  assert.equal(headers.get('anthropic-organization-id'), null);
  assert.equal(headers.get('set-cookie'), null);
  assert.equal(headers.get('request-id'), null);
  assert.equal(headers.get('x-army-grant-remaining'), '5');
  assert.equal(headers.get('content-type'), 'application/json');
});

test('passthrough headers carry the flow but never a credential', () => {
  const request = new Request(`${EDGE_HOST}/join?i=abc`, {
    headers: {
      'content-type': 'application/json',
      cookie: 'sess=1',
      'last-event-id': '7',
      'x-api-key': 'somepoolkey',
      authorization: 'Bearer somepoolkey',
      'accept-encoding': 'gzip',
    },
  });
  const headers = passthroughHeaders(request);

  assert.equal(headers.get('x-api-key'), null, 'no credential crosses the edge');
  assert.equal(headers.get('authorization'), null);
  // The join flow may be stateless today, but eating session headers would be
  // a trap for whoever changes the upstream next.
  assert.equal(headers.get('cookie'), 'sess=1');
  assert.equal(headers.get('last-event-id'), '7');
  // Letting the origin compress hands back a body whose content-encoding no
  // longer matches what the platform does to it.
  assert.equal(headers.get('accept-encoding'), null);
});

test('the key query param is stripped and nothing else is', () => {
  assert.equal(passthroughQuery('?i=abc&fresh=1'), '?i=abc&fresh=1');
  assert.equal(passthroughQuery('?i=abc&key=secret'), '?i=abc');
  assert.equal(passthroughQuery('?key=secret'), '');
  assert.equal(passthroughQuery(''), '');
});

test('passthrough responses drop transport shape but keep session cookies', () => {
  const upstream = new Response('<html>', {
    headers: {
      'content-type': 'text/html',
      'content-length': '9999',
      'content-encoding': 'gzip',
      server: 'nginx',
      'set-cookie': 'sess=1; HttpOnly',
    },
  });
  const headers = passthroughResponseHeaders(upstream);

  assert.equal(headers.get('content-length'), null, 'the body is re-framed by the runtime');
  assert.equal(headers.get('content-encoding'), null);
  assert.equal(headers.get('server'), null);
  // Unlike the inference path: these are first-party pages on a first-party
  // host, and stripping a session cookie the flow needs is an invisible break.
  assert.equal(headers.get('set-cookie'), 'sess=1; HttpOnly');
});

test('isPublicPath knows what this edge actually serves', () => {
  assert.equal(isPublicPath('/status'), true);
  assert.equal(isPublicPath('/join'), true);
  assert.equal(isPublicPath('/ledger'), false);
  assert.equal(isPublicPath('/admin'), false);
  assert.equal(isPublicPath('/nonsense'), false);
});

test('cors is limited to the configured first-party origins', () => {
  assert.equal(corsHeaders(SITE_ORIGIN)['access-control-allow-origin'], SITE_ORIGIN);
  assert.equal(corsHeaders(EDGE_HOST)['access-control-allow-origin'], EDGE_HOST);
  assert.deepEqual(corsHeaders('https://evil.example'), {});
  assert.deepEqual(corsHeaders(null), {});
});

test('oversized bodies are rejected before upstream is contacted', () => {
  const big = new Request(`${EDGE_HOST}/v1/messages`, {
    method: 'POST',
    headers: { 'content-length': String(64 * 1024 * 1024) },
  });
  assert.equal(bodyTooLarge(big), true);
  const ok = new Request(`${EDGE_HOST}/v1/messages`, {
    method: 'POST',
    headers: { 'content-length': '2048' },
  });
  assert.equal(bodyTooLarge(ok), false);
});
