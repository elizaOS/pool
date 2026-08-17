'use strict';
// account.js — Steward-backed pool accounts: identity verification + the pool
// session cookie layer. No deps, Node stdlib only, same style as lib/join.js.
//
// TRUST MODEL (read this before touching anything):
//
//   A pool session is NOT a Steward token. The browser signs in to Steward
//   (passkey via @stwd/sdk), then hands pool-meter a Steward credential ONCE
//   at POST /account/session. Pool-meter verifies that credential server-side
//   and mints its OWN short-lived HMAC-signed httpOnly cookie carrying only
//   { userId, email }. Steward's refresh token never transits pool-meter.
//
//   TENANT (directive 2026-07-31): pool identities ARE Eliza Cloud
//   identities. The pinned tenant is 'elizacloud' — the same Steward tenant
//   the elizacloud.ai app uses (its prod bundle ships
//   VITE_STEWARD_TENANT_ID:"elizacloud" against eliza.steward.fi). One login
//   works across cloud + pool. The dedicated 'pool' tenant (created
//   2026-07-30) is DEPRECATED: left in place in Steward, no longer accepted
//   here.
//
//   Verification is fail-closed, in strict preference order:
//
//   1. idToken + JWKS (preferred, local): if Steward publishes a non-empty
//      JWKS at /.well-known/jwks.json we verify the identity JWT's signature
//      (RS256/ES256 only), iss, exp/nbf and tenant locally. No per-request
//      network call, no secret involved. Accepted issuers: the Steward base
//      or the tenant-scoped issuer `{base}/tenants/{tenant}` that Steward's
//      createIdentityToken() actually mints.
//      AS OF 2026-07-31 the live JWKS is still EMPTY (`{"keys":[]}`) because
//      STEWARD_IDENTITY_JWT_PRIVATE_KEY is not configured in prod, so this
//      path currently rejects everything — deliberately. The moment Steward
//      publishes keys it starts working.
//
//   2. accessToken introspection via GET {steward}/auth/session (works
//      today): the browser posts its short-lived Steward access token and
//      pool-meter presents it as the bearer. Steward verifies the HS256
//      session token server-side (signature, expiry, revocation) and only
//      answers `authenticated:true` for a token IT issued, so this proves
//      possession of a live Steward session. All claims come from Steward's
//      reply, never the client. Verified live 2026-07-31: genuine token ->
//      {authenticated:true,userId,tenantId}, garbage/absent ->
//      {authenticated:false}.
//      (GET /auth/identity-token was the previous introspection endpoint but
//      503s for REAL tokens in prod — "Identity JWT private key is not
//      configured", the same root cause as the empty JWKS — so it cannot
//      carry the working path today.)
//
//   GUEST GATE: anyone can mint an anonymous guest session in the elizacloud
//   tenant via POST /auth/guest (no credentials required), and /auth/session
//   does not expose the guest flag. So after Steward confirms the token, we
//   parse the (Steward-verified) token payload ourselves and REFUSE
//   guest:true identities, cross-checking payload.userId against Steward's
//   reply so the payload we inspected is the token Steward verified. Pool
//   accounts attach durable key ownership; ephemeral anonymous identities
//   must not own keys.
//
//   A pure "platform lookup" fallback (look up a client-supplied userId via
//   the platform key) was REJECTED: it proves a userId exists, not that the
//   caller owns it, i.e. anyone who learns a userId could mint a session.
//   The platform key therefore does not participate in the request path at
//   all. Nothing in this file reads it.
//
//   CSRF boundary: the session cookie is httpOnly + Secure + SameSite=Lax, so
//   modern browsers do not attach it to cross-site POSTs. Defense in depth:
//   every cookie-authenticated mutating route additionally requires the
//   Origin header, when present, to match the configured public origin
//   (checkOrigin below). POST /account/session itself is not CSRF-sensitive:
//   its credential is the bearer token in the body, not the cookie.

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');
const config = require('./config.js');

const SESSION_SECRET_FILE = path.join(config.secretsDir, 'pool-account-session.secret');
const COOKIE_NAME = 'pool_sess';
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min, then the browser re-verifies with Steward.
const JWKS_CACHE_MS = 10 * 60 * 1000;
const ALLOWED_ALGS = new Set(['RS256', 'ES256']);

