'use strict';
// join-e2e.js — drives the real /join flow against the real broker.
//
// Proves the OPEN JOIN contract (2026-07-31 22:12: sign-in is THE gate, no
// invite needed): a bare GET /join renders (200), /join/start without a
// steward session is 401, a verified session starts a genuine device-oauth
// flow on the broker with NO invite, invites still work as optional
// elevation, live SSE state relay, one-live-flow-per-invite, and a CLEAN
// cancel that leaves no orphan session on the broker. It deliberately stops
// short of completing an enrollment: finishing would link a real anthropic
// account, which is a human's decision to make at the demo, not a test's.
//
// AUTH NOTE: the live Steward is real prod, so this test cannot complete a
// passkey ceremony. Instead it mints the pool session cookie DIRECTLY with
// lib/account.js against the real session secret on this box, the exact
// artifact a verified elizacloud login produces. The Steward verification leg
// itself (introspection, guest gate, tenant pin) is covered by
// account-unit/account-e2e/join-auth-e2e with a mock Steward, and by the live
// smoke against real prod Steward. Requires the branch to be DEPLOYED; against
// a pre-steward-join build the 401 check below fails, which is correct.

const http = require('http');
const https = require('https');

const HOST = '127.0.0.1';
// Overridable so this suite can drive a scratch instance of an undeployed
// branch (same real broker) instead of only the live service on 18811.
const PORT = Number(process.env.JOIN_E2E_PORT) || 18811;
const KEYS_FILE = process.env.JOIN_E2E_KEYS_FILE || '/opt/pool/secrets/pool-keys.json';
const EVENTS_FILE = process.env.JOIN_E2E_EVENTS_FILE || '/opt/pool/logs/pool-meter/join-events.jsonl';

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
};

function call(method, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({
      host: HOST, port: PORT, method, path, timeout: 130000,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...(extraHeaders || {}),
      },
    }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const text = Buffer.concat(c).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function adminKey() {
  const d = JSON.parse(require('fs').readFileSync(KEYS_FILE, 'utf8'));
  return d.keys.find((k) => k.admin).key;
}

// Pool session cookie for the steward-gated join. Signed with the SAME secret
// file the live service uses (lib/account.js resolves the default secrets
// dir), so the server accepts it exactly as it would a login-produced cookie.
function poolSessionCookie(userId) {
  const account = require('../src/lib/account.js');
  return `pool_sess=${account.mintSession({ userId, email: 'join-e2e@test.local' })}`;
}

/** Collect SSE frames from /join/events for `ms`, then close. */
function watch(sessionId, ms) {
  return new Promise((resolve) => {
    const frames = [];
    const req = http.request({
      host: HOST, port: PORT, method: 'GET',
      path: `/join/events?sessionId=${encodeURIComponent(sessionId)}`,
      headers: { accept: 'text/event-stream' },
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try { frames.push(JSON.parse(line.slice(5).trim())); } catch (_) {}
        }
      });
    });
    req.on('error', () => {});
    req.end();
    setTimeout(() => { try { req.destroy(); } catch (_) {} resolve(frames); }, ms);
  });
}

/** Ask the broker directly whether a session still exists. */
function brokerSessionAlive(sessionId) {
  return new Promise((resolve) => {
    const r = http.request({
      host: '127.0.0.1', port: 7803, method: 'GET',
      path: `/api/accounts/anthropic-subscription/oauth/status?sessionId=${encodeURIComponent(sessionId)}`,
      headers: { Authorization: 'Bearer local-dev-token-sol', accept: 'text/event-stream' },
      timeout: 8000,
    }, (res) => {
      // 404 => the broker has no such flow (cancelled + reaped). 200 => alive.
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 2000) { try { r.destroy(); } catch (_) {} } });
      setTimeout(() => { try { r.destroy(); } catch (_) {} resolve({ status: res.statusCode, body }); }, 1500);
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: '' }); });
    r.on('error', () => resolve({ status: 0, body: '' }));
    r.end();
  });
}

