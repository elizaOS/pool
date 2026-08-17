/**
 * config.test.mjs — the fail-closed validator contract.
 *
 * Every rejection here is a rejection an operator would otherwise discover in
 * production. The validator must throw, not warn, not default.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { loadConfig, resolveConfig } from '../scripts/lib/config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function validConfig(overrides = {}) {
  return {
    edgeName: 'acme-pool-edge',
    publicOrigin: 'https://pool.army.acme.dev',
    pool: { baseUrl: 'https://pool.acme.dev' },
    tiers: {
      contributor: { weightedTokens: 1_000_000, models: null },
    },
    ...overrides,
  };
}

test('the committed example config loads', () => {
  const config = loadConfig(join(ROOT, 'pool-edge.config.json'));
  assert.equal(config.edgeName, 'example-pool-edge');
  assert.equal(config.poolBaseUrl, 'https://pool.example.com');
  assert.ok(config.tiers.contributor);
});

test('a minimal valid config resolves with defaults', () => {
  const config = resolveConfig(validConfig());
  assert.equal(config.tokenPrefix, 'army_');
  assert.deepEqual([...config.allowedOrigins], ['https://pool.army.acme.dev']);
  assert.equal(config.grantIncreaseNote, '');
  assert.deepEqual([...config.passthroughAssets], []);
});

test('unknown top-level keys are rejected, not ignored', () => {
  assert.throws(
    () => resolveConfig(validConfig({ surprise: true })),
    /unknown key/u,
  );
});

test('security behavior is not configurable', () => {
  for (const key of ['forbiddenPrefixes', 'forwardHeaders', 'tokenWeights', 'maxBodyBytes', 'poolKey', 'secrets']) {
    assert.throws(
      () => resolveConfig(validConfig({ [key]: {} })),
      /security behavior is not configurable/u,
      key,
    );
  }
});

test('a secret cannot be smuggled into the config', () => {
  assert.throws(() => resolveConfig(validConfig({ apiKey: 'sk-live-oops' })), /not configurable/u);
  assert.throws(() => resolveConfig(validConfig({ pool: { baseUrl: 'https://user:pass@pool.acme.dev' } })), /credentials/u);
});

test('origins must be bare https origins', () => {
  assert.throws(() => resolveConfig(validConfig({ publicOrigin: 'http://pool.acme.dev' })), /https/u);
  assert.throws(() => resolveConfig(validConfig({ publicOrigin: 'https://pool.acme.dev/path' })), /bare origin/u);
  assert.throws(() => resolveConfig(validConfig({ publicOrigin: 'not a url' })), /absolute URL/u);
});

test('the edge cannot be its own upstream', () => {
  assert.throws(
    () =>
      resolveConfig(
        validConfig({
          publicOrigin: 'https://pool.acme.dev',
          pool: { baseUrl: 'https://pool.acme.dev' },
        }),
      ),
    /cannot be its own upstream/u,
  );
});

test('the contributor tier is mandatory (it is the unknown-tier fallback)', () => {
  assert.throws(
    () => resolveConfig(validConfig({ tiers: { proven: { weightedTokens: 1, models: null } } })),
    /tiers\.contributor/u,
  );
});

test('tier models must be explicitly null or a non-empty list', () => {
  assert.throws(
    () => resolveConfig(validConfig({ tiers: { contributor: { weightedTokens: 1 } } })),
    /explicitly null/u,
  );
  assert.throws(
    () => resolveConfig(validConfig({ tiers: { contributor: { weightedTokens: 1, models: [] } } })),
    /non-empty/u,
  );
});

test('tier budgets are bounded integers', () => {
  assert.throws(
    () => resolveConfig(validConfig({ tiers: { contributor: { weightedTokens: 0, models: null } } })),
    /integer/u,
  );
  assert.throws(
    () => resolveConfig(validConfig({ tiers: { contributor: { weightedTokens: 1.5, models: null } } })),
    /integer/u,
  );
});

test('passthrough assets cannot expose a sealed upstream surface', () => {
  for (const path of ['/admin/x.svg', '/ledger.json', '/meter/pricing', '/byo/anything']) {
    assert.throws(
      () => resolveConfig(validConfig({ passthroughAssets: [path] })),
      /sealed upstream surface/u,
      path,
    );
  }
});

test('passthrough assets must be clean exact paths', () => {
  assert.throws(() => resolveConfig(validConfig({ passthroughAssets: ['relative.svg'] })), /absolute path/u);
  assert.throws(() => resolveConfig(validConfig({ passthroughAssets: ['/a/../b.svg'] })), /clean exact path/u);
  const ok = resolveConfig(validConfig({ passthroughAssets: ['/brand-mark.svg'] }));
  assert.deepEqual([...ok.passthroughAssets], ['/brand-mark.svg']);
});

test('the token prefix is constrained to a short lowercase word', () => {
  assert.throws(() => resolveConfig(validConfig({ tokens: { prefix: 'ARMY_' } })), /lowercase/u);
  assert.throws(() => resolveConfig(validConfig({ tokens: { prefix: 'noprefix' } })), /lowercase/u);
  const ok = resolveConfig(validConfig({ tokens: { prefix: 'acme_' } }));
  assert.equal(ok.tokenPrefix, 'acme_');
});

test('the grant-increase note is bounded operator copy', () => {
  assert.throws(
    () => resolveConfig(validConfig({ support: { grantIncreaseNote: 'x'.repeat(301) } })),
    /300/u,
  );
});

test('the kv namespace id must be a real-looking id or empty', () => {
  assert.throws(() => resolveConfig(validConfig({ kv: { namespaceId: 'not-hex' } })), /32-hex/u);
  const ok = resolveConfig(validConfig({ kv: { namespaceId: 'a'.repeat(32) } }));
  assert.equal(ok.kvNamespaceId, 'a'.repeat(32));
});

test('publicOrigin is always in the cors allowlist', () => {
  const config = resolveConfig(
    validConfig({ cors: { allowedOrigins: ['https://army.acme.dev'] } }),
  );
  assert.deepEqual(
    [...config.allowedOrigins],
    ['https://pool.army.acme.dev', 'https://army.acme.dev'],
  );
});
