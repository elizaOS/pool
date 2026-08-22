const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { EventEmitter } = require('events');
const { Readable, Writable, PassThrough } = require('stream');
const { createRequestHandler, processBody, removeTopLevelThinkingParam, removeClearThinkingWithoutThinking, relocateDynamicSystemContext, reportBrokerOutcome, releaseBrokerLease, leaseAlreadyReported, sanitizeAnthropicBlocksJson, collectValidToolPairIds, activeRenamesForRequest, reverseMap } = require('./proxy');

function makeConfig(overrides = {}) {
  return {
    credsPath: 'env',
    replacements: [],
    reverseMap: [],
    toolRenames: [],
    propRenames: [],
    stripSystemConfig: false,
    stripToolDescriptions: false,
    injectCCStubs: false,
    stripTrailingAssistantPrefill: false,
    stripThinkingBlocks: false,
    upstreamUrl: 'http://anthropic.test',
    upstreamTimeoutMs: 2000,
    broker: {
      enabled: true,
      url: 'http://broker.test',
      token: 'broker-secret-token',
      strategy: 'quota-aware',
      providerId: 'anthropic-subscription',
      timeoutMs: 1000
    },
    ...overrides
  };
}

function messageBody() {
  return {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 64,
    system: [
      { type: 'text', text: 'system survives' },
      { type: 'text', text: 'history and tools stay as Anthropic messages' }
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'secret prompt marker' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'exec', input: { command: 'printf ok' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'tool result text' }] }] }
    ],
    tools: [
      { name: 'exec', description: 'runs commands', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }
    ]
  };
}

function jsonResponse(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...headers },
    chunks: [Buffer.from(JSON.stringify(body))]
  };
}

class MockClientRequest extends Writable {
  constructor(options, callback, router) {
    super();
    this.options = options;
    this.callback = callback;
    this.router = router;
    this.body = [];
    this.destroyed = false;
  }
  _write(chunk, enc, cb) {
    this.body.push(Buffer.from(chunk));
    cb();
  }
  setTimeout() {}
  end(chunk) {
    if (chunk) this.body.push(Buffer.from(chunk));
    setImmediate(() => {
      if (this.destroyed) return;
      this.router(this.options, Buffer.concat(this.body), this.callback, this);
    });
    return this;
  }
  destroy(err) {
    this.destroyed = true;
    if (err) this.emit('error', err);
    this.emit('close');
  }
}

function emitResponse(callback, spec) {
  const res = new PassThrough();
  res.statusCode = spec.statusCode;
  res.headers = spec.headers || {};
  callback(res);
  const chunks = spec.chunks || [];
  const writeNext = (i) => {
    if (i >= chunks.length) {
      if (!spec.keepOpen) res.end();
      return;
    }
    res.write(chunks[i]);
    setTimeout(() => writeNext(i + 1), spec.delayMs || 0);
  };
  writeNext(0);
  return res;
}

function installHttpMock(t, broker, upstream) {
  const oldRequest = http.request;
  http.request = (options, callback) => new MockClientRequest(options, callback, (opts, body, cb, req) => {
    const host = opts.hostname || opts.host;
    if (host === 'broker.test') broker(opts, body, cb, req);
    else if (host === 'anthropic.test') upstream(opts, body, cb, req);
    else throw new Error(`unexpected host ${host}`);
  });
  t.after(() => { http.request = oldRequest; });
}

// `opts.exhaustAfter`: number of leases to serve before answering
// `no_account_available`, which is how the real broker reports a starved pool.
//
// This mock mirrors the real broker's lease lifecycle: a terminal report DELETES
// the lease server-side, so any second report for the same leaseId is answered
// 404 `unknown_lease`. Without that behaviour the double-report bug from
// incident 2026-07-29B is invisible to tests.
function makeBroker(leases, opts = {}) {
  const state = { leaseRequests: [], reports: [], releases: [], duplicateReports: [] };
  const liveLeases = new Set();
  return {
    state,
    handler(options, body, callback) {
      assert.equal(options.headers.authorization, 'Bearer broker-secret-token');
      const parsed = JSON.parse(body.toString('utf8'));
      if (options.path === '/api/internal/account-pool/v1/lease') {
        state.leaseRequests.push(parsed);
        if (typeof opts.exhaustAfter === 'number' && state.leaseRequests.length > opts.exhaustAfter) {
          emitResponse(callback, jsonResponse(503, { ok: false, error: 'no_account_available' }));
          return;
        }
        const lease = leases[state.leaseRequests.length - 1] || leases[leases.length - 1];
        liveLeases.add(lease.leaseId);
        emitResponse(callback, jsonResponse(200, lease));
        return;
      }
      if (options.path === '/api/internal/account-pool/v1/report') {
        if (!liveLeases.has(parsed.leaseId)) {
          // Real broker: report() -> { ok:false, error:'unknown_lease' } -> 404.
          state.duplicateReports.push(parsed);
          emitResponse(callback, jsonResponse(404, { ok: false, error: 'unknown_lease' }));
          return;
        }
        state.reports.push(parsed);
        // A terminal (non-ok) report deletes the lease broker-side.
        if (!parsed.ok) liveLeases.delete(parsed.leaseId);
        emitResponse(callback, jsonResponse(200, { ok: true }));
        return;
      }
      if (options.path === '/api/internal/account-pool/v1/release') {
        state.releases.push(parsed);
        const released = liveLeases.delete(parsed.leaseId);
        emitResponse(callback, jsonResponse(200, { ok: true, released }));
        return;
      }
      emitResponse(callback, jsonResponse(404, { error: 'not_found' }));
    }
  };
}

