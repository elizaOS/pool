'use strict';
// join.js — invite tokens, trust tiers, key minting, contribution ledger.
//
// This is the state layer behind /join. It never talks HTTP and never talks to
// the broker; pool-meter.js owns both. Keeping it separate means the mint path
// is unit-testable without standing up a server or touching a real OAuth flow.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store.js');

// Resolved the same way lib/config.js resolves everything else. Previously
// hardcoded, which meant a staging copy on a scratch port silently read and
// (worse) could WRITE the production keys file — so the mint path could not be
// exercised off-prod at all. Defaults are unchanged, so production behavior is
// identical with the env vars unset.
const SECRETS_DIR = process.env.POOL_METER_SECRETS_DIR || '/opt/pool/secrets';
const LOG_DIR = process.env.POOL_METER_LOG_DIR || '/opt/pool/logs/pool-meter';
const KEYS_FILE = process.env.POOL_METER_KEYS_FILE || path.join(SECRETS_DIR, 'pool-keys.json');
const INVITES_FILE = path.join(SECRETS_DIR, 'pool-invites.json');
const JOIN_SECRET_FILE = path.join(SECRETS_DIR, 'pool-join.secret');
const LEDGER_FILE = path.join(LOG_DIR, 'join-events.jsonl');

const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

// ---- trust tiers -----------------------------------------------------------
// One source of truth. The quota gate and the model gate both read from here,
// so a tier change cannot drift between enforcement points.
const TIERS = {
  donor: {
    name: 'donor',
    baseQuota: 250_000_000,
    // Earned quota: every 1% of weekly capacity a donor makes available is
    // worth CAPACITY_TOKEN_VALUE tokens of their own consumption. See
    // earnedQuota() for the whole formula in one place.
    capacityMultiplier: 1.0,
    models: null, // null = no restriction
  },
  invited: {
    name: 'invited',
    baseQuota: 50_000_000,
    capacityMultiplier: 0,
    models: null,
  },
  demo: {
    name: 'demo',
    baseQuota: 2_000_000,
    capacityMultiplier: 0,
    // Cheap models only. Matched case-insensitively as a prefix so dated
    // model ids (claude-fable-5-20260101) resolve to the same rule.
    models: ['claude-fable-5', 'claude-sonnet-4-6'],
  },
};
const DEFAULT_TIER = 'invited';

// One percentage point of one account's weekly window, expressed in tokens.
// A Max seat's weekly window is far larger than this; the number is
// deliberately conservative so earned quota is generous but not unbounded.
const CAPACITY_TOKEN_VALUE = 2_000_000;
// Hard ceiling so a bug in capacity reporting cannot mint infinite quota.
const MAX_EARNED_QUOTA = 5_000_000_000;

function tierFor(name) {
  return TIERS[name] || TIERS[DEFAULT_TIER];
}

/**
 * earned_quota = base + contributed_capacity_pct * multiplier * token_value
 *
 * `contributedPct` is how much weekly capacity this donor's seat has actually
 * made available to the pool, in percentage points (0..100 per seat). It comes
 * from live broker usage, never from anything the donor controls.
 */
function earnedQuota(tierName, contributedPct) {
  const tier = tierFor(tierName);
  const pct = Number.isFinite(contributedPct) ? Math.max(0, contributedPct) : 0;
  const earned = tier.baseQuota + pct * tier.capacityMultiplier * CAPACITY_TOKEN_VALUE;
  return Math.min(MAX_EARNED_QUOTA, Math.round(earned));
}

/** Does `tier` permit `model`? Unknown/absent model is allowed (non-inference routes). */
function modelAllowed(tierName, model) {
  const tier = tierFor(tierName);
  if (!tier.models) return true;
  if (!model) return true;
  const m = String(model).toLowerCase();
  return tier.models.some((allowed) => m.startsWith(allowed));
}

