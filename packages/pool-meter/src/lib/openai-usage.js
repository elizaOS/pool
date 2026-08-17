'use strict';
// openai-usage.js — convert OpenAI-shaped usage objects into the Anthropic
// shape the rest of pool-meter assumes.
//
// OpenAI usage semantics: usage.input_tokens (and chat-completions
// prompt_tokens) INCLUDE the cached subset reported in
// input_tokens_details.cached_tokens / prompt_tokens_details.cached_tokens.
// Anthropic semantics keep input_tokens and cache_read_input_tokens DISJOINT,
// and everything downstream (bumpTotals, effective-token weights, ledger,
// /status) assumes the Anthropic shape.
//
// So we convert at the boundary: input_tokens = max(0, input - cached),
// cache_read_input_tokens = cached. Copying cached without subtracting is a
// double-count (the bug this module exists to prevent: gpt-5.6-sol rows were
// logged as input=170093 cache_read=169472 when real uncached input was ~621).
//
// NEVER applied to Anthropic usage objects — those never carry
// *_tokens_details, and their branches in pool-meter.js do not call this.

function applyOpenAiUsage(usage, u) {
  if (!u) return;
  const input = (u.input_tokens != null ? u.input_tokens : u.prompt_tokens) || 0;
  const output = (u.output_tokens != null ? u.output_tokens : u.completion_tokens) || 0;
  const det = u.input_tokens_details || u.prompt_tokens_details || null;
  const cached = det && det.cached_tokens != null ? det.cached_tokens : null;
  usage.input_tokens = cached != null ? Math.max(0, input - cached) : input;
  usage.output_tokens = output;
  if (cached != null) usage.cache_read_input_tokens = cached;
}

// Parse Responses-API usage from SSE (or capture the model slug). Feeds the
// same {input_tokens,output_tokens,cache_read_input_tokens} shape bumpTotals
// expects, with the OpenAI→Anthropic conversion applied.
function makeResponsesUsageParser(usage, reqMeta) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let obj; try { obj = JSON.parse(payload); } catch (_) { continue; }
      const resp = obj && obj.response;
      if (reqMeta && !reqMeta.model) {
        const m = (resp && resp.model) || obj.model;
        if (m) reqMeta.model = m;
      }
      const u = (resp && resp.usage) || obj.usage || null;
      if (u && (u.input_tokens != null || u.output_tokens != null)) {
        applyOpenAiUsage(usage, u);
      }
    }
  };
}

module.exports = { applyOpenAiUsage, makeResponsesUsageParser };