function invokeProxy(config, body, headers = {}, opts = {}) {
  return new Promise((resolve) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, {
      method: 'POST',
      url: opts.url || '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'input-beta',
        ...headers
      }
    });
    const chunks = [];
    const res = new Writable({
      write(chunk, enc, cb) {
        chunks.push(Buffer.from(chunk));
        if (opts.onData) opts.onData(req, res, Buffer.from(chunk));
        cb();
      }
    });
    res.headersSent = false;
    res.statusCode = 200;
    res.headers = {};
    res.writeHead = (statusCode, responseHeaders) => {
      res.statusCode = statusCode;
      res.headers = responseHeaders || {};
      res.headersSent = true;
    };
    const originalEnd = res.end.bind(res);
    res.end = (chunk) => {
      if (chunk) chunks.push(Buffer.from(chunk));
      originalEnd();
      resolve({ statusCode: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') });
    };
    createRequestHandler(config, { requestCount: 0, startedAt: Date.now() })(req, res);
    if (opts.abortAfterMs) {
      setTimeout(() => req.emit('aborted'), opts.abortAfterMs);
    }
    if (opts.resolveAfterMs) {
      setTimeout(() => resolve({ statusCode: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }), opts.resolveAfterMs);
    }
  });
}

async function waitFor(fn, timeoutMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function processConfig(overrides = {}) {
  return {
    replacements: [],
    toolRenames: [],
    propRenames: [],
    stripSystemConfig: false,
    stripToolDescriptions: false,
    injectCCStubs: true,
    stripTrailingAssistantPrefill: false,
    stripThinkingBlocks: false,
    ...overrides
  };
}

function processedTools(tools, overrides = {}) {
  const body = {
    model: 'claude-fable-5',
    max_tokens: 8,
    messages: [{ role: 'user', content: 'test' }],
    tools
  };
  return JSON.parse(processBody(JSON.stringify(body), processConfig(overrides))).tools;
}

test('CC stub injection skips names already supplied by the client', () => {
  const tools = processedTools([
    { name: 'Glob', description: 'real client Glob tool', input_schema: { type: 'object', properties: {} } },
    { name: 'custom_tool', description: 'custom client tool', input_schema: { type: 'object', properties: {} } }
  ], { stripToolDescriptions: true });
  const names = tools.map(tool => tool.name);
  assert.equal(names.filter(name => name === 'Glob').length, 1);
  assert.equal(names.filter(name => name === 'custom_tool').length, 1);
  assert.equal(new Set(names).size, names.length);
});

test('CC stub injection populates an empty tools array', () => {
  const names = processedTools([]).map(tool => tool.name);
  assert.deepEqual(names, ['Glob', 'Grep', 'Agent', 'NotebookEdit', 'TodoRead']);
});

test('tool rename and CC stub injection together keep names unique', () => {
  const tools = processedTools([
    { name: 'exec', input_schema: { type: 'object', properties: {} } }
  ], { toolRenames: [['exec', 'Glob']] });
  const names = tools.map(tool => tool.name);
  assert.equal(names.filter(name => name === 'Glob').length, 1);
  assert.equal(new Set(names).size, names.length);
});

test('disabled CC stub injection leaves the tools array untouched', () => {
  const original = [
    { name: 'Glob', description: 'real tool', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'custom_tool', input_schema: { type: 'object', properties: {} } }
  ];
  assert.deepEqual(processedTools(original, { injectCCStubs: false }), original);
});

test('broker mode preserves complex Anthropic JSON fields and required headers', async (t) => {
  const broker = makeBroker([{ leaseId: 'lease-a', accountId: 'acct-a', accessToken: 'lease-token-a' }]);
  const upstreamState = { requests: [] };
  installHttpMock(t, broker.handler.bind(broker), (options, body, callback) => {
    upstreamState.requests.push({ options, body });
    assert.equal(options.headers.authorization, 'Bearer lease-token-a');
    assert.equal(options.headers['anthropic-version'], '2023-06-01');
    assert.match(options.headers['anthropic-beta'], /input-beta/);
    assert.match(options.headers['anthropic-beta'], /oauth-2025-04-20/);
    assert.equal(options.headers['user-agent'], 'claude-cli/2.1.224 (external, sdk-cli)');
    assert.equal(options.headers['x-app'], 'cli');
    assert.match(options.headers['x-client-request-id'], /^[0-9a-f-]{36}$/);
    assert.match(options.headers['x-claude-code-session-id'], /^[0-9a-f-]{36}$/);
    emitResponse(callback, jsonResponse(200, {
      type: 'message',
      model: 'claude-sonnet-4-20250514',
      role: 'assistant',
      content: [{ type: 'text', text: 'upstream response marker' }],
      usage: { input_tokens: 7, output_tokens: 11 }
    }));
  });
  const out = await invokeProxy(makeConfig(), messageBody(), { 'x-eliza-session-key': 'openclaw:test-session' });
  assert.equal(out.statusCode, 200);
  const sent = JSON.parse(upstreamState.requests[0].body.toString('utf8'));
  assert.deepEqual(sent.messages, messageBody().messages);
  assert.deepEqual(sent.tools, messageBody().tools);
  assert.match(sent.system[0].text, /^x-anthropic-billing-header: cc_version=2\.1\.224\.[0-9a-f]{3}; cc_entrypoint=sdk-cli; cch=[0-9a-f]{5};$/);
  assert.equal(sent.system[1].text, "You are a Claude agent, built on Anthropic's Claude Agent SDK.");
  assert.equal(sent.system.some(block => block.text === 'system survives'), true);
  assert.equal(broker.state.leaseRequests[0].sessionKey, 'openclaw:test-session');
  await waitFor(() => broker.state.reports.length >= 1);
  assert.equal(broker.state.reports[0].ok, true);
  assert.equal(broker.state.reports[0].tokens, 18);
});

test('Cursor chat completions route uses a pooled Claude seat', async (t) => {
  const broker = makeBroker([{ leaseId: 'lease-cursor', accountId: 'acct-cursor', accessToken: 'cursor-token' }]);
  let sent;
  installHttpMock(t, broker.handler.bind(broker), (options, body, callback) => {
    sent = { options, body: JSON.parse(body.toString('utf8')) };
    emitResponse(callback, jsonResponse(200, { id: 'msg_cursor', type: 'message', model: 'claude-sonnet-4-6', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'README.md' } }], stop_reason: 'tool_use', usage: { input_tokens: 9, output_tokens: 4 } }));
  });
  const out = await invokeProxy(makeConfig(), { model: 'anthropic:sonnet', messages: [{ role: 'user', content: 'Read it.' }], tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }] }, {}, { url: '/v1/chat/completions' });
  assert.equal(sent.options.path, '/v1/messages');
  assert.equal(sent.options.headers.authorization, 'Bearer cursor-token');
  assert.equal(sent.body.model, 'claude-sonnet-4-6');
  assert.equal(sent.body.tools[0].name, 'read_file');
  assert.match(sent.body.system[0].text, /cc_version=2\.1\.224/);
  const response = JSON.parse(out.text);
  assert.equal(response.object, 'chat.completion');
  assert.equal(response.choices[0].message.tool_calls[0].function.name, 'read_file');
  await waitFor(() => broker.state.reports.length >= 1);
  assert.equal(broker.state.reports[0].tokens, 13);
});

