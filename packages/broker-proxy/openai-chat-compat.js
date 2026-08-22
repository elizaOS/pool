'use strict';

const crypto = require('crypto');

const CURSOR_MODEL_ALIASES = Object.freeze({
  'anthropic:sonnet': 'claude-sonnet-4-6',
  'anthropic:opus': 'claude-opus-4-6',
  'anthropic:haiku': 'claude-haiku-4-5-20251001'
});

function cursorModel(model) {
  const requested = String(model || 'anthropic:sonnet');
  if (CURSOR_MODEL_ALIASES[requested]) return CURSOR_MODEL_ALIASES[requested];
  if (requested.startsWith('anthropic:claude-')) return requested.slice('anthropic:'.length);
  return requested;
}

function contentBlocks(content) {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [{ type: 'text', text: String(content) }];
  const out = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if ((part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string') {
      out.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url' && part.image_url) {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url.url;
      const data = typeof url === 'string' && url.match(/^data:([^;,]+);base64,(.+)$/s);
      if (data) out.push({ type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } });
      else if (typeof url === 'string') out.push({ type: 'image', source: { type: 'url', url } });
    }
  }
  return out;
}

function append(messages, role, blocks) {
  if (!blocks.length) return;
  const tail = messages[messages.length - 1];
  if (tail && tail.role === role) tail.content.push(...blocks);
  else messages.push({ role, content: blocks });
}

function chatToAnthropic(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('request body must be a JSON object');
  if (!Array.isArray(body.messages)) throw new Error('messages must be an array');
  if (body.n != null && body.n !== 1) throw new Error('only n=1 is supported');
  const system = [];
  const messages = [];
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'system' || message.role === 'developer') {
      system.push(...contentBlocks(message.content));
    } else if (message.role === 'assistant') {
      const blocks = contentBlocks(message.content);
      for (const call of message.tool_calls || []) {
        if (!call || call.type !== 'function' || !call.function) continue;
        let input;
        try { input = JSON.parse(call.function.arguments || '{}'); }
        catch (_) { throw new Error(`tool call ${call.id || call.function.name || ''} arguments must be valid JSON`); }
        blocks.push({ type: 'tool_use', id: call.id || `call_${crypto.randomUUID()}`, name: call.function.name, input });
      }
      append(messages, 'assistant', blocks);
    } else if (message.role === 'tool') {
      append(messages, 'user', [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: contentBlocks(message.content) }]);
    } else {
      append(messages, 'user', contentBlocks(message.content));
    }
  }
  const out = {
    model: cursorModel(body.model),
    max_tokens: body.max_completion_tokens ?? body.max_tokens ?? 8192,
    messages,
    stream: body.stream === true
  };
  if (system.length) out.system = system;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop != null) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (Array.isArray(body.tools) && body.tool_choice !== 'none') {
    out.tools = body.tools.filter(t => t && t.type === 'function' && t.function && t.function.name).map(t => ({
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      input_schema: t.function.parameters || { type: 'object', properties: {} }
    }));
  }
  const choice = body.tool_choice;
  if (choice === 'auto') out.tool_choice = { type: 'auto' };
  else if (choice === 'required') out.tool_choice = { type: 'any' };
  else if (choice && choice.type === 'function' && choice.function && choice.function.name) out.tool_choice = { type: 'tool', name: choice.function.name };
  return out;
}

function finishReason(reason) {
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  return 'stop';
}

function anthropicToChat(body) {
  const blocks = Array.isArray(body.content) ? body.content : [];
  const text = blocks.filter(b => b && b.type === 'text').map(b => b.text || '').join('');
  const calls = blocks.filter(b => b && b.type === 'tool_use').map(b => ({
    id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) }
  }));
  const sourceUsage = body.usage || {};
  const message = { role: 'assistant', content: text || null };
  if (calls.length) message.tool_calls = calls;
  return {
    id: `chatcmpl-${String(body.id || crypto.randomUUID()).replace(/^msg_/, '')}`,
    object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
    choices: [{ index: 0, message, finish_reason: finishReason(body.stop_reason) }],
    usage: {
      prompt_tokens: sourceUsage.input_tokens || 0,
      completion_tokens: sourceUsage.output_tokens || 0,
      total_tokens: (sourceUsage.input_tokens || 0) + (sourceUsage.output_tokens || 0),
      ...(sourceUsage.cache_read_input_tokens != null ? { prompt_tokens_details: { cached_tokens: sourceUsage.cache_read_input_tokens } } : {})
    }
  };
}

function openAiError(status, body) {
  const source = body && body.error ? body.error : body || {};
  return { error: { message: source.message || `Claude upstream returned HTTP ${status}`, type: source.type || 'api_error', param: null, code: source.type || null } };
}

function createSseTranslator() {
  const state = { id: `chatcmpl-${crypto.randomUUID()}`, model: 'claude', created: Math.floor(Date.now() / 1000), tool: -1, input: 0, output: 0, cached: 0, finish: 'stop', buffer: '', done: false };
  const frame = (delta, finish = null, usage) => `data: ${JSON.stringify({ id: state.id, object: 'chat.completion.chunk', created: state.created, model: state.model, choices: usage ? [] : [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
  function translate(event) {
    if (event.type === 'message_start') {
      const message = event.message || {}; const usage = message.usage || {};
      state.id = `chatcmpl-${String(message.id || crypto.randomUUID()).replace(/^msg_/, '')}`; state.model = message.model || state.model;
      state.input = usage.input_tokens || 0; state.cached = usage.cache_read_input_tokens || 0;
      return frame({ role: 'assistant', content: '' });
    }
    if (event.type === 'content_block_start' && event.content_block && event.content_block.type === 'tool_use') {
      state.tool++; const block = event.content_block;
      return frame({ tool_calls: [{ index: state.tool, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }] });
    }
    if (event.type === 'content_block_delta' && event.delta) {
      if (event.delta.type === 'text_delta') return frame({ content: event.delta.text || '' });
      if (event.delta.type === 'input_json_delta') return frame({ tool_calls: [{ index: state.tool, function: { arguments: event.delta.partial_json || '' } }] });
    }
    if (event.type === 'message_delta') {
      state.finish = finishReason(event.delta && event.delta.stop_reason); state.output = event.usage && event.usage.output_tokens || state.output; return '';
    }
    if (event.type === 'error') { state.done = true; return `data: ${JSON.stringify(openAiError(502, event))}\n\ndata: [DONE]\n\n`; }
    if (event.type === 'message_stop' && !state.done) {
      state.done = true;
      const usage = { prompt_tokens: state.input, completion_tokens: state.output, total_tokens: state.input + state.output, ...(state.cached ? { prompt_tokens_details: { cached_tokens: state.cached } } : {}) };
      return frame({}, state.finish) + frame({}, null, usage) + 'data: [DONE]\n\n';
    }
    return '';
  }
  return {
    push(chunk) {
      state.buffer += chunk.toString('utf8'); let out = ''; let at;
      while ((at = state.buffer.indexOf('\n\n')) >= 0) {
        const raw = state.buffer.slice(0, at); state.buffer = state.buffer.slice(at + 2);
        const line = raw.split('\n').find(l => l.startsWith('data:')); if (!line) continue;
        const payload = line.slice(5).trim(); if (!payload || payload === '[DONE]') continue;
        try { out += translate(JSON.parse(payload)); } catch (_) {}
      }
      return out;
    },
    end() { const out = state.done ? '' : translate({ type: 'message_stop' }); state.buffer = ''; return out; }
  };
}

module.exports = { anthropicToChat, chatToAnthropic, createSseTranslator, cursorModel, openAiError };