// ---- signing secret --------------------------------------------------------
let joinSecret = null;
function getSecret() {
  if (joinSecret) return joinSecret;
  try {
    const raw = fs.readFileSync(JOIN_SECRET_FILE, 'utf8').trim();
    if (raw.length >= 32) {
      joinSecret = raw;
      return joinSecret;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const generated = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(JOIN_SECRET_FILE, `${generated}\n`, { mode: 0o600 });
  fs.chmodSync(JOIN_SECRET_FILE, 0o600);
  joinSecret = generated;
  return joinSecret;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
}

/**
 * Mint a signed invite token. The token is self-describing (id, tier, expiry)
 * and HMAC-signed, so a forged or edited token fails verification before any
 * state is touched. Single-use enforcement is separate, in the invite store.
 */
function createInvite({ tier = DEFAULT_TIER, note = '', ttlMs = INVITE_TTL_MS, createdBy = 'admin' } = {}) {
  const id = crypto.randomBytes(9).toString('base64url');
  const expiresAt = Date.now() + Math.max(60_000, ttlMs);
  const payload = { i: id, t: tierFor(tier).name, e: expiresAt };
  const payloadB64 = b64url(JSON.stringify(payload));
  const token = `${payloadB64}.${sign(payloadB64)}`;
  store.update(INVITES_FILE, () => ({ invites: {} }), (data) => {
    const invites = data.invites || {};
    invites[id] = {
      id,
      tier: payload.t,
      note: String(note || '').slice(0, 200),
      createdAt: Date.now(),
      createdBy,
      expiresAt,
      status: 'unused',
      usedAt: null,
      keyLabel: null,
      activeSessionId: null,
      activeSessionAt: null,
      starts: [],
    };
    return { ...data, invites };
  });
  return { id, token, tier: payload.t, expiresAt };
}

/**
 * Verify a token's signature and expiry, then check single-use state.
 * Returns { ok, reason, invite }. Signature is compared in constant time.
 */
function verifyInvite(token) {
  if (typeof token !== 'string' || token.length > 512 || !token.includes('.')) {
    return { ok: false, reason: 'malformed' };
  }
  const [payloadB64, sig] = token.split('.', 2);
  if (!payloadB64 || !sig) return { ok: false, reason: 'malformed' };
  const expected = sign(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad signature' };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (_) {
    return { ok: false, reason: 'malformed' };
  }
  if (!payload || typeof payload.i !== 'string') return { ok: false, reason: 'malformed' };
  if (typeof payload.e !== 'number' || Date.now() > payload.e) {
    return { ok: false, reason: 'expired' };
  }
  const data = store.readJsonSync(INVITES_FILE, { invites: {} });
  const invite = (data.invites || {})[payload.i];
  if (!invite) return { ok: false, reason: 'unknown invite' };
  if (invite.status === 'used') return { ok: false, reason: 'already used' };
  if (invite.status === 'revoked') return { ok: false, reason: 'revoked' };
  if (Date.now() > invite.expiresAt) return { ok: false, reason: 'expired' };
  return { ok: true, invite, tier: invite.tier || DEFAULT_TIER };
}

function listInvites() {
  const data = store.readJsonSync(INVITES_FILE, { invites: {} });
  return Object.values(data.invites || {}).sort((x, y) => y.createdAt - x.createdAt);
}

/**
 * Record a flow start against an invite, enforcing one live flow per invite and
 * a per-invite start ceiling. Returns { ok, reason }.
 */
function claimFlowStart(inviteId, sessionId, maxStarts = 5) {
  let outcome = { ok: false, reason: 'unknown invite' };
  store.update(INVITES_FILE, () => ({ invites: {} }), (data) => {
    const invites = data.invites || {};
    const inv = invites[inviteId];
    if (!inv) return null;
    if (inv.status !== 'unused') {
      outcome = { ok: false, reason: `invite ${inv.status}` };
      return null;
    }
    // A stale in-flight session (broker flows time out at 15m) must not lock
    // the invite forever; expire it rather than making the donor ask for a new
    // invite because they closed a tab.
    const liveAge = inv.activeSessionAt ? Date.now() - inv.activeSessionAt : Infinity;
    if (inv.activeSessionId && liveAge < 15 * 60 * 1000) {
      outcome = { ok: false, reason: 'a login for this invite is already in progress' };
      return null;
    }
    const starts = (inv.starts || []).filter((ts) => Date.now() - ts < 60 * 60 * 1000);
    if (starts.length >= maxStarts) {
      outcome = { ok: false, reason: 'too many attempts for this invite, ask for a new one' };
      return null;
    }
    starts.push(Date.now());
    invites[inviteId] = {
      ...inv,
      starts,
      activeSessionId: sessionId,
      activeSessionAt: Date.now(),
      previousSessionId: inv.activeSessionId || null,
    };
    outcome = { ok: true };
    return { ...data, invites };
  });
  return outcome;
}

function releaseFlow(inviteId, sessionId) {
  store.update(INVITES_FILE, () => ({ invites: {} }), (data) => {
    const invites = data.invites || {};
    const inv = invites[inviteId];
    if (!inv || inv.activeSessionId !== sessionId) return null;
    invites[inviteId] = { ...inv, activeSessionId: null, activeSessionAt: null };
    return { ...data, invites };
  });
}

function consumeInvite(inviteId, keyLabel) {
  store.update(INVITES_FILE, () => ({ invites: {} }), (data) => {
    const invites = data.invites || {};
    const inv = invites[inviteId];
    if (!inv) return null;
    invites[inviteId] = {
      ...inv,
      status: 'used',
      usedAt: Date.now(),
      keyLabel,
      activeSessionId: null,
      activeSessionAt: null,
    };
    return { ...data, invites };
  });
}

function revokeInvite(inviteId) {
  let found = false;
  store.update(INVITES_FILE, () => ({ invites: {} }), (data) => {
    const invites = data.invites || {};
    const inv = invites[inviteId];
    if (!inv || inv.status === 'used') return null;
    found = true;
    invites[inviteId] = { ...inv, status: 'revoked', activeSessionId: null };
    return { ...data, invites };
  });
  return found;
}

// ---- key minting -----------------------------------------------------------

function uniqueLabel(existingLabels, base) {
  const clean =
    String(base || 'donor')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'donor';
  if (!existingLabels.has(clean)) return clean;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${clean}-${n}`;
    if (!existingLabels.has(candidate)) return candidate;
  }
  return `${clean}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Mint a pool key. Runs entirely inside the pool-keys.json lock: the label
 * uniqueness check and the append are one critical section, so two concurrent
 * mints can never produce duplicate labels or lose a key. Returns the full
 * record including the plaintext key, which the caller shows exactly once and
 * must never log.
 */
function mintKey({ labelBase, tier = 'donor', contributedAccountId = null, inviteId = null, contributedPct = 0, provider = 'anthropic-subscription', ownerUserId = null, uniqueOwner = false }) {
  const key = `sk-pool-${crypto.randomBytes(24).toString('base64url')}`;
  let minted = null;
  store.update(KEYS_FILE, () => ({ keys: [] }), (data) => {
    const keys = Array.isArray(data.keys) ? data.keys : [];
    // Open-join duplicate backstop (2026-07-31): when the caller asks for
    // uniqueOwner, the one-active-key-per-user check runs INSIDE this lock,
    // so two concurrent open-join flows for the same user cannot both mint.
    // The pre-existing record is returned (marked duplicate) instead of a new
    // key. Invite-driven mints never set the flag: an invite is an explicit
    // operator grant and may add a second key.
    if (uniqueOwner && ownerUserId) {
      const existing = keys.find((k) => k.ownerUserId === ownerUserId && k.enabled !== false);
      if (existing) {
        minted = { ...existing, duplicate: true };
        return null; // no write
      }
    }
    const labels = new Set(keys.map((k) => k.label).filter(Boolean));
    const label = uniqueLabel(labels, labelBase);
    const record = {
      key,
      label,
      enabled: true,
      admin: false,
      tier: tierFor(tier).name,
      quota: earnedQuota(tier, contributedPct),
      donor: tier === 'donor',
      contributedAccountId,
      // Which broker provider this donor's seat lives under. Needed so revoke
      // deletes the right account (anthropic-subscription vs openai-codex).
      contributedProvider: provider || 'anthropic-subscription',
      inviteId,
      // Steward identity that owns this key, when the donor was signed in at
      // mint time. OPTIONAL and additive: headless mints leave it null and
      // behave exactly as before. Never client-supplied; the caller passes a
      // userId only after lib/account.js verified the session.
      ...(ownerUserId ? { ownerUserId } : {}),
      created: new Date().toISOString(),
      source: 'join',
    };
    minted = record;
    return { ...data, keys: [...keys, record] };
  }, 0o600);
  if (!minted) throw new Error('mint failed: keys file not written');
  return minted;
}

/** Disable a key by label. Returns true if a key changed state. */
function disableKeyByLabel(label) {
  let changed = false;
  store.update(KEYS_FILE, () => ({ keys: [] }), (data) => {
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const next = keys.map((k) => {
      if (k.label === label && k.enabled !== false) {
        changed = true;
        return { ...k, enabled: false, disabledAt: new Date().toISOString() };
      }
      return k;
    });
    return changed ? { ...data, keys: next } : null;
  }, 0o600);
  return changed;
}

function markBrokerRevoked(label, detail = {}) {
  let changed = false;
  store.update(KEYS_FILE, () => ({ keys: [] }), (data) => {
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const next = keys.map((k) => {
      if (k.label !== label) return k;
      changed = true;
      return {
        ...k,
        brokerRevokedAt: new Date().toISOString(),
        brokerRevocation: {
          ...(k.brokerRevocation || {}),
          ...detail,
          status: detail.status || 'deleted',
        },
      };
    });
    return changed ? { ...data, keys: next } : null;
  }, 0o600);
  return changed;
}

function markBrokerRevocationFailed(label, detail = {}) {
  let changed = false;
  store.update(KEYS_FILE, () => ({ keys: [] }), (data) => {
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const next = keys.map((k) => {
      if (k.label !== label) return k;
      changed = true;
      return {
        ...k,
        brokerRevocation: {
          ...(k.brokerRevocation || {}),
          ...detail,
          status: 'failed',
          failedAt: new Date().toISOString(),
        },
      };
    });
    return changed ? { ...data, keys: next } : null;
  }, 0o600);
  return changed;
}

/** Re-price every donor key from live contributed capacity. */
function syncDonorQuotas(contributedByAccountId) {
  const changes = [];
  store.update(KEYS_FILE, () => ({ keys: [] }), (data) => {
    const keys = Array.isArray(data.keys) ? data.keys : [];
    let dirty = false;
    const next = keys.map((k) => {
      if (!k.donor || !k.contributedAccountId) return k;
      const pct = contributedByAccountId[k.contributedAccountId];
      if (!Number.isFinite(pct)) return k;
      const q = earnedQuota(k.tier || 'donor', pct);
      if (q === k.quota) return k;
      dirty = true;
      changes.push({ label: k.label, from: k.quota, to: q, contributedPct: pct });
      return { ...k, quota: q };
    });
    return dirty ? { ...data, keys: next } : null;
  }, 0o600);
  return changes;
}

function listKeys() {
  const data = store.readJsonSync(KEYS_FILE, { keys: [] });
  return Array.isArray(data.keys) ? data.keys : [];
}

// ---- Steward account ownership (additive, 2026-07-30) ----------------------
// A key record MAY carry ownerUserId: the verified Steward userId that owns
// it. Old records without the field keep working headless forever.

/** Every key owned by a verified Steward user. Never includes other users'. */
function keysOwnedBy(userId) {
  if (!userId || typeof userId !== 'string') return [];
  return listKeys().filter((k) => k.ownerUserId === userId);
}

/** The user's active (enabled) key, or null. Drives the open-join duplicate
 *  gate: one active key per steward userId unless an invite elevates. */
function activeKeyOwnedBy(userId) {
  if (!userId || typeof userId !== 'string') return null;
  return listKeys().find((k) => k.ownerUserId === userId && k.enabled !== false) || null;
}

/**
 * Claim an existing key for a Steward user by proving possession of the raw
 * key. Runs inside the keys-file lock. Refuses to steal: a key already owned
 * by a DIFFERENT user is not reassigned. Returns { ok, reason?, label? }.
 * The raw key is used only as a lookup credential and never stored anew,
 * logged, or echoed back.
 */
function claimKeyByRawKey(rawKey, userId) {
  if (typeof rawKey !== 'string' || rawKey.length < 8 || rawKey.length > 256) {
    return { ok: false, reason: 'malformed key' };
  }
  if (!userId || typeof userId !== 'string') return { ok: false, reason: 'no user' };
  let outcome = { ok: false, reason: 'unknown key' };
  store.update(KEYS_FILE, () => ({ keys: [] }), (data) => {
    const keys = Array.isArray(data.keys) ? data.keys : [];
    const idx = keys.findIndex((k) => k.key === rawKey);
    if (idx === -1) return null; // outcome stays 'unknown key'
    const rec = keys[idx];
    if (rec.ownerUserId && rec.ownerUserId !== userId) {
      outcome = { ok: false, reason: 'already claimed' };
      return null;
    }
    if (rec.ownerUserId === userId) {
      outcome = { ok: true, label: rec.label, alreadyOwned: true };
      return null; // no write needed
    }
    const next = [...keys];
    next[idx] = { ...rec, ownerUserId: userId, claimedAt: new Date().toISOString() };
    outcome = { ok: true, label: rec.label, alreadyOwned: false };
    return { ...data, keys: next };
  }, 0o600);
  return outcome;
}

// ---- audit ledger ----------------------------------------------------------
// Append-only. Never contains a key, an OAuth code, or a token.
function logEvent(event) {
  store.appendJsonl(LEDGER_FILE, { ts: new Date().toISOString(), ...event });
}

function readEvents(limit = 500) {
  try {
    const lines = fs.readFileSync(LEDGER_FILE, 'utf8').split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

module.exports = {
  TIERS,
  DEFAULT_TIER,
  CAPACITY_TOKEN_VALUE,
  MAX_EARNED_QUOTA,
  INVITE_TTL_MS,
  KEYS_FILE,
  INVITES_FILE,
  LEDGER_FILE,
  tierFor,
  earnedQuota,
  modelAllowed,
  createInvite,
  verifyInvite,
  listInvites,
  claimFlowStart,
  releaseFlow,
  consumeInvite,
  revokeInvite,
  mintKey,
  keysOwnedBy,
  activeKeyOwnedBy,
  claimKeyByRawKey,
  disableKeyByLabel,
  markBrokerRevoked,
  markBrokerRevocationFailed,
  syncDonorQuotas,
  listKeys,
  logEvent,
  readEvents,
};
