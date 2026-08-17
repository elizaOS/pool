'use strict';
// join-auth-e2e.js — the steward-gated OPEN JOIN flow (directive 2026-07-31
// 22:12: "/join should have sign in and we shouldnt need unique link
// anymore"), end to end against the REAL src/pool-meter.js on a scratch port
// with fully isolated state, a MOCK Steward (elizacloud tenant, real
// /auth/session shape) and a MOCK broker (real oauth start/SSE shape). No
// prod files, no live service, no real broker.
//
// What it proves:
//   - GET /join with NO invite renders the sign-in + join flow (200, open)
//   - /join/start with NO steward session -> 401 needsAuth, nothing reaches
//     the broker (invite or not)
//   - verified elizacloud session alone starts the flow, broker succeeds,
//     key is minted BORN-OWNED at the DEFAULT tier (not donor)
//   - re-join by the same user -> 409 alreadyJoined with their existing
//     label, no duplicate key, broker untouched
//   - a valid invite is an OPTIONAL elevation path: same user + donor invite
//     mints a second key at the invite's tier; the invite stays single-use
//   - forged/used invites are refused loudly (403), never silently downgraded
//   - guest and wrong-tenant Steward tokens can never produce the pool
//     session cookie the join gate requires (end-to-end, not just unit)
//   - a cross-site Origin on /join/start is refused even with a valid cookie
//   - the per-user rate limit fires
//   - everything lands in the join-events audit log, without secrets

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-join-auth-e2e-'));
const PORT = 18897;         // pool-meter under test
const STEWARD_PORT = 18896; // mock steward
const BROKER_PORT = 18895;  // mock broker
const HOST = '127.0.0.1';

// ---- fixture keys file -----------------------------------------------------
const ADMIN_KEY = `sk-pool-${crypto.randomBytes(24).toString('base64url')}`;
const KEYS_FILE = path.join(TMP, 'pool-keys.json');
fs.writeFileSync(KEYS_FILE, JSON.stringify({
  keys: [{ key: ADMIN_KEY, label: 'e2e-admin', enabled: true, admin: true }],
}, null, 2), { mode: 0o600 });

// ---- mock steward (same contract as account-e2e) ---------------------------
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sessionJwt = (payload) => `${b64u({ alg: 'HS256' })}.${b64u(payload)}.${b64u('sig')}`;
const nowSec = Math.floor(Date.now() / 1000);
const ALICE_TOKEN = sessionJwt({ userId: 'user_alice', tenantId: 'elizacloud', authMethod: 'passkey', exp: nowSec + 900 });
const CAROL_TOKEN = sessionJwt({ userId: 'user_carol', tenantId: 'elizacloud', authMethod: 'passkey', exp: nowSec + 900 });
const GUEST_TOKEN = sessionJwt({ userId: 'user_guest', tenantId: 'elizacloud', guest: true, authMethod: 'guest', exp: nowSec + 900 });
const WRONG_TENANT_TOKEN = sessionJwt({ userId: 'user_stray', tenantId: 'waifu', authMethod: 'passkey', exp: nowSec + 900 });
const SESSIONS = {
  [ALICE_TOKEN]: { authenticated: true, userId: 'user_alice', tenantId: 'elizacloud', email: 'alice@example.com' },
  [CAROL_TOKEN]: { authenticated: true, userId: 'user_carol', tenantId: 'elizacloud', email: 'carol@example.com' },
  [GUEST_TOKEN]: { authenticated: true, userId: 'user_guest', tenantId: 'elizacloud' },
  [WRONG_TENANT_TOKEN]: { authenticated: true, userId: 'user_stray', tenantId: 'waifu', email: 'stray@example.com' },
};
const steward = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.url === '/.well-known/jwks.json') return send(200, { keys: [] });
  if (req.url === '/auth/session') {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    return send(200, (m && SESSIONS[m[1]]) || { authenticated: false });
  }
  send(404, { ok: false });
});

