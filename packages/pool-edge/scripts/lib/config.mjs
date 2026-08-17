/**
 * Loads, validates, and resolves pool-edge.config.json. Fail-closed: unknown
 * keys, malformed values, and attempts to configure non-configurable security
 * behavior are hard errors. schema/pool-edge.config.schema.json documents the
 * same contract for editors; this module is the enforcement.
 *
 * Same discipline as the army template's config.mjs (see the army repo,
 * scripts/lib/config.mjs): nothing in this file may weaken a security default.
 * Sealed prefixes, header hygiene, token weights, probe policy and the
 * secrets-are-never-config rule are structural, not configurable.
 */

import { readFileSync } from 'node:fs';

const EDGE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const TIER_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/u;
const TOKEN_PREFIX_RE = /^[a-z][a-z0-9]{2,15}_$/u;
const MODEL_RE = /^[a-z0-9.:_-]+$/u;
const ASSET_PATH_RE = /^\/[A-Za-z0-9._/-]+$/u;
const KV_ID_RE = /^[0-9a-f]{32}$/u;

/** Keys that must never appear because they would imply the security defaults
 * are configurable. Their behavior is structural (src/lib/policy.js). */
const FORBIDDEN_KEYS = [
  'forbiddenPrefixes',
  'sealedPrefixes',
  'forwardHeaders',
  'tokenWeights',
  'weights',
  'probe',
  'maxBodyBytes',
  'poolKey',
  'secrets',
  'apiKey',
];

class ConfigError extends TypeError {
  constructor(path, message) {
    super(`[pool-edge] pool-edge.config.json: ${path}: ${message}`);
    this.name = 'ConfigError';
  }
}

function asObject(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(path, 'must be an object');
  }
  return value;
}

function asString(value, path, pattern, hint) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError(path, 'must be a non-empty string');
  }
  if (pattern && !pattern.test(value)) {
    throw new ConfigError(path, hint ?? `does not match ${pattern}`);
  }
  return value;
}

function rejectUnknownKeys(object, allowed, path) {
  for (const key of Object.keys(object)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      throw new ConfigError(
        path ? `${path}.${key}` : key,
        'security behavior is not configurable (fail-closed)',
      );
    }
    if (!allowed.includes(key)) {
      throw new ConfigError(
        path ? `${path}.${key}` : key,
        'unknown key (fail-closed: remove it or upgrade the template)',
      );
    }
  }
}

function validateOrigin(value, path) {
  const origin = asString(value, path);
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new ConfigError(path, 'must be an absolute URL origin');
  }
  if (parsed.protocol !== 'https:') throw new ConfigError(path, 'must use https');
  if (parsed.pathname !== '/' || parsed.search || parsed.hash || origin.endsWith('/')) {
    throw new ConfigError(path, 'must be a bare origin (no path, query, fragment, or trailing slash)');
  }
  if (parsed.username || parsed.password) {
    throw new ConfigError(path, 'must not contain credentials');
  }
  return parsed.origin;
}

function validateTier(value, path) {
  const tier = asObject(value, path);
  rejectUnknownKeys(tier, ['weightedTokens', 'models'], path);
  const weightedTokens = tier.weightedTokens;
  if (!Number.isInteger(weightedTokens) || weightedTokens < 1 || weightedTokens > 1e12) {
    throw new ConfigError(`${path}.weightedTokens`, 'must be an integer in [1, 1e12]');
  }
  if (!('models' in tier)) {
    throw new ConfigError(`${path}.models`, 'must be explicitly null or a list (no silent default)');
  }
  let models = null;
  if (tier.models !== null) {
    if (!Array.isArray(tier.models) || tier.models.length === 0) {
      throw new ConfigError(`${path}.models`, 'must be null (unrestricted) or a non-empty array');
    }
    models = tier.models.map((m, i) =>
      asString(m, `${path}.models[${i}]`, MODEL_RE, 'must be a lowercase model-name prefix'),
    );
  }
  return Object.freeze({ weightedTokens, models: models ? Object.freeze(models) : null });
}

/**
 * @param {string} filePath
 * @returns resolved, frozen config
 */
