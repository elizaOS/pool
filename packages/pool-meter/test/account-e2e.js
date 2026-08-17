'use strict';
// account-e2e.js — boots the REAL src/pool-meter.js on a scratch port with
// fully isolated state (temp secrets/keys/logs) plus a MOCK Steward, and
// proves the /account family end-to-end:
//
//   - GET /account renders with zero secrets in the HTML
//   - forged/garbage Steward credentials can never mint a session (401)
//   - a valid credential mints an httpOnly SameSite=Lax cookie session
//   - tampered and missing cookies are refused
//   - one user can NEVER see another user's keys/labels (the leak test)
//   - claiming a key is possession-gated, once-only, origin-gated
//   - the EXISTING x-api-key surface (/meter/me) still works untouched
//   - /status.json still serves
//
// No prod files are read or written: every path is redirected via env before
// the child process starts, and the broker/upstream ports point at nothing
// (their failure paths are part of what "unaffected" means).

const assert = require('assert');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-account-e2e-'));
const PORT = 18899;         // pool-meter under test
const STEWARD_PORT = 18898; // mock steward
const HOST = '127.0.0.1';

// ---- fixture keys file (raw keys generated here, never real) ---------------
const ADMIN_KEY = `sk-pool-${crypto.randomBytes(24).toString('base64url')}`;
const LEGACY_KEY = `sk-pool-${crypto.randomBytes(24).toString('base64url')}`;
const ALICE_KEY = `sk-pool-${crypto.randomBytes(24).toString('base64url')}`;
const BOB_KEY = `sk-pool-${crypto.randomBytes(24).toString('base64url')}`;
fs.writeFileSync(path.join(TMP, 'pool-keys.json'), JSON.stringify({
  keys: [
    { key: ADMIN_KEY, label: 'e2e-admin', enabled: true, admin: true },
    { key: LEGACY_KEY, label: 'e2e-legacy', enabled: true, tier: 'donor', donor: true, quota: 250000000 },
    { key: ALICE_KEY, label: 'e2e-alice', enabled: true, tier: 'donor', donor: true, quota: 250000000, ownerUserId: 'user_alice' },
    { key: BOB_KEY, label: 'e2e-bob-secret-label', enabled: true, tier: 'donor', donor: true, quota: 250000000, ownerUserId: 'user_bob' },
  ],
}, null, 2), { mode: 0o600 });

// ---- mock steward ----------------------------------------------------------
// Access tokens are HS256-shaped session JWTs (payload matters: the guest
// gate decodes the Steward-verified token locally). The mock verifies by
// exact string match (prod verifies by signature) and answers on the REAL
// introspection endpoint GET /auth/session in its real shape. JWKS is EMPTY,
// mirroring live prod today, so the idToken path fails closed and
// introspection is what carries. Tenant is 'elizacloud': pool accounts ARE
// Eliza Cloud accounts (directive 2026-07-31).
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sessionJwt = (payload) => `${b64u({ alg: 'HS256' })}.${b64u(payload)}.${b64u('sig')}`;
const nowSec = Math.floor(Date.now() / 1000);
const ALICE_TOKEN = sessionJwt({ userId: 'user_alice', tenantId: 'elizacloud', authMethod: 'passkey', exp: nowSec + 900 });
const BOB_TOKEN = sessionJwt({ userId: 'user_bob', tenantId: 'elizacloud', authMethod: 'passkey', exp: nowSec + 900 });
const GUEST_TOKEN = sessionJwt({ userId: 'user_guest', tenantId: 'elizacloud', guest: true, authMethod: 'guest', exp: nowSec + 900 });
const WRONG_TENANT_TOKEN = sessionJwt({ userId: 'user_stray', tenantId: 'waifu', authMethod: 'passkey', exp: nowSec + 900 });
const SESSIONS = {
  [ALICE_TOKEN]: { authenticated: true, userId: 'user_alice', tenantId: 'elizacloud', email: 'alice@example.com', address: '0xa11ce' },
  [BOB_TOKEN]: { authenticated: true, userId: 'user_bob', tenantId: 'elizacloud', email: 'bob@example.com', address: '0xb0b' },
  [GUEST_TOKEN]: { authenticated: true, userId: 'user_guest', tenantId: 'elizacloud', address: '0x9e57' },
  [WRONG_TENANT_TOKEN]: { authenticated: true, userId: 'user_stray', tenantId: 'waifu', email: 'stray@example.com', address: '0x57ay' },
};
const steward = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.url === '/.well-known/jwks.json') return send(200, { keys: [] });
  if (req.url === '/auth/session') {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const s = m && SESSIONS[m[1]];
    return send(200, s || { authenticated: false });
  }
  send(404, { ok: false, error: 'not found' });
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

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
};

function waitForServer(retries = 50) {
  return call('GET', '/status.json').catch(() => {
    if (retries <= 0) throw new Error('server never came up');
    return new Promise((r) => setTimeout(r, 200)).then(() => waitForServer(retries - 1));
  });
}