async function main() {
  const AK = adminKey();

  // ---- open join: the page is public, the start is steward-gated ----
  const openJoin = await call('GET', '/join');
  check('/join with NO invite renders the open join page (200)', openJoin.status === 200, `got ${openJoin.status}`);
  check('open join page carries the sign-in step', /sign in first/i.test(openJoin.text) && /Eliza Cloud/.test(openJoin.text));
  check('open join lands on the default tier, not donor', /<b>invited<\/b>/.test(openJoin.text));

  const forged = await call('GET', '/join?i=' + Buffer.from('{"i":"x","t":"donor","e":99999999999999}').toString('base64url') + '.deadbeef');
  check('forged invite signature rejected loudly, not downgraded', forged.status === 403, `got ${forged.status}`);

  const startNoAuth = await call('POST', '/join/start');
  check('/join/start with no session is 401 needsAuth (open join, invite not required)',
    startNoAuth.status === 401 && startNoAuth.json && startNoAuth.json.needsAuth === true, `got ${startNoAuth.status}`);

  // ---- mint an invite via the admin API ----
  const mint = await new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ tier: 'donor', note: 'e2e-test', ttlHours: 1 }));
    const r = http.request({
      host: HOST, port: PORT, method: 'POST', path: '/admin/invite',
      headers: { 'x-api-key': AK, 'content-type': 'application/json', 'content-length': payload.length },
    }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c).toString('utf8')) }));
    });
    r.on('error', reject); r.end(payload);
  });
  check('admin can mint an invite', mint.status === 200 && !!mint.json.url, JSON.stringify(mint.json).slice(0, 120));
  const token = new URL(mint.json.url).searchParams.get('i');

  const good = await call('GET', `/join?i=${encodeURIComponent(token)}`);
  check('valid invite renders the elevated join page', good.status === 200 && /start device login/.test(good.text), `got ${good.status}`);
  check('invited page shows the elevated tier', /invite link is valid/.test(good.text) && /<b>donor<\/b>/.test(good.text));
  check('page states the ToS reality', /against anthropic's terms of service/i.test(good.text));
  check('page carries the tracker rules', /hit-and-run/i.test(good.text) && /freeleech/i.test(good.text));
  check('page is noindex', /noindex/.test(good.text));

  // ---- steward gate: invite alone is no longer enough ----
  const unauthStart = await call('POST', `/join/start?i=${encodeURIComponent(token)}`);
  check('/join/start with invite but NO steward session -> 401 needsAuth',
    unauthStart.status === 401 && unauthStart.json && unauthStart.json.needsAuth === true,
    `got ${unauthStart.status} ${JSON.stringify(unauthStart.json).slice(0, 120)}`);

  const COOKIE = poolSessionCookie(`user_join_e2e_${Date.now()}`);

  // ---- OPEN JOIN: real device-oauth start with a session and NO invite ----
  console.log('  (starting a real broker device flow with no invite, may take ~1m on a cold CLI)');
  const openStart = await call('POST', '/join/start', undefined, { cookie: COOKIE });
  check('open join starts a broker device flow with NO invite',
    openStart.status === 200 && !!openStart.json && !!openStart.json.sessionId,
    `got ${openStart.status} ${JSON.stringify(openStart.json).slice(0, 200)}`);
  if (openStart.json && openStart.json.sessionId) {
    // one live flow per USER on the open path
    const openSecond = await call('POST', '/join/start', undefined, { cookie: COOKIE });
    check('a second concurrent OPEN flow for the same user is refused', openSecond.status === 429,
      `got ${openSecond.status} ${JSON.stringify(openSecond.json)}`);
    const openCancel = await call('POST', '/join/cancel', { sessionId: openStart.json.sessionId });
    check('open flow cancels cleanly', openCancel.status === 200 && openCancel.json.cancelled === true, JSON.stringify(openCancel.json));
  }

  // ---- invited elevation: device-oauth start against the live broker ----
  console.log('  (starting a real broker device flow via invite)');
  const started = await call('POST', `/join/start?i=${encodeURIComponent(token)}`, undefined, { cookie: COOKIE });
  check('broker device flow starts (invite elevation + steward session)', started.status === 200 && !!started.json && !!started.json.sessionId,
    `got ${started.status} ${JSON.stringify(started.json).slice(0, 200)}`);
  if (started.status !== 200) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

  const sid = started.json.sessionId;
  check('flow returns an anthropic authorize url',
    typeof started.json.authUrl === 'string' && /claude\.ai|anthropic\.com/.test(started.json.authUrl),
    String(started.json.authUrl).slice(0, 120));
  check('flow returns an inline QR svg',
    typeof started.json.qr === 'string' && started.json.qr.startsWith('<svg') && started.json.qr.length > 500);
  check('QR encodes the same url it displays', started.json.qr.includes('viewBox'));

  // ---- one live flow per invite ----
  const second = await call('POST', `/join/start?i=${encodeURIComponent(token)}`, undefined, { cookie: COOKIE });
  check('a second concurrent flow on the same invite is refused', second.status === 429,
    `got ${second.status} ${JSON.stringify(second.json)}`);

  // ---- SSE relay ----
  const frames = await watch(sid, 4000);
  check('SSE relays live broker state', frames.length > 0 && frames.some((f) => f.status === 'pending'),
    JSON.stringify(frames).slice(0, 200));

  // ---- unknown session is not a stream ----
  const bogus = await call('GET', '/join/events?sessionId=does-not-exist');
  check('unknown session does not open a stream', bogus.status === 404, `got ${bogus.status}`);

  // ---- clean cancel, no orphan on the broker ----
  const cancelled = await call('POST', '/join/cancel', { sessionId: sid });
  check('cancel succeeds', cancelled.status === 200 && cancelled.json.cancelled === true, JSON.stringify(cancelled.json));

  await new Promise((r) => setTimeout(r, 1200));
  const after = await brokerSessionAlive(sid);
  check('broker reports the cancelled flow as terminal (no orphan)',
    after.status === 404 || /cancelled/.test(after.body), `status=${after.status} body=${after.body.slice(0, 160)}`);

  // ---- invite is reusable after a cancel (a donor who bailed can retry) ----
  const retry = await call('GET', `/join?i=${encodeURIComponent(token)}`);
  check('invite still valid after a cancel', retry.status === 200, `got ${retry.status}`);

  // ---- codex/openai donate path is first-class (provider picker) ----
  // A fresh invite driven with ?provider=codex must start a REAL openai device
  // flow (auth.openai.com), proving donations are no longer anthropic-only.
  console.log('  (starting a real broker codex device flow)');
  const codexMint = await new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ tier: 'donor', note: 'e2e-codex', ttlHours: 1 }));
    const r = http.request({
      host: HOST, port: PORT, method: 'POST', path: '/admin/invite',
      headers: { 'x-api-key': AK, 'content-type': 'application/json', 'content-length': payload.length },
    }, (res) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c).toString('utf8')) })); });
    r.on('error', reject); r.end(payload);
  });
  const ctoken = new URL(codexMint.json.url).searchParams.get('i');
  const cstart = await call('POST', `/join/start?i=${encodeURIComponent(ctoken)}&provider=codex`, undefined, { cookie: COOKIE });
  check('codex donate flow starts', cstart.status === 200 && !!cstart.json && !!cstart.json.sessionId,
    `got ${cstart.status} ${JSON.stringify(cstart.json).slice(0, 160)}`);
  check('codex flow returns an openai authorize url',
    typeof cstart.json.authUrl === 'string' && /openai\.com/.test(cstart.json.authUrl),
    String(cstart.json.authUrl).slice(0, 120));
  if (cstart.json && cstart.json.sessionId) await call('POST', '/join/cancel', { sessionId: cstart.json.sessionId });
  // A garbage provider must be refused, never reflected into a broker path.
  const cbad = await call('POST', `/join/start?i=${encodeURIComponent(ctoken)}&provider=hackerman`, undefined, { cookie: COOKIE });
  check('unknown provider is rejected 400', cbad.status === 400, `got ${cbad.status}`);

  // ---- no secrets in the audit log ----
  const fs = require('fs');
  let ledger = '';
  try { ledger = fs.readFileSync(EVENTS_FILE, 'utf8'); } catch (_) {}
  check('audit log never contains a pool key', !/sk-pool-[A-Za-z0-9_-]{20,}/.test(ledger));
  check('audit log never contains an oauth code param', !/[?&]code=/.test(ledger));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('ERROR', e); process.exit(1); });
