'use strict';
// config.js — every deployment-specific value and every credential in one place,
// resolved from the environment or an out-of-tree secrets file.
//
// THIS FILE MUST NEVER CONTAIN A CREDENTIAL. The repo is private, but "private
// repo" is not a secret store: clones, forks, CI logs and screen shares all
// leak. Precedence is env var -> secrets JSON -> safe non-secret default. A
// missing credential degrades the dependent feature and logs once; it never
// hardcodes a fallback token.

const fs = require('fs');
const path = require('path');

const SECRETS_DIR = process.env.POOL_METER_SECRETS_DIR || '/opt/pool/secrets';
const CONFIG_FILE = process.env.POOL_METER_CONFIG || path.join(SECRETS_DIR, 'pool-meter.config.json');

let fileConfig = {};
try {
  fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') console.error(`config: ${CONFIG_FILE} unreadable: ${err.message}`);
}

function pick(envName, fileKey, fallback) {
  if (process.env[envName]) return process.env[envName];
  if (fileConfig[fileKey] !== undefined && fileConfig[fileKey] !== null) return fileConfig[fileKey];
  return fallback;
}

function num(envName, fileKey, fallback) {
  const v = pick(envName, fileKey, undefined);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readSecretFile(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch (_) { return ''; }
}

const warned = new Set();
function warnOnce(msg) {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.error(`config: ${msg}`);
}

const config = {
  secretsDir: SECRETS_DIR,
  configFile: CONFIG_FILE,

  listenHost: pick('POOL_METER_HOST', 'listenHost', '127.0.0.1'),
  listenPort: num('POOL_METER_PORT', 'listenPort', 18811),

  upstreamHost: pick('POOL_METER_UPSTREAM_HOST', 'upstreamHost', '127.0.0.1'),
  upstreamPort: num('POOL_METER_UPSTREAM_PORT', 'upstreamPort', 18807),

  brokerHost: pick('POOL_METER_BROKER_HOST', 'brokerHost', '127.0.0.1'),
  brokerPort: num('POOL_METER_BROKER_PORT', 'brokerPort', 7803),

  keysFile: pick('POOL_METER_KEYS_FILE', 'keysFile', path.join(SECRETS_DIR, 'pool-keys.json')),
  logDir: pick('POOL_METER_LOG_DIR', 'logDir', '/opt/pool/logs/pool-meter'),

  defaultQuota: num('POOL_METER_DEFAULT_QUOTA', 'defaultQuota', 13371337),
  publicBaseUrl: pick('POOL_METER_PUBLIC_URL', 'publicBaseUrl', 'https://pool.example.com'),

  // ---- Steward-backed accounts (/account) ----
  // Identity provider base URL and the tenant pool identities live in.
  // Default tenant is 'elizacloud' (directive 2026-07-31): a pool account IS
  // an Eliza Cloud account, one login across cloud + pool. The dedicated
  // 'pool' tenant (created 2026-07-30) is deprecated but left in place.
  // Identities outside the pinned tenant are refused. These are NOT
  // credentials; verification is either local JWKS or possession-proving
  // introspection (see lib/account.js).
  stewardBaseUrl: pick('POOL_METER_STEWARD_BASE', 'stewardBaseUrl', 'https://eliza.steward.fi'),
  accountTenant: pick('POOL_METER_STEWARD_TENANT', 'accountTenant', 'elizacloud'),

  // ---- trace collection & storage (Feature 2) ----
  // Traces default ON at the service level; the per-key consent flag decides
  // per request whether a given call is actually captured.
  tracesDir: pick('POOL_METER_TRACES_DIR', 'tracesDir', '/opt/pool/services/pool-meter/traces'),
  tracesEnabled: pick('POOL_METER_TRACES_ENABLED', 'tracesEnabled', true) !== false
    && pick('POOL_METER_TRACES_ENABLED', 'tracesEnabled', 'true') !== 'false',
  tracesCapBytes: num('POOL_METER_TRACES_CAP_BYTES', 'tracesCapBytes', 20 * 1024 * 1024 * 1024),

  /** Broker read-only API token. No default: absent means status degrades. */
  get brokerToken() {
    const t = pick('POOL_METER_BROKER_TOKEN', 'brokerToken', '');
    if (!t) warnOnce(`no broker token configured (set brokerToken in ${CONFIG_FILE} or POOL_METER_BROKER_TOKEN); broker-backed views will degrade`);
    return t;
  },

  /** Broker internal health secret, historically stored in its own file. */
  get brokerInternalSecret() {
    const inline = pick('POOL_METER_BROKER_INTERNAL_SECRET', 'brokerInternalSecret', '');
    if (inline) return inline;
    const file = pick('POOL_METER_BROKER_INTERNAL_SECRET_FILE', 'brokerInternalSecretFile', path.join(SECRETS_DIR, 'eliza-account-pool-broker.secret'));
    const v = readSecretFile(file);
    if (!v) warnOnce('no broker internal secret; live lease overlay disabled');
    return v;
  },
};

module.exports = config;
