# army-pool-edge

A deployable **compute-pool edge** for operators with spare inference capacity
who want to contribute it to an [army](../army) instance's contributors, or to
any group of agent operators, without handing out a shared upstream key.

It is a Cloudflare Worker that sits in front of a **pool-meter** instance (the
metering/credential service, see `docs/POOL-API.md`) and gives you:

- **Surface reduction.** The pool origin also serves `/admin`, `/ledger`,
  `/meter/*` and `/byo`. A CNAME would publish all of it. The edge is a
  positive allowlist: only inference legs and the public human pages exist.
- **Fan-out control.** Every contributor gets an opaque `army_` token mapped to
  a pool key that never leaves the edge, revocable individually.
- **Edge quota.** A cheap early stop (weighted-token counter per grant) before
  upstream capacity is spent. The pool's own per-key quota stays the hard
  ceiling.
- **A kill switch** that pauses inference in seconds without touching DNS, the
  pool, or anyone's grant.

This is a sibling template to the army repo: same discipline. One config file,
a fail-closed validator, no reference-instance strings in template defaults
(contract-tested), secrets never in git.

## Relationship to an army instance

The army template's `compute` config block is a *documented offer*: a base URL
contributors point `ANTHROPIC_BASE_URL` at. This repo is what the operator of
that base URL runs. There is **zero code coupling** in either direction: an
army instance works with no pool, and this edge works with no army instance.

## Prerequisites

- A running **pool-meter** instance you control (or an operator who will mint
  you a key on theirs). The edge needs one dedicated pool key with its own
  quota and traces off.
- A Cloudflare account with the zone for your edge hostname.
- Node 20+ and `wrangler` (`npm install` pulls it).

## Setup

### 1. Configure

Edit `pool-edge.config.json`. Everything instance-specific lives here:

- `edgeName` — worker name, and the `service` value `/health` reports.
- `publicOrigin` — the https origin the edge serves (becomes the
  custom-domain route).
- `pool.baseUrl` — your pool-meter origin.
- `cors.allowedOrigins` — browser origins allowed to call the edge (your army
  instance site, if any).
- `tiers` — grant tiers: weighted-token budgets and optional model
  restrictions. `contributor` is mandatory (it's the unknown-tier fallback).
- `support.grantIncreaseNote` — your copy for the 429 grant-exhausted error.
- `passthroughAssets` — extra static upstream paths (a brand mark the pool's
  pages reference), GET-exact only, never under a sealed prefix.

The validator is fail-closed: unknown keys, malformed origins, attempts to
configure security behavior, and sealed-prefix assets are hard errors.

### 2. Render

```bash
npm install
node scripts/render.mjs
```

This renders `src/edge.gen.js` (the worker's identity module) and
`wrangler.toml` from your config. Both are committed; the test suite re-renders
and compares, so hand edits to generated files fail tests.

### 3. KV + secrets

```bash
wrangler kv namespace create POOL_EDGE
# paste the id into pool-edge.config.json -> kv.namespaceId, re-render, commit

wrangler secret put POOL_EDGE_KEY
# paste the dedicated pool key minted on your pool-meter instance.
# Mint it with its own quota and traces:false. It is the ONLY secret,
# it lives in Cloudflare, and it must never appear in this repo.
```

**Secrets are never config.** `pool-edge.config.json` is committed; the
validator rejects any key that smells like a credential, and the render test
asserts `POOL_EDGE_KEY` is documented but never assigned in `wrangler.toml`.

### 4. Test + deploy

```bash
npm test          # 96 tests, no Cloudflare access needed
npm run deploy    # wrangler deploy
```

DNS: use the Worker **custom domain** binding (rendered into `wrangler.toml`),
not a CNAME to the pool origin. A CNAME would publish the pool's whole admin
surface on your hostname.

## Operating

### Issuing contributor tokens

Two paths:

1. **Invite links (recommended if your pool-meter runs the `/join` flow):**
   send `https://<your-edge>/join?i=<invite>`. Invites are minted on the pool
   host (operator-only, never reachable through this edge). The contributor
   links a seat and the pool mints them a key directly.
2. **Operator-minted edge grants:**
   ```bash
   node scripts/grant-admin.mjs mint <githubId> <login> [tier]
   ```
   Prints the `army_` token once (it is never stored; KV holds only its
   SHA-256). Also: `list`, `show`, `promote`, `revoke`, `topup`. This is a
   local CLI over `wrangler kv` on purpose. There is no HTTP admin route.

### What a contributor does

Point an Anthropic-compatible client at the edge:

```bash
export ANTHROPIC_BASE_URL=https://<your-edge>
export ANTHROPIC_API_KEY=army_...   # their token
```

Then verify:

- `GET /me` — their own pool-side usage report, pool key substituted at the
  edge. This is pool-meter's `/meter/me` (see `docs/POOL-API.md` for the
  response shape). The command:
  ```bash
  curl -s -H "x-api-key: army_..." https://<your-edge>/me
  ```
- `GET /keys/status` — their edge-local grant: tier, weighted tokens used and
  remaining, request count. Edge state, no upstream call.

### Quota and tier expectations

- Usage is counted in **weighted tokens**: input ×1.0, output ×5.0, cache read
  ×0.1, cache creation ×1.25. These weights are NOT configurable: they must
  match pool-meter's accounting exactly or the two counters would disagree.
- The edge counter is an early stop; the pool-side per-key quota is the
  authoritative ceiling. A KV race can undercount briefly; the pool backstops
  it.
- Exhausted grants get a 429 with `x-army-grant-remaining: 0` and your
  configured `grantIncreaseNote`. Promotion between tiers is an operator
  decision (`grant-admin.mjs promote`), never self-serve.

### Kill switch

Set `KILL_SWITCH = "on"` in `wrangler.toml` and redeploy, or
`wrangler secret put KILL_SWITCH`. All inference stops in seconds; grants, DNS,
and the pool are untouched. `/join`, `/status` and `/docs` deliberately keep
serving: a paused endpoint whose status page also goes dark is
indistinguishable from an outage.

Deeper escalation: `grant-admin.mjs revoke` for one contributor, or disable the
edge's key pool-side (effective within seconds, survives any Worker bug).

### Monitoring

`GET /health` is edge-local JSON:

```json
{ "ok": true, "service": "<edgeName>", "upstreamOk": true,
  "issuance": "invite", "killSwitch": "off", "timestamp": "..." }
```

`ok` is THIS worker's liveness; path health is `upstreamOk`, probed against
pool-meter's `/meter/pricing` (cached 30s, single-flight, costs zero model
tokens). No secret and no upstream hostname can reach `/health` by
construction.

## Security invariants (non-configurable, contract-tested)

1. `/admin`, `/ledger`, `/meter`, `/byo` are sealed with an opaque 404, as
   exact path, prefix, AND extension twin (`/ledger.json`).
2. Passthrough routes are method-exact and path-exact. Never a prefix rule.
3. No credential crosses a passthrough in either direction; `?key=` is
   stripped.
4. The pool key is substituted only on inference legs and never logged,
   rendered, or returned.
5. KV stores token hashes, never tokens.
6. A missing pool-key binding fails closed (500), never anonymous
   passthrough.
7. Token weights match pool-meter exactly.

The forbidden-strings test additionally guarantees no reference-instance
identity (branding, hostnames, account ids) ships in template defaults.

## Note for whoever edits the passthrough table next

`PASSTHROUGH` in `src/lib/policy.js` is method-exact and path-exact on
purpose. Do not turn it into a prefix rule: a `/join*` prefix would silently
adopt whatever the upstream adds under that prefix, unreviewed. Add the exact
route.
