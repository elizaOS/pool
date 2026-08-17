# Architecture

How a request flows through the pool, and which package owns each hop.

## The one-line version

Donated provider subscription seats sit behind an **account broker** (not in
this repo) that tracks seat health and issues short-lived leases. Everything in
this repo is the machinery that lets many pool members share those seats
safely: metering, quotas, reputation, and provider-facing request shaping.

## Request path (Anthropic traffic)

```
client ──► [pool-edge (optional CF worker)] ──► cloudflare ──► nginx ──► pool-meter ──► broker-proxy ──► provider
```

1. **client** points `ANTHROPIC_BASE_URL` at the pool origin and authenticates
   with an `x-api-key` pool key.
2. **pool-edge** (`packages/pool-edge`, optional) is a Cloudflare Worker for
   federated deployments: it issues its own member tokens, enforces
   contribution tiers and model policy, then forwards to the upstream pool with
   the pool key it holds. A standalone army can run one of these in front of
   someone else's pool-meter.
3. **nginx** terminates TLS and proxies to the local meter
   (`packages/pool-meter/deploy/nginx-pool-proxy.conf`).
4. **pool-meter** (`packages/pool-meter`, :18811) authenticates the pool key,
   checks quota (cost-weighted effective tokens + optional USD budget), streams
   the request through, meters usage from response/SSE frames to cache-token
   granularity, writes the ledger, and updates member reputation and seat
   attribution.
5. **broker-proxy** (`packages/broker-proxy`, :18807) leases a healthy donated
   seat from the account broker (:7803), rewrites the request so it presents as
   first-party client traffic (OAuth header injection, tool-name conventions,
   system-prompt shaping below the cache boundary), sends it to the provider,
   and reports the outcome back to the broker (quota sweeps, bounded rate-limit
   cooldowns, seat re-admission).

## Request path (OpenAI-compat traffic)

```
client ──► ... ──► pool-meter (/openai/v1/*) ──► codex-proxy ──► provider
```

**codex-proxy** (`packages/codex-proxy`) is the OpenAI-side twin of
broker-proxy: it leases pooled ChatGPT-subscription seats and speaks the
Responses API upstream.

## Trust boundaries

- **Pool keys** (member credentials) exist only at pool-meter and edge layers.
  They never reach the provider.
- **Seat OAuth credentials** exist only at broker-proxy / codex-proxy and the
  broker. They never reach members.
- **pool-edge passthrough** never carries the pool key, so a federated edge can
  never mint free inference (enforced by test).
- The account broker (:7803) is read-only from pool-meter's perspective: it
  reads seat health for the status page and never writes.

## Ports (local service mesh)

| port | service |
|---|---|
| 18811 | pool-meter (this repo) |
| 18807 | broker-proxy (this repo) |
| 18801 | broker-proxy alt/dev instance |
| 7803 | account broker (third-party, read-only) |

## Data & privacy model

- Metering records: label, model, token counts by class, latency, status.
- The public ledger and status page are anonymized (no member labels), enforced
  by regression tests.
- Traces, when enabled, pass through credential/PII redaction
  (`pool-meter/scripts/redact-traces.js`) before any retention.
- No usage data, traces, logs or credentials are committed to this repo.
