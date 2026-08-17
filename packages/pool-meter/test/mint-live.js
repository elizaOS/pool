'use strict';
// Exercises the real mint path against the REAL pool-keys.json, then removes
// the test key. This is the one part of /join that cannot be proven by the
// device-flow test (we deliberately do not enroll a stranger's account just to
// watch a key appear), so it is proven directly here instead.
//
// Run: node test/mint-live.js

const fs = require('fs');
const join = require('../lib/join.js');

const KEYS = join.KEYS_FILE;
const before = JSON.parse(fs.readFileSync(KEYS, 'utf8'));
const beforeCount = before.keys.length;
const beforeLabels = before.keys.map((k) => k.label).sort();

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
};

const rec = join.mintKey({
  labelBase: 'zz-mint-selftest',
  tier: 'donor',
  contributedAccountId: 'test-account-id',
  inviteId: 'test-invite',
  contributedPct: 25,
});

const after = JSON.parse(fs.readFileSync(KEYS, 'utf8'));
check('exactly one key added', after.keys.length === beforeCount + 1, `${beforeCount} -> ${after.keys.length}`);
check('all pre-existing keys intact',
  beforeLabels.every((l) => after.keys.some((k) => k.label === l)),
  `${beforeLabels.length} prior labels`);
check('key format', /^sk-pool-[A-Za-z0-9_-]{30,}$/.test(rec.key));
check('donor flag set', rec.donor === true);
check('tier recorded', rec.tier === 'donor');
check('contributed account linked', rec.contributedAccountId === 'test-account-id');
check('quota reflects contribution',
  rec.quota === join.earnedQuota('donor', 25),
  `${rec.quota.toLocaleString()} for 25% contributed`);
check('quota exceeds base', rec.quota > join.TIERS.donor.baseQuota);

// label collision handling against the live file
const rec2 = join.mintKey({ labelBase: 'zz-mint-selftest', tier: 'invited' });
check('colliding label is suffixed', rec2.label !== rec.label, `${rec.label} vs ${rec2.label}`);
check('second key is a distinct secret', rec2.key !== rec.key);
check('invited tier quota is base', rec2.quota === join.TIERS.invited.baseQuota);

// file perms must stay tight
const mode = fs.statSync(KEYS).mode & 0o777;
check('keys file still 0600', mode === 0o600, `0${mode.toString(8)}`);

// disable path
check('disable works', join.disableKeyByLabel(rec.label) === true);
const afterDisable = JSON.parse(fs.readFileSync(KEYS, 'utf8'));
check('disabled key marked',
  afterDisable.keys.find((k) => k.label === rec.label).enabled === false);

// ---- cleanup: remove both test keys ----
const store = require('../lib/store.js');
store.update(KEYS, () => ({ keys: [] }), (data) => ({
  ...data,
  keys: data.keys.filter((k) => k.label !== rec.label && k.label !== rec2.label),
}), 0o600);

const final = JSON.parse(fs.readFileSync(KEYS, 'utf8'));
check('cleanup restored key count', final.keys.length === beforeCount, `${final.keys.length} vs ${beforeCount}`);
check('cleanup preserved every original label',
  JSON.stringify(final.keys.map((k) => k.label).sort()) === JSON.stringify(beforeLabels));
check('final perms 0600', (fs.statSync(KEYS).mode & 0o777) === 0o600);

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
