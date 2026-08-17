/**
 * tokens.js — opaque contributor tokens.
 *
 * A contributor never receives a pool key. They receive a prefixed edge token
 * (default `army_`) that only means something at this edge. KV stores the
 * SHA-256 of the token, never the token itself, so a KV dump is not a
 * credential dump. The mapped pool key lives in a wrangler secret and is never
 * returned by any route.
 */

import { EDGE_CONFIG } from '../edge.gen.js';

const TOKEN_PREFIX = EDGE_CONFIG.tokenPrefix;
const TOKEN_BYTES = 32;

const B64URL = /^[A-Za-z0-9_-]+$/u;

export function mintToken(randomBytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))) {
  if (randomBytes.length !== TOKEN_BYTES) {
    throw new Error(`[pool-edge] token entropy must be ${TOKEN_BYTES} bytes`);
  }
  return TOKEN_PREFIX + base64url(randomBytes);
}

export function looksLikeToken(value) {
  if (typeof value !== 'string' || !value.startsWith(TOKEN_PREFIX)) return false;
  const body = value.slice(TOKEN_PREFIX.length);
  return body.length >= 40 && body.length <= 64 && B64URL.test(body);
}

export async function tokenHash(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/**
 * Constant-time-ish string compare. Workers has no timingSafeEqual; comparing
 * hashes (not secrets) makes the exposure theoretical, but this costs nothing.
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Bearer or x-api-key, same as the upstream pool accepts. */
export function readToken(request) {
  const direct = request.headers.get('x-api-key');
  if (direct) return direct.trim();
  const auth = request.headers.get('authorization');
  if (typeof auth === 'string') {
    const match = auth.match(/^Bearer\s+(.+)$/iu);
    if (match) return match[1].trim();
  }
  return null;
}
