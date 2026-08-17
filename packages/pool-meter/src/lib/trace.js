'use strict';
// trace.js — per-request trace collection & storage for pool.example.com.
//
// WHAT WE STORE (per request): request messages, response text (reassembled
// from SSE when streaming), model, tokens, ttfb + total latency, label,
// provider, byo-vs-pooled, status. This is the raw material for a future
// PII-stripped dataset (offered to AI labs under a privacy policy). This module
// only STORES; it publishes/sells nothing.
//
// PII POSTURE v1: capture RAW, redact ON EXPORT. Trace files are 0600. A
// separate offline script (scripts/redact-traces.js) strips emails, phones,
// api keys/bearer tokens, ssh keys, and seed-phrase-looking strings before any
// dataset leaves the box. We do NOT claim PII-stripped-at-capture.
//
// CONSENT: capture is gated by a per-request `traces` flag decided by the
// caller (pooled default true, BYO default false until opt-in). This module
// never captures a request whose flag is false.
//
// STORAGE: append-only JSONL under tracesDir/, one file per day
// (trace-YYYY-MM-DD.jsonl). At the first write of a new day the previous day's
// file is gzipped (.jsonl.gz) off the hot path. A total-bytes cap (~20G)
// evicts the OLDEST files first with a loud log line so a runaway capture can
// never fill the disk.
//
// Streaming latency is sacred: we tee the SSE bytes (never buffer-then-forward)
// and reassemble the text lazily from the copy, so trace capture adds no
// perceptible latency to the stream.
//
// Node stdlib only.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DEFAULT_CAP_BYTES = 20 * 1024 * 1024 * 1024; // 20 GiB
const MAX_TEXT_CHARS = 200 * 1024;                 // per field cap (req/resp text)

class TraceStore {
  constructor({ dir, capBytes = DEFAULT_CAP_BYTES, enabled = true }) {
    this.dir = dir;
    this.capBytes = capBytes;
    this.enabled = enabled;
    this.currentDay = null;
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (e) { console.error('trace: mkdir failed:', e.message); }
  }

  _dayFile(day) { return path.join(this.dir, `trace-${day}.jsonl`); }

  // Rotate: on a new UTC day, gzip yesterday's plaintext file (if any) so only
  // the live day stays uncompressed. Idempotent and cheap (runs once per day).
  _rotateIfNeeded(day) {
    if (this.currentDay === day) return;
    const prev = this.currentDay;
    this.currentDay = day;
    if (!prev) return;
    const plain = this._dayFile(prev);
    const gz = plain + '.gz';
    fs.access(plain, fs.constants.F_OK, (err) => {
      if (err) return; // nothing to rotate
      const inp = fs.createReadStream(plain);
      const out = fs.createWriteStream(gz, { mode: 0o600 });
      inp.pipe(zlib.createGzip()).pipe(out).on('finish', () => {
        fs.unlink(plain, () => {});
        console.log(`trace: rotated ${path.basename(plain)} -> ${path.basename(gz)}`);
        this._enforceCap();
      }).on('error', (e) => console.error('trace: rotate gzip error:', e.message));
    });
  }

