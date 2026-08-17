# pool-meter

Metering, quota and reputation edge for the Eliza account pool.

`pool-meter` sits between the public internet and the account-pool proxy. It
authenticates pool keys, meters every request down to cache-token granularity,
enforces cost-weighted quotas, attributes consumption back to the donated seat
that served it, and publishes an anonymized reliability record.

```
client
  │  https://pool.example.com
  ▼
cloudflare ──► nginx (pool-proxy)          :80/:8080
  │              proxy_pass
  ▼
pool-meter                                 127.0.0.1:18811   ← this repo
  │  auth · quota · metering · /status · /join · /meter/*
  ▼
account-pool proxy                         127.0.0.1:18807   ← DO NOT TOUCH
  │
  ▼
Anthropic
                                           127.0.0.1:7803    ← broker, READ ONLY
                                           (account health, OAuth enrollment)
```

Zero runtime dependencies: Node stdlib only, including the QR encoder.

---

## Operational rules

Two services are **denylisted**. This repo reads from them and never writes,
restarts or reconfigures them:

| Port  | Service            | Allowed interaction              |
|-------|--------------------|----------------------------------|
| 7803  | account broker     | `GET /api/accounts` (read only)   |
| 18807 | account-pool proxy | proxy target + `GET /health` probe |
| 18811 | pool-meter         | **restart allowed** (this service) |