test('streaming SSE event order is preserved and usage is reported without full buffering', async (t) => {
  const broker = makeBroker([{ leaseId: 'lease-stream', accountId: 'acct-stream', accessToken: 'lease-token-stream' }]);
  const events = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2,"output_tokens":0}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n'
  ];
  installHttpMock(t, broker.handler.bind(broker), (options, body, callback) => {
    emitResponse(callback, { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, chunks: events.map(Buffer.from) });
  });
  const out = await invokeProxy(makeConfig(), { ...messageBody(), stream: true });
  assert.equal(out.statusCode, 200);
  assert.equal(out.text, events.join(''));
  await waitFor(() => broker.state.reports.length >= 1);
  assert.equal(broker.state.reports[0].tokens, 5);
});

test('401 and 429 retry once before client bytes and exclude failed account', async (t) => {
  for (const status of [401, 429]) {
    const broker = makeBroker([
      { leaseId: `lease-${status}-a`, accountId: `acct-${status}-a`, accessToken: `lease-token-${status}-a` },
      { leaseId: `lease-${status}-b`, accountId: `acct-${status}-b`, accessToken: `lease-token-${status}-b` }
    ]);
    const upstreamState = { count: 0 };
    installHttpMock(t, broker.handler.bind(broker), (options, body, callback) => {
      upstreamState.count++;
      if (upstreamState.count === 1) {
        emitResponse(callback, jsonResponse(status, { error: { type: status === 401 ? 'authentication_error' : 'rate_limit_error' } }, status === 429 ? { 'retry-after': '2' } : {}));
        return;
      }
      assert.equal(options.headers.authorization, `Bearer lease-token-${status}-b`);
      emitResponse(callback, jsonResponse(200, { type: 'message', model: 'claude', usage: { input_tokens: 1, output_tokens: 1 }, content: [] }));
    });
    const out = await invokeProxy(makeConfig(), messageBody());
    assert.equal(out.statusCode, 200);
    assert.equal(upstreamState.count, 2);
    assert.deepEqual(broker.state.leaseRequests[1].exclude, [`acct-${status}-a`]);
    await waitFor(() => broker.state.reports.length >= 2);
    assert.equal(broker.state.reports[0].httpStatus, status);
    assert.equal(broker.state.reports[1].ok, true);
  }
});

