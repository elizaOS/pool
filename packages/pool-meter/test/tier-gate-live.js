'use strict';
// tier-gate-live.js — proves the tier model gate + quota gate against the LIVE
// service, then removes the temporary key it created.
//
// The gate lives in the same auth path as the quota gate (pool-meter.js), so
// this is the only way to prove it end-to-end: a unit test can only prove
// modelAllowed(), not that the running server actually enforces it before
// proxying, and that streaming still works for a restricted key on an
// ALLOWED model (the gate buffers the body, so that path must be re-proven).

const http = require('http');
const store = require('../lib/store.js');

const KEYS = '/opt/pool/secrets/pool-keys.json';
const LABEL = 'zz-tiergate-tmp';
const KEY = 'sk-pool-tiergate-tmp-probe';

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}

function req(body, key = KEY) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port: 18811, method: 'POST', path: '/v1/messages',
      headers: { 'x-api-key': key, 'content-type': 'application/json', 'content-length': payload.length },
      timeout: 120000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    r.end(payload);
  });
}

function addKey(rec) {
  store.update(KEYS, () => ({ keys: [] }), (d) => ({
    ...d, keys: [...d.keys.filter((k) => k.label !== LABEL), rec],
  }), 0o600);
}
function removeKey() {
  store.update(KEYS, () => ({ keys: [] }), (d) => ({
    ...d, keys: d.keys.filter((k) => k.label !== LABEL),
  }), 0o600);
}

async function main() {
  // demo tier: cheap models only, small quota
  addKey({ key: KEY, label: LABEL, enabled: true, admin: false, tier: 'demo', quota: 2_000_000, source: 'test' });
  await new Promise((r) => setTimeout(r, 6000)); // hot-reload is 5s

  const denied = await req({ model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] });
  check('demo tier DENIES expensive model (403)', denied.status === 403, `got ${denied.status}`);
  check('denial names the tier and allowed models',
    /tier 'demo' cannot use claude-opus-5/.test(denied.text) && /claude-fable-5/.test(denied.text),
    denied.text.slice(0, 160));

  const allowed = await req({ model: 'claude-fable-5', max_tokens: 16, messages: [{ role: 'user', content: 'say ok' }] });
  check('demo tier ALLOWS cheap model (200)', allowed.status === 200, `got ${allowed.status}`);

  // The gate buffers the request body; replay must not break streaming.
  const streamed = await req({ model: 'claude-fable-5', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'count to three' }] });
  check('gated key can still stream on an allowed model',
    streamed.status === 200 && /event: message_stop/.test(streamed.text), `got ${streamed.status}`);

  // quota gate: drop quota below usage and confirm it fires
  addKey({ key: KEY, label: LABEL, enabled: true, admin: false, tier: 'demo', quota: 1, source: 'test' });
  await new Promise((r) => setTimeout(r, 6000));
  const over = await req({ model: 'claude-fable-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] });
  check('quota gate fires (429)', over.status === 429, `got ${over.status}`);
  // The user-facing copy is deliberately Shadow's joke text, not the word
  // "quota"; assert the machine-readable type instead of the prose, which is
  // what a client actually branches on.
  check('quota error is a typed rate_limit_error',
    /"type"\s*:\s*"rate_limit_error"/.test(over.text), over.text.slice(0, 160));

  // unrestricted tier is unaffected by the model gate
  addKey({ key: KEY, label: LABEL, enabled: true, admin: false, tier: 'invited', quota: 50_000_000, source: 'test' });
  await new Promise((r) => setTimeout(r, 6000));
  const inv = await req({ model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] });
  check('invited tier may use an expensive model', inv.status === 200, `got ${inv.status}`);

  removeKey();
  await new Promise((r) => setTimeout(r, 6000));
  const gone = await req({ model: 'claude-fable-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] });
  check('removed key is rejected (401)', gone.status === 401, `got ${gone.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { removeKey(); console.error('ERROR', e); process.exit(1); });