// ---- session secret (persisted, 0600, generated once; same as join.js) ----
let sessionSecret = null;
function getSecret() {
  if (sessionSecret) return sessionSecret;
  const env = process.env.POOL_ACCOUNT_SESSION_SECRET;
  if (env && env.length >= 32) { sessionSecret = env; return sessionSecret; }
  try {
    const raw = fs.readFileSync(SESSION_SECRET_FILE, 'utf8').trim();
    if (raw.length >= 32) { sessionSecret = raw; return sessionSecret; }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const generated = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(SESSION_SECRET_FILE), { recursive: true });
  fs.writeFileSync(SESSION_SECRET_FILE, `${generated}\n`, { mode: 0o600 });
  fs.chmodSync(SESSION_SECRET_FILE, 0o600);
  sessionSecret = generated;
  return sessionSecret;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function hmac(payloadB64) {
  return crypto.createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
}

// ---- pool session cookie ---------------------------------------------------

/** Mint a signed session token for a VERIFIED identity. Never call this with
 *  anything client-supplied that has not been through verifyIdentity(). */
function mintSession({ userId, email }, ttlMs = SESSION_TTL_MS) {
  if (!userId || typeof userId !== 'string') throw new Error('userId required');
  const now = Date.now();
  const payload = { u: userId, e: email || null, iat: now, exp: now + ttlMs };
  const payloadB64 = b64url(JSON.stringify(payload));
  return `${payloadB64}.${hmac(payloadB64)}`;
}

/** Verify a session token. Constant-time signature compare. */
function verifySession(token) {
  if (typeof token !== 'string' || !token.includes('.') || token.length > 4096) {
    return { ok: false, reason: 'malformed' };
  }
  const [payloadB64, sig] = token.split('.', 2);
  if (!payloadB64 || !sig) return { ok: false, reason: 'malformed' };
  const expected = hmac(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad signature' };
  }
  let p;
  try {
    p = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (_) {
    return { ok: false, reason: 'malformed' };
  }
  if (!p || typeof p.u !== 'string' || typeof p.exp !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (Date.now() > p.exp) return { ok: false, reason: 'expired' };
  return { ok: true, session: { userId: p.u, email: p.e || null, issuedAt: p.iat, expiresAt: p.exp } };
}

/** Set-Cookie value. httpOnly + Secure + SameSite=Lax (decision 2026-07-30). */
function serializeCookie(token, { ttlMs = SESSION_TTL_MS, secure = true } = {}) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearCookie({ secure = true } = {}) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Extract our session token from a Cookie header. */
function tokenFromCookieHeader(cookieHeader) {
  if (!cookieHeader) return null;
  for (const pair of String(cookieHeader).split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const k = pair.slice(0, idx).trim();
    if (k === COOKIE_NAME) return pair.slice(idx + 1).trim();
  }
  return null;
}

/** Valid session from an incoming request, or null. Never throws. */
function sessionFromRequest(req) {
  try {
    const tok = tokenFromCookieHeader(req.headers && req.headers.cookie);
    if (!tok) return null;
    const v = verifySession(tok);
    return v.ok ? v.session : null;
  } catch (_) {
    return null;
  }
}

/**
 * CSRF / origin boundary for cookie-authenticated mutating routes.
 * If the request carries an Origin header it MUST match the configured public
 * origin (or a loopback origin, for local testing). No Origin header means a
 * non-browser client; the cookie is then the caller's own to spend.
 */
function checkOrigin(req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true;
  let allowed;
  try {
    allowed = new URL(config.publicBaseUrl).origin;
  } catch (_) {
    allowed = null;
  }
  let got;
  try {
    got = new URL(origin).origin;
  } catch (_) {
    return false;
  }
  if (allowed && got === allowed) return true;
  const host = (() => { try { return new URL(origin).hostname; } catch (_) { return ''; } })();
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return true;
  return false;
}

// ---- Steward identity verification ----------------------------------------

const STEWARD_BASE = process.env.POOL_METER_STEWARD_BASE || config.stewardBaseUrl;
const ACCOUNT_TENANT = process.env.POOL_METER_STEWARD_TENANT || config.accountTenant;

function httpGetJson(url, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const r = mod.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        timeout: timeoutMs,
        headers: { accept: 'application/json', ...headers },
      },
      (res) => {
        const chunks = [];
        let len = 0;
        res.on('data', (c) => { if (len < (1 << 20)) { chunks.push(c); len += c.length; } });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch (_) {}
          resolve({ status: res.statusCode, body: parsed });
        });
        res.on('error', reject);
      },
    );
    r.on('timeout', () => r.destroy(new Error('steward timeout')));
    r.on('error', reject);
    r.end();
  });
}

