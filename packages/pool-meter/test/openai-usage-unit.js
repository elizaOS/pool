'use strict';
// openai-usage-unit.js — the OpenAI→Anthropic usage-shape conversion.
//
// OpenAI semantics: usage.input_tokens INCLUDES input_tokens_details.cached_tokens
// (cached is a subset of input). Anthropic semantics: input_tokens EXCLUDES
// cache_read_input_tokens (disjoint). pool-meter's metrics/ledger/status all
// assume the Anthropic shape, so the conversion boundary must subtract.
//
// The regression these tests pin down: gpt-5.6-sol rows logged as
// input=170093 cache_read=169472 when the real uncached input was 621 —
// cached tokens billed twice (once at weight 1.0 inside input, once at 0.1
// as cache_read). These tests FAIL on the pre-fix code (which copied
// cached_tokens into cache_read_input_tokens without subtracting).

const assert = require('assert');
const { applyOpenAiUsage, makeResponsesUsageParser } = require('../src/lib/openai-usage.js');

let pass = 0, fail = 0;
function t(desc, fn) {
  try { fn(); console.log(`  \x1b[32mPASS\x1b[0m ${desc}`); pass++; }
  catch (e) { console.log(`  \x1b[31mFAIL\x1b[0m ${desc} :: ${e.message}`); fail++; }
}

// ---- applyOpenAiUsage: the conversion itself -------------------------------

t('subtracts cached from input (the double-count fix, real-world numbers)', () => {
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  applyOpenAiUsage(usage, { input_tokens: 170093, output_tokens: 858, input_tokens_details: { cached_tokens: 169472 } });
  assert.strictEqual(usage.input_tokens, 621, `input should be 621, got ${usage.input_tokens}`);
  assert.strictEqual(usage.cache_read_input_tokens, 169472);
  assert.strictEqual(usage.output_tokens, 858);
});

t('no cached details: input passes through untouched', () => {
  const usage = { input_tokens: 0, output_tokens: 0 };
  applyOpenAiUsage(usage, { input_tokens: 500, output_tokens: 20 });
  assert.strictEqual(usage.input_tokens, 500);
  assert.strictEqual(usage.output_tokens, 20);
  assert.strictEqual(usage.cache_read_input_tokens || 0, 0);
});

t('cached_tokens: 0 is honored (no subtraction, cache_read stays 0)', () => {
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  applyOpenAiUsage(usage, { input_tokens: 400, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } });
  assert.strictEqual(usage.input_tokens, 400);
  assert.strictEqual(usage.cache_read_input_tokens, 0);
});

t('clamps to zero when cached > input (defensive, never negative)', () => {
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  applyOpenAiUsage(usage, { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 150 } });
  assert.strictEqual(usage.input_tokens, 0);
  assert.strictEqual(usage.cache_read_input_tokens, 150);
});

t('chat-completions shape (prompt_tokens + prompt_tokens_details) converts too', () => {
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  applyOpenAiUsage(usage, { prompt_tokens: 1200, completion_tokens: 44, prompt_tokens_details: { cached_tokens: 1024 } });
  assert.strictEqual(usage.input_tokens, 176);
  assert.strictEqual(usage.cache_read_input_tokens, 1024);
  assert.strictEqual(usage.output_tokens, 44);
});

t('null usage object is a no-op', () => {
  const usage = { input_tokens: 7, output_tokens: 8 };
  applyOpenAiUsage(usage, null);
  assert.strictEqual(usage.input_tokens, 7);
  assert.strictEqual(usage.output_tokens, 8);
});

// ---- SSE parser path (makeResponsesUsageParser) ----------------------------

t('SSE response.completed converts cached tokens (streaming path)', () => {
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const reqMeta = {};
  const feed = makeResponsesUsageParser(usage, reqMeta);
  feed(Buffer.from('event: response.created\ndata: {"response":{"model":"gpt-5.6-sol"}}\n\n'));
  feed(Buffer.from('event: response.completed\ndata: {"response":{"model":"gpt-5.6-sol","usage":{"input_tokens":170093,"output_tokens":858,"input_tokens_details":{"cached_tokens":169472}}}}\n\n'));
  assert.strictEqual(usage.input_tokens, 621, `input should be 621, got ${usage.input_tokens}`);
  assert.strictEqual(usage.cache_read_input_tokens, 169472);
  assert.strictEqual(usage.output_tokens, 858);
  assert.strictEqual(reqMeta.model, 'gpt-5.6-sol');
});

t('SSE without cached details leaves input as reported', () => {
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  const feed = makeResponsesUsageParser(usage, {});
  feed(Buffer.from('data: {"response":{"usage":{"input_tokens":300,"output_tokens":12}}}\n'));
  assert.strictEqual(usage.input_tokens, 300);
  assert.strictEqual(usage.cache_read_input_tokens, 0);
});

t('SSE events without usage do not clobber parsed usage', () => {
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  const feed = makeResponsesUsageParser(usage, {});
  feed(Buffer.from('data: {"response":{"usage":{"input_tokens":1000,"output_tokens":50,"input_tokens_details":{"cached_tokens":900}}}}\n'));
  feed(Buffer.from('data: {"type":"response.output_text.delta","delta":"hi"}\n'));
  assert.strictEqual(usage.input_tokens, 100);
  assert.strictEqual(usage.cache_read_input_tokens, 900);
});

t('SSE split across chunk boundaries still parses', () => {
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  const feed = makeResponsesUsageParser(usage, {});
  const line = 'data: {"response":{"usage":{"input_tokens":5000,"output_tokens":9,"input_tokens_details":{"cached_tokens":4000}}}}\n';
  feed(Buffer.from(line.slice(0, 40)));
  feed(Buffer.from(line.slice(40)));
  assert.strictEqual(usage.input_tokens, 1000);
  assert.strictEqual(usage.cache_read_input_tokens, 4000);
});

// ---- Anthropic passthrough must remain untouched ---------------------------
// The Anthropic SSE/JSON branches in pool-meter.js never call applyOpenAiUsage.
// Sanity-proof the disjointness assumption: an Anthropic-shaped usage object
// carries no *_tokens_details, so even a misrouted call would not subtract.

t('Anthropic-shaped usage (no *_tokens_details) is never subtracted', () => {
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  // Anthropic reports input=621 cache_read=169472 already-disjoint.
  applyOpenAiUsage(usage, { input_tokens: 621, output_tokens: 858 });
  assert.strictEqual(usage.input_tokens, 621);
  assert.strictEqual(usage.cache_read_input_tokens, 0, 'must not invent cache tokens');
});

t('pool-meter.js Anthropic branch does not route through the OpenAI converter', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../src/pool-meter.js'), 'utf8');
  // The Anthropic JSON branch must keep its direct field copies.
  assert.ok(/provider === 'anthropic'\) \{[\s\S]{0,400}usage\.cache_read_input_tokens = body\.usage\.cache_read_input_tokens/.test(src)
    || /makeSseUsageParser/.test(src), 'anthropic branch missing');
  // And no site may copy cached_tokens without going through the converter.
  assert.ok(!/usage\.cache_read_input_tokens = u\.input_tokens_details\.cached_tokens/.test(src),
    'found a raw cached_tokens copy outside the converter (double-count regression)');
});

console.log(`\nopenai-usage-unit: ${pass} passed, ${fail} failed`);
process.exit(fail);
