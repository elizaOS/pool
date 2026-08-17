'use strict';
// broker.js — read-only client for the eliza account-pool broker on :7803.
//
// The broker service is DENYLISTED: never restarted, never reconfigured. This
// module is a consumer only. It speaks, PER PROVIDER:
//   GET  /api/accounts
//   POST /api/accounts/<provider>/oauth/start
//   GET  /api/accounts/<provider>/oauth/status  (SSE)
//   POST /api/accounts/<provider>/oauth/submit-code
//   POST /api/accounts/<provider>/oauth/cancel
//   DELETE /api/accounts/<provider>/<accountId>
//   PATCH  /api/accounts/<provider>/<accountId>
//
// PROVIDER FIRST-CLASSING: donations were anthropic-subscription only. The
// broker exposes the identical OAuth surface for openai-codex (verified: its
// /oauth/start answers 400-bad-params, not 404), so every method here takes an
// optional `provider` and defaults to anthropic-subscription. Anthropic callers
// are byte-for-byte unchanged; codex donors now have a real donate path.

const http = require('http');
const config = require('./config.js');

// Host/port/token all come from config so no credential is ever committed.
const HOST = config.brokerHost;
const PORT = config.brokerPort;
const PROVIDER = 'anthropic-subscription';

// Providers this client is allowed to drive an OAuth/donate flow for. Anything
// outside this allowlist is rejected before a request is built, so a bad
// `?provider=` cannot be reflected into a broker path.
const SUPPORTED_PROVIDERS = new Set(['anthropic-subscription', 'openai-codex']);

function resolveProvider(provider) {
  const p = provider || PROVIDER;
  if (!SUPPORTED_PROVIDERS.has(p)) {
    const err = new Error(`unsupported provider: ${String(p).slice(0, 40)}`);
    err.status = 400;
    throw err;
  }
  return p;
}

function oauthBase(provider) {
  return `/api/accounts/${resolveProvider(provider)}/oauth`;
}

