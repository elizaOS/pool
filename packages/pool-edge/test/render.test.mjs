/**
 * render.test.mjs — determinism + drift gate for the render step.
 *
 * The committed src/edge.gen.js and wrangler.toml must be exactly what the
 * committed pool-edge.config.json renders. Hand edits to generated files are a
 * test failure, not a silent skew. Same drift-gate pattern as the army
 * template's committed-render checks.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../scripts/lib/config.mjs';
import { renderEdgeGen, renderWranglerToml } from '../scripts/render.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('committed edge.gen.js matches the config render byte for byte', () => {
  const config = loadConfig(join(ROOT, 'pool-edge.config.json'));
  const committed = readFileSync(join(ROOT, 'src/edge.gen.js'), 'utf8');
  assert.equal(committed, renderEdgeGen(config), 'run: node scripts/render.mjs');
});

test('committed wrangler.toml matches the config render byte for byte', () => {
  const config = loadConfig(join(ROOT, 'pool-edge.config.json'));
  const committed = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');
  assert.equal(committed, renderWranglerToml(config), 'run: node scripts/render.mjs');
});

test('rendering is deterministic', () => {
  const config = loadConfig(join(ROOT, 'pool-edge.config.json'));
  assert.equal(renderEdgeGen(config), renderEdgeGen(config));
  assert.equal(renderWranglerToml(config), renderWranglerToml(config));
});

test('no secret name renders a secret value', () => {
  const config = loadConfig(join(ROOT, 'pool-edge.config.json'));
  const toml = renderWranglerToml(config);
  // The secret is DOCUMENTED in the toml comment but never assigned there.
  assert.ok(toml.includes('POOL_EDGE_KEY'), 'the secret name must be documented');
  assert.ok(!/POOL_EDGE_KEY\s*=/u.test(toml), 'the secret must never be assigned in committed config');
});

test('an empty kv id renders a commented placeholder, not an invalid binding', () => {
  const config = loadConfig(join(ROOT, 'pool-edge.config.json'));
  const toml = renderWranglerToml(config);
  if (!config.kvNamespaceId) {
    assert.match(toml, /# id = "<paste the id/u);
    assert.ok(!/^id = /mu.test(toml));
  }
});
