'use strict';
// byo-unit.js — unit tests for the BYO credential store. No network, no service.
// Uses a scratch secrets dir under os.tmpdir so it never touches real secrets.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ByoStore, PROVIDERS, knownProvider } = require('../lib/byo.js');

let pass = 0, fail = 0;
function ok(d) { console.log(`  \x1b[32mPASS\x1b[0m ${d}`); pass++; }
function bad(d, e) { console.log(`  \x1b[31mFAIL\x1b[0m ${d}${e ? ' :: ' + e : ''}`); fail++; }
function t(d, fn) { try { fn(); ok(d); } catch (e) { bad(d, e.message); } }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byo-test-'));
const store = new ByoStore({ secretsDir: dir });
const KEY = 'sk-pool-testkey-abc123';
const KEY2 = 'sk-pool-other-xyz789';

t('unknown provider throws', () => {
  assert.throws(() => store.set(KEY, 'nope', 'tok'), /unknown provider/);
});
t('empty token throws', () => {
  assert.throws(() => store.set(KEY, 'anthropic', ''), /token required/);
});
t('set returns masked summary, no plaintext', () => {
  const s = store.set(KEY, 'anthropic', 'sk-ant-supersecrettoken9999');
  assert.strictEqual(s.provider, 'anthropic');
  assert.strictEqual(s.last4, '9999');
  assert.ok(!JSON.stringify(s).includes('supersecret'));
});
t('get decrypts back to the original token', () => {
  assert.strictEqual(store.get(KEY, 'anthropic'), 'sk-ant-supersecrettoken9999');
});
t('has() reflects presence', () => {
  assert.strictEqual(store.has(KEY, 'anthropic'), true);
  assert.strictEqual(store.has(KEY, 'openai'), false);
});
t('creds file exists, is 0600, contains NO plaintext token', () => {
  const cf = path.join(dir, 'pool-byo-creds.json');
  const st = fs.statSync(cf);
  assert.strictEqual(st.mode & 0o777, 0o600);
  const raw = fs.readFileSync(cf, 'utf8');
  assert.ok(!raw.includes('supersecrettoken'), 'plaintext token leaked into creds file');
  assert.ok(!raw.includes(KEY), 'plaintext pool key leaked into creds file (should be hashed)');
});
t('master key file exists and is 0600', () => {
  const mk = path.join(dir, 'pool-byo-master.key');
  assert.strictEqual(fs.statSync(mk).mode & 0o777, 0o600);
  assert.strictEqual(fs.readFileSync(mk).length, 32);
});
t('list() returns masked entries only', () => {
  const l = store.list(KEY);
  assert.strictEqual(l.length, 1);
  assert.strictEqual(l[0].provider, 'anthropic');
  assert.strictEqual(l[0].last4, '9999');
  assert.ok(!('token' in l[0]) && !('ct' in l[0]));
});
t('different pool key has independent creds', () => {
  assert.strictEqual(store.get(KEY2, 'anthropic'), null);
  store.set(KEY2, 'openai', 'sk-openai-other');
  assert.strictEqual(store.get(KEY2, 'openai'), 'sk-openai-other');
  assert.strictEqual(store.get(KEY, 'openai'), null);
});
t('replace overwrites', () => {
  store.set(KEY, 'anthropic', 'sk-ant-newtoken0001');
  assert.strictEqual(store.get(KEY, 'anthropic'), 'sk-ant-newtoken0001');
  assert.strictEqual(store.list(KEY)[0].last4, '0001');
});
t('remove deletes and returns true, then false', () => {
  assert.strictEqual(store.remove(KEY, 'anthropic'), true);
  assert.strictEqual(store.has(KEY, 'anthropic'), false);
  assert.strictEqual(store.remove(KEY, 'anthropic'), false);
});
t('a fresh store reloads persisted creds (decrypt survives restart)', () => {
  const store2 = new ByoStore({ secretsDir: dir });
  assert.strictEqual(store2.get(KEY2, 'openai'), 'sk-openai-other');
});
t('provider table has anthropic/openai/openrouter', () => {
  assert.ok(knownProvider('anthropic') && knownProvider('openai') && knownProvider('openrouter'));
  assert.ok(PROVIDERS.anthropic.authHeader === 'x-api-key');
  assert.ok(PROVIDERS.openai.scheme === 'bearer');
});

try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

console.log(`\nbyo-unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