// ---- mock broker (real oauth start + SSE status shape) ---------------------
let brokerStarts = 0;
const brokerFlows = new Map(); // sessionId -> { accountId }
const broker = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const u = new URL(req.url, `http://${HOST}:${BROKER_PORT}`);
  if (req.method === 'GET' && u.pathname === '/api/accounts') {
    return send(200, { providers: [{ providerId: 'anthropic-subscription', accounts: [] }] });
  }
  if (req.method === 'POST' && u.pathname === '/api/accounts/anthropic-subscription/oauth/start') {
    brokerStarts++;
    const sessionId = `mock-flow-${crypto.randomBytes(6).toString('hex')}`;
    brokerFlows.set(sessionId, { accountId: `acct-${crypto.randomBytes(6).toString('hex')}` });
    return send(200, { sessionId, authUrl: 'https://claude.ai/oauth/authorize?mock=1', needsCodeSubmission: true });
  }
  if (req.method === 'GET' && u.pathname === '/api/accounts/anthropic-subscription/oauth/status') {
    const flow = brokerFlows.get(u.searchParams.get('sessionId'));
    if (!flow) return send(404, { error: 'unknown session' });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ status: 'pending' })}\n\n`);
    setTimeout(() => {
      res.write(`data: ${JSON.stringify({ status: 'success', account: { id: flow.accountId } })}\n\n`);
      // The real broker closes the stream on terminal state, but not in the
      // same tick as the frame; pool-meter's mint runs async (utilization
      // lookup) between relaying success and writing the key payload. Hold
      // the stream open briefly so the mock does not race the mint in a way
      // the real broker does not.
      setTimeout(() => res.end(), 1500);
    }, 150);
    return;
  }
  if (req.method === 'POST' && u.pathname === '/api/accounts/anthropic-subscription/oauth/cancel') {
    return send(200, { cancelled: true });
  }
  send(404, { error: 'not found' });
});

// ---- http helper -----------------------------------------------------------
function call(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({
      host: HOST, port: PORT, method, path: p, timeout: 15000,
      headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}), ...headers },
    }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const text = Buffer.concat(c).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** Collect SSE frames from /join/events until the stream ends or `ms` passes. */
function watchEvents(sessionId, headers, ms) {
  return new Promise((resolve) => {
    const frames = [];
    const req = http.request({
      host: HOST, port: PORT, method: 'GET',
      path: `/join/events?sessionId=${encodeURIComponent(sessionId)}`,
      headers: { accept: 'text/event-stream', ...headers },
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try { frames.push(JSON.parse(line.slice(5).trim())); } catch (_) {}
        }
      });
      res.on('end', () => resolve(frames));
    });
    req.on('error', () => resolve(frames));
    req.end();
    setTimeout(() => { try { req.destroy(); } catch (_) {} resolve(frames); }, ms);
  });
}

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
};

function waitForServer(retries = 50) {
  return call('GET', '/account').catch(() => {
    if (retries <= 0) throw new Error('server never came up');
    return new Promise((r) => setTimeout(r, 200)).then(() => waitForServer(retries - 1));
  });
}

async function mintInvite() {
  const r = await call('POST', '/admin/invite', {
    body: { tier: 'donor', note: 'join-auth-e2e', ttlHours: 1 },
    headers: { 'x-api-key': ADMIN_KEY },
  });
  if (r.status !== 200 || !r.json || !r.json.url) throw new Error(`invite mint failed: ${r.status} ${r.text.slice(0, 200)}`);
  return new URL(r.json.url).searchParams.get('i');
}

async function main() {
  await new Promise((r) => steward.listen(STEWARD_PORT, HOST, r));
  await new Promise((r) => broker.listen(BROKER_PORT, HOST, r));

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'pool-meter.js')], {
    env: {
      ...process.env,
      POOL_METER_PORT: String(PORT),
      POOL_METER_HOST: HOST,
      POOL_METER_SECRETS_DIR: TMP,
      POOL_METER_KEYS_FILE: KEYS_FILE,
      POOL_METER_LOG_DIR: path.join(TMP, 'logs'),
      POOL_METER_CONFIG: path.join(TMP, 'no-config.json'),
      POOL_METER_TRACES_DIR: path.join(TMP, 'traces'),
      POOL_METER_STEWARD_BASE: `http://${HOST}:${STEWARD_PORT}`,
      POOL_METER_STEWARD_TENANT: 'elizacloud',
      POOL_METER_BROKER_PORT: String(BROKER_PORT),
      POOL_METER_BROKER_TOKEN: 'mock-broker-token',
      POOL_METER_UPSTREAM_PORT: '1',
      // Every request in this suite shares 127.0.0.1, so the IP ceiling must
      // not fire before the per-user checks it would mask. The user limit is
      // pinned low so the rate-limit check can trip it deterministically.
      POOL_METER_MAX_STARTS_PER_IP: '100',
      POOL_METER_MAX_STARTS_PER_USER: '3',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));

  try {
    await waitForServer();

    // ---- 1. open /join page: no invite required -----------------------------
    const openPage = await call('GET', '/join');
    check('GET /join with NO invite renders the join page (200)', openPage.status === 200, `got ${openPage.status}`);
    check('open join page carries the steward sign-in step', /sign in first/i.test(openPage.text) && /Eliza Cloud/.test(openPage.text));
    check('start button is gated until sign-in', /id="go" disabled/.test(openPage.text));
    check('open join page still states the ToS reality', /against anthropic's terms of service/i.test(openPage.text));
    check('open join lands on the default tier, not donor', /<b>invited<\/b>/.test(openPage.text), 'tier cell should read invited');

    // ---- 2. invite is still honored on the page (elevation) -----------------
    const invite1 = await mintInvite();
    const invPage = await call('GET', `/join?i=${encodeURIComponent(invite1)}`);
    check('valid invite still renders (elevation path)', invPage.status === 200, `got ${invPage.status}`);
    check('invited page shows the elevated tier', /invite link is valid/.test(invPage.text) && /<b>donor<\/b>/.test(invPage.text));
    const forged = await call('GET', '/join?i=' + Buffer.from('{"i":"x","t":"donor","e":99999999999999}').toString('base64url') + '.deadbeef');
    check('forged invite refused loudly (403), not silently downgraded', forged.status === 403, `got ${forged.status}`);

    // ---- 3. no steward session -> refused, broker untouched -----------------
    let startsBefore = brokerStarts;
    const noAuth = await call('POST', '/join/start');
    check('/join/start with no steward session -> 401 needsAuth',
      noAuth.status === 401 && noAuth.json && noAuth.json.needsAuth === true, `got ${noAuth.status} ${JSON.stringify(noAuth.json)}`);
    const noAuthInvite = await call('POST', `/join/start?i=${encodeURIComponent(invite1)}`);
    check('/join/start with invite but no steward session -> still 401',
      noAuthInvite.status === 401 && noAuthInvite.json && noAuthInvite.json.needsAuth === true, `got ${noAuthInvite.status}`);
    check('refused starts never reach the broker', brokerStarts === startsBefore, `broker starts ${startsBefore} -> ${brokerStarts}`);

    // ---- 4. guest / wrong-tenant identities can never reach the gate --------
    const guestLogin = await call('POST', '/account/session', { body: { accessToken: GUEST_TOKEN } });
    check('guest steward token -> no pool session, no cookie',
      guestLogin.status === 401 && !guestLogin.headers['set-cookie'], `got ${guestLogin.status}`);
    const strayLogin = await call('POST', '/account/session', { body: { accessToken: WRONG_TENANT_TOKEN } });
    check('wrong-tenant steward token -> no pool session, no cookie',
      strayLogin.status === 401 && !strayLogin.headers['set-cookie'], `got ${strayLogin.status}`);

    // ---- 5. sign in, cross-site origin still refused ------------------------
    const login = await call('POST', '/account/session', { body: { accessToken: ALICE_TOKEN } });
    check('elizacloud identity mints a pool session', login.status === 200 && login.json && login.json.ok, `got ${login.status}`);
    const cookie = ((login.headers['set-cookie'] || [])[0] || '').split(';')[0];
    check('session cookie present', /^pool_sess=./.test(cookie));
    const evil = await call('POST', '/join/start', {
      headers: { cookie, origin: 'https://evil.example.com' },
    });
    check('/join/start from a foreign origin -> 403 even signed in', evil.status === 403, `got ${evil.status}`);

    // ---- 6. OPEN JOIN: session alone starts the flow, key born-owned --------
    const started = await call('POST', '/join/start', {
      headers: { cookie, origin: `http://${HOST}:${PORT}` },
    });
    check('verified session starts the broker flow with NO invite',
      started.status === 200 && started.json && !!started.json.sessionId, `got ${started.status} ${JSON.stringify(started.json).slice(0, 160)}`);

    const frames = await watchEvents(started.json.sessionId, { cookie }, 8000);
    const success = frames.find((f) => f.status === 'success');
    check('open join flow completes and mints a key', !!success && /^sk-pool-/.test(success.poolKey || ''), JSON.stringify(frames).slice(0, 200));
    check('open join mints at the DEFAULT tier, not donor-privileged',
      !!success && success.tier === 'invited', success && success.tier);

    let keysNow = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')).keys;
    const minted = success ? keysNow.find((k) => k.key === success.poolKey) : null;
    check('minted key is BORN-OWNED by the verified identity (ownerUserId at issuance)',
      !!minted && minted.ownerUserId === 'user_alice', JSON.stringify(minted && { label: minted.label, ownerUserId: minted.ownerUserId }));
    check('minted key carries the broker account linkage, no invite',
      !!minted && !!minted.contributedAccountId && !minted.inviteId);

    // ---- 7. duplicate join -> existing state, no second key -----------------
    startsBefore = brokerStarts;
    const dup = await call('POST', '/join/start', { headers: { cookie } });
    check('re-join by the same user -> 409 alreadyJoined with their label',
      dup.status === 409 && dup.json && dup.json.alreadyJoined === true && minted && dup.json.label === minted.label,
      `got ${dup.status} ${JSON.stringify(dup.json)}`);
    check('duplicate join never reaches the broker', brokerStarts === startsBefore, `broker starts ${startsBefore} -> ${brokerStarts}`);
    keysNow = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')).keys;
    check('no duplicate key exists for the user',
      keysNow.filter((k) => k.ownerUserId === 'user_alice').length === 1);

    // ---- 8. invite as elevation: second key at the invite's tier ------------
    const elevated = await call('POST', `/join/start?i=${encodeURIComponent(invite1)}`, {
      headers: { cookie, origin: `http://${HOST}:${PORT}` },
    });
    check('a valid invite elevates past the one-key rule',
      elevated.status === 200 && elevated.json && !!elevated.json.sessionId, `got ${elevated.status} ${JSON.stringify(elevated.json).slice(0, 160)}`);
    const eframes = await watchEvents(elevated.json.sessionId, { cookie }, 8000);
    const esuccess = eframes.find((f) => f.status === 'success');
    check('invited flow mints at the INVITE tier (donor)', !!esuccess && esuccess.tier === 'donor', esuccess && esuccess.tier);
    keysNow = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')).keys;
    const emint = esuccess ? keysNow.find((k) => k.key === esuccess.poolKey) : null;
    check('invited key is also born-owned and records its invite',
      !!emint && emint.ownerUserId === 'user_alice' && !!emint.inviteId);

    // ---- 9. invite single-use holds -----------------------------------------
    const reuse = await call('POST', `/join/start?i=${encodeURIComponent(invite1)}`, { headers: { cookie } });
    check('used invite cannot start another flow', reuse.status === 403, `got ${reuse.status}`);

    // ---- 10. per-user rate limit fires --------------------------------------
    const carolLogin = await call('POST', '/account/session', { body: { accessToken: CAROL_TOKEN } });
    const carolCookie = ((carolLogin.headers['set-cookie'] || [])[0] || '').split(';')[0];
    let limited = null;
    for (let i = 0; i < 5; i++) {
      const r = await call('POST', '/join/start', { headers: { cookie: carolCookie } });
      if (r.status === 429 && /account/.test((r.json && r.json.error) || '')) { limited = r; break; }
      if (r.status === 200 && r.json && r.json.sessionId) {
        await call('POST', '/join/cancel', { body: { sessionId: r.json.sessionId } });
      }
    }
    check('per-user rate limit fires on repeated starts', !!limited, 'never hit 429');

    // ---- 11. owned keys appear on the account dashboard ---------------------
    const who = await call('POST', '/account/whoami', { headers: { cookie } });
    check('both born-owned keys show up in the owner dashboard',
      who.status === 200 && who.json.ok && (who.json.account.keys || []).length === 2,
      JSON.stringify(who.json && who.json.account && who.json.account.keys));

    // ---- 12. hygiene --------------------------------------------------------
    const logText = logs.join('');
    check('no raw keys or steward tokens in server logs',
      ![ADMIN_KEY, ALICE_TOKEN, CAROL_TOKEN, GUEST_TOKEN, success && success.poolKey, esuccess && esuccess.poolKey]
        .filter(Boolean).some((s) => logText.includes(s)));
    let ledger = '';
    try { ledger = fs.readFileSync(path.join(TMP, 'logs', 'join-events.jsonl'), 'utf8'); } catch (_) {}
    check('audit log records rejections + open joins without secrets',
      /no steward session/.test(ledger) && /already joined/.test(ledger)
        && /"open":true/.test(ledger) && !/sk-pool-[A-Za-z0-9_-]{20,}/.test(ledger));
  } finally {
    child.kill('SIGTERM');
    steward.close();
    broker.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