export function loadConfig(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ConfigError(filePath, `unreadable: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(filePath, `invalid JSON: ${error.message}`);
  }
  return resolveConfig(parsed);
}

export function resolveConfig(parsed) {
  const root = asObject(parsed, '(root)');
  rejectUnknownKeys(root, [
    '$schema',
    'edgeName',
    'publicOrigin',
    'pool',
    'cors',
    'tokens',
    'tiers',
    'support',
    'passthroughAssets',
    'kv',
  ]);

  const edgeName = asString(root.edgeName, 'edgeName', EDGE_NAME_RE, 'must be a lowercase dns-ish name');
  const publicOrigin = validateOrigin(root.publicOrigin, 'publicOrigin');

  const pool = asObject(root.pool, 'pool');
  rejectUnknownKeys(pool, ['baseUrl'], 'pool');
  const poolBaseUrl = validateOrigin(pool.baseUrl, 'pool.baseUrl');
  if (poolBaseUrl === publicOrigin) {
    throw new ConfigError('pool.baseUrl', 'must differ from publicOrigin (the edge cannot be its own upstream)');
  }

  let allowedOrigins = [];
  if (root.cors !== undefined) {
    const cors = asObject(root.cors, 'cors');
    rejectUnknownKeys(cors, ['allowedOrigins'], 'cors');
    if (cors.allowedOrigins !== undefined) {
      if (!Array.isArray(cors.allowedOrigins)) {
        throw new ConfigError('cors.allowedOrigins', 'must be an array');
      }
      allowedOrigins = cors.allowedOrigins.map((o, i) => validateOrigin(o, `cors.allowedOrigins[${i}]`));
    }
  }
  if (!allowedOrigins.includes(publicOrigin)) allowedOrigins = [publicOrigin, ...allowedOrigins];

  let tokenPrefix = 'army_';
  if (root.tokens !== undefined) {
    const tokens = asObject(root.tokens, 'tokens');
    rejectUnknownKeys(tokens, ['prefix'], 'tokens');
    if (tokens.prefix !== undefined) {
      tokenPrefix = asString(tokens.prefix, 'tokens.prefix', TOKEN_PREFIX_RE, 'must be short lowercase alphanumeric ending in _');
    }
  }

  const tiersRaw = asObject(root.tiers, 'tiers');
  const tierNames = Object.keys(tiersRaw);
  if (tierNames.length === 0) throw new ConfigError('tiers', 'must define at least one tier');
  if (!tierNames.includes('contributor')) {
    throw new ConfigError('tiers.contributor', 'required: it is the fallback for unknown tier names on stored grants');
  }
  const tiers = {};
  for (const name of tierNames) {
    if (!TIER_NAME_RE.test(name)) throw new ConfigError(`tiers.${name}`, 'tier name must be lowercase alphanumeric');
    tiers[name] = validateTier(tiersRaw[name], `tiers.${name}`);
  }

  let grantIncreaseNote = '';
  if (root.support !== undefined) {
    const support = asObject(root.support, 'support');
    rejectUnknownKeys(support, ['grantIncreaseNote'], 'support');
    if (support.grantIncreaseNote !== undefined) {
      grantIncreaseNote = asString(support.grantIncreaseNote, 'support.grantIncreaseNote');
      if (grantIncreaseNote.length > 300) {
        throw new ConfigError('support.grantIncreaseNote', 'must be at most 300 characters');
      }
    }
  }

  let passthroughAssets = [];
  if (root.passthroughAssets !== undefined) {
    if (!Array.isArray(root.passthroughAssets)) {
      throw new ConfigError('passthroughAssets', 'must be an array of exact paths');
    }
    passthroughAssets = root.passthroughAssets.map((p, i) => {
      const path = asString(p, `passthroughAssets[${i}]`, ASSET_PATH_RE, 'must be an absolute path');
      if (path.includes('..') || path.endsWith('/')) {
        throw new ConfigError(`passthroughAssets[${i}]`, 'must be a clean exact path');
      }
      for (const sealed of ['/admin', '/ledger', '/meter', '/byo']) {
        if (path === sealed || path.startsWith(`${sealed}/`) || path.startsWith(`${sealed}.`)) {
          throw new ConfigError(`passthroughAssets[${i}]`, `${sealed} is a sealed upstream surface and cannot be exposed`);
        }
      }
      return path;
    });
  }

  let kvNamespaceId = '';
  if (root.kv !== undefined) {
    const kv = asObject(root.kv, 'kv');
    rejectUnknownKeys(kv, ['namespaceId'], 'kv');
    if (kv.namespaceId !== undefined && kv.namespaceId !== '') {
      kvNamespaceId = asString(kv.namespaceId, 'kv.namespaceId', KV_ID_RE, 'must be a 32-hex Cloudflare KV namespace id');
    }
  }

  return Object.freeze({
    edgeName,
    publicOrigin,
    poolBaseUrl,
    allowedOrigins: Object.freeze(allowedOrigins),
    tokenPrefix,
    tiers: Object.freeze(tiers),
    grantIncreaseNote,
    passthroughAssets: Object.freeze(passthroughAssets),
    kvNamespaceId,
  });
}
