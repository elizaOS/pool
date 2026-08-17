/**
 * forbidden-strings.test.mjs — the template-cleanliness contract.
 *
 * This template was extracted from the pool.eliza.army edge (the eliza
 * reference instance). Nothing identifying that instance may survive in the
 * template tree or in output rendered from the example config: no eliza
 * branding, no reference-instance upstream, no reference-deployment account ids.
 * Same contract shape as the army template's forbidden-strings scanner
 * (design doc risk: reference-instance identity must never leak into
 * template defaults).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveConfig } from '../scripts/lib/config.mjs';
import { renderEdgeGen, renderWranglerToml } from '../scripts/render.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Reference-instance identity. One needle family per receipt: brand host,
 * upstream origin, brand asset, worker name, CF account/zone, KV namespace. */
export const FORBIDDEN_STRINGS = [
  // brand hostname + site origin of the reference instance
  'eliza.army',
  'pool.eliza.army',
  // reference upstream pool origin (set to your real upstream when deploying)
  'pool.reference-upstream.invalid',
  'reference-upstream.invalid',
  // reference brand asset + org
  'eliza-mark.svg',
  'elizaOS',
  'elizaos',
  'eliza',
  // reference deployment identity
  'pool-army-edge',
  'POOL_ARMY',
  'POOL_KEY_ARMY',
  '00000000000000000000000000000000', // reference CF account id (placeholder)
  '11111111111111111111111111111111', // reference CF zone id (placeholder)
];

const SKIP_DIRS = new Set(['.git', 'node_modules', '.wrangler']);
const SELF = 'test/forbidden-strings.test.mjs';
/** docs/POOL-API.md may name the reference deployment as a worked example of
 * the API shapes; it is documentation about an third-party service, not a
 * template default. Everything else must be clean. */
const ALLOWED_FILES = new Set([SELF, 'docs/POOL-API.md']);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

test('no reference-instance string appears anywhere in the template tree', () => {
  const offenders = [];
  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file);
    if (ALLOWED_FILES.has(rel)) continue;
    const text = readFileSync(file, 'utf8');
    for (const needle of FORBIDDEN_STRINGS) {
      if (text.toLowerCase().includes(needle.toLowerCase())) {
        offenders.push(`${rel}: ${needle}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `forbidden strings found:\n${offenders.join('\n')}`);
});

test('output rendered from a third-party config is clean', () => {
  const config = resolveConfig({
    edgeName: 'acme-pool-edge',
    publicOrigin: 'https://pool.army.acme.dev',
    pool: { baseUrl: 'https://pool.acme.dev' },
    cors: { allowedOrigins: ['https://army.acme.dev'] },
    tiers: { contributor: { weightedTokens: 1_000_000, models: null } },
  });
  const rendered = renderEdgeGen(config) + renderWranglerToml(config);
  for (const needle of FORBIDDEN_STRINGS) {
    assert.ok(
      !rendered.toLowerCase().includes(needle.toLowerCase()),
      `rendered output contains forbidden string: ${needle}`,
    );
  }
});

test('the example config itself uses only example.com-family hosts', () => {
  const raw = readFileSync(join(ROOT, 'pool-edge.config.json'), 'utf8');
  const parsed = JSON.parse(raw);
  assert.match(parsed.publicOrigin, /example\.com$/u);
  assert.match(parsed.pool.baseUrl, /example\.com$/u);
});