function request(method, path, body, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        method,
        path,
        timeout: timeoutMs,
        headers: {
          Authorization: `Bearer ${config.brokerToken}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        let len = 0;
        res.on('data', (c) => {
          if (len < (4 << 20)) {
            chunks.push(c);
            len += c.length;
          }
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch (_) {
            /* non-JSON error body */
          }
          resolve({ status: res.statusCode, body: parsed, text });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('broker timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function startOAuth({ label, mode = 'device', replaceAccountId, provider }) {
  const res = await request(
    'POST',
    `${oauthBase(provider)}/start`,
    { label, mode, ...(replaceAccountId ? { replaceAccountId } : {}) },
    120000, // a cold broker may npm-install the provider CLI on first device login
  );
  if (res.status !== 200 || !res.body || !res.body.sessionId) {
    const msg =
      (res.body && (res.body.error || res.body.message)) || res.text || `broker http ${res.status}`;
    const err = new Error(String(msg).slice(0, 300));
    err.status = res.status;
    throw err;
  }
  return res.body; // { sessionId, authUrl, needsCodeSubmission, userCode? }
}

async function submitCode(sessionId, code, provider) {
  const res = await request('POST', `${oauthBase(provider)}/submit-code`, { sessionId, code });
  if (res.status !== 200) {
    const msg = (res.body && (res.body.error || res.body.message)) || `broker http ${res.status}`;
    throw new Error(String(msg).slice(0, 300));
  }
  return res.body;
}

async function cancel(sessionId, provider) {
  try {
    const res = await request('POST', `${oauthBase(provider)}/cancel`, { sessionId }, 8000);
    return !!(res.body && res.body.cancelled);
  } catch (_) {
    return false; // cancelling is best-effort cleanup, never fatal to the caller
  }
}

/**
 * Subscribe to the broker's flow SSE. Calls `onState` for each state object and
 * `onEnd` once when the stream terminates. Returns a close function.
 *
 * The broker closes the stream itself on any terminal state, so this does not
 * need to interpret status values; it just relays them.
 */
function watchFlow(sessionId, onState, onEnd, provider) {
  let ended = false;
  const finish = (err) => {
    if (ended) return;
    ended = true;
    if (onEnd) onEnd(err || null);
  };
  let base;
  try { base = oauthBase(provider); } catch (err) { finish(err); return () => {}; }
  const req = http.request(
    {
      host: HOST,
      port: PORT,
      method: 'GET',
      path: `${base}/status?sessionId=${encodeURIComponent(sessionId)}`,
      headers: { Authorization: `Bearer ${config.brokerToken}`, accept: 'text/event-stream' },
      timeout: 0,
    },
    (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        finish(new Error(`broker sse http ${res.statusCode}`));
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            onState(JSON.parse(payload));
          } catch (_) {
            /* ignore malformed frame, the next one will carry state */
          }
        }
        if (buf.length > (1 << 20)) buf = '';
      });
      res.on('end', () => finish(null));
      res.on('error', (e) => finish(e));
    },
  );
  req.on('error', (e) => finish(e));
  req.end();
  return () => {
    try {
      req.destroy();
    } catch (_) {
      /* already gone */
    }
    finish(null);
  };
}

async function listAccounts() {
  const res = await request('GET', '/api/accounts', undefined, 10000);
  if (res.status !== 200 || !res.body) throw new Error(`broker http ${res.status}`);
  return res.body;
}

/** Is `accountId` still present in the broker's account list for `providerId`? */
async function accountExists(accountId, providerId) {
  const wanted = resolveProvider(providerId);
  const raw = await listAccounts();
  const provider = (raw.providers || []).find((p) => p.providerId === wanted);
  if (!provider) return false;
  return (provider.accounts || []).some((a) => a && a.id === accountId);
}

/**
 * Remove a donated account credential from the broker.
 *
 * The broker's DELETE handler is idempotent and answers `{deleted:true}`
 * unconditionally, even for an id that never existed (verified against
 * handleDeleteAccount in accounts-routes.ts). Trusting that response would let
 * the revoke page tell a donor "your credential is gone" when nothing was
 * removed. So we verify against the live account list afterwards and only
 * report success when the seat has actually disappeared.
 */
async function deleteAccount(accountId, providerId) {
  const provider = resolveProvider(providerId);
  const safe = String(accountId || '').trim();
  if (!safe) throw new Error('accountId required');

  const existedBefore = await accountExists(safe, provider).catch(() => null);
  if (existedBefore === false) {
    // Nothing to remove. Truthful, and not an error: the end state the donor
    // asked for (credential not in the pool) already holds.
    return { deleted: false, verified: true, alreadyAbsent: true };
  }

  const res = await request('DELETE', `/api/accounts/${provider}/${encodeURIComponent(safe)}`, undefined, 15000);
  if (res.status !== 200) {
    const msg = (res.body && (res.body.error || res.body.message)) || `broker http ${res.status}`;
    const err = new Error(String(msg).slice(0, 300));
    err.status = res.status;
    throw err;
  }

  const stillThere = await accountExists(safe, provider).catch(() => null);
  if (stillThere === true) {
    throw new Error('broker reported success but the account is still in the pool');
  }
  // stillThere === null means the verification call itself failed; say so
  // rather than claiming a verified removal.
  return { deleted: true, verified: stillThere === false };
}

async function disableAccount(accountId, providerId) {
  const provider = resolveProvider(providerId);
  const safe = String(accountId || '').trim();
  if (!safe) throw new Error('accountId required');
  const res = await request('PATCH', `/api/accounts/${provider}/${encodeURIComponent(safe)}`, { enabled: false }, 15000);
  if (res.status !== 200) {
    const msg = (res.body && (res.body.error || res.body.message)) || `broker http ${res.status}`;
    const err = new Error(String(msg).slice(0, 300));
    err.status = res.status;
    throw err;
  }
  return res.body;
}

module.exports = {
  startOAuth,
  submitCode,
  cancel,
  watchFlow,
  listAccounts,
  accountExists,
  deleteAccount,
  disableAccount,
  resolveProvider,
  PROVIDER,
  SUPPORTED_PROVIDERS,
};
