'use strict';
// Sweep every version 1..20 through the real decoder to localize failures.
const { execFileSync } = require('child_process');
const qr = require('../lib/qr.js');

const cases = [];
const seen = new Set();
for (let len = 1; len < 900; len += 1) {
  const text = 'A'.repeat(len);
  const sym = qr.encode(text, { ecl: 'M' });
  if (sym.version > 20) break;
  if (seen.has(sym.version)) continue;
  seen.add(sym.version);
  cases.push({
    name: `v${sym.version} blocks=${blocks(sym.version)} len=${len}`,
    text,
    rows: sym.modules.map((r) => r.map((b) => (b ? '1' : '0')).join('')),
  });
}
function blocks(v) {
  return [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17][v];
}
const out = execFileSync('/tmp/qrvenv/bin/python', [`${__dirname}/qr_decode.py`], {
  input: JSON.stringify({ cases }),
  encoding: 'utf8',
  maxBuffer: 64 << 20,
});
process.stdout.write(out);