test('real extra-usage exhaustion walks excluded accounts until success without logging bodies or secrets', async (t) => {
  const logs = [];
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));
  t.after(() => { console.log = oldLog; console.error = oldError; });

  const broker = makeBroker([
    { leaseId: 'lease-quota-a', accountId: 'acct-quota-a', accessToken: 'quota-token-a', email: 'quota-a@example.com' },
    { leaseId: 'lease-quota-b', accountId: 'acct-quota-b', accessToken: 'quota-token-b', email: 'quota-b@example.com' }
  ]);
  const quotaMessage = "You're out of extra usage. Add more to continue.";
  let upstreamCount = 0;
  installHttpMock(t, broker.handler.bind(broker), (options, body, callback) => {
    if (upstreamCount++ === 0) {
      emitResponse(callback, jsonResponse(400, { type: 'error', error: { type: 'invalid_request_error', message: quotaMessage } }));
      return;
    }
    assert.equal(options.headers.authorization, 'Bearer quota-token-b');
    emitResponse(callback, jsonResponse(200, { type: 'message', model: 'claude', usage: { input_tokens: 2, output_tokens: 3 }, content: [] }));
  });

  const out = await invokeProxy(makeConfig(), messageBody());
  assert.equal(out.statusCode, 200);
  assert.equal(upstreamCount, 2);
  assert.deepEqual(broker.state.leaseRequests.map(request => request.exclude), [[], ['acct-quota-a']]);
  await waitFor(() => broker.state.reports.length >= 2);
  assert.deepEqual(broker.state.reports.map(report => report.errorCode), ['account_quota_exhausted', undefined]);
  assert.equal(logs.join('\n').includes(quotaMessage), false);
});

test('third-party app classification is request-level: no seat sweep, no demotion, lease released', async (t) => {
  const broker = makeBroker([
    { leaseId: 'lease-class-a', accountId: 'acct-class-a', accessToken: 'class-token-a' },
    { leaseId: 'lease-class-b', accountId: 'acct-class-b', accessToken: 'class-token-b' }
  ]);
  let upstreamCount = 0;
  installHttpMock(t, broker.handler.bind(broker), (_options, _body, callback) => {
    upstreamCount++;
    emitResponse(callback, jsonResponse(400, {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Third-party apps now draw from your extra usage, not your plan limits.' }
    }));
  });

  const out = await invokeProxy(makeConfig(), messageBody());
  assert.equal(out.statusCode, 400);
  assert.equal(upstreamCount, 1, 'must not replay a request-classification failure on another seat');
  assert.equal(broker.state.leaseRequests.length, 1);
  await waitFor(() => broker.state.releases.length === 1);
  assert.equal(broker.state.reports.length, 0, 'must not report a request fault as account health');
  assert.equal(broker.state.releases[0].leaseId, 'lease-class-a');
});

test('ordinary Anthropic 400 is terminal and does not churn broker accounts or log its body', async (t) => {
  const logs = [];
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));
  t.after(() => { console.log = oldLog; console.error = oldError; });

  const broker = makeBroker([
    { leaseId: 'lease-bad-request-a', accountId: 'acct-bad-request-a', accessToken: 'bad-request-token-a' },
    { leaseId: 'lease-bad-request-b', accountId: 'acct-bad-request-b', accessToken: 'bad-request-token-b' }
  ]);
  const terminalMessage = 'ordinary-400-private-body-marker';
  let upstreamCount = 0;
  installHttpMock(t, broker.handler.bind(broker), (options, body, callback) => {
    upstreamCount++;
    emitResponse(callback, jsonResponse(400, {
      type: 'error', error: { type: 'invalid_request_error', message: terminalMessage }
    }));
  });

  const out = await invokeProxy(makeConfig(), messageBody());
  assert.equal(out.statusCode, 400);
  assert.match(out.text, new RegExp(terminalMessage));
  assert.equal(upstreamCount, 1);
  assert.equal(broker.state.leaseRequests.length, 1);
  await waitFor(() => broker.state.reports.length >= 1);
  assert.equal(broker.state.reports.length, 1);
  assert.equal(broker.state.reports[0].httpStatus, 400);
  assert.equal(broker.state.reports[0].errorCode, 'invalid_request_error');
  assert.equal(logs.join('\n').includes(terminalMessage), false);
});

test('network failure before upstream bytes retries once; provider 5xx does not churn', async (t) => {
  const broker = makeBroker([
    { leaseId: 'lease-net-a', accountId: 'acct-net-a', accessToken: 'lease-token-net-a' },
    { leaseId: 'lease-net-b', accountId: 'acct-net-b', accessToken: 'lease-token-net-b' }
  ]);
  let count = 0;
  installHttpMock(t, broker.handler.bind(broker), (options, body, callback, req) => {
    count++;
    if (count === 1) {
      req.emit('error', Object.assign(new Error('connect reset'), { code: 'ECONNRESET' }));
      return;
    }
    emitResponse(callback, jsonResponse(200, { type: 'message', model: 'claude', usage: { input_tokens: 1, output_tokens: 1 }, content: [] }));
  });
  const out = await invokeProxy(makeConfig(), messageBody());
  assert.equal(out.statusCode, 200);
  assert.equal(count, 2);
  assert.equal(broker.state.leaseRequests[1].exclude.length, 0);

  const broker5xx = makeBroker([{ leaseId: 'lease-5xx', accountId: 'acct-5xx', accessToken: 'lease-token-5xx' }]);
  let count5xx = 0;
  installHttpMock(t, broker5xx.handler.bind(broker5xx), (options, body, callback) => {
    count5xx++;
    emitResponse(callback, jsonResponse(529, { error: { type: 'overloaded_error', message: 'try later' } }));
  });
  const out5xx = await invokeProxy(makeConfig(), messageBody());
  assert.equal(out5xx.statusCode, 529);
  assert.equal(count5xx, 1);
  assert.equal(broker5xx.state.leaseRequests.length, 1);
});