**No secrets in this repository, ever.** Every credential resolves at runtime
from the environment or from `/opt/pool/secrets/`, via
`src/lib/config.js`. See [Configuration](#configuration).

---

## Metering model

### Cost-weighted effective tokens

Raw token counts are a bad quota unit: a cache-heavy Claude Code session reads
millions of cached tokens that cost almost nothing. Quota is therefore
denominated in **effective tokens**, normalized to input cost = 1.0 using
Anthropic's own pricing ratios:

| Component        | Weight |
|------------------|--------|
| input            | 1.0    |
| output           | 5.0    |
| cache read       | 0.1    |
| cache creation   | 1.25   |

Raw counters are always stored unweighted and are always reported alongside the
weighted number, so weights can be retuned without rewriting history.

### Dual-unit accounting: tokens AND dollars

Every aggregate in the system reports **both** raw tokens by class and **USD at
Anthropic API list pricing** — what this traffic would have cost on metered API
billing. `src/lib/pricing.js` holds the rate table.

Dollars exist because the weight vector above cannot express cross-model price
differences: a Fable 5 input token costs 5x an Opus 5 input token and 10x a
discounted Sonnet 5 one, but all three weigh `1.0`. Effective tokens remain the
quota unit (unchanged, backwards compatible); dollars are the honest
cross-model comparison and the unit for the optional budget cap.

Rules the implementation follows:

- **Priced once, at ingest.** Each request is costed against the rate card in
  force at *that request's* timestamp, then the same figure is folded into every
  aggregate it touches. Historical cost does not move when prices change.
- **Effective-dated rates.** Sonnet 5's introductory $2/$10 pricing runs through
  2026-08-31; requests on or after 2026-09-01 automatically cost at $3/$15.
- **Cache writes** are priced at the 5-minute rate (1.25x input) unless the API
  reports an explicit 1h breakdown, since `cache_creation_input_tokens` does not
  say which TTL was used.
- **Unknown models are never silently costed at zero.** An unrecognized id
  resolves to its family's flagship card and is flagged `exact: false`; a
  totally unresolvable id is reported under `unpriced` with its token count.
- **Not modelled** (would require data the proxy cannot observe): batch API 50%
  discount, fast-mode premium, data-residency 1.1x. All three would only push
  cost up, so reported spend is a floor, never an overstatement.

The table is verified against Anthropic's published pricing page and carries a
`lastVerified` date surfaced through `/meter/pricing`, `/meter/stats`,
`/meter/me` and `/status.json`, so a stale table is visible rather than quietly
wrong. Re-verify whenever a model ships or an introductory window lapses.

### Logs are the source of truth

`~/.moltbot/logs/pool-meter/usage-YYYY-MM-DD.jsonl` holds one record per
request. All aggregates are a derived index, rebuilt from those logs at every
boot — a restart cannot lose history, and a corrupt aggregate file self-heals on
the next start.

One wrinkle handled explicitly: log files can be pruned or lost. A pure rebuild
would then hand users free quota back. At boot the rebuild is diffed against the
legacy `totals.json` and any shortfall is carried forward as an auditable
`baseline`, surfaced as `baselineCarried` in the API.

### Per-donor-account attribution

The upstream proxy relays Anthropic's `anthropic-organization-id` response
header, and every broker account has a distinct `organizationId`. That gives
**real** per-seat attribution, not an estimate: each metered response maps to
exactly one donated seat.

Records written before v2 carry no org header and are reported honestly under
`unattributed` rather than being guessed at or spread proportionally.

Account identities are never public. Seats appear as stable one-way hashes
(`acct-` + first 6 hex of sha256), so a donor can find their own row without
anyone learning which email or account id it is.

### Pool vs outside-pool usage per seat

`src/lib/poolshare.js`. For a donated seat, how much of the owner's consumed
capacity went through the pool, versus them using their own subscription
directly?

Two measurements, in incompatible units:

| | what it measures | precision |
|---|---|---|
| Anthropic weekly pct (via broker) | the owner's **total** burn, pool and outside | **integer only** — 1pp is the smallest observable step |
| Pool-served tokens (via org-id) | exactly what the pool consumed | exact |

A point estimate needs a tokens-per-percentage-point factor. Measured against
live data, that factor is **not derivable yet**: 1pp equals 2,000,000 tokens
while pool traffic on the only attributed seat is ~2.9k effective tokens,
roughly **840x below the resolution of the instrument**. A calibration window
requires pool traffic to visibly move the meter while nothing else touches the
seat, and that has never happened.

So, per the honest-gap rule, this ships:

1. **The raw ingredients.** Per-seat weekly-pct timeline with pool-served
   tokens overlaid, plus a sparkline on the public pane. This is exactly the
   dataset a real calibration needs.
2. **Live calibration detection**, not a stub. It looks for meter steps that
   pool traffic alone explains (>=80% coverage using the declared factor as the
   yardstick). A 50% threshold was tried and rejected: a half-third-party window
   passed it and then reported the seat as pool-only. Today it finds nothing
   and says so; it begins publishing a measured factor with no code change as
   volume grows.
3. **A rigorous upper bound**, which *is* derivable. `CAPACITY_TOKEN_VALUE` is
   documented as deliberately conservative, so the true tokens-per-point is
   larger. Dividing by a factor that is too small **overstates** the pool's
   percentage points, which makes the result a genuine ceiling: pool share is
   *at most* this, so outside use is *at least* the remainder.

Every figure carries `bound` (`upper` or `point`), `confidence`,
`calibrationWindows` and a plain-English `reason`. A seat whose meter has not
moved reports `null` and renders as "no signal yet" — never 100%, which would
paint a full pool bar on a seat nobody has used.

---

## Reputation and the ratio economy

Three independently measured inputs, deliberately not fused until the last step:

1. **Meter uptime** — process uptime, restart count, and an active
   `GET /health` probe of upstream every 30s, persisted across restarts.
2. **Seeding uptime** — per donated seat, the fraction of 60s broker polls that
   saw it present and not credential-failed. A rate-limited seat is *still
   seeding* (drained but present); a revoked or errored one is not.
3. **Ratio** — contributed capacity value ÷ effective tokens consumed.

```
score = 100 × seedingUptime × (0.35 + 0.65 × ratioStanding) × (0.4 + 0.6 × tenure)
```

`ratioStanding` saturates at 1.0 (being 10× net-positive is not ten times better
than being comfortably net-positive) and `tenure` ramps across the 7-day minimum
seeding period. Members with fewer than 20 seeding samples are reported as
`provisional` with **no score**, rather than a flattering default. Members with
no donated seat are `consumer` — a legitimate state for the invited tier, scored
by quota rather than ratio.

Every input is returned next to the score. No black-box number.

---

## Endpoints

### Public

| Endpoint       | Description |
|----------------|-------------|
| `GET /status`      | Public dashboard: $ served at API pricing, capacity + sparkline, inline-SVG model mix donut, anonymized seat reliability cards with the pool-vs-outside split. No third-party assets; mobile-first at 390px |
| `GET /status.json` | Anonymized status + `reliability` block (uptime, per-seat seeding, per-seat `usageSplit`) + top-level `usageSplit` summary + `meter` block with pool-wide today/all-time tokens and USD, and a label-free per-model cost table |
| `GET /join`        | Invite-gated seat donation flow |
| `GET /ledger`      | Anonymized contribution ledger |

### Authenticated (any valid key)

| Endpoint | Description |
|----------|-------------|
| `GET /meter/me?days=N` | **Self-serve.** That key's own usage only: per-model breakdown, cache tokens, weighted quota, remaining, N-day series, `costUsd` on every counter and a `budget` block. Scoped to the caller's label with no parameter that can widen it. |
| `GET /meter/pricing`   | The full rate table with `lastVerified` and source. Public list pricing, not a secret. |

```bash
curl -H "x-api-key: $KEY" https://pool.example.com/meter/me | jq '.quota, .budget'
curl -H "x-api-key: $KEY" https://pool.example.com/meter/pricing | jq .lastVerified
```

Both gates are readable while capped: `/meter/me` and `/meter/pricing` resolve
**before** the quota and budget gates, so a throttled key can always find out
why it was throttled.

### Optional per-key dollar budget

A key may carry an optional `budgetUsd` in `pool-keys.json`:

```json
{ "key": "sk-pool-...", "label": "someone", "quota": 50000000, "budgetUsd": 25.00 }
```

It is enforced **only when present and positive**. Keys without it behave
exactly as before and gate on the effective-token quota alone — no existing key
changed behavior when this shipped. Over budget returns `429` with a
rate-limit-shaped error naming the amounts, mirroring the quota gate. Admin keys
are exempt from both gates.

### Admin key only

| Endpoint | Description |
|----------|-------------|
| `GET /meter/stats?days=N` | v2: every user, per-user-per-model, pool-wide model table, donor attribution, uptime, rebuild provenance. `?identify=1` deanonymizes seats. Retains v1 fields under `legacy`. |
| `GET /meter/reputation`   | Per-member ratio, seeding uptime, tenure and score. `?identify=1` for real labels. |
| `POST /admin/invite`      | Mint an invite |
| `GET /admin/invites`      | List invites |
| `POST /admin/invite/revoke` | Revoke an invite |
| `POST /admin/sync-quotas` | Recompute donor quotas from live contribution |

Non-admin keys receive `401` on every admin route, including `/admin/*`, rather
than falling through to the proxy.

---

## Configuration

`src/lib/config.js` resolves in this order: **environment variable → secrets
JSON → safe non-secret default**. A missing credential degrades the dependent
feature and warns once; it never falls back to a hardcoded token.

Runtime config lives at `/opt/pool/secrets/pool-meter.config.json`
(mode `600`, outside this repo):

```json
{
  "brokerToken": "<broker api token>",
  "brokerHost": "127.0.0.1",
  "brokerPort": 7803,
  "upstreamHost": "127.0.0.1",
  "upstreamPort": 18807,
  "listenHost": "127.0.0.1",
  "listenPort": 18811,
  "defaultQuota": 13371337,
  "publicBaseUrl": "https://pool.example.com"
}
```

| Env var | Overrides |
|---------|-----------|
| `POOL_METER_PORT` | listen port (use a scratch port for staging) |
| `POOL_METER_BROKER_TOKEN` | broker API token |
| `POOL_METER_BROKER_INTERNAL_SECRET_FILE` | live lease overlay secret path |
| `POOL_METER_KEYS_FILE` | pool keys path |
| `POOL_METER_LOG_DIR` | usage log directory |
| `POOL_METER_CONFIG` | config file path |

Other out-of-tree state: `pool-keys.json`, `pool-invites.json`,
`pool-join.secret`, `eliza-account-pool-broker.secret`.

---

## Layout

```
src/
  pool-meter.js        entrypoint: proxy, auth, quota, routing
  lib/
    config.js          credential + deployment resolution (no secrets in tree)
    pricing.js         Anthropic list-price rate cards, effective-dated, USD math
    metrics.js         per-user × per-model × per-seat aggregates, weights + USD
    reputation.js      uptime probes, seeding uptime, ratio scoring
    join.js            invite tokens, tiers, key minting, earned quota
    join-page.js       /join and /ledger UI
    broker.js          read-only broker client
    store.js           lockfile + fsync + atomic-rename JSON store
    utilization.js     honest pool utilization math
    qr.js              dependency-free QR encoder
    poolshare.js       pool vs outside-pool capacity split (bounded estimate)
  public/              static assets, /docs markdown
deploy/
  pool-meter.service   systemd unit
  nginx-pool-proxy.conf
scripts/deploy.sh      rsync deploy, backup, health gate, auto-rollback
test/regression.sh     full regression pack
test/poolshare-unit.js pool-vs-outside estimator unit suite
```

---

## Deploy

The repo is the source of truth for code; `scripts/deploy.sh` rsyncs `src/` to
`/opt/pool/services/pool-meter` and restarts only `pool-meter.service`.
rsync is used rather than a symlinked checkout because the runtime directory also
holds historical `.bak-*` files referenced by the existing unit and nginx alias.

```bash
./scripts/deploy.sh --dry-run   # preview
./scripts/deploy.sh             # syntax check → backup → sync → restart → health gate
```

The script aborts before touching the live copy if any file fails `node --check`,
and rolls back automatically if `/status.json` is not 200 afterwards.

Rollback snapshots the **entire live code set** to `.rollback-<stamp>/`, not just
the entrypoint. Restoring `pool-meter.js` alone would leave an old entrypoint
beside new `lib/` modules, which is a worse state than the failed deploy; the
restore uses `--delete` so modules added by a bad deploy are removed too. The
five most recent snapshots are kept.

Staging without touching the live listener:

```bash
POOL_METER_PORT=18899 node src/pool-meter.js
```

## Test

```bash
POOL_ADMIN_KEY=... POOL_USER_KEY=... ./test/regression.sh          # against live 18811
POOL_ADMIN_KEY=... POOL_USER_KEY=... ./test/regression.sh 18899    # against staging
```

Covers: public streaming + non-streaming, `/status`, `/status.json`, admin gate
(401 without admin), bad-key 401, quota gate, chunked-request framing, v2
endpoint shape, and privacy invariants (no UUIDs, emails or keys in public JSON).

---

## Known gaps

- **Pre-v2 records are unattributed.** ~1000 historical requests predate org-header
  capture. They are reported as `unattributed` rather than back-filled by guess.
- **Weekly percent is not tokens.** Broker capacity percentages are Anthropic's
  opaque metric and are not linear in tokens, so contributed capacity and consumed
  tokens are reported separately and only combined through the explicit, documented
  `CAPACITY_TOKEN_VALUE` conversion.
- **Seeding uptime starts at v2 deploy.** Seats have no history before the poller
  existed, so all seats begin `provisional`.
- **No seat is calibrated for the pool-vs-outside split yet**, so every share is
  published as an upper bound rather than a point estimate. This resolves itself
  once a seat's pool traffic moves Anthropic's whole-percent weekly meter; the
  detection code is already live. `usageSplit.calibratedSeats` is the canary.
- **Window-scoped token totals are day-granular.** `metrics.servedSince()` sums
  whole days from the per-day index, so the day containing a weekly reset is
  counted in full. That can only over-attribute to the current window, which
  keeps the derived pool share an upper bound rather than an understatement.
- **Attribution depends on an upstream header.** If the pool proxy stops relaying
  `anthropic-organization-id`, attribution silently degrades to `unattributed`.
  The `attribution.accountsKnown` field in `/meter/stats` is the canary.