let jwksCache = { at: 0, keys: null };
async function fetchJwks(fetcher = httpGetJson) {
  const now = Date.now();
  if (jwksCache.keys && now - jwksCache.at < JWKS_CACHE_MS) return jwksCache.keys;
  const res = await fetcher(`${STEWARD_BASE}/.well-known/jwks.json`).catch(() => null);
  const keys = res && res.status === 200 && res.body && Array.isArray(res.body.keys) ? res.body.keys : [];
  jwksCache = { at: now, keys };
  return keys;
}
function _resetJwksCache() { jwksCache = { at: 0, keys: null }; }

/** Tenant gate. The identity must belong to the pool tenant. Fail closed. */
function tenantOk(claims) {
  if (!ACCOUNT_TENANT) return true; // explicitly unset => no tenant pinning
  if (claims.tenantId === ACCOUNT_TENANT) return true;
  if (Array.isArray(claims.tenantIds) && claims.tenantIds.includes(ACCOUNT_TENANT)) return true;
  return false;
}

/**
 * Path 1 — local JWKS verification of a Steward identity JWT.
 * Fail-closed on: empty/unreachable JWKS, unknown kid, disallowed alg,
 * bad signature, bad iss, expired, not-yet-valid, wrong tenant.
 */
async function verifyIdTokenLocal(idToken, { fetcher } = {}) {
  if (typeof idToken !== 'string' || idToken.length > 8192) return { ok: false, reason: 'malformed idToken' };
  const parts = idToken.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed idToken' };
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (_) {
    return { ok: false, reason: 'malformed idToken' };
  }
  if (!header || !ALLOWED_ALGS.has(header.alg)) return { ok: false, reason: 'disallowed alg' };

  const keys = await fetchJwks(fetcher);
  if (!keys.length) {
    // Live prod state 2026-07-30: JWKS exists but is empty. Local verification
    // is impossible, so this path refuses. The introspection path still works.
    return { ok: false, reason: 'jwks empty or unavailable; local verification disabled (fail closed)' };
  }
  const jwk = keys.find((k) => (header.kid ? k.kid === header.kid : k.alg === header.alg)) || (keys.length === 1 ? keys[0] : null);
  if (!jwk) return { ok: false, reason: 'no matching jwks key' };

  let keyObj;
  try {
    keyObj = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch (_) {
    return { ok: false, reason: 'unusable jwks key' };
  }
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2], 'base64url');
  let valid = false;
  try {
    if (header.alg === 'RS256') {
      valid = crypto.verify('RSA-SHA256', data, keyObj, sig);
    } else if (header.alg === 'ES256') {
      valid = crypto.verify('sha256', data, { key: keyObj, dsaEncoding: 'ieee-p1363' }, sig);
    }
  } catch (_) {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad signature' };

  const nowSec = Math.floor(Date.now() / 1000);
  // Steward's createIdentityToken() mints iss = `{base}/tenants/{tenantId}`
  // (tenant-scoped); accept that for OUR tenant, or the plain base.
  const tenantIss = `${STEWARD_BASE}/tenants/${encodeURIComponent(ACCOUNT_TENANT)}`;
  if (!claims.iss) return { ok: false, reason: 'missing issuer' };
  if (claims.iss !== STEWARD_BASE && claims.iss !== tenantIss) return { ok: false, reason: 'bad issuer' };
  if (typeof claims.exp !== 'number' || nowSec >= claims.exp) return { ok: false, reason: 'expired' };
  if (typeof claims.nbf === 'number' && nowSec < claims.nbf) return { ok: false, reason: 'not yet valid' };
  const userId = claims.userId || claims.sub;
  if (!userId || typeof userId !== 'string') return { ok: false, reason: 'no userId claim' };
  if (!tenantOk(claims)) return { ok: false, reason: 'wrong tenant' };
  return { ok: true, userId, email: claims.email || null, claims, method: 'jwks' };
}