test('does not replay after streamed bytes and propagates caller abort', async (t) => {
  const broker = makeBroker([{ leaseId: 'lease-abort', accountId: 'acct-abort', accessToken: 'lease-token-abort' }]);
  let upstreamDestroyed = false;
  installHttpMock(t, broker.handler.bind(broker), (options, body, callback, req) => {
    const res = emitResponse(callback, {
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
      chunks: [Buffer.from('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n' + 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"' + 'x'.repeat(128) + '"}}\n\n')],
      keepOpen: true
    });
    req.on('close', () => {
      upstreamDestroyed = true;
      res.destroy();
    });
  });
  const out = await invokeProxy(makeConfig(), { ...messageBody(), stream: true }, {}, {
    abortAfterMs: 5,
    resolveAfterMs: 50
  });
  await waitFor(() => broker.state.reports.length >= 1);
  assert.match(out.text, /message_start/);
  assert.equal(upstreamDestroyed, true);
  assert.equal(broker.state.leaseRequests.length, 1);
  assert.equal(broker.state.reports.some(r => r.errorCode === 'client_aborted'), true);
});

test('broker token, access token, auth header, prompts, responses, and account email are redacted from logs', async (t) => {
  const logs = [];
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));
  t.after(() => { console.log = oldLog; console.error = oldError; });
  const broker = makeBroker([{ leaseId: 'lease-redact', accountId: 'acct-redact', accessToken: 'lease-token-redact', email: 'person@example.com' }]);
  installHttpMock(t, broker.handler.bind(broker), (options, body, callback) => {
    emitResponse(callback, jsonResponse(200, { type: 'message', model: 'claude', content: [{ type: 'text', text: 'upstream response marker' }], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  await invokeProxy(makeConfig(), messageBody());
  const joined = logs.join('\n');
  for (const forbidden of ['broker-secret-token', 'lease-token-redact', 'Authorization', 'secret prompt marker', 'upstream response marker', 'person@example.com']) {
    assert.equal(joined.includes(forbidden), false, forbidden);
  }
});

test('legacy mode is unchanged: broker is not called and OAUTH_TOKEN authorizes upstream', async (t) => {
  process.env.OAUTH_TOKEN = 'legacy-token';
  let brokerCalled = false;
  let upstreamCalled = false;
  installHttpMock(t, () => { brokerCalled = true; }, (options, body, callback) => {
    upstreamCalled = true;
    assert.equal(options.headers.authorization, 'Bearer legacy-token');
    emitResponse(callback, jsonResponse(200, { type: 'message', model: 'claude', usage: { input_tokens: 1, output_tokens: 1 }, content: [] }));
  });
  const out = await invokeProxy(makeConfig({ broker: { enabled: false } }), messageBody());
  assert.equal(out.statusCode, 200);
  assert.equal(upstreamCalled, true);
  assert.equal(brokerCalled, false);
});


// Regression: the top-level thinking strip used to be a regex that matched any
// "thinking":{...} anywhere in the body and truncated at the first '}'. That
// deleted tool input_schema properties named "thinking" and corrupted the JSON,
// so Anthropic returned 400 "The request body is not valid JSON" and the proxy
// swept every pooled account as if it were a quota outage.
test('top-level thinking strip removes only the request parameter and keeps valid JSON', () => {
  const body = JSON.stringify({
    model: 'm',
    thinking: { type: 'enabled', budget_tokens: 2048 },
    tools: [{
      name: 'notes',
      input_schema: {
        type: 'object',
        properties: {
          thinking: { type: 'string', description: 'scratch' },
          text: { type: 'string' }
        },
        required: ['text']
      }
    }],
    messages: [{ role: 'user', content: 'hi' }]
  });

  const { body: out, count } = removeTopLevelThinkingParam(body);
  assert.equal(count, 1);
  const parsed = JSON.parse(out);
  assert.equal('thinking' in parsed, false);
  assert.deepEqual(parsed.tools[0].input_schema.properties.thinking, { type: 'string', description: 'scratch' });
  assert.deepEqual(parsed.messages, [{ role: 'user', content: 'hi' }]);
});

test('top-level thinking strip handles nested braces, first/last position, and absence', () => {
  const nested = removeTopLevelThinkingParam(JSON.stringify({
    thinking: { type: 'enabled', nested: { a: 1, b: { c: 2 } } },
    model: 'm'
  }));
  assert.equal(nested.count, 1);
  assert.deepEqual(JSON.parse(nested.body), { model: 'm' });

  const last = removeTopLevelThinkingParam(JSON.stringify({ model: 'm', messages: [], thinking: { type: 'enabled' } }));
  assert.equal(last.count, 1);
  assert.deepEqual(JSON.parse(last.body), { model: 'm', messages: [] });

  const none = removeTopLevelThinkingParam(JSON.stringify({
    model: 'm',
    messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }] }]
  }));
  assert.equal(none.count, 0);
  assert.equal(JSON.parse(none.body).messages[0].content[0].type, 'thinking');
});

test('clear_thinking context edit is removed when thinking is absent', () => {
  const input = JSON.stringify({
    model: 'claude-fable-5',
    context_management: { edits: [
      { type: 'clear_thinking_20251015', keep: 'all' },
      { type: 'clear_tool_uses_20250919', trigger: { type: 'input_tokens', value: 1000 } }
    ] },
    messages: [{ role: 'user', content: 'hi' }]
  });
  const cleaned = removeClearThinkingWithoutThinking(input);
  assert.equal(cleaned.count, 1);
  assert.deepEqual(JSON.parse(cleaned.body).context_management.edits, [
    { type: 'clear_tool_uses_20250919', trigger: { type: 'input_tokens', value: 1000 } }
  ]);

  const enabled = removeClearThinkingWithoutThinking(JSON.stringify({
    thinking: { type: 'adaptive' },
    context_management: { edits: [{ type: 'clear_thinking_20251015' }] }
  }));
  assert.equal(enabled.count, 0);
});