  // Enforce the total-bytes cap by evicting the OLDEST trace files first.
  // Runs after a rotation (bounded frequency). Loud log line on eviction.
  _enforceCap() {
    fs.readdir(this.dir, (err, names) => {
      if (err) return;
      const files = names
        .filter((n) => /^trace-\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(n))
        .map((n) => {
          try { const st = fs.statSync(path.join(this.dir, n)); return { n, size: st.size, m: st.mtimeMs }; }
          catch (_) { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => a.m - b.m); // oldest first
      let total = files.reduce((s, f) => s + f.size, 0);
      let i = 0;
      while (total > this.capBytes && i < files.length - 1) { // never evict the live file (last)
        const f = files[i++];
        try {
          fs.unlinkSync(path.join(this.dir, f.n));
          total -= f.size;
          console.error(`trace: CAP EXCEEDED (${this.capBytes} bytes) — evicted oldest ${f.n} (${f.size} bytes), total now ${total}`);
        } catch (e) { console.error('trace: evict failed:', e.message); break; }
      }
    });
  }

  _clip(s) {
    if (s == null) return null;
    s = typeof s === 'string' ? s : JSON.stringify(s);
    return s.length > MAX_TEXT_CHARS ? s.slice(0, MAX_TEXT_CHARS) + `…[clipped ${s.length - MAX_TEXT_CHARS}]` : s;
  }

  // Append one trace record. `rec` fields:
  //   ts, label, provider, byo(bool), model, stream(bool), status,
  //   ttfb_ms, latency_ms, usage{...}, request(messages/body), response(text)
  // Returns fast; the actual write is async and never throws into the caller.
  capture(rec) {
    if (!this.enabled) return;
    try {
      const day = new Date().toISOString().slice(0, 10);
      this._rotateIfNeeded(day);
      const line = {
        ts: rec.ts || new Date().toISOString(),
        label: rec.label || null,
        provider: rec.provider || 'anthropic',
        byo: !!rec.byo,
        model: rec.model || null,
        stream: !!rec.stream,
        status: rec.status != null ? rec.status : null,
        ttfb_ms: rec.ttfb_ms != null ? rec.ttfb_ms : null,
        latency_ms: rec.latency_ms != null ? rec.latency_ms : null,
        usage: rec.usage || null,
        request: this._clip(rec.request),
        response: this._clip(rec.response),
      };
      fs.appendFile(this._dayFile(day), JSON.stringify(line) + '\n', { mode: 0o600 }, (e) => {
        if (e) console.error('trace: append error:', e.message);
      });
    } catch (e) {
      console.error('trace: capture error (non-fatal):', e.message);
    }
  }

  // Admin stats: file counts, total bytes, oldest/newest.
  stats() {
    let files = [];
    try {
      files = fs.readdirSync(this.dir)
        .filter((n) => /^trace-\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(n))
        .map((n) => { const st = fs.statSync(path.join(this.dir, n)); return { name: n, bytes: st.size, mtime: st.mtimeMs }; })
        .sort((a, b) => a.mtime - b.mtime);
    } catch (_) {}
    const bytes = files.reduce((s, f) => s + f.bytes, 0);
    return {
      dir: this.dir,
      enabled: this.enabled,
      capBytes: this.capBytes,
      fileCount: files.length,
      totalBytes: bytes,
      capUsedPct: this.capBytes ? Math.round((bytes / this.capBytes) * 1000) / 10 : null,
      oldest: files[0] ? { name: files[0].name, at: new Date(files[0].mtime).toISOString() } : null,
      newest: files.length ? { name: files[files.length - 1].name, at: new Date(files[files.length - 1].mtime).toISOString() } : null,
      note: 'PII posture v1: stored RAW (0600), redact-on-export via scripts/redact-traces.js. NOT stripped at capture.',
    };
  }
}

// Reassemble assistant text from an Anthropic Messages SSE stream copy. Cheap:
// concatenates content_block_delta text_delta chunks. Bounded by MAX_TEXT_CHARS
// at write time. Never throws (metering/streaming must not break).
function makeSseTextCollector() {
  let buf = '';
  let text = '';
  let done = false;
  return {
    feed(chunk) {
      if (done) return;
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let obj; try { obj = JSON.parse(payload); } catch (_) { continue; }
        try {
          // Anthropic Messages API
          if (obj.type === 'content_block_delta' && obj.delta) {
            if (obj.delta.type === 'text_delta' && obj.delta.text) text += obj.delta.text;
          }
          // OpenAI Responses API
          else if (obj.type === 'response.output_text.delta' && obj.delta) text += obj.delta;
        } catch (_) {}
        if (text.length > MAX_TEXT_CHARS + 1024) done = true; // stop early, write path clips
      }
      if (buf.length > (1 << 20)) buf = buf.slice(-65536);
    },
    text() { return text; },
  };
}

module.exports = { TraceStore, makeSseTextCollector, MAX_TEXT_CHARS };
