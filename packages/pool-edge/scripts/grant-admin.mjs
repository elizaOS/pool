#!/usr/bin/env node
/**
 * grant-admin.mjs — operator control for contributor grants.
 *
 * Deliberately a local CLI over `wrangler kv`, not an HTTP admin route. An
 * admin endpoint on a public hostname is exactly the surface this whole design
 * exists to avoid: there is no privileged path to find, guess, or leak.
 *
 * Usage:
 *   node scripts/grant-admin.mjs mint <githubId> <login> [tier]
 *   node scripts/grant-admin.mjs list
 *   node scripts/grant-admin.mjs show <githubId>
 *   node scripts/grant-admin.mjs promote <githubId> <tier>
 *   node scripts/grant-admin.mjs revoke <githubId> "reason"
 *   node scripts/grant-admin.mjs topup <githubId>       # reset usage to zero
 *
 * Every mutation prints the before/after record so the change is auditable in
 * the terminal scrollback. Mint prints the token ONCE; it is never stored.
 *
 * Requires wrangler auth for the account that owns the worker (see README).
 */

import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';

import { loadConfig } from './lib/config.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = loadConfig(join(ROOT, 'pool-edge.config.json'));

const BINDING = 'POOL_EDGE';
const TIERS = new Set(Object.keys(CONFIG.tiers));

function kv(args) {
  const out = execFileSync('wrangler', ['kv', ...args, '--binding', BINDING, '--remote'], {
    encoding: 'utf8',
  });
  return out.trim();
}

function readJson(key) {
  try {
    const raw = kv(['key', 'get', key]);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  execFileSync(
    'wrangler',
    ['kv', 'key', 'put', key, JSON.stringify(value), '--binding', BINDING, '--remote'],
    { encoding: 'utf8' },
  );
}

function grantKey(githubId) {
  return `grant:gh:${githubId}`;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function sha256Hex(value) {
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Mutate both the grant record and the token record; they must never diverge. */
function mutate(githubId, patch) {
  const grant = readJson(grantKey(githubId));
  if (!grant) fail(`no grant for GitHub id ${githubId}`);
  if (!grant.tokenHash) fail(`grant ${grant.grantId} has no tokenHash; refusing a partial update`);

  const token = readJson(`token:${grant.tokenHash}`);
  if (!token) fail(`grant ${grant.grantId} has no live token record; refusing a partial update`);

  process.stdout.write(`before: ${JSON.stringify(token, null, 2)}\n`);
  const nextToken = { ...token, ...patch, updatedAt: new Date().toISOString() };
  const nextGrant = { ...grant, ...patch, updatedAt: nextToken.updatedAt };
  writeJson(`token:${grant.tokenHash}`, nextToken);
  writeJson(grantKey(githubId), nextGrant);
  process.stdout.write(`after:  ${JSON.stringify(nextToken, null, 2)}\n`);
}

const [command, arg, extra, extra2] = process.argv.slice(2);

switch (command) {
  case 'mint': {
    if (!arg || !extra) fail('usage: mint <githubId> <login> [tier]');
    const tier = extra2 || 'contributor';
    if (!TIERS.has(tier)) fail(`unknown tier '${tier}'. configured: ${[...TIERS].join(', ')}`);
    if (readJson(grantKey(arg))) fail(`GitHub id ${arg} already has a grant; revoke it first`);
    const token = CONFIG.tokenPrefix + base64url(webcrypto.getRandomValues(new Uint8Array(32)));
    const hash = await sha256Hex(token);
    const now = new Date().toISOString();
    const record = {
      grantId: `${CONFIG.tokenPrefix}${arg}-${Date.now().toString(36)}`,
      githubId: String(arg),
      login: extra,
      tier,
      weightedUsed: 0,
      requests: 0,
      revoked: false,
      createdAt: now,
    };
    // Both records or neither: token first, then the grant that references it.
    writeJson(`token:${hash}`, record);
    writeJson(grantKey(arg), { ...record, tokenHash: hash });
    process.stdout.write(`grant:  ${JSON.stringify(record, null, 2)}\n`);
    process.stdout.write(`\ntoken (shown ONCE, never stored):\n  ${token}\n`);
    break;
  }
  case 'list': {
    process.stdout.write(kv(['key', 'list', '--prefix', 'grant:gh:']) + '\n');
    break;
  }
  case 'show': {
    if (!arg) fail('usage: show <githubId>');
    const grant = readJson(grantKey(arg));
    if (!grant) fail(`no grant for GitHub id ${arg}`);
    process.stdout.write(`${JSON.stringify(grant, null, 2)}\n`);
    break;
  }
  case 'promote': {
    if (!arg || !TIERS.has(extra)) fail(`usage: promote <githubId> <${[...TIERS].join('|')}>`);
    mutate(arg, { tier: extra, reason: `promoted to ${extra} by operator` });
    break;
  }
  case 'revoke': {
    if (!arg) fail('usage: revoke <githubId> "reason"');
    mutate(arg, { revoked: true, reason: extra || 'revoked by operator' });
    break;
  }
  case 'topup': {
    if (!arg) fail('usage: topup <githubId>');
    mutate(arg, { weightedUsed: 0, reason: 'grant reset by operator' });
    break;
  }
  default:
    fail(
      'commands: mint <githubId> <login> [tier] | list | show <githubId> | promote <githubId> <tier> | revoke <githubId> "reason" | topup <githubId>',
    );
}
