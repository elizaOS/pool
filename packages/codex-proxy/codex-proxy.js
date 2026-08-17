#!/usr/bin/env node
'use strict';
// codex-proxy: broker-emulation sibling to account-broker-proxy-work/proxy.js,
// but for the OpenAI/Codex (ChatGPT-subscription) leg instead of Claude Code.
//
// Flow (mirrors proxy.js's lease/report loop, receipt POOL-CODEX-2026-07-28.md R4):
//   1. Receive an OpenAI Responses-API request on 127.0.0.1:18812 (from pool-meter).
//   2. Lease an `openai-codex` account from the eliza broker
//      (POST /api/internal/account-pool/v1/lease, providerId=openai-codex).
//      The lease returns { accessToken (chatgpt OAuth JWT), chatgptAccountId, leaseId }.
//   3. Forward the client's request body VERBATIM to the ChatGPT backend Responses
//      endpoint, swapping Authorization for the leased token and injecting the
//      Codex-CLI emulation headers (originator, chatgpt-account-id, session_id,
//      OpenAI-Beta). We NEVER synthesize the body — the caller's real codex CLI does,
//      because the backend strictly validates originator=codex_cli_rs bodies.
//   4. Stream the SSE response back byte-for-byte.
//   5. Report the outcome to the broker (leaseId, ok, httpStatus, tokens).
//
// Discipline: never log tokens/keys. Broker token from env -> secrets -> (no default).
// NO restarts of the broker (7803). This service restarts freely.

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── config: env -> secrets JSON -> safe default ────────────────────────────
function loadSecrets() {
  const p = path.join(process.env.HOME, '.moltbot/secrets/pool-meter.config.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return {}; }
}
function loadBrokerEnvToken() {
  // The lease API requires the broker's INTERNAL token (same one proxy.js uses),
  // which lives in the anthropic proxy's EnvironmentFile. Read it directly so we
  // never duplicate a secret. env var wins if set.
  if (process.env.ELIZA_ACCOUNT_BROKER_TOKEN) return process.env.ELIZA_ACCOUNT_BROKER_TOKEN;
  const envFile = path.join(process.env.HOME, '.moltbot/secrets/eliza-account-pool-proxy.env');
  try {
    const raw = fs.readFileSync(envFile, 'utf8');
    const m = raw.match(/^ELIZA_ACCOUNT_BROKER_TOKEN=(.*)$/m);
    if (m) return m[1].trim();
  } catch (_) {}
  return '';
}

const secrets = loadSecrets();
const CONFIG = {
  listenHost: process.env.CODEX_PROXY_HOST || '127.0.0.1',
  listenPort: parseInt(process.env.CODEX_PROXY_PORT || '18812', 10),
  brokerUrl: process.env.ELIZA_ACCOUNT_BROKER_URL ||
    `http://${secrets.brokerHost || '127.0.0.1'}:${secrets.brokerPort || 7803}`,
  brokerToken: loadBrokerEnvToken(),
  providerId: process.env.CODEX_BROKER_PROVIDER_ID || 'openai-codex',
  strategy: process.env.CODEX_BROKER_STRATEGY || 'priority',
  brokerTimeoutMs: parseInt(process.env.CODEX_BROKER_TIMEOUT_MS || '5000', 10),
  // ChatGPT backend Responses endpoint that the real Codex CLI targets.
  upstreamBase: process.env.CODEX_UPSTREAM_BASE || 'https://chatgpt.com/backend-api/codex',
  upstreamTimeoutMs: parseInt(process.env.CODEX_UPSTREAM_TIMEOUT_MS || '610000', 10),
  codexUa: process.env.CODEX_UA || 'codex_cli_rs/0.0.0 (pool.example.com; codex-proxy)',
  codexOriginator: process.env.CODEX_ORIGINATOR || 'codex_cli_rs',
  // Bind upstream codex requests to this local interface address to avoid the
  // datacenter-IP Cloudflare block on chatgpt.com. Empty = default routing.
  egressLocalAddress: process.env.CODEX_EGRESS_LOCAL_ADDRESS || '',
};

function ts() { return new Date().toISOString().substring(11, 19); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }
function errlog(msg) { console.error(`[${ts()}] ${msg}`); }

// ── broker lease/report (same contract as proxy.js:581/610) ────────────────
function brokerJson(pathname, payload) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(CONFIG.brokerUrl.replace(/\/$/, '') + pathname); }
    catch (e) { e.code = 'BROKER_CONFIG'; return reject(e); }
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        'cache-control': 'no-store',
        authorization: `Bearer ${CONFIG.brokerToken}`,
      },
      timeout: CONFIG.brokerTimeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(text); } catch (_) {}
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`broker ${res.statusCode}`);
          err.code = `BROKER_${res.statusCode}`;
          err.body = parsed;
          return reject(err);
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => { req.destroy(Object.assign(new Error('broker timeout'), { code: 'BROKER_TIMEOUT' })); });
    req.on('error', (e) => { if (!e.code) e.code = 'BROKER_NETWORK'; reject(e); });
    req.end(body);
  });
}

