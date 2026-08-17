# Upstream pool-meter API — what this edge depends on

The edge is a front door for a **pool-meter** instance: a metering broker that
fronts one or more provider accounts, mints per-member keys, enforces
weighted-token quotas, and serves its own human pages (`/join`, `/status`,
`/docs`).

pool-meter is not yet a published OSS package. This document pins the exact
endpoints and response shapes the edge relies on, as observed against the
reference deployment (`pool.example.com`, the upstream behind `pool.eliza.army`,
2026-08-04). If your pool implements these shapes, the edge works in front of
it. Anything not listed here is not touched by the edge.

Every section is marked with how the edge uses it. Shapes were read from the
running service source (read-only); treat them as **[CURRENT API — may
drift]** until pool-meter ships a versioned contract.

## Inference legs (pool key substituted by the edge)

### `POST /v1/messages` [CURRENT API]
Anthropic Messages API shape, streamed or buffered. The edge:
- substitutes its pool key into `x-api-key`,
- forwards only `content-type`, `accept`, `anthropic-version`,
  `anthropic-beta`, `accept-encoding`,
- meters usage from the response body (`usage` in JSON, or `usage` /
  `message.usage` in SSE frames).

Expected error shape (edge mirrors it): 
```json
{ "type": "error", "error": { "type": "...", "message": "..." } }
```

### `POST /v1/messages/count_tokens` [CURRENT API]
Same auth handling, not metered.

### `GET /v1/models` [CURRENT API]
Model listing, not metered.

## Introspection

### `GET /meter/me` (served at the edge as `GET /me`) [CURRENT API]
Requires a valid pool key (`x-api-key`). Returns the key's own usage report.
Observed top-level shape (abridged; fields the edge or its operators rely on):

```json
{
  "label": "<key label>",
  "tier": "<tier or null>",
  "weights": { "input": 1.0, "output": 5.0, "cache_read": 0.1, "cache_creation": 1.25 },
  "quota": {
    "effectiveTokens": 100000000,
    "used": 12345,
    "remaining": 99987655,
    "usedPct": 0.01,
    "exhausted": false,
    "note": "quota is denominated in cost-weighted effective tokens, not raw tokens"
  },
  "budget": { "budgetUsd": null, "spentUsd": 0.0, "...": "..." },
  "byModel": [ { "model": "...", "effectiveTokens": 0, "...": "..." } ],
  "myEarnings": null,
  "byo": { "...": "..." },
  "traces": { "pooled": false, "byo": false, "note": "..." },
  "endpoint": { "self": "/meter/me", "...": "..." }
}
```

The edge does not parse this response; it pipes it through. Contributors use it
to verify their pool-side burn. The `weights` block is the source of truth the
edge's own `TOKEN_WEIGHTS` must match.

### `GET /meter/pricing` [CURRENT API]
The published pricing table (in-memory, cheap). The edge uses it ONLY as its
reachability probe: any status < 500 counts as "upstream alive". The body is
never read.

## Human pages (passed through verbatim, anonymously)

All of these are served by pool-meter itself and adopted by the edge rather
than re-implemented. No credential is attached in either direction; `?key=` is
stripped (the keyed `/status` view de-anonymizes seat labels and must not be
reachable through the edge).

- `GET /join` [CURRENT API] — invite-gated seat-donation page. Invite arrives
  as `?i=<invite>`; invites are minted pool-side (`/admin/invite`,
  operator-only, sealed at the edge).
- `POST /join/start`, `GET /join/events` (SSE), `POST /join/submit-code`,
  `POST /join/cancel`, `GET|POST /join/revoke` [CURRENT API] — the join flow.
  `/join/events` is a long-lived SSE mirror of a device-OAuth flow; the edge
  streams it unbuffered with a 10-minute budget.
- `GET /account`, `POST /account/session`, `POST /account/whoami`,
  `POST /account/logout` [CURRENT API] — pool session cookie surface;
  `/join/start` can require a verified session cookie, so donors must be able
  to mint/inspect/drop it through the edge. `/account/claim` (legacy) is
  deliberately NOT passed through.
- `GET /status`, `GET /status.json` [CURRENT API] — pool telemetry, human and
  machine. `?fresh=1` forces a refresh and is forwarded.
- `GET /docs` [CURRENT API] — the env contract page.

If your pool-meter does not serve the `/join` flow, the passthrough routes
simply 404 upstream and operator-minted grants (`scripts/grant-admin.mjs`)
become the only issuance path. The edge does not require the join flow.

## Sealed upstream surfaces (never reachable through the edge)

`/admin/*` (invite minting, key admin), `/ledger` + `/ledger.json` (earnings),
`/meter/*` named directly (stats, traces, ledger), `/byo/*` (bring-your-own
credentials). The edge maps `/me` onto `/meter/me` itself; a caller can never
name a `/meter` path.

## What the edge needs minted for it

One pool key, with:
- its own quota (this is the authoritative ceiling for the whole edge),
- traces disabled (`traces:false`) so contributor traffic is not
  trace-captured,
- no admin flag.

Set it as the `POOL_EDGE_KEY` wrangler secret. If the pool operator disables
that key pool-side, all edge inference stops within seconds regardless of any
Worker state: that is the deepest kill switch and it belongs to the pool.
