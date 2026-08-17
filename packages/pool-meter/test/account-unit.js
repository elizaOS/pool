'use strict';
// account-unit.js — unit tests for lib/account.js + the ownership layer in
// lib/join.js. Entirely off-prod: every file path is redirected into a temp
// dir BEFORE the modules load, and the Steward network edge is a mock fetcher.
// Nothing here reads pool secrets, the live keys file, or the platform key.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- isolate ALL state before any module loads -----------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-account-test-'));
process.env.POOL_METER_SECRETS_DIR = TMP;
process.env.POOL_METER_LOG_DIR = path.join(TMP, 'logs');
process.env.POOL_METER_KEYS_FILE = path.join(TMP, 'pool-keys.json');
process.env.POOL_METER_CONFIG = path.join(TMP, 'nonexistent-config.json');
delete process.env.POOL_ACCOUNT_SESSION_SECRET;

const account = require('../src/lib/account.js');
const join = require('../src/lib/join.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++; console.log(`PASS ${name}`);
  } catch (e) {
    fail++; console.log(`FAIL ${name} :: ${e.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass++; console.log(`PASS ${name}`);
  } catch (e) {
    fail++; console.log(`FAIL ${name} :: ${e.message}`);
  }
}

// ---- helpers ---------------------------------------------------------------
function b64url(o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); }
function makeJwt(header, claims, key, alg) {
  const data = `${b64url(header)}.${b64url(claims)}`;
  let sig;
  if (alg === 'RS256') sig = crypto.sign('RSA-SHA256', Buffer.from(data), key);
  else sig = crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return `${data}.${sig.toString('base64url')}`;
}

async function main() {
  // ===========================================================================
  // 1. pool session cookie layer
  // ===========================================================================
  check('mint + verify roundtrip', () => {
    const t = account.mintSession({ userId: 'user_abc', email: 'a@b.c' });
    const v = account.verifySession(t);
    assert(v.ok, v.reason);
    assert.strictEqual(v.session.userId, 'user_abc');
    assert.strictEqual(v.session.email, 'a@b.c');
  });

  check('tampered payload rejected', () => {
    const t = account.mintSession({ userId: 'user_abc' });
    const [p, s] = t.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    claims.u = 'user_victim'; // try to become someone else
    const forged = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}`;
    const v = account.verifySession(forged);
    assert(!v.ok && v.reason === 'bad signature', JSON.stringify(v));
  });

  check('tampered signature rejected', () => {
    const t = account.mintSession({ userId: 'user_abc' });
    const [p] = t.split('.');
    const v = account.verifySession(`${p}.${'A'.repeat(43)}`);
    assert(!v.ok, 'must reject');
  });

  check('expired session rejected', () => {
    const t = account.mintSession({ userId: 'user_abc' }, -1000);
    const v = account.verifySession(t);
    assert(!v.ok && v.reason === 'expired', JSON.stringify(v));
  });

  check('malformed tokens rejected without throwing', () => {
    for (const bad of [null, undefined, 42, '', 'no-dot', 'a.b.c.d', 'x'.repeat(5000) + '.y', `${Buffer.from('"str"').toString('base64url')}.sig`]) {
      const v = account.verifySession(bad);
      assert(!v.ok, `should reject ${String(bad).slice(0, 20)}`);
    }
  });

  check('session secret persisted 0600', () => {
    const f = path.join(TMP, 'pool-account-session.secret');
    assert(fs.existsSync(f), 'secret file exists');
    const mode = fs.statSync(f).mode & 0o777;
    assert.strictEqual(mode, 0o600, `mode ${mode.toString(8)}`);
  });

  check('cookie flags: httpOnly + Secure + SameSite=Lax', () => {
    const c = account.serializeCookie('tok');
    assert(/HttpOnly/.test(c) && /Secure/.test(c) && /SameSite=Lax/.test(c), c);
    const cl = account.clearCookie();
    assert(/Max-Age=0/.test(cl) && /HttpOnly/.test(cl), cl);
  });

  check('cookie extraction from header', () => {
    const t = account.mintSession({ userId: 'user_abc' });
    const got = account.tokenFromCookieHeader(`other=1; pool_sess=${t}; x=2`);
    assert.strictEqual(got, t);
    assert.strictEqual(account.tokenFromCookieHeader('other=1'), null);
    assert.strictEqual(account.tokenFromCookieHeader(undefined), null);
  });

  check('sessionFromRequest end-to-end', () => {
    const t = account.mintSession({ userId: 'user_abc' });
    assert(account.sessionFromRequest({ headers: { cookie: `pool_sess=${t}` } }));
    assert.strictEqual(account.sessionFromRequest({ headers: { cookie: 'pool_sess=garbage' } }), null);
    assert.strictEqual(account.sessionFromRequest({ headers: {} }), null);
  });

  // ===========================================================================
  // 2. origin / CSRF boundary
  // ===========================================================================
  check('checkOrigin: allowed, hostile, absent', () => {
    assert(account.checkOrigin({ headers: { origin: 'https://pool.example.com' } }), 'own origin allowed');
    assert(!account.checkOrigin({ headers: { origin: 'https://evil.example.com' } }), 'foreign origin refused');
    assert(!account.checkOrigin({ headers: { origin: 'not a url' } }), 'garbage origin refused');
    assert(account.checkOrigin({ headers: { origin: 'http://127.0.0.1:9999' } }), 'loopback allowed for local tests');
    assert(account.checkOrigin({ headers: {} }), 'no origin header = non-browser client');
  });

  // ===========================================================================
  // 3. idToken local (JWKS) verification — fail closed everywhere
  // ===========================================================================
  const { publicKey: rsaPub, privateKey: rsaPriv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsaJwk = rsaPub.export({ format: 'jwk' });
  rsaJwk.kid = 'k1'; rsaJwk.alg = 'RS256';
  const goodClaims = () => ({
    iss: account.STEWARD_BASE, sub: 'user_ok', userId: 'user_ok', tenantId: account.ACCOUNT_TENANT,
    email: 'ok@example.com', exp: Math.floor(Date.now() / 1000) + 600,
  });
  const jwksFetcher = (keys) => async () => ({ status: 200, body: { keys } });

  await checkAsync('jwks: valid RS256 token accepted', async () => {
    account._resetJwksCache();
    const tok = makeJwt({ alg: 'RS256', typ: 'JWT', kid: 'k1' }, goodClaims(), rsaPriv, 'RS256');
    const r = await account.verifyIdTokenLocal(tok, { fetcher: jwksFetcher([rsaJwk]) });
    assert(r.ok, r.reason);
    assert.strictEqual(r.userId, 'user_ok');
    assert.strictEqual(r.method, 'jwks');
  });

  await checkAsync('jwks: EMPTY key set fails closed (live prod state today)', async () => {
    account._resetJwksCache();
    const tok = makeJwt({ alg: 'RS256', typ: 'JWT', kid: 'k1' }, goodClaims(), rsaPriv, 'RS256');
    const r = await account.verifyIdTokenLocal(tok, { fetcher: jwksFetcher([]) });
    assert(!r.ok && /jwks empty/.test(r.reason), JSON.stringify(r));
  });

  await checkAsync('jwks: forged signature rejected', async () => {
    account._resetJwksCache();
    const { privateKey: otherPriv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const tok = makeJwt({ alg: 'RS256', typ: 'JWT', kid: 'k1' }, goodClaims(), otherPriv, 'RS256');
    const r = await account.verifyIdTokenLocal(tok, { fetcher: jwksFetcher([rsaJwk]) });
    assert(!r.ok && r.reason === 'bad signature', JSON.stringify(r));
  });

  await checkAsync('jwks: alg none / HS256 refused before any crypto', async () => {
    account._resetJwksCache();
    for (const alg of ['none', 'HS256']) {
      const tok = `${b64url({ alg, typ: 'JWT' })}.${b64url(goodClaims())}.`;
      const r = await account.verifyIdTokenLocal(tok, { fetcher: jwksFetcher([rsaJwk]) });
      assert(!r.ok && r.reason === 'disallowed alg', `${alg}: ${JSON.stringify(r)}`);
    }
  });

  await checkAsync('jwks: expired token rejected', async () => {
    account._resetJwksCache();
    const c = goodClaims(); c.exp = Math.floor(Date.now() / 1000) - 10;
    const tok = makeJwt({ alg: 'RS256', typ: 'JWT', kid: 'k1' }, c, rsaPriv, 'RS256');
    const r = await account.verifyIdTokenLocal(tok, { fetcher: jwksFetcher([rsaJwk]) });
    assert(!r.ok && r.reason === 'expired', JSON.stringify(r));
  });

  await checkAsync('jwks: wrong issuer rejected', async () => {
    account._resetJwksCache();
    const c = goodClaims(); c.iss = 'https://evil.example.com';
    const tok = makeJwt({ alg: 'RS256', typ: 'JWT', kid: 'k1' }, c, rsaPriv, 'RS256');
    const r = await account.verifyIdTokenLocal(tok, { fetcher: jwksFetcher([rsaJwk]) });
    assert(!r.ok && r.reason === 'bad issuer', JSON.stringify(r));
  });

  await checkAsync('jwks: wrong tenant rejected', async () => {
    account._resetJwksCache();
    const c = goodClaims(); c.tenantId = 'waifu'; delete c.tenantIds;
    const tok = makeJwt({ alg: 'RS256', typ: 'JWT', kid: 'k1' }, c, rsaPriv, 'RS256');
    const r = await account.verifyIdTokenLocal(tok, { fetcher: jwksFetcher([rsaJwk]) });
    assert(!r.ok && r.reason === 'wrong tenant', JSON.stringify(r));
  });

  await checkAsync('jwks: tenant-scoped issuer (what Steward actually mints) accepted', async () => {
    account._resetJwksCache();
    const c = goodClaims();
    c.iss = `${account.STEWARD_BASE}/tenants/${account.ACCOUNT_TENANT}`;
    const tok = makeJwt({ alg: 'RS256', typ: 'JWT', kid: 'k1' }, c, rsaPriv, 'RS256');
    const r = await account.verifyIdTokenLocal(tok, { fetcher: jwksFetcher([rsaJwk]) });
    assert(r.ok, JSON.stringify(r));
  });

  await checkAsync('jwks: FOREIGN-tenant-scoped issuer rejected', async () => {
    account._resetJwksCache();
    const c = goodClaims();
    c.iss = `${account.STEWARD_BASE}/tenants/waifu`;
    const tok = makeJwt({ alg: 'RS256', typ: 'JWT', kid: 'k1' }, c, rsaPriv, 'RS256');
    const r = await account.verifyIdTokenLocal(tok, { fetcher: jwksFetcher([rsaJwk]) });
    assert(!r.ok && r.reason === 'bad issuer', JSON.stringify(r));
  });

  check('tenant binding: default tenant is elizacloud (pool account = eliza cloud account)', () => {
    // Tests run without POOL_METER_STEWARD_TENANT set, so this asserts the
    // shipped default. Directive 2026-07-31: identity binds to Eliza Cloud.
    assert.strictEqual(account.ACCOUNT_TENANT, 'elizacloud');
  });

  await checkAsync('jwks: unreachable endpoint fails closed', async () => {
    account._resetJwksCache();
    const tok = makeJwt({ alg: 'RS256', typ: 'JWT', kid: 'k1' }, goodClaims(), rsaPriv, 'RS256');
    const r = await account.verifyIdTokenLocal(tok, { fetcher: async () => { throw new Error('down'); } });
    assert(!r.ok, 'must fail closed');
  });

  // ===========================================================================
  // 4. accessToken introspection — server-side via /auth/session, mock Steward
  // ===========================================================================
  // Access tokens are HS256 session JWTs; the mock "Steward" verifies them by
  // exact string match (as prod verifies by signature) and answers in the
  // real GET /auth/session shape. Payloads must exist because the guest gate
  // decodes the Steward-verified token locally.
  const fakeSessionToken = (payload) =>
    `${b64url({ alg: 'HS256' })}.${b64url(payload)}.${Buffer.from('sig').toString('base64url')}`;
  const LIVE_TOKEN = fakeSessionToken({ userId: 'user_ok', tenantId: account.ACCOUNT_TENANT, authMethod: 'passkey', iss: 'steward', exp: Math.floor(Date.now() / 1000) + 900 });
  const GUEST_TOKEN = fakeSessionToken({ userId: 'user_guest', tenantId: account.ACCOUNT_TENANT, guest: true, authMethod: 'guest', exp: Math.floor(Date.now() / 1000) + 900 });
  const MISMATCH_TOKEN = fakeSessionToken({ userId: 'user_SOMEONE_ELSE', tenantId: account.ACCOUNT_TENANT, exp: Math.floor(Date.now() / 1000) + 900 });
  const stewardSessions = {
    [LIVE_TOKEN]: { authenticated: true, userId: 'user_ok', tenantId: account.ACCOUNT_TENANT, email: 'ok@example.com', address: '0xabc' },
    [GUEST_TOKEN]: { authenticated: true, userId: 'user_guest', tenantId: account.ACCOUNT_TENANT, address: '0xdef' },
    [MISMATCH_TOKEN]: { authenticated: true, userId: 'user_ok', tenantId: account.ACCOUNT_TENANT },
  };
  const stewardOk = async (url, headers) => {
    assert(/\/auth\/session$/.test(url), `introspection must hit /auth/session, got ${url}`);
    const m = /^Bearer (.+)$/.exec((headers && headers.authorization) || '');
    const s = m && stewardSessions[m[1]];
    return { status: 200, body: s || { authenticated: false } };
  };

  await checkAsync('introspection: live token accepted (via /auth/session)', async () => {
    const r = await account.verifyAccessToken(LIVE_TOKEN, { fetcher: stewardOk });
    assert(r.ok && r.userId === 'user_ok' && r.method === 'introspection', JSON.stringify(r));
    assert.strictEqual(r.email, 'ok@example.com');
  });

  await checkAsync('introspection: forged/garbage token rejected', async () => {
    const r = await account.verifyAccessToken('forged-token', { fetcher: stewardOk });
    assert(!r.ok, 'must reject');
  });

  await checkAsync('introspection: steward outage fails closed', async () => {
    const r = await account.verifyAccessToken(LIVE_TOKEN, { fetcher: async () => { throw new Error('down'); } });
    assert(!r.ok, 'must fail closed');
  });

  await checkAsync('introspection: wrong tenant rejected', async () => {
    const wrongTok = fakeSessionToken({ userId: 'user_x', tenantId: 'waifu' });
    const f = async () => ({ status: 200, body: { authenticated: true, userId: 'user_x', tenantId: 'waifu' } });
    const r = await account.verifyAccessToken(wrongTok, { fetcher: f });
    assert(!r.ok && r.reason === 'wrong tenant', JSON.stringify(r));
  });

  await checkAsync('introspection: GUEST session refused (anonymous, freely mintable)', async () => {
    const r = await account.verifyAccessToken(GUEST_TOKEN, { fetcher: stewardOk });
    assert(!r.ok && /guest/.test(r.reason), JSON.stringify(r));
  });

  await checkAsync('introspection: payload/reply userId mismatch refused', async () => {
    const r = await account.verifyAccessToken(MISMATCH_TOKEN, { fetcher: stewardOk });
    assert(!r.ok && r.reason === 'token payload mismatch', JSON.stringify(r));
  });

  await checkAsync('introspection: authenticated:false (steward said no) refused', async () => {
    const f = async () => ({ status: 200, body: { authenticated: false } });
    const r = await account.verifyAccessToken(LIVE_TOKEN, { fetcher: f });
    assert(!r.ok, 'must reject');
  });

  // ===========================================================================
  // 5. verifyIdentity preference + no-second-chance rule
  // ===========================================================================
  await checkAsync('verifyIdentity: bad idToken does NOT fall through to accessToken', async () => {
    account._resetJwksCache();
    const { privateKey: otherPriv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const forged = makeJwt({ alg: 'RS256', typ: 'JWT', kid: 'k1' }, goodClaims(), otherPriv, 'RS256');
    const r = await account.verifyIdentity(
      { idToken: forged, accessToken: LIVE_TOKEN },
      { fetcher: async (url, headers) => (url.includes('jwks') ? { status: 200, body: { keys: [rsaJwk] } } : stewardOk(url, headers || {})) },
    );
    assert(!r.ok && r.reason === 'bad signature', JSON.stringify(r));
  });

  await checkAsync('verifyIdentity: jwks-empty DOES fall through to accessToken', async () => {
    account._resetJwksCache();
    const tok = makeJwt({ alg: 'RS256', typ: 'JWT', kid: 'k1' }, goodClaims(), rsaPriv, 'RS256');
    const r = await account.verifyIdentity(
      { idToken: tok, accessToken: LIVE_TOKEN },
      { fetcher: async (url, headers) => (url.includes('jwks') ? { status: 200, body: { keys: [] } } : stewardOk(url, headers || {})) },
    );
    assert(r.ok && r.method === 'introspection', JSON.stringify(r));
  });

  await checkAsync('verifyIdentity: nothing presented fails closed', async () => {
    const r = await account.verifyIdentity({});
    assert(!r.ok, 'must reject');
  });

  // ===========================================================================
  // 6. ownership layer in join.js (temp keys file)
  // ===========================================================================
  check('mintKey without ownerUserId: record has NO ownerUserId field (legacy shape preserved)', () => {
    const rec = join.mintKey({ labelBase: 'legacy-donor', tier: 'donor' });
    assert(rec.key.startsWith('sk-pool-'));
    const onDisk = join.listKeys().find((k) => k.label === rec.label);
    assert(onDisk && !('ownerUserId' in onDisk), 'legacy mints must not grow fields');
  });

  check('mintKey with ownerUserId attaches ownership', () => {
    const rec = join.mintKey({ labelBase: 'owned-donor', tier: 'donor', ownerUserId: 'user_alice' });
    const onDisk = join.listKeys().find((k) => k.label === rec.label);
    assert.strictEqual(onDisk.ownerUserId, 'user_alice');
  });

  check('keysOwnedBy scopes strictly to the owner', () => {
    join.mintKey({ labelBase: 'bob-key', tier: 'donor', ownerUserId: 'user_bob' });
    const alice = join.keysOwnedBy('user_alice');
    const bob = join.keysOwnedBy('user_bob');
    assert(alice.length === 1 && alice[0].label.startsWith('owned-donor'), JSON.stringify(alice.map((k) => k.label)));
    assert(bob.length === 1 && bob[0].label.startsWith('bob-key'));
    assert(alice.every((k) => k.ownerUserId === 'user_alice'), 'no cross-user leak');
    assert.deepStrictEqual(join.keysOwnedBy(''), []);
    assert.deepStrictEqual(join.keysOwnedBy(null), []);
  });

  check('claimKeyByRawKey: legacy key claimable exactly once, not stealable', () => {
    const legacy = join.listKeys().find((k) => k.label.startsWith('legacy-donor'));
    const r1 = join.claimKeyByRawKey(legacy.key, 'user_alice');
    assert(r1.ok && !r1.alreadyOwned, JSON.stringify(r1));
    // idempotent for the same user
    const r2 = join.claimKeyByRawKey(legacy.key, 'user_alice');
    assert(r2.ok && r2.alreadyOwned, JSON.stringify(r2));
    // NOT stealable by another user
    const r3 = join.claimKeyByRawKey(legacy.key, 'user_bob');
    assert(!r3.ok && r3.reason === 'already claimed', JSON.stringify(r3));
    // unknown / malformed keys refused
    assert(!join.claimKeyByRawKey('sk-pool-doesnotexist000000', 'user_alice').ok);
    assert(!join.claimKeyByRawKey('short', 'user_alice').ok);
    assert(!join.claimKeyByRawKey(legacy.key, '').ok);
  });

  check('claiming does not change key function-critical fields', () => {
    const legacy = join.listKeys().find((k) => k.label.startsWith('legacy-donor'));
    assert.strictEqual(legacy.enabled, true);
    assert.strictEqual(legacy.tier, 'donor');
    assert(typeof legacy.quota === 'number' && legacy.quota > 0);
    assert.strictEqual(legacy.key.startsWith('sk-pool-'), true, 'raw key untouched');
  });

  // ---- report -------------------------------------------------------------
  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