async function leaseCodex(sessionKey) {
  if (!CONFIG.brokerToken) {
    const e = new Error('codex-proxy: no broker token (ELIZA_ACCOUNT_BROKER_TOKEN)');
    e.code = 'BROKER_CONFIG';
    throw e;
  }
  const lease = await brokerJson('/api/internal/account-pool/v1/lease', {
    providerId: CONFIG.providerId,
    sessionKey,
    strategy: CONFIG.strategy,
    exclude: [],
  });
  if (!lease || !lease.leaseId || !lease.accessToken) {
    const e = new Error('codex lease missing leaseId/accessToken');
    e.code = 'BROKER_BAD_RESPONSE';
    throw e;
  }
  return lease;
}

async function reportCodex(lease, outcome) {
  if (!lease || !lease.leaseId) return;
  try {
    const body = {
      leaseId: lease.leaseId,
      ok: !!outcome.ok,
      httpStatus: outcome.httpStatus || 0,
      tokens: outcome.tokens || 0,
      latencyMs: outcome.latencyMs || 0,
    };
    if (outcome.errorCode) body.errorCode = String(outcome.errorCode);
    if (Number.isFinite(outcome.retryAfterMs)) body.retryAfterMs = outcome.retryAfterMs;
    await brokerJson('/api/internal/account-pool/v1/report', body);
  } catch (e) {
    errlog(`codex broker report failed: ${e.code || e.message}`);
  }
}

// ── session key: sticky per pool caller when possible ──────────────────────
const INSTANCE = crypto.randomBytes(8).toString('hex');
let reqCounter = 0;
function deriveSessionKey(req) {
  const explicit = req.headers['x-eliza-session-key'] || req.headers['session_id'];
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim().slice(0, 512);
  const affinity = req.headers['x-session-affinity'] || req.headers['x-request-id'];
  if (typeof affinity === 'string' && affinity.trim()) {
    const h = crypto.createHash('sha256').update(affinity.trim()).digest('hex').slice(0, 32);
    return `codex:header:${h}`;
  }
  return `codex:req:${INSTANCE}:${++reqCounter}`;
}
// A stable session_id header value per session key (uuid-ish), for upstream.
function sessionIdFor(sessionKey) {
  const h = crypto.createHash('sha256').update(sessionKey).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

// ── Codex-CLI upstream header emulation (receipt R2) ───────────────────────
function buildUpstreamHeaders(req, bodyLength, lease, sessionKey) {
  const headers = {};
  // Pass through client headers except auth/host/framing/session-internal.
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (['host', 'connection', 'authorization', 'x-api-key', 'content-length',
      'x-session-affinity', 'x-eliza-session-key', 'accept-encoding'].includes(lk)) continue;
    headers[k] = v;
  }
  headers['authorization'] = `Bearer ${lease.accessToken}`;
  headers['chatgpt-account-id'] = lease.chatgptAccountId || '';
  headers['originator'] = CONFIG.codexOriginator;
  headers['user-agent'] = CONFIG.codexUa;
  headers['session_id'] = sessionIdFor(sessionKey);
  headers['content-length'] = bodyLength;
  headers['accept-encoding'] = 'identity';
  if (!headers['openai-beta']) headers['openai-beta'] = 'responses=experimental';
  if (!headers['accept']) headers['accept'] = 'text/event-stream';
  if (!headers['content-type']) headers['content-type'] = 'application/json';
  return headers;
}

