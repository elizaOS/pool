import assert from 'node:assert/strict';
import test from 'node:test';

import {
  grantKey,
  modelAllowed,
  tierFor,
  weighUsage,
} from '../src/lib/grants.js';
import { looksLikeToken, mintToken, safeEqual, tokenHash } from '../src/lib/tokens.js';

test('weighted usage matches the pool-side weights exactly', () => {
  // input 1.0, output 5.0, cache_read 0.1, cache_creation 1.25
  const weighted = weighUsage({
    input_tokens: 1000,
    output_tokens: 100,
    cache_read_input_tokens: 10_000,
    cache_creation_input_tokens: 400,
  });
  assert.equal(weighted, 1000 + 500 + 1000 + 500);
});

test('missing or malformed usage weighs zero, never NaN', () => {
  assert.equal(weighUsage(null), 0);
  assert.equal(weighUsage({}), 0);
  assert.equal(weighUsage({ input_tokens: 'x' }), 0);
});

test('a restricted tier is limited to its configured models, unrestricted is not', () => {
  assert.equal(modelAllowed('probation', 'claude-opus-5'), false);
  assert.equal(modelAllowed('probation', 'claude-fable-5-20260101'), true);
  assert.equal(modelAllowed('contributor', 'claude-opus-5'), true);
});

test('grants are keyed on the immutable GitHub id, not the renameable login', () => {
  assert.equal(grantKey(12345), 'grant:gh:12345');
  assert.notEqual(grantKey(12345), grantKey('renamed-login'));
});

test('an unknown tier degrades to contributor rather than throwing', () => {
  assert.equal(tierFor('nonsense').name, 'contributor');
});

test('tier budgets come from the rendered config', () => {
  assert.equal(tierFor('contributor').weightedTokens, 25_000_000);
  assert.equal(tierFor('proven').weightedTokens, 150_000_000);
  assert.equal(tierFor('probation').weightedTokens, 2_000_000);
});

test('minted tokens carry the configured prefix, are high entropy, and validate', async () => {
  const token = mintToken();
  assert.ok(token.startsWith('army_'), 'default prefix from the example config');
  assert.equal(looksLikeToken(token), true);
  assert.equal(looksLikeToken('army_short'), false);
  assert.equal(looksLikeToken('sk-ant-something'), false);
  assert.equal(looksLikeToken(null), false);
  const hash = await tokenHash(token);
  assert.match(hash, /^[0-9a-f]{64}$/u);
  assert.notEqual(hash, token, 'the stored value must not be the token');
});

test('token compare rejects length and content mismatches', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});