test('relocateDynamicSystemContext preserves dynamic integration context but moves it out of system identity', () => {
  const marker = '<!-- OPENCLAW_CACHE_BOUNDARY -->';
  const input = {
    model: 'claude-fable-5',
    system: [{ type: 'text', text: `static workspace identity\n${marker}\n# Dynamic Project Context\nchannel: discord`, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }, { type: 'text', text: 'current request' }] }]
  };
  const result = relocateDynamicSystemContext(JSON.stringify(input));
  assert.equal(result.relocated, true);
  assert.ok(result.chars > marker.length);
  const output = JSON.parse(result.body);
  assert.equal(output.system[0].text, 'static workspace identity');
  assert.deepEqual(output.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(output.messages[0].content[0].type, 'tool_result', 'tool result ordering is preserved');
  const relocatedText = output.messages[0].content.at(-1).text;
  assert.match(relocatedText, /<runtime_context>/);
  assert.match(relocatedText, /Dynamic Project Context/);
  assert.match(relocatedText, /channel: discord/);
});

test('relocateDynamicSystemContext is fail-open/no-op without a known boundary or user turn', () => {
  const ordinary = JSON.stringify({ system: [{ type: 'text', text: 'ordinary' }], messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(relocateDynamicSystemContext(ordinary), { body: ordinary, relocated: false, chars: 0 });
  const noUser = JSON.stringify({ system: [{ type: 'text', text: 'static<!-- OPENCLAW_CACHE_BOUNDARY -->dynamic' }], messages: [] });
  assert.deepEqual(relocateDynamicSystemContext(noUser), { body: noUser, relocated: false, chars: 0 });
});

test('processBody with thinking strip enabled emits valid JSON for tools that declare a thinking property', () => {
  const config = makeConfig({ stripThinkingBlocks: true });
  const body = JSON.stringify({
    model: 'm',
    max_tokens: 64,
    thinking: { type: 'enabled', budget_tokens: 2048 },
    tools: [{ name: 'notes', input_schema: { type: 'object', properties: { thinking: { type: 'string' }, text: { type: 'string' } } } }],
    messages: [{ role: 'user', content: 'hi' }]
  });

  const shaped = processBody(body, config);
  const parsed = JSON.parse(shaped); // would throw before the fix
  assert.equal('thinking' in parsed, false);
  assert.deepEqual(parsed.tools[0].input_schema.properties.thinking, { type: 'string' });
});

// ── Regression: quota-flavoured 400 must carry a bounded retry window ────────
//
// Incident 2026-07-29. The broker's report handler routes a quota/rate-limit
// outcome with no usable `retryAfterMs` into `markRateLimitedUnknown`, which
// persists `health='rate-limited'` WITHOUT `healthDetail.until`. Selection only
// re-admits a rate-limited seat when `healthDetail.until < now`, so a missing
// `until` never expires and the seat is parked indefinitely. One 400 sweep
// across the pool therefore demoted every seat, after which leases returned
// `no_account_available` and the proxy answered 503 "Account broker
// unavailable" for ALL models. Emitting an explicit bounded window makes the
// demotion self-healing.
test('resolveRetryAfterMs always returns a bounded window for a quota 400', () => {
  const { resolveRetryAfterMs, QUOTA_400_COOLDOWN_MS } = require('./proxy');

  // No Retry-After header: must synthesise a positive finite cooldown, never
  // null/0/NaN (any of which the broker reads as "unknown" -> no expiry).
  for (const missing of [null, undefined, 0, -1, NaN, Infinity]) {
    const out = resolveRetryAfterMs(true, missing);
    assert.equal(Number.isFinite(out), true, String(missing));
    assert.equal(out > 0, true, String(missing));
    assert.equal(out, QUOTA_400_COOLDOWN_MS, String(missing));
  }

  // A real upstream Retry-After wins over the fallback.
  assert.equal(resolveRetryAfterMs(true, 5000), 5000);

  // Non-quota outcomes are untouched, including the null passthrough.
  assert.equal(resolveRetryAfterMs(false, null), null);
  assert.equal(resolveRetryAfterMs(false, 1234), 1234);
});

test('quota 400 sweep reports a positive retryAfterMs for every demoted account', async (t) => {
  const oldLog = console.log;
  const oldError = console.error;
  console.log = () => {};
  console.error = () => {};
  t.after(() => { console.log = oldLog; console.error = oldError; });

  const broker = makeBroker([
    { leaseId: 'lease-ra-a', accountId: 'acct-ra-a', accessToken: 'ra-token-a' },
    { leaseId: 'lease-ra-b', accountId: 'acct-ra-b', accessToken: 'ra-token-b' },
    { leaseId: 'lease-ra-c', accountId: 'acct-ra-c', accessToken: 'ra-token-c' }
  ]);

  let upstreamCount = 0;
  installHttpMock(t, broker.handler.bind(broker), (options, body, callback) => {
    const attempt = upstreamCount++;
    if (attempt < 2) {
      // Anthropic sends NO Retry-After on these 400s. That is the trigger.
      emitResponse(callback, jsonResponse(400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: "You're out of extra usage." }
      }));
      return;
    }
    emitResponse(callback, jsonResponse(200, {
      type: 'message', model: 'claude', usage: { input_tokens: 1, output_tokens: 1 }, content: []
    }));
  });

  const out = await invokeProxy(makeConfig(), messageBody());
  assert.equal(out.statusCode, 200);
  await waitFor(() => broker.state.reports.length >= 3);

  const quotaReports = broker.state.reports.filter(r => r.errorCode === 'account_quota_exhausted');
  assert.equal(quotaReports.length, 2);
  for (const report of quotaReports) {
    // Before the fix this field was absent -> markRateLimitedUnknown -> the
    // seat never became selectable again.
    assert.equal(typeof report.retryAfterMs, 'number', 'retryAfterMs must be present');
    assert.equal(Number.isFinite(report.retryAfterMs) && report.retryAfterMs > 0, true);
  }
});

