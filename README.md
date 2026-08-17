# pool

Metering, quota, reputation and routing edge for the Eliza account pool.

A subscription-seat pool turns donated provider subscriptions (Claude Max,
ChatGPT) into a shared, metered, quota-governed inference endpoint. This
monorepo contains the four services that make that work, from the public edge
down to the provider socket:

```
client (Claude Code / SDK / OpenAI-compat)
  │  https://pool.example.com
  ▼
┌───────────────────────────────────────────────┐
│ packages/pool-edge          cloudflare worker │  grants · issuance · tiers ·
│ (optional remote edge for federated armies)   │  policy · passthrough
└───────────────────────────────────────────────┘
  │
  ▼
cloudflare ──► nginx (pool-proxy)               :80/:8080
  │
  ▼
┌───────────────────────────────────────────────┐
│ packages/pool-meter         127.0.0.1:18811   │  auth · quota · metering ·
│                                               │  reputation · ledger · /join
└───────────────────────────────────────────────┘
  │                          ┌──────────────────────────────────────────┐
  ├── anthropic traffic ───► │ packages/broker-proxy  127.0.0.1:18807   │
  │                          │ seat leasing · header shaping · retries  │
  │                          └──────────────────────────────────────────┘
  │                                        │
  └── openai traffic ─────►  ┌──────────────────────────────────────────┐
                             │ packages/codex-proxy                     │
                             │ OpenAI-compat lease proxy                │
                             └──────────────────────────────────────────┘
                                           │
                                           ▼
                             account broker            127.0.0.1:7803
                             (seat health, OAuth enrollment, leases)
                                           │
                                           ▼
                                     provider APIs
```

## Packages

| package | what it does |
|---|---|
| [`packages/pool-meter`](packages/pool-meter) | The metering core. Authenticates pool keys, meters every request to cache-token granularity, enforces cost-weighted quotas in effective tokens AND dollars, attributes consumption to the donated seat that served it, runs the invite/join flow, and publishes an anonymized public ledger and status page. Node stdlib only, zero dependencies. |
| [`packages/broker-proxy`](packages/broker-proxy) | The seat-side Anthropic proxy. Integrates with the account broker's lease API, shapes requests to look like first-party client traffic (header injection, tool-name conventions, system-prompt relocation), handles quota sweeps, rate-limit cooldowns and seat re-admission. |
| [`packages/pool-edge`](packages/pool-edge) | A deployable Cloudflare Worker template for federated "army" edges: token issuance, contribution tiers, policy enforcement, and metered passthrough to an upstream pool-meter. Ships with a forbidden-strings test that keeps reference-instance identity out of the template. |
| [`packages/codex-proxy`](packages/codex-proxy) | OpenAI-compatible lease proxy for pooled ChatGPT-subscription traffic (`/openai/v1/*`). |

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), how the four pieces fit together
- [`docs/DECISIONS.md`](docs/DECISIONS.md), source-selection and scrub decisions for this consolidation

## Configuration

No secrets live in this repository, ever. All hostnames in this tree
(`pool.example.com` etc.) are placeholders; every deployment supplies its own
public origin, secrets directory and credentials via environment variables or
runtime config files kept outside the tree. See each package's README and
`packages/pool-meter/src/lib/config.js` for the environment contract.

## License

MIT
