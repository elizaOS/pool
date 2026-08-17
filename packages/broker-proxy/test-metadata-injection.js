#!/usr/bin/env node
// Bidirectional test for the depth-aware metadata injection fix (2026-08-06).
//
// Defect: naive indexOf('"metadata":{') in processBody replaced the FIRST
// "metadata" occurrence anywhere in the body. When a request carried a
// structured-output schema (output_config.format.schema.properties.metadata)
// BEFORE any top-level metadata field, the injection clobbered the schema
// property with {"user_id":...}, producing "Invalid schema" API rejections and
// killing all post-turn evaluator extraction.
//
// Direction 1: fixed proxy.js leaves nested schema metadata intact.
// Direction 2: the pre-fix backup (proxy.js.bak-20260806) reproduces the corruption.
//
// Run: node test-metadata-injection.js

const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = __dirname;
const fixed = require(path.join(DIR, 'proxy.js'));

// Load the pre-fix backup as a module (copy to a .js path first).
const bakSrc = path.join(DIR, 'proxy.js.bak-20260806');
const bakTmp = path.join(os.tmpdir(), 'proxy-naive-20260806.js');
fs.copyFileSync(bakSrc, bakTmp);
const naive = require(bakTmp);

const CONFIG = {
  replacements: [],
  toolRenames: [],
  propRenames: [],
  sanitizeBlocks: false,
  stripSystemConfig: false,
  stripToolDescriptions: false,
  stripTrailingAssistantPrefill: false,
  stripThinkingBlocks: false,
  relocateDynamicContext: false,
  injectCCStubs: false,
};

// Evaluator-style request: output_config schema with a nested `metadata`
// property, and NO pre-existing top-level metadata (the corruption case).
const body = JSON.stringify({
  model: 'claude-haiku-4-5',
  max_tokens: 512,
  system: 'extract facts',
  output_config: {
    format: {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          user_id: { type: 'string' },
          metadata: { type: 'object', properties: { source: { type: 'string' } } },
          facts: { type: 'array', items: { type: 'string' } },
        },
        required: ['facts'],
      },
    },
  },
  messages: [{ role: 'user', content: 'turn text here' }],
});

// Same request but WITH a legit top-level metadata field (replacement case).
const bodyWithTopMeta = JSON.stringify({
  ...JSON.parse(body),
  metadata: { user_id: 'old-value' },
});

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

// ── Direction 1: FIXED proxy ────────────────────────────────────────────────
{
  const out = fixed.processBody(body, CONFIG);
  let parsed = null;
  try { parsed = JSON.parse(out); } catch (e) {}
  check('fixed: output is valid JSON', !!parsed);
  check(
    'fixed: nested schema metadata property preserved',
    !!(parsed && parsed.output_config &&
       parsed.output_config.format.schema.properties.metadata &&
       parsed.output_config.format.schema.properties.metadata.type === 'object' &&
       parsed.output_config.format.schema.properties.metadata.properties.source),
    parsed ? JSON.stringify(parsed.output_config?.format?.schema?.properties?.metadata) : 'unparseable'
  );
  check(
    'fixed: top-level metadata injected with user_id device/session blob',
    !!(parsed && parsed.metadata && typeof parsed.metadata.user_id === 'string' &&
       parsed.metadata.user_id.includes('device_id'))
  );
  check(
    'fixed: schema required/facts untouched',
    !!(parsed && parsed.output_config.format.schema.properties.facts &&
       parsed.output_config.format.schema.required[0] === 'facts')
  );
}

// ── Direction 1b: FIXED proxy replaces a real top-level metadata ────────────
{
  const out = fixed.processBody(bodyWithTopMeta, CONFIG);
  let parsed = null;
  try { parsed = JSON.parse(out); } catch (e) {}
  check('fixed(top-meta): output is valid JSON', !!parsed);
  check(
    'fixed(top-meta): existing top-level metadata replaced (old value gone)',
    !!(parsed && parsed.metadata && parsed.metadata.user_id !== 'old-value' &&
       String(parsed.metadata.user_id).includes('device_id'))
  );
  check(
    'fixed(top-meta): exactly one top-level metadata key, schema still intact',
    !!(parsed && parsed.output_config.format.schema.properties.metadata &&
       parsed.output_config.format.schema.properties.metadata.properties)
  );
}

// ── Direction 2: NAIVE (pre-fix) proxy reproduces the corruption ────────────
{
  const out = naive.processBody(body, CONFIG);
  let parsed = null;
  try { parsed = JSON.parse(out); } catch (e) {}
  const schemaMeta = parsed && parsed.output_config &&
    parsed.output_config.format.schema.properties.metadata;
  const corrupted =
    !parsed ||
    (schemaMeta && typeof schemaMeta.user_id === 'string') ||
    (schemaMeta && !schemaMeta.type);
  check(
    'naive: reproduces schema corruption (nested metadata clobbered)',
    corrupted,
    parsed ? 'schema metadata = ' + JSON.stringify(schemaMeta) : 'body unparseable (also corruption)'
  );
}

// ── Helper sanity: findTopLevelKey exported and depth-aware ─────────────────
{
  const s = '{"a":{"metadata":{"x":1}},"metadata":{"y":2}}';
  const idx = fixed.findTopLevelKey(s, 'metadata');
  check('helper: findTopLevelKey skips nested, finds top-level',
    idx === s.indexOf('"metadata":{"y"'));
  const none = fixed.findTopLevelKey('{"a":{"metadata":{}}}', 'metadata');
  check('helper: findTopLevelKey returns -1 when only nested exists', none === -1);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