// ─── Incident 2026-07-29B: lease double-report / BROKER_404 ─────────────────

test('exhausted pool reports each lease exactly once and never double-reports (BROKER_404)', async (t) => {
  const oldLog = console.log;
  const oldError = console.error;
  const errors = [];
  console.log = () => {};
  console.error = (...a) => { errors.push(a.join(' ')); };
  t.after(() => { console.log = oldLog; console.error = oldError; });

  // Two seats available, then the pool is starved. Every seat answers the
  // quota-flavoured 400, so the proxy exhausts its retry budget and falls
  // through to the terminal branch holding an ALREADY-REPORTED lease.
  const broker = makeBroker([
    { leaseId: 'lease-dup-a', accountId: 'acct-dup-a', accessToken: 'dup-token-a' },
    { leaseId: 'lease-dup-b', accountId: 'acct-dup-b', accessToken: 'dup-token-b' }
  ], { exhaustAfter: 2 });

  installHttpMock(t, broker.handler.bind(broker), (options, body, callback) => {
    emitResponse(callback, jsonResponse(400, {
      type: 'error',
      error: { type: 'invalid_request_error', message: "You're out of extra usage." }
    }));
  });

  const out = await invokeProxy(makeConfig(), messageBody());

  // The client still gets a complete response rather than a hang.
  assert.equal(out.statusCode, 400);

  await waitFor(() => broker.state.reports.length >= 2);

  // Core assertion: no leaseId is reported twice.
  const ids = broker.state.reports.map(r => r.leaseId);
  assert.deepEqual([...new Set(ids)].sort(), ids.slice().sort(),
    'each lease must be reported at most once');
  assert.equal(broker.state.duplicateReports.length, 0,
    'broker must never receive a duplicate report (this produced BROKER_404)');
  assert.equal(errors.some(e => e.includes('BROKER_404')), false,
    'no BROKER_404 should be logged');

  // The bounded-window contract from 2026-07-29 must still hold on every report.
  for (const report of broker.state.reports) {
    assert.equal(report.errorCode, 'account_quota_exhausted');
    assert.equal(Number.isFinite(report.retryAfterMs) && report.retryAfterMs > 0, true,
      'each demoted seat still needs a bounded cooldown');
  }
});

test('reportBrokerOutcome is idempotent per lease and releaseBrokerLease is a no-op after reporting', async (t) => {
  const oldError = console.error;
  console.error = () => {};
  t.after(() => { console.error = oldError; });

  const broker = makeBroker([{ leaseId: 'lease-idem', accountId: 'acct-idem', accessToken: 'tok' }]);
  installHttpMock(t, broker.handler.bind(broker), () => {
    throw new Error('upstream must not be called');
  });

  const config = makeConfig();
  const lease = { leaseId: 'lease-idem', accountId: 'acct-idem' };
  // Seed the lease as live so the first report is accepted.
  broker.handler(
    { headers: { authorization: 'Bearer broker-secret-token' }, path: '/api/internal/account-pool/v1/lease' },
    Buffer.from(JSON.stringify({ providerId: 'anthropic-subscription', sessionKey: 'k' })),
    () => {}
  );

  await reportBrokerOutcome(config, lease, { ok: false, httpStatus: 400, errorCode: 'account_quota_exhausted', retryAfterMs: 60000 });
  await reportBrokerOutcome(config, lease, { ok: false, httpStatus: 400, errorCode: 'account_quota_exhausted', retryAfterMs: 60000 });
  await releaseBrokerLease(config, lease);

  assert.equal(broker.state.reports.length, 1, 'second report must be suppressed client-side');
  assert.equal(broker.state.duplicateReports.length, 0);
  assert.equal(broker.state.releases.length, 0, 'a reported lease must not also be released');
  assert.equal(leaseAlreadyReported(lease), true);
});

test('releaseBrokerLease hands back an unreported lease exactly once', async (t) => {
  const oldError = console.error;
  console.error = () => {};
  t.after(() => { console.error = oldError; });

  const broker = makeBroker([{ leaseId: 'lease-rel', accountId: 'acct-rel', accessToken: 'tok' }]);
  installHttpMock(t, broker.handler.bind(broker), () => {
    throw new Error('upstream must not be called');
  });

  const config = makeConfig();
  const lease = { leaseId: 'lease-rel', accountId: 'acct-rel' };

  await releaseBrokerLease(config, lease);
  await releaseBrokerLease(config, lease);

  assert.equal(broker.state.releases.length, 1, 'release must be sent once, not per call');
  assert.equal(broker.state.releases[0].leaseId, 'lease-rel');
  assert.equal(broker.state.reports.length, 0);
});

