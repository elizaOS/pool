#!/usr/bin/env node
'use strict';
// redact-traces.js — offline PII redaction pass over captured trace JSONL.
//
// Trace capture is RAW by design (see lib/trace.js). This script is the
// redact-on-EXPORT half of the posture: run it to produce a redacted copy of a
// trace file (or a whole day) before any dataset leaves the box. It NEVER edits
// the source in place.
//
// Strips, from the `request` and `response` free-text fields:
//   - emails
//   - phone numbers (loose, international-ish)
//   - api keys / bearer tokens (sk-..., pool keys, JWT-shaped, generic long
//     high-entropy hex/base64 runs, Authorization: Bearer <...>)
//   - ssh private keys (BEGIN ... PRIVATE KEY blocks) and ssh-rsa/ed25519 pubkeys
//   - seed-phrase-looking strings (12/15/18/21/24 lowercase words in a row)
//
// Usage:
//   node scripts/redact-traces.js <in.jsonl[.gz]> [out.jsonl]
//   node scripts/redact-traces.js --dir traces/ --out traces-redacted/
//
// Metadata (tokens, latency, model, label, provider, usage) is preserved; only
// the free-text request/response fields are scrubbed. Emits a summary of hit
// counts per category so a human can eyeball whether the pass did its job.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const RULES = [
  { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, tag: '[REDACTED_EMAIL]' },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._\-]+/gi, tag: 'Bearer [REDACTED_TOKEN]' },
  { name: 'apikey', re: /\b(?:sk|pk|rk|sk-pool|sk-ant|sk-proj)[-_][A-Za-z0-9\-_]{16,}\b/g, tag: '[REDACTED_APIKEY]' },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g, tag: '[REDACTED_JWT]' },
  { name: 'ssh_priv', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, tag: '[REDACTED_PRIVATE_KEY]' },
  { name: 'ssh_pub', re: /\b(?:ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-nistp\d+)\s+[A-Za-z0-9+/]{40,}={0,3}(?:\s+\S+)?/g, tag: '[REDACTED_SSH_PUBKEY]' },
  { name: 'phone', re: /(?<![\w.])\+?\d{1,3}[-.\s]?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}(?![\w.])/g, tag: '[REDACTED_PHONE]' },
  // seed phrases: 12/15/18/21/24 space-separated lowercase words (BIP39-ish).
  { name: 'seed', re: /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g, tag: '[REDACTED_SEED_PHRASE]' },
  // generic high-entropy secret runs (>=32 hex or base64url) — last, catches leftovers.
  { name: 'entropy', re: /\b[A-Fa-f0-9]{40,}\b|\b[A-Za-z0-9_\-]{48,}\b/g, tag: '[REDACTED_SECRET]' },
];

function redactString(s, counts) {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  for (const r of RULES) {
    out = out.replace(r.re, () => { counts[r.name] = (counts[r.name] || 0) + 1; return r.tag; });
  }
  return out;
}

function redactRecord(rec, counts) {
  if (rec.request != null) rec.request = redactString(rec.request, counts);
  if (rec.response != null) rec.response = redactString(rec.response, counts);
  return rec;
}

function openLineStream(file) {
  const raw = fs.createReadStream(file);
  const stream = file.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw;
  return readline.createInterface({ input: stream, crlfDelay: Infinity });
}

async function processFile(inFile, outFile, counts) {
  const rl = openLineStream(inFile);
  const out = fs.createWriteStream(outFile, { mode: 0o600 });
  let n = 0;
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let rec; try { rec = JSON.parse(t); } catch (_) { continue; }
    out.write(JSON.stringify(redactRecord(rec, counts)) + '\n');
    n++;
  }
  await new Promise((res) => out.end(res));
  return n;
}

async function main() {
  const args = process.argv.slice(2);
  const counts = {};
  if (args[0] === '--dir') {
    const inDir = args[1];
    const outIdx = args.indexOf('--out');
    const outDir = outIdx >= 0 ? args[outIdx + 1] : inDir.replace(/\/?$/, '-redacted');
    fs.mkdirSync(outDir, { recursive: true });
    const files = fs.readdirSync(inDir).filter((f) => /\.jsonl(\.gz)?$/.test(f));
    let total = 0;
    for (const f of files) {
      const out = path.join(outDir, f.replace(/\.gz$/, ''));
      const n = await processFile(path.join(inDir, f), out, counts);
      console.log(`  ${f} -> ${path.basename(out)} (${n} records)`);
      total += n;
    }
    console.log(`\nredacted ${total} records across ${files.length} files -> ${outDir}`);
  } else {
    const inFile = args[0];
    if (!inFile) { console.error('usage: redact-traces.js <in.jsonl[.gz]> [out.jsonl]  |  --dir <dir> [--out <dir>]'); process.exit(2); }
    const outFile = args[1] || inFile.replace(/\.gz$/, '').replace(/\.jsonl$/, '.redacted.jsonl');
    const n = await processFile(inFile, outFile, counts);
    console.log(`redacted ${n} records -> ${outFile}`);
  }
  console.log('\nredaction hits by category:');
  for (const r of RULES) console.log(`  ${r.name.padEnd(12)} ${counts[r.name] || 0}`);
}

main().catch((e) => { console.error('redact-traces failed:', e.message); process.exit(1); });
