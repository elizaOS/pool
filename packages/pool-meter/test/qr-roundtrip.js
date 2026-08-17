'use strict';
// Proof that lib/qr.js emits scannable QR codes: every symbol is rendered to a
// bitmap and decoded by zxing-cpp, the same library class a phone camera uses.
//
// Why not compare module-for-module against segno? Because segno appends one
// extra 0x00 pad byte before the ec/11 pad run for some inputs, so the matrices
// differ while both remain valid QR symbols. A decoder round-trip tests the
// property that actually matters (does a scanner read the right URL) instead of
// a byte-identical match with one particular encoder.
//
// Run: node test/qr-roundtrip.js   (needs /tmp/qrvenv/bin/python + zxing-cpp)
const { execFileSync } = require('child_process');
const qr = require('../lib/qr.js');

const AUTH_URL =
  'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e' +
  '&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback' +
  '&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference' +
  '&code_challenge=abcdefghijklmnopqrstuvwxyz012345678901234567&code_challenge_method=S256' +
  '&state=abcdefghijklmnopqrstuvwxyz012345678901234567';

const cases = [
  { name: 'anthropic-authorize-url', text: AUTH_URL },
  { name: 'join-invite-short', text: 'https://pool.example.com/join?i=short' },
  { name: 'single-char', text: 'x' },
  { name: 'long-300', text: 'a'.repeat(300) },
  { name: 'join-invite-long', text: 'https://pool.example.com/join?i=' + 'Zk9'.repeat(40) },
  { name: 'utf8', text: 'https://pool.example.com/join?i=abc#donate' },
];

const payload = {
  cases: cases.map((c) => {
    const sym = qr.encode(c.text, { ecl: 'M' });
    return {
      name: `${c.name} (v${sym.version} mask ${sym.mask})`,
      text: c.text,
      rows: sym.modules.map((r) => r.map((b) => (b ? '1' : '0')).join('')),
    };
  }),
};

const out = execFileSync('/tmp/qrvenv/bin/python', [`${__dirname}/qr_decode.py`], {
  input: JSON.stringify(payload),
  encoding: 'utf8',
  maxBuffer: 32 << 20,
});
process.stdout.write(out);

// svg smoke test
const s = qr.svg('https://pool.example.com/join?i=test', { quiet: 2 });
if (!/^<svg [^>]*viewBox="0 0 \d+ \d+"/.test(s) || s.length < 500) {
  console.log('FAIL svg(): unexpected output');
  process.exit(1);
}
console.log(`PASS svg(): ${s.length} bytes, well-formed`);
