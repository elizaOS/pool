'use strict';
// trace-unit.js — unit tests for trace capture/storage, consent gating, SSE
// reassembly, cap eviction, and the offline redaction rules. No network.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { TraceStore, makeSseTextCollector } = require('../lib/trace.js');

let pass = 0, fail = 0;
function ok(d) { console.log(`  \x1b[32mPASS\x1b[0m ${d}`); pass++; }
function bad(d, e) { console.log(`  \x1b[31mFAIL\x1b[0m ${d}${e ? ' :: ' + e : ''}`); fail++; }
async function t(d, fn) { try { await fn(); ok(d); } catch (e) { bad(d, e.message); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'));

function readTraceLines() {
  const day = new Date().toISOString().slice(0, 10);
  const f = path.join(dir, `trace-${day}.jsonl`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function main() {
await t('capture writes a JSONL line with the expected fields', async () => {
  const store = new TraceStore({ dir, enabled: true });
  store.capture({ label: 'alice', provider: 'anthropic', byo: false, model: 'claude-fable-5', stream: false, status: 200, latency_ms: 42, ttfb_ms: 10, usage: { input_tokens: 5, output_tokens: 7 }, request: '{"hi":1}', response: 'hello' });
  await sleep(100);
  const lines = readTraceLines();
  assert.strictEqual(lines.length, 1);
  const r = lines[0];
  assert.strictEqual(r.label, 'alice');
  assert.strictEqual(r.provider, 'anthropic');
  assert.strictEqual(r.byo, false);
  assert.strictEqual(r.model, 'claude-fable-5');
  assert.strictEqual(r.response, 'hello');
  assert.strictEqual(r.usage.output_tokens, 7);
});

await t('disabled store captures nothing', () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-off-'));
  const store = new TraceStore({ dir: d2, enabled: false });
  store.capture({ label: 'x', request: 'a', response: 'b' });
  const day = new Date().toISOString().slice(0, 10);
  assert.strictEqual(fs.existsSync(path.join(d2, `trace-${day}.jsonl`)), false);
  fs.rmSync(d2, { recursive: true, force: true });
});

await t('trace file is 0600', () => {
  const day = new Date().toISOString().slice(0, 10);
  const st = fs.statSync(path.join(dir, `trace-${day}.jsonl`));
  assert.strictEqual(st.mode & 0o777, 0o600);
});

await t('SSE text collector reassembles anthropic content_block_delta text', () => {
  const c = makeSseTextCollector();
  c.feed(Buffer.from('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n'));
  c.feed(Buffer.from('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo!"}}\n'));
  c.feed(Buffer.from('data: [DONE]\n'));
  assert.strictEqual(c.text(), 'Hello!');
});

await t('SSE text collector reassembles openai response.output_text.delta', () => {
  const c = makeSseTextCollector();
  c.feed(Buffer.from('data: {"type":"response.output_text.delta","delta":"foo"}\n'));
  c.feed(Buffer.from('data: {"type":"response.output_text.delta","delta":"bar"}\n'));
  assert.strictEqual(c.text(), 'foobar');
});

await t('stats() reports counts and bytes', () => {
  const store = new TraceStore({ dir, enabled: true });
  const s = store.stats();
  assert.ok(s.fileCount >= 1);
  assert.ok(s.totalBytes > 0);
  assert.ok(s.newest);
  assert.ok(/redact-on-export/i.test(s.note));
});

await t('cap eviction removes oldest gz files, keeps live file', async () => {
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-cap-'));
  // three fake dated files, tiny cap
  const mk = (name, bytes, mtime) => {
    const p = path.join(d3, name);
    fs.writeFileSync(p, Buffer.alloc(bytes, 1));
    fs.utimesSync(p, mtime, mtime);
  };
  mk('trace-2026-07-01.jsonl.gz', 1000, 1000);
  mk('trace-2026-07-02.jsonl.gz', 1000, 2000);
  mk('trace-2026-07-03.jsonl', 1000, 3000); // live-ish (newest)
  const store = new TraceStore({ dir: d3, enabled: true, capBytes: 1500 });
  store._enforceCap();
  await sleep(100);
  const left = fs.readdirSync(d3).sort();
  // oldest evicted until under cap; newest always kept
  assert.ok(left.includes('trace-2026-07-03.jsonl'), 'live file must survive');
  assert.ok(!left.includes('trace-2026-07-01.jsonl.gz'), 'oldest should be evicted');
  fs.rmSync(d3, { recursive: true, force: true });
});

await t('redact-traces.js strips emails, tokens, seed phrases', () => {
  const d4 = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-'));
  const infile = path.join(d4, 'trace-2026-07-28.jsonl');
  const rec = {
    ts: 't', label: 'x', provider: 'anthropic',
    request: 'email me at alice@example.com key sk-ant-abcdef0123456789abcdef',
    response: 'seed: legal winner thank year wave sausage worth useful legal winner thank yellow and Bearer eyJabc.defghijklmn.opqrstuvwx',
  };
  fs.writeFileSync(infile, JSON.stringify(rec) + '\n');
  const out = path.join(d4, 'out.jsonl');
  execFileSync('node', [path.join(__dirname, '..', 'scripts', 'redact-traces.js'), infile, out]);
  const red = JSON.parse(fs.readFileSync(out, 'utf8').trim());
  assert.ok(!red.request.includes('alice@example.com'), 'email not redacted');
  assert.ok(red.request.includes('[REDACTED_EMAIL]'));
  assert.ok(!red.request.includes('sk-ant-abcdef0123456789abcdef'), 'apikey not redacted');
  assert.ok(/REDACTED_(SEED_PHRASE|SECRET)/.test(red.response), 'seed phrase not redacted');
  fs.rmSync(d4, { recursive: true, force: true });
});

try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

console.log(`\ntrace-unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
}
main();