async function main() {
  await new Promise((r) => steward.listen(STEWARD_PORT, HOST, r));

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'pool-meter.js')], {
    env: {
      ...process.env,
      POOL_METER_PORT: String(PORT),
      POOL_METER_HOST: HOST,
      POOL_METER_SECRETS_DIR: TMP,
      POOL_METER_KEYS_FILE: path.join(TMP, 'pool-keys.json'),
      POOL_METER_LOG_DIR: path.join(TMP, 'logs'),
      POOL_METER_CONFIG: path.join(TMP, 'no-config.json'),
      POOL_METER_TRACES_DIR: path.join(TMP, 'traces'),
      POOL_METER_STEWARD_BASE: `http://${HOST}:${STEWARD_PORT}`,
      POOL_METER_STEWARD_TENANT: 'elizacloud',
      POOL_METER_BROKER_PORT: '1', // nothing there; failure path must be graceful
      POOL_METER_UPSTREAM_PORT: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));

  try {
    await waitForServer();

    // ---- 1. the page ------------------------------------------------------
    const pageRes = await call('GET', '/account');
    check('GET /account renders', pageRes.status === 200 && /passkey/i.test(pageRes.text), `got ${pageRes.status}`);
    check('no key material in /account HTML', ![ADMIN_KEY, LEGACY_KEY, ALICE_KEY, BOB_KEY].some((k) => pageRes.text.includes(k)));
    check('no user labels baked into static HTML', !pageRes.text.includes('e2e-bob-secret-label'));

    // ---- 2. session establishment: hostile first --------------------------
    const noCred = await call('POST', '/account/session', { body: {} });
    check('session without credential -> 400', noCred.status === 400, `got ${noCred.status}`);

    const forged = await call('POST', '/account/session', { body: { accessToken: 'forged-nonsense-token' } });
    check('forged accessToken -> 401, no cookie', forged.status === 401 && !forged.headers['set-cookie'], `got ${forged.status}`);

    const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'x' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ userId: 'user_alice', tenantId: 'elizacloud', iss: `http://${HOST}:${STEWARD_PORT}`, exp: 9999999999 })).toString('base64url');
    const forgedJwt = await call('POST', '/account/session', { body: { idToken: `${h}.${p}.${'A'.repeat(64)}` } });
    check('forged idToken (empty JWKS, no fallback) -> 401', forgedJwt.status === 401, `got ${forgedJwt.status}`);

    // Eliza-cloud tenant binding: a pool session cookie is minted ONLY from a
    // verified eliza-cloud-tenant identity (the directive's required test).
    const guestTry = await call('POST', '/account/session', { body: { accessToken: GUEST_TOKEN } });
    check('guest session token (anonymous, mintable by anyone) -> 401, no cookie',
      guestTry.status === 401 && !guestTry.headers['set-cookie'], `got ${guestTry.status}`);
    const wrongTenantTry = await call('POST', '/account/session', { body: { accessToken: WRONG_TENANT_TOKEN } });
    check('valid Steward session from NON-elizacloud tenant -> 401, no cookie',
      wrongTenantTry.status === 401 && !wrongTenantTry.headers['set-cookie'], `got ${wrongTenantTry.status}`);

    // ---- 3. real session for alice ----------------------------------------
    const aliceLogin = await call('POST', '/account/session', { body: { accessToken: ALICE_TOKEN } });
    check('valid token -> 200 + account payload', aliceLogin.status === 200 && aliceLogin.json && aliceLogin.json.ok, JSON.stringify(aliceLogin.json).slice(0, 120));
    const setCookie = (aliceLogin.headers['set-cookie'] || [])[0] || '';
    check('cookie is HttpOnly + SameSite=Lax + Secure', /HttpOnly/.test(setCookie) && /SameSite=Lax/.test(setCookie) && /Secure/.test(setCookie), setCookie.replace(/pool_sess=[^;]+/, 'pool_sess=<redacted>'));
    const cookie = setCookie.split(';')[0];
    check('login response has only alice keys', aliceLogin.json.account.keys.length === 1 && aliceLogin.json.account.keys[0].label === 'e2e-alice', JSON.stringify(aliceLogin.json.account.keys.map((k) => k.label)));
    check('login response never contains raw keys', !aliceLogin.text.includes(ALICE_KEY) && !aliceLogin.text.includes(BOB_KEY));

    // ---- 4. whoami: cookie discipline -------------------------------------
    const who = await call('POST', '/account/whoami', { headers: { cookie } });
    check('whoami with valid cookie -> account', who.status === 200 && who.json.ok && who.json.account.userId === 'user_alice');

    const whoNone = await call('POST', '/account/whoami');
    check('whoami without cookie -> ok:false', whoNone.status === 200 && whoNone.json.ok === false);

    const [pb64, sig] = cookie.replace('pool_sess=', '').split('.');
    const claims = JSON.parse(Buffer.from(pb64, 'base64url').toString('utf8'));
    claims.u = 'user_bob';
    const tampered = `pool_sess=${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
    const whoTampered = await call('POST', '/account/whoami', { headers: { cookie: tampered } });
    check('tampered cookie (userId swap) refused', whoTampered.status === 200 && whoTampered.json.ok === false);

    const expClaims = JSON.parse(Buffer.from(pb64, 'base64url').toString('utf8'));
    expClaims.exp = Date.now() - 1000;
    const expiredTok = Buffer.from(JSON.stringify(expClaims)).toString('base64url');
    const whoExpired = await call('POST', '/account/whoami', { headers: { cookie: `pool_sess=${expiredTok}.${sig}` } });
    check('expired-and-resigned cookie refused (sig mismatch)', whoExpired.json.ok === false);

    // ---- 5. cross-user isolation ------------------------------------------
    const bobLogin = await call('POST', '/account/session', { body: { accessToken: BOB_TOKEN } });
    const bobCookie = (bobLogin.headers['set-cookie'] || [])[0].split(';')[0];
    const bobWho = await call('POST', '/account/whoami', { headers: { cookie: bobCookie } });
    check('bob sees only bob keys', bobWho.json.account.keys.length === 1 && bobWho.json.account.keys[0].label === 'e2e-bob-secret-label');
    check("alice's view has no bob labels", !JSON.stringify(who.json.account).includes('e2e-bob-secret-label'));
    check("bob's view has no alice labels", !JSON.stringify(bobWho.json.account).includes('e2e-alice'));

    // ---- 6. claim: origin gate, possession gate, no stealing --------------
    const evilClaim = await call('POST', '/account/claim', { headers: { cookie, origin: 'https://evil.example.com' }, body: { key: LEGACY_KEY } });
    check('claim from foreign origin -> 403', evilClaim.status === 403, `got ${evilClaim.status}`);

    const noSessClaim = await call('POST', '/account/claim', { body: { key: LEGACY_KEY } });
    check('claim without session -> 401', noSessClaim.status === 401, `got ${noSessClaim.status}`);

    const aliceClaim = await call('POST', '/account/claim', { headers: { cookie, origin: `http://${HOST}:${PORT}` }, body: { key: LEGACY_KEY } });
    check('alice claims legacy key by possession', aliceClaim.status === 200 && aliceClaim.json.ok && aliceClaim.json.label === 'e2e-legacy', JSON.stringify(aliceClaim.json));

    const bobSteal = await call('POST', '/account/claim', { headers: { cookie: bobCookie, origin: `http://${HOST}:${PORT}` }, body: { key: LEGACY_KEY } });
    check('bob cannot steal a claimed key', bobSteal.status === 400, `got ${bobSteal.status}`);

    const badKeyClaim = await call('POST', '/account/claim', { headers: { cookie, origin: `http://${HOST}:${PORT}` }, body: { key: 'sk-pool-idontexist12345' } });
    check('unknown key claim gives uniform error (no oracle)', badKeyClaim.status === 400 && badKeyClaim.json.error === 'that key cannot be claimed');

    const whoAfterClaim = await call('POST', '/account/whoami', { headers: { cookie } });
    check('claimed key now in alice dashboard', whoAfterClaim.json.account.keys.some((k) => k.label === 'e2e-legacy'));

    // ---- 7. existing surfaces untouched -----------------------------------
    const meterMe = await call('GET', '/meter/me', { headers: { 'x-api-key': LEGACY_KEY } });
    check('claimed key STILL works headless on /meter/me', meterMe.status === 200 && meterMe.json.label === 'e2e-legacy', `got ${meterMe.status}`);

    const meterMe2 = await call('GET', '/meter/me', { headers: { 'x-api-key': BOB_KEY } });
    check('unclaimed-path key works on /meter/me', meterMe2.status === 200 && meterMe2.json.label === 'e2e-bob-secret-label');

    const badKey = await call('GET', '/meter/me', { headers: { 'x-api-key': 'sk-pool-wrong' } });
    check('invalid api key still 401', badKey.status === 401);

    // Baseline parity: with a dead broker port, UNMODIFIED master b6996b2
    // also serves 503 + retry-after here (verified via a control worktree,
    // test/status-control run 2026-07-30). "Unaffected" therefore means the
    // same graceful degraded response, not a 200 this environment can't give.
    const status = await call('GET', '/status.json');
    check('/status.json unaffected (graceful 503, matches broker-less baseline)',
      status.status === 503 && status.json && /unavailable/.test(status.json.error || '') && status.headers['retry-after'] === '60',
      `got ${status.status}`);

    const statusHtml = await call('GET', '/status');
    check('/status html unaffected (graceful 503, matches broker-less baseline)',
      statusHtml.status === 503 && /unavailable/.test(statusHtml.text), `got ${statusHtml.status}`);

    // ---- 8. logout ---------------------------------------------------------
    const logout = await call('POST', '/account/logout', { headers: { cookie } });
    const cleared = (logout.headers['set-cookie'] || [])[0] || '';
    check('logout clears cookie', logout.status === 200 && /Max-Age=0/.test(cleared), cleared);

    // ---- 9. nothing sensitive in server logs -------------------------------
    const logText = logs.join('');
    check('no raw keys or tokens in server logs', ![ADMIN_KEY, LEGACY_KEY, ALICE_KEY, BOB_KEY, ALICE_TOKEN, BOB_TOKEN].some((s) => logText.includes(s)));
  } finally {
    child.kill('SIGTERM');
    steward.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