/**
 * Decode (NOT verify) a JWT payload. Only ever called on a token that Steward
 * has ALREADY verified server-side — used to read claims /auth/session does
 * not surface (the guest flag). Returns null on anything malformed.
 */
function decodeJwtPayloadUnsafe(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return p && typeof p === 'object' ? p : null;
  } catch (_) {
    return null;
  }
}

/**
 * Path 2 — server-side introspection of a Steward ACCESS token via
 * GET /auth/session. Steward verifies the HS256 session token itself
 * (signature, expiry, revocation) and only answers `authenticated:true` for a
 * token IT issued, so this proves the caller possesses a live Steward
 * session. Identity claims (userId, tenantId, email) come from Steward's
 * reply, never the client.
 *
 * GUEST GATE: /auth/session does not expose Steward's guest flag, and
 * anonymous guest sessions are freely mintable via POST /auth/guest. Since
 * Steward has just verified this exact token, its payload is trustworthy —
 * we decode it locally, cross-check userId against Steward's reply (so the
 * payload we read IS the token Steward verified), and refuse guest sessions.
 * Ephemeral anonymous identities must not own pool keys.
 */
async function verifyAccessToken(accessToken, { fetcher = httpGetJson } = {}) {
  if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 8192) {
    return { ok: false, reason: 'malformed accessToken' };
  }
  const res = await fetcher(`${STEWARD_BASE}/auth/session`, {
    authorization: `Bearer ${accessToken}`,
  }).catch(() => null);
  if (!res || res.status !== 200 || !res.body || res.body.authenticated !== true) {
    return { ok: false, reason: `steward rejected token (http ${res ? res.status : 'error'})` };
  }
  const userId = res.body.userId;
  if (!userId || typeof userId !== 'string') return { ok: false, reason: 'no userId in steward reply' };
  const claims = { userId, tenantId: res.body.tenantId, email: res.body.email };
  if (!tenantOk(claims)) return { ok: false, reason: 'wrong tenant' };
  const payload = decodeJwtPayloadUnsafe(accessToken);
  if (!payload || payload.userId !== userId) {
    // Steward said yes but the token payload does not match its reply —
    // refuse rather than trust anything we cannot pin to the verified token.
    return { ok: false, reason: 'token payload mismatch' };
  }
  if (payload.guest === true || payload.authMethod === 'guest') {
    return { ok: false, reason: 'guest sessions cannot own pool accounts' };
  }
  return { ok: true, userId, email: claims.email || null, claims, method: 'introspection' };
}

/**
 * Verify whichever credential the client presented. idToken (local JWKS) is
 * preferred; accessToken introspection is the working fallback. Both fail
 * closed. Returns { ok, userId?, email?, method?, reason? }.
 */
async function verifyIdentity({ idToken, accessToken } = {}, opts = {}) {
  if (idToken) {
    const r = await verifyIdTokenLocal(idToken, opts);
    if (r.ok) return r;
    // Only fall through when local verification is impossible, not when the
    // token itself failed a check: a bad-signature idToken must never get a
    // second chance via a different token in the same request.
    const impossible = r.reason && r.reason.startsWith('jwks empty');
    if (!impossible || !accessToken) return r;
  }
  if (accessToken) return verifyAccessToken(accessToken, opts);
  return { ok: false, reason: 'no credential presented' };
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_MS,
  STEWARD_BASE,
  ACCOUNT_TENANT,
  mintSession,
  verifySession,
  serializeCookie,
  clearCookie,
  tokenFromCookieHeader,
  sessionFromRequest,
  checkOrigin,
  verifyIdentity,
  verifyIdTokenLocal,
  verifyAccessToken,
  fetchJwks,
  _resetJwksCache,
};
