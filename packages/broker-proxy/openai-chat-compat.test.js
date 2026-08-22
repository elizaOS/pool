'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { anthropicToChat, chatToAnthropic, createSseTranslator, cursorModel } = require('./openai-chat-compat');

test('maps Cursor-safe Anthropic aliases to upstream Claude models', () => {
  assert.equal(cursorModel('anthropic:sonnet'), 'claude-sonnet-4-6');
  assert.equal(cursorModel('anthropic:opus'), 'claude-opus-4-6');
  assert.equal(cursorModel('anthropic:haiku'), 'claude-haiku-4-5-20251001');
  assert.equal(cursorModel('anthropic:claude-sonnet-4-6'), 'claude-sonnet-4-6');
  assert.equal(cursorModel('custom-model'), 'custom-model');
});

test('converts Cursor messages and tools to Anthropic', () => {
  const out = chatToAnthropic({ model: 'claude-sonnet-4-6', stream: true, messages: [
    { role: 'system', content: 'Use tools.' }, { role: 'user', content: 'Read.' },
    { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'pool docs' }
  ], tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }] });
  assert.equal(out.system[0].text, 'Use tools.');
  assert.deepEqual(out.messages[1].content[0], { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'README.md' } });
  assert.equal(out.messages[2].content[0].tool_use_id, 'call_1');
  assert.equal(out.tools[0].name, 'read_file');
});

test('converts Anthropic JSON tool calls and usage to Chat Completions', () => {
  const out = anthropicToChat({ id: 'msg_1', model: 'claude', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'README.md' } }], usage: { input_tokens: 10, output_tokens: 3 } });
  assert.equal(out.id, 'chatcmpl-1');
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
  assert.equal(out.choices[0].message.tool_calls[0].function.arguments, '{"path":"README.md"}');
  assert.deepEqual(out.usage, { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
});

test('converts split Anthropic SSE with tool deltas and final usage', () => {
  const t = createSseTranslator();
  const raw = [
    { type: 'message_start', message: { id: 'msg_s', model: 'claude', usage: { input_tokens: 12 } } },
    { type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } },
    { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"path":"README.md"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' }
  ].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  const split = Math.floor(raw.length / 2);
  const out = t.push(raw.slice(0, split)) + t.push(raw.slice(split)) + t.end();
  assert.match(out, /"id":"toolu_1"/);
  assert.match(out, /"finish_reason":"tool_calls"/);
  assert.match(out, /"prompt_tokens":12/);
  assert.match(out, /"completion_tokens":7/);
  assert.equal(out.endsWith('data: [DONE]\n\n'), true);
});
