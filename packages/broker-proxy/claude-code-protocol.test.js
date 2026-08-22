'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AGENT_SDK_SYSTEM_PROMPT,
  CLAUDE_CODE_ENTRYPOINT,
  CLAUDE_CODE_VERSION,
  applyClaudeCodeProtocol,
  claudeCodeHeaders,
  versionFingerprint,
  xxHash64
} = require('./claude-code-protocol');

test('implements standard XXH64 vectors', () => {
  assert.equal(xxHash64(Buffer.from('')).toString(16), 'ef46db3751d8e999');
  assert.equal(xxHash64(Buffer.from('hello')).toString(16), '26c7827d889f6da3');
});

test('reproduces the Claude Code 2.1.224 prompt fingerprint', () => {
  assert.equal(
    versionFingerprint([{ role: 'user', content: 'Reply with exactly: PROBE_OK' }]),
    'f97'
  );
});

test('puts versioned billing and Agent SDK blocks before caller system content', () => {
  const input = {
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'Reply with exactly: PROBE_OK' }],
    max_tokens: 64000,
    stream: true,
    system: [{ type: 'text', text: 'caller system', cache_control: { type: 'ephemeral' } }]
  };
  const output = JSON.parse(applyClaudeCodeProtocol(JSON.stringify(input)));

  assert.match(
    output.system[0].text,
    /^x-anthropic-billing-header: cc_version=2\.1\.224\.f97; cc_entrypoint=sdk-cli; cch=[0-9a-f]{5};$/
  );
  assert.equal(output.system[0].text.endsWith('cch=bf82e;'), true);
  assert.notEqual(output.system[0].text.includes('cch=00000'), true);
  assert.deepEqual(output.system[1], { type: 'text', text: AGENT_SDK_SYSTEM_PROMPT });
  assert.deepEqual(output.system[2], input.system[0]);
  assert.deepEqual(output.messages, input.messages);
});

test('is idempotent and does not accumulate compatibility blocks', () => {
  const input = JSON.stringify({
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 1,
    system: [{ type: 'text', text: 'caller system' }]
  });
  const once = applyClaudeCodeProtocol(input);
  const twice = applyClaudeCodeProtocol(once);
  assert.equal(twice, once);
  const system = JSON.parse(twice).system;
  assert.equal(system.filter(block => block.text.startsWith('x-anthropic-billing-header: ')).length, 1);
  assert.equal(system.filter(block => block.text === AGENT_SDK_SYSTEM_PROMPT).length, 1);
});

test('changes cch when final request content changes without touching nested fields', () => {
  const body = {
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'cch=00000', model: 'nested-model', max_tokens: 7 }],
    max_tokens: 64000,
    tools: [{ name: 'probe', description: 'model max_tokens cch=00000', input_schema: { type: 'object' } }]
  };
  const first = JSON.parse(applyClaudeCodeProtocol(JSON.stringify(body)));
  body.tools[0].description += ' changed';
  const second = JSON.parse(applyClaudeCodeProtocol(JSON.stringify(body)));

  assert.notEqual(first.system[0].text, second.system[0].text);
  assert.equal(first.messages[0].model, 'nested-model');
  assert.equal(first.messages[0].max_tokens, 7);
  assert.equal(first.messages[0].content, 'cch=00000');
  assert.match(first.tools[0].description, /cch=00000/);
});

test('builds per-request Claude Code headers', () => {
  const first = claudeCodeHeaders('session-1');
  const second = claudeCodeHeaders('session-1');
  assert.equal(first['user-agent'], `claude-cli/${CLAUDE_CODE_VERSION} (external, ${CLAUDE_CODE_ENTRYPOINT})`);
  assert.equal(first['x-app'], 'cli');
  assert.equal(first['x-claude-code-session-id'], 'session-1');
  assert.match(first['x-client-request-id'], /^[0-9a-f-]{36}$/);
  assert.notEqual(first['x-client-request-id'], second['x-client-request-id']);
});