// ─── Composability: works in ANY harness (Claude Code CLI, arbitrary agents) ──
// These lock in the two fixes that make the pool harness-agnostic:
//   1. sanitizer preserves VALID tool_use/tool_result pairs (only drops orphans
//      and OC-internal camelCase blocks), so real agentic history round-trips.
//   2. reverse-rename only undoes renames the caller actually originated, so a
//      native-CC harness gets its own tool names back verbatim.

test('composability: collectValidToolPairIds returns only paired tool_use ids', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'ok1', name: 'Bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ok1', content: [] }] },
    // orphan tool_use (no matching result)
    { role: 'assistant', content: [{ type: 'tool_use', id: 'orphan', name: 'Bash', input: {} }] },
    // orphan tool_result (references unknown id)
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ghost', content: [] }] }
  ];
  const valid = collectValidToolPairIds(messages);
  assert.equal(valid.has('ok1'), true);
  assert.equal(valid.has('orphan'), false);
  assert.equal(valid.has('ghost'), false);
  assert.equal(valid.size, 1);
});

test('composability: sanitizer preserves valid tool_use/tool_result pairs (agentic history round-trips)', () => {
  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'run it' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'file.txt' }] }] }
    ]
  });
  const out = sanitizeAnthropicBlocksJson(body);
  const parsed = JSON.parse(out.body);
  // All three turns survive; the tool blocks are intact.
  assert.equal(parsed.messages.length, 3);
  assert.equal(parsed.messages[1].content[0].type, 'tool_use');
  assert.equal(parsed.messages[1].content[0].id, 'tu_1');
  assert.equal(parsed.messages[2].content[0].type, 'tool_result');
  assert.equal(parsed.messages[2].content[0].tool_use_id, 'tu_1');
});

test('composability: sanitizer still drops ORPHANED tool blocks and OC camelCase blocks', () => {
  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'keep me' }] },
      // orphan tool_use (no result) — must be dropped
      { role: 'assistant', content: [{ type: 'tool_use', id: 'no_pair', name: 'Bash', input: {} }] },
      // OC-internal camelCase — always dropped
      { role: 'assistant', content: [{ type: 'toolCall', id: 'oc1', name: 'exec' }] },
      { role: 'user', content: [{ type: 'toolResult', toolCallId: 'oc1' }] }
    ]
  });
  const out = sanitizeAnthropicBlocksJson(body);
  const parsed = JSON.parse(out.body);
  // Only the text turn survives; every tool block was orphaned/OC-internal.
  const kept = parsed.messages.filter(m => Array.isArray(m.content) && m.content.length);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].content[0].text, 'keep me');
});

test('composability: reverse-rename only undoes renames the caller originated (native-CC passthrough)', () => {
  const config = makeConfig({
    toolRenames: [['web_search', 'WebSearch'], ['exec', 'Bash']],
    propRenames: [],
    reverseMap: []
  });
  // A native Claude Code CLI request: it sends WebSearch natively, never web_search.
  const ccRequestBody = JSON.stringify({ tools: [{ name: 'WebSearch' }, { name: 'Bash' }] });
  const active = activeRenamesForRequest(ccRequestBody, config);
  // No OC snake_case names present -> nothing is active -> nothing gets reversed.
  assert.equal(active.toolRenames.length, 0);
  // A response containing WebSearch must pass through UNTOUCHED for this caller.
  const upstreamResp = '{"content":[{"type":"tool_use","name":"WebSearch"}]}';
  assert.equal(reverseMap(upstreamResp, config, active), upstreamResp);
});

test('composability: OC caller still gets its snake_case names back (no regression)', () => {
  const config = makeConfig({
    toolRenames: [['web_search', 'WebSearch'], ['exec', 'Bash']],
    propRenames: [],
    reverseMap: []
  });
  // OC harness sends snake_case natively.
  const ocRequestBody = JSON.stringify({ tools: [{ name: 'web_search' }, { name: 'exec' }] });
  const active = activeRenamesForRequest(ocRequestBody, config);
  assert.equal(active.toolRenames.length, 2);
  // Upstream (camouflaged as CC) responds with WebSearch/Bash; reverse to OC names.
  const upstreamResp = '{"content":[{"type":"tool_use","name":"WebSearch"},{"type":"tool_use","name":"Bash"}]}';
  const mapped = reverseMap(upstreamResp, config, active);
  assert.match(mapped, /"web_search"/);
  assert.match(mapped, /"exec"/);
  assert.equal(/"WebSearch"|"Bash"/.test(mapped), false);
});

test('composability: null activeRenames falls back to reversing all (backward-compat default)', () => {
  const config = makeConfig({
    toolRenames: [['web_search', 'WebSearch']],
    propRenames: [],
    reverseMap: []
  });
  const upstreamResp = '{"name":"WebSearch"}';
  // No active set provided -> legacy behaviour: reverse everything.
  assert.match(reverseMap(upstreamResp, config, null), /"web_search"/);
});
