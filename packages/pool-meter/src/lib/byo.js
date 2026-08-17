'use strict';
// byo.js — Bring-Your-Own-token credential store for the universal proxy.
//
// Users register their OWN provider API keys. The pool proxies + meters their
// traffic but spends none of the pooled subscription quota for them. Their
// token is forwarded straight to the provider's real API endpoint.
//
// SECURITY POSTURE (v1, single-box deployment, no HSM):
//  - Tokens are encrypted at rest with AES-256-GCM. The 32-byte master key
//    lives in an out-of-tree, 0600 file (secretsDir/pool-byo-master.key),
//    auto-generated once with crypto.randomBytes if absent. This matches the
//    existing deployment posture (the OAuth refresh tokens already live in a
//    root-owned file on one box, not a vault — join-page.js). The alternative
//    (per-request KMS/age) was rejected for v1: no infra for it, and it would
//    not raise the real security floor on a single box.
//  - Ciphertext is stored in secretsDir/pool-byo-creds.json (0600), keyed by a
//    SHA-256 hash of the pool key so the plaintext pool key is never a filename
//    or JSON key. NEVER written to pool-keys.json. NEVER logged.
//  - Decryption happens only in memory, at request time, to set the upstream
//    Authorization/x-api-key header. The plaintext token is never logged, never
//    traced, never returned by any read endpoint (only a masked suffix).
//
// Node stdlib only.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Provider table — small, easy to extend. `endpoint` is the real provider API
// host; `authHeader` + `scheme` describe how the user's token is presented.
// `pathPrefix` is the public route prefix on pool-meter that maps to this
// provider for BYO. anthropic + openai reuse the existing leg prefixes; a BYO
// credential for that pool key short-circuits the pooled path (see pool-meter).
const PROVIDERS = {
  anthropic: {
    host: 'api.anthropic.com',
    port: 443,
    authHeader: 'x-api-key',
    scheme: 'raw',          // header value = token verbatim
    stripPrefix: '/v1',     // pool route /v1/* -> upstream /v1/*  (no strip)
    keepPrefix: true,
  },
  openai: {
    host: 'api.openai.com',
    port: 443,
    authHeader: 'authorization',
    scheme: 'bearer',       // header value = "Bearer <token>"
    stripPrefix: '/openai', // pool route /openai/v1/* -> upstream /v1/*
    keepPrefix: false,
  },
  openrouter: {
    host: 'openrouter.ai',
    port: 443,
    authHeader: 'authorization',
    scheme: 'bearer',
    stripPrefix: '/openrouter', // pool route /openrouter/api/v1/* -> upstream /api/v1/*
    keepPrefix: false,
  },
};

function knownProvider(p) { return Object.prototype.hasOwnProperty.call(PROVIDERS, p); }

class ByoStore {
  constructor({ secretsDir }) {
    this.secretsDir = secretsDir;
    this.credsFile = path.join(secretsDir, 'pool-byo-creds.json');
    this.masterFile = path.join(secretsDir, 'pool-byo-master.key');
    this._master = null;
    this._creds = null;      // { <sha256(poolKey)>: { <provider>: {iv,tag,ct,addedAt,last4} } }
    this._mtime = 0;
    this._load();
  }

  // ---- master key (32 bytes, auto-generated once, 0600) ----
  _masterKey() {
    if (this._master) return this._master;
    try {
      const raw = fs.readFileSync(this.masterFile);
      if (raw.length >= 32) { this._master = raw.slice(0, 32); return this._master; }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const key = crypto.randomBytes(32);
    const tmp = this.masterFile + '.tmp';
    fs.writeFileSync(tmp, key, { mode: 0o600 });
    fs.renameSync(tmp, this.masterFile);
    try { fs.chmodSync(this.masterFile, 0o600); } catch (_) {}
    this._master = key;
    console.log('byo: generated new master key (0600) at pool-byo-master.key');
    return this._master;
  }

  _hashKey(poolKey) {
    return crypto.createHash('sha256').update(String(poolKey)).digest('hex');
  }

  _load() {
    try {
      const st = fs.statSync(this.credsFile);
      if (st.mtimeMs === this._mtime && this._creds) return;
      this._creds = JSON.parse(fs.readFileSync(this.credsFile, 'utf8')) || {};
      this._mtime = st.mtimeMs;
    } catch (e) {
      if (e.code === 'ENOENT') { this._creds = {}; return; }
      console.error('byo: creds load error:', e.message);
      if (!this._creds) this._creds = {};
    }
  }

  _persist() {
    const tmp = this.credsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this._creds, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.credsFile);
    try { fs.chmodSync(this.credsFile, 0o600); } catch (_) {}
    try { this._mtime = fs.statSync(this.credsFile).mtimeMs; } catch (_) {}
  }

  _encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this._masterKey(), iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64') };
  }

  _decrypt(rec) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', this._masterKey(), Buffer.from(rec.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(rec.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(rec.ct, 'base64')), decipher.final()]).toString('utf8');
  }

  // Register (or replace) a BYO credential for pool key + provider.
  // Returns a safe summary (no plaintext token). Throws on unknown provider or
  // empty token so the caller can 400.
  set(poolKey, provider, token) {
    provider = String(provider || '').toLowerCase();
    if (!knownProvider(provider)) throw new Error(`unknown provider '${provider}'. known: ${Object.keys(PROVIDERS).join(', ')}`);
    token = String(token || '').trim();
    if (!token) throw new Error('token required');
    this._load();
    const h = this._hashKey(poolKey);
    const bucket = this._creds[h] || (this._creds[h] = {});
    const last4 = token.length >= 4 ? token.slice(-4) : token;
    bucket[provider] = { ...this._encrypt(token), addedAt: new Date().toISOString(), last4 };
    this._persist();
    return { provider, last4, addedAt: bucket[provider].addedAt };
  }

  // List providers this pool key has BYO creds for (masked). No plaintext.
  list(poolKey) {
    this._load();
    const h = this._hashKey(poolKey);
    const bucket = this._creds[h] || {};
    return Object.keys(bucket).map((provider) => ({
      provider,
      last4: bucket[provider].last4 || null,
      addedAt: bucket[provider].addedAt || null,
    }));
  }

  // True if this pool key has a BYO credential for the given provider.
  has(poolKey, provider) {
    this._load();
    const bucket = this._creds[this._hashKey(poolKey)];
    return !!(bucket && bucket[String(provider || '').toLowerCase()]);
  }

  // Decrypt the token for request-time forwarding. Returns null if absent.
  // The returned plaintext MUST NOT be logged or traced.
  get(poolKey, provider) {
    this._load();
    provider = String(provider || '').toLowerCase();
    const bucket = this._creds[this._hashKey(poolKey)];
    if (!bucket || !bucket[provider]) return null;
    try { return this._decrypt(bucket[provider]); }
    catch (e) { console.error('byo: decrypt failed (master key mismatch?):', e.message); return null; }
  }

  // Remove a BYO credential. Returns true if something was deleted.
  remove(poolKey, provider) {
    this._load();
    provider = String(provider || '').toLowerCase();
    const h = this._hashKey(poolKey);
    const bucket = this._creds[h];
    if (!bucket || !bucket[provider]) return false;
    delete bucket[provider];
    if (Object.keys(bucket).length === 0) delete this._creds[h];
    this._persist();
    return true;
  }
}

module.exports = { ByoStore, PROVIDERS, knownProvider };
