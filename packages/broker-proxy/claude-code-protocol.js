'use strict';

const crypto = require('crypto');

const CLAUDE_CODE_VERSION = '2.1.224';
const CLAUDE_CODE_ENTRYPOINT = 'sdk-cli';
const BILLING_HASH_SALT = '59cf53e54c78';
const BILLING_HASH_INDICES = [4, 7, 20];
const CCH_PLACEHOLDER = 'cch=00000';
const CCH_SEED = 0x4d659218e32a3268n;
const MASK_64 = 0xffffffffffffffffn;
const PRIME64_1 = 0x9e3779b185ebca87n;
const PRIME64_2 = 0xc2b2ae3d27d4eb4fn;
const PRIME64_3 = 0x165667b19e3779f9n;
const PRIME64_4 = 0x85ebca77c2b2ae63n;
const PRIME64_5 = 0x27d4eb2f165667c5n;
const AGENT_SDK_SYSTEM_PROMPT = 'You are a Claude agent, built on Anthropic\'s Claude Agent SDK.';

function rotateLeft(value, bits) {
  const normalized = value & MASK_64;
  return ((normalized << bits) | (normalized >> (64n - bits))) & MASK_64;
}

function readUint32LE(bytes, offset) {
  return BigInt(
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>> 0
  );
}

function readUint64LE(bytes, offset) {
  return readUint32LE(bytes, offset) | (readUint32LE(bytes, offset + 4) << 32n);
}

function round(accumulator, input) {
  const mixed = (accumulator + input * PRIME64_2) & MASK_64;
  return (rotateLeft(mixed, 31n) * PRIME64_1) & MASK_64;
}

function mergeRound(accumulator, value) {
  return ((accumulator ^ round(0n, value)) * PRIME64_1 + PRIME64_4) & MASK_64;
}

function xxHash64(bytes, seed = 0n) {
  let offset = 0;
  let hash;

  if (bytes.length >= 32) {
    let v1 = (seed + PRIME64_1 + PRIME64_2) & MASK_64;
    let v2 = (seed + PRIME64_2) & MASK_64;
    let v3 = seed & MASK_64;
    let v4 = (seed - PRIME64_1) & MASK_64;
    while (offset <= bytes.length - 32) {
      v1 = round(v1, readUint64LE(bytes, offset));
      v2 = round(v2, readUint64LE(bytes, offset + 8));
      v3 = round(v3, readUint64LE(bytes, offset + 16));
      v4 = round(v4, readUint64LE(bytes, offset + 24));
      offset += 32;
    }
    hash = (
      rotateLeft(v1, 1n) + rotateLeft(v2, 7n) +
      rotateLeft(v3, 12n) + rotateLeft(v4, 18n)
    ) & MASK_64;
    hash = mergeRound(hash, v1);
    hash = mergeRound(hash, v2);
    hash = mergeRound(hash, v3);
    hash = mergeRound(hash, v4);
  } else {
    hash = (seed + PRIME64_5) & MASK_64;
  }

  hash = (hash + BigInt(bytes.length)) & MASK_64;
  while (offset <= bytes.length - 8) {
    const lane = round(0n, readUint64LE(bytes, offset));
    hash = (rotateLeft(hash ^ lane, 27n) * PRIME64_1 + PRIME64_4) & MASK_64;
    offset += 8;
  }
  if (offset <= bytes.length - 4) {
    hash ^= readUint32LE(bytes, offset) * PRIME64_1;
    hash = (rotateLeft(hash, 23n) * PRIME64_2 + PRIME64_3) & MASK_64;
    offset += 4;
  }
  while (offset < bytes.length) {
    hash ^= BigInt(bytes[offset]) * PRIME64_5;
    hash = (rotateLeft(hash, 11n) * PRIME64_1) & MASK_64;
    offset++;
  }

  hash ^= hash >> 33n;
  hash = (hash * PRIME64_2) & MASK_64;
  hash ^= hash >> 29n;
  hash = (hash * PRIME64_3) & MASK_64;
  hash ^= hash >> 32n;
  return hash & MASK_64;
}

function firstUserText(messages) {
  for (const message of messages || []) {
    if (!message || message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (!Array.isArray(message.content)) return '';
    return message.content
      .filter(block => block && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('');
  }
  return '';
}

function versionFingerprint(messages) {
  const prompt = firstUserText(messages);
  const selected = BILLING_HASH_INDICES.map(index => prompt[index] || '0').join('');
  return crypto
    .createHash('sha256')
    .update(`${BILLING_HASH_SALT}${selected}${CLAUDE_CODE_VERSION}`)
    .digest('hex')
    .slice(0, 3);
}

function isBillingBlock(block) {
  return block && typeof block.text === 'string' &&
    block.text.startsWith('x-anthropic-billing-header: ');
}

function applyClaudeCodeProtocol(serializedBody) {
  let body;
  try { body = JSON.parse(serializedBody); }
  catch (_) { throw new Error('Claude Code compatibility requires a JSON request object'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Claude Code compatibility requires a JSON request object');
  }
  if (typeof body.model !== 'string' || !Object.prototype.hasOwnProperty.call(body, 'max_tokens')) {
    throw new Error('Claude Code compatibility requires model and max_tokens');
  }

  const existing = Array.isArray(body.system)
    ? body.system
    : typeof body.system === 'string'
      ? [{ type: 'text', text: body.system }]
      : [];
  const remaining = existing.filter((block, index) => {
    if (isBillingBlock(block)) return false;
    return !(index <= 1 && block && block.text === AGENT_SDK_SYSTEM_PROMPT);
  });
  const fingerprint = versionFingerprint(body.messages);
  body.system = [
    {
      type: 'text',
      text: `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${fingerprint}; cc_entrypoint=${CLAUDE_CODE_ENTRYPOINT}; ${CCH_PLACEHOLDER};`
    },
    { type: 'text', text: AGENT_SDK_SYSTEM_PROMPT },
    ...remaining
  ];

  const normalized = structuredClone(body);
  normalized.model = '';
  delete normalized.max_tokens;
  const hash = xxHash64(Buffer.from(JSON.stringify(normalized), 'utf8'), CCH_SEED);
  const cch = (hash & 0xfffffn).toString(16).padStart(5, '0');
  body.system[0].text = body.system[0].text.replace(CCH_PLACEHOLDER, `cch=${cch}`);
  return JSON.stringify(body);
}

function claudeCodeHeaders(sessionId) {
  return {
    'user-agent': `claude-cli/${CLAUDE_CODE_VERSION} (external, ${CLAUDE_CODE_ENTRYPOINT})`,
    'x-app': 'cli',
    'x-client-request-id': crypto.randomUUID(),
    ...(sessionId ? { 'x-claude-code-session-id': sessionId } : {})
  };
}

module.exports = {
  AGENT_SDK_SYSTEM_PROMPT,
  CLAUDE_CODE_ENTRYPOINT,
  CLAUDE_CODE_VERSION,
  applyClaudeCodeProtocol,
  claudeCodeHeaders,
  versionFingerprint,
  xxHash64
};