// ── usage parsing from Responses-API SSE (receipt R5) ──────────────────────
// Terminal event `response.completed`.response.usage carries the token counts.
function makeResponsesUsageParser(usage) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]' || !payload) continue;
      let obj; try { obj = JSON.parse(payload); } catch (_) { continue; }
      const u = (obj && obj.response && obj.response.usage) || (obj && obj.usage) || null;
      if (u) {
        if (u.input_tokens != null) usage.input_tokens = u.input_tokens;
        if (u.output_tokens != null) usage.output_tokens = u.output_tokens;
        const cached = u.input_tokens_details && u.input_tokens_details.cached_tokens;
        if (cached != null) usage.cache_read_input_tokens = cached;
      }
    }
  };
}

// ── request handler ────────────────────────────────────────────────────────
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > cap) { reject(Object.assign(new Error('body too large'), { code: 'TOO_LARGE' })); try { req.destroy(); } catch (_) {} return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  if (req.method === 'GET' && urlPath === '/health') {
    return sendJson(res, 200, { ok: true, service: 'codex-proxy', provider: CONFIG.providerId, hasBrokerToken: !!CONFIG.brokerToken });
  }

  // Only the Responses API path is served (v1/responses; also accept /responses).
  const isResponses = req.method === 'POST' && /\/responses$/.test(urlPath);
  if (!isResponses) {
    return sendJson(res, 404, { error: { type: 'not_found', message: 'codex-proxy serves POST .../responses only' } });
  }

  const start = Date.now();
  const sessionKey = deriveSessionKey(req);
  let body;
  try { body = await readBody(req, 32 * 1024 * 1024); }
  catch (e) { return sendJson(res, 413, { error: { type: 'invalid_request_error', message: 'request body too large' } }); }

  // OpenClaw's generic Responses transport includes parameters that the
  // ChatGPT Codex backend rejects. Normalize only those known-unsupported
  // transport fields; preserve the prompt, tools, model, and input verbatim.
  try {
    const payload = JSON.parse(body.toString('utf8'));
    for (const key of ['max_output_tokens', 'metadata', 'prompt_cache_retention', 'service_tier', 'temperature']) {
      delete payload[key];
    }
    // The ChatGPT Codex backend rejects stored responses: it requires
    // `store:false` on every Responses call ("Store must be set to false").
    // Generic Responses clients omit it; inject it so callers don't need to
    // know this codex-specific quirk. Caller can still send store:false itself.
    payload.store = false;
    body = Buffer.from(JSON.stringify(payload), 'utf8');
  } catch (_) {
    return sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'request body must be valid JSON' } });
  }

  let lease;
  try { lease = await leaseCodex(sessionKey); }
  catch (e) {
    errlog(`codex lease failed: ${e.code || e.message}`);
    return sendJson(res, 503, { error: { type: 'api_error', message: `codex account lease failed (${e.code || 'error'})` } });
  }

  // Mutable so a CF-challenge retry can swap in a FRESH seat (different ChatGPT
  // account => different cf-clearance fingerprint). buildUpstreamHeaders bakes
  // the leased token + account id into the headers, so both must be rebuilt when
  // the lease changes.
  let headers = buildUpstreamHeaders(req, body.length, lease, sessionKey);
  const target = new URL(CONFIG.upstreamBase.replace(/\/$/, '') + '/responses');
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  const parseUsage = makeResponsesUsageParser(usage);

  // ── CF-challenge-aware retrying sender ────────────────────────────────────
  // ChatGPT's Cloudflare edge intermittently 403-challenges requests from the
  // datacenter host IP (`cf-mitigated: challenge`). That 403 is NOT an OpenAI
  // auth failure: the leased token is valid. But a naive report of httpStatus
  // 403 makes the broker classify the seat `needs-reauth` and pull it, which
  // cascades into BROKER_503 for every subsequent call. The reliable fix:
  //   1. Peek the upstream status BEFORE streaming to the client.
  //   2. If it's a Cloudflare challenge 403 (not a real OpenAI auth 403),
  //      retry with a fresh connection + jittered backoff up to N times.
  //   3. Only stream a response we've decided to keep. Report a genuine 2xx/
  //      4xx/5xx accurately; report a persistent CF challenge as a TRANSIENT
  //      failure (`errorCode: cf_challenge`, httpStatus 503) so the broker
  //      cools the seat briefly instead of nuking it as auth-dead. A real
  //      OpenAI auth 403 (JSON body, no cf-mitigated) is passed through so
  //      legitimate reauth still surfaces.
  // A CF challenge tends to stick to one seat+IP fingerprint, so the highest-
  // leverage lever is re-leasing a FRESH seat between challenge retries rather
  // than hammering the same account. We allow more attempts now that each retry
  // can rotate the serving account.
  const MAX_ATTEMPTS = 6;
  // Track seats we've already burned a CF challenge on this request so a fresh
  // lease that hands back the same account doesn't get re-tried pointlessly.
  const triedSeats = new Set();
  if (lease.chatgptAccountId) triedSeats.add(String(lease.chatgptAccountId));

  // Re-lease a fresh codex seat mid-flight (CF-challenge recovery). Reports the
  // current lease as a transient cf cooldown (keeps the seat alive, just rests
  // it) and swaps lease+headers to the new seat. Returns false if we couldn't
  // get a usably-different seat.
  const rotateSeat = async (reason) => {
    try {
      reportCodex(lease, { ok: false, httpStatus: 503, tokens: 0, latencyMs: Date.now() - start, errorCode: reason || 'cf_challenge' });
    } catch (_) {}
    let next;
    try { next = await leaseCodex(sessionKey); }
    catch (e) { errlog(`codex re-lease failed: ${e.code || e.message}`); return false; }
    lease = next;
    headers = buildUpstreamHeaders(req, body.length, lease, sessionKey);
    if (lease.chatgptAccountId) triedSeats.add(String(lease.chatgptAccountId));
    return true;
  };
  const isCloudflareChallenge = (upRes, firstChunk) => {
    if ((upRes.statusCode || 0) !== 403) return false;
    const cfm = String(upRes.headers['cf-mitigated'] || '').toLowerCase();
    if (cfm.includes('challenge')) return true;
    const server = String(upRes.headers['server'] || '').toLowerCase();
    const ct = String(upRes.headers['content-type'] || '').toLowerCase();
    const head = (firstChunk ? firstChunk.toString('utf8', 0, 512) : '').toLowerCase();
    // Cloudflare block/challenge pages are HTML from the cloudflare server and
    // do NOT carry an OpenAI JSON error envelope ({"detail":...} / {"error":..}).
    if (server.includes('cloudflare') && (ct.includes('text/html') || head.includes('<!doctype') || head.includes('cf-ray') || head.includes('cloudflare'))) return true;
    // Fallback: a 403 with no OpenAI JSON error shape from the CF edge.
    if (server.includes('cloudflare') && !head.includes('"detail"') && !head.includes('"error"') && !head.includes('"type"')) return true;
    return false;
  };

  const buildOpts = () => {
    const o = {
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname,
      method: 'POST',
      // Fresh connection per attempt: no keepalive reuse, which reduces the
      // burst-fingerprinting that makes CF challenge a warm socket.
      headers: { ...headers, connection: 'close' },
      agent: false,
      timeout: CONFIG.upstreamTimeoutMs,
      // Force IPv4. chatgpt.com resolves IPv6-first, and node honors that by
      // default, egressing over eth0's IPv6 (the datacenter IP Cloudflare
      // challenges) and BYPASSING our IPv4 tun0 route pins. Pinning family:4
      // makes every codex upstream connection take the VPN-routed v4 path, which
      // returns clean auth instead of a CF challenge. tun0 has no usable v6
      // egress anyway, so v4 is strictly correct here.
      family: 4,
    };
    if (CONFIG.egressLocalAddress) o.localAddress = CONFIG.egressLocalAddress;
    return o;
  };

  const finishOk = (upRes, firstChunk) => {
    const outHeaders = { ...upRes.headers };
    for (const h of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer']) delete outHeaders[h];
    // Seat attribution for the metering layer. pool-meter consumes + STRIPS it.
    if (lease.chatgptAccountId) outHeaders['x-codex-seat'] = String(lease.chatgptAccountId);
    res.writeHead(upRes.statusCode || 502, outHeaders);
    if (firstChunk && firstChunk.length) { try { parseUsage(firstChunk); } catch (_) {} res.write(firstChunk); }
    upRes.on('data', (chunk) => { try { parseUsage(chunk); } catch (_) {} res.write(chunk); });
    upRes.on('end', () => {
      res.end();
      const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
      const sc = upRes.statusCode || 0;
      reportCodex(lease, { ok: sc >= 200 && sc < 300, httpStatus: sc, tokens, latencyMs: Date.now() - start });
      log(`codex ${sc} in=${usage.input_tokens} out=${usage.output_tokens} cr=${usage.cache_read_input_tokens} ${Date.now() - start}ms`);
    });
  };

  const attempt = (n) => {
    const upReq = https.request(buildOpts(), (upRes) => {
      const sc = upRes.statusCode || 0;
      // Peek the first chunk so we can classify a 403 before committing to stream.
      let firstChunk = null;
      let decided = false;
      const decide = () => {
        if (decided) return; decided = true;
        if (isCloudflareChallenge(upRes, firstChunk)) {
          // Transient CF challenge. Drain the challenge body, then RE-LEASE a
          // fresh seat and retry on a fresh connection. Rotating the account is
          // what actually clears it: CF is fingerprinting seat+IP, so a new
          // account usually sails through where the old one keeps getting walled.
          try { upRes.resume(); } catch (_) {}
          if (n < MAX_ATTEMPTS) {
            // Longer floor than the network-error path: CF wants a beat, and we
            // rotate the seat during the wait.
            const backoff = Math.min(4000, 400 * Math.pow(2, n - 1)) + Math.floor(Math.random() * 300);
            log(`codex 403(cf-challenge) seat=${lease.chatgptAccountId || '?'} attempt ${n}/${MAX_ATTEMPTS}, rotating seat + retry in ${backoff}ms`);
            setTimeout(() => {
              rotateSeat('cf_challenge').then((ok) => {
                if (!ok) {
                  // Couldn't get a fresh seat; retry once more on the same one
                  // rather than hard-failing, then let the attempt cap end it.
                  errlog('codex re-lease unavailable during cf-challenge; retrying same seat');
                }
                attempt(n + 1);
              });
            }, backoff);
          } else {
            // Persisted across retries + seat rotations. Report TRANSIENT (not
            // auth) so the seat is cooled briefly, not marked needs-reauth.
            errlog(`codex cf-challenge persisted after ${MAX_ATTEMPTS} attempts (rotated ${triedSeats.size} seats)`);
            reportCodex(lease, { ok: false, httpStatus: 503, tokens: 0, latencyMs: Date.now() - start, errorCode: 'cf_challenge' });
            if (!res.headersSent) sendJson(res, 503, { error: { type: 'api_error', message: 'codex upstream temporarily unavailable (cf-challenge); retry shortly' } });
            else try { res.end(); } catch (_) {}
          }
          return;
        }
        // Not a CF challenge: a real upstream response (2xx or genuine 4xx/5xx).
        finishOk(upRes, firstChunk);
      };
      // If the status is a plausible challenge, wait for the first chunk to
      // inspect the body; otherwise decide immediately on headers.
      if (sc === 403) {
        upRes.once('data', (chunk) => { firstChunk = chunk; decide(); });
        upRes.once('end', () => decide());
      } else {
        decide();
      }
    });
    upReq.on('timeout', () => { upReq.destroy(new Error('upstream timeout')); });
    upReq.on('error', (e) => {
      // Network-level error: retry a couple times (transient), then 502.
      if (n < MAX_ATTEMPTS && (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'EPIPE' || e.message === 'upstream timeout')) {
        const backoff = Math.min(1500, 150 * Math.pow(2, n - 1)) + Math.floor(Math.random() * 200);
        errlog(`codex upstream ${e.code || e.message}; retry ${n}/${MAX_ATTEMPTS} in ${backoff}ms`);
        setTimeout(() => attempt(n + 1), backoff);
        return;
      }
      errlog(`codex upstream error: ${e.code || e.message}`);
      // Network failures are transient, not auth: report 503 so the seat lives.
      reportCodex(lease, { ok: false, httpStatus: 503, tokens: 0, latencyMs: Date.now() - start, errorCode: e.code || 'upstream_error' });
      if (!res.headersSent) sendJson(res, 502, { error: { type: 'api_error', message: 'codex upstream unavailable' } });
      else try { res.end(); } catch (_) {}
    });
    upReq.end(body);
  };

  attempt(1);
});

server.listen(CONFIG.listenPort, CONFIG.listenHost, () => {
  log(`codex-proxy listening on ${CONFIG.listenHost}:${CONFIG.listenPort} provider=${CONFIG.providerId} upstream=${CONFIG.upstreamBase} brokerToken=${CONFIG.brokerToken ? 'present' : 'MISSING'}`);
});
