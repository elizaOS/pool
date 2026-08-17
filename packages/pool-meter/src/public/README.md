# pool.example.com

anthropic-compatible API endpoint backed by a pooled claude subscription.
you need a key from shadow. usage is metered per key.

## claude code

```bash
export ANTHROPIC_BASE_URL="https://pool.example.com"
export ANTHROPIC_AUTH_TOKEN="<your-key>"
claude
```

add both exports to your `~/.bashrc` / `~/.zshrc` to make it permanent.
if you already have `ANTHROPIC_API_KEY` set, `unset ANTHROPIC_API_KEY` first so it doesn't win.

## opencode / other anthropic-compatible tools

point the anthropic provider at:

- base url: `https://pool.example.com`
- api key: `<your-key>` (sent as `x-api-key` or `Authorization: Bearer`, both work)

## raw API / SDKs

```bash
curl -s https://pool.example.com/v1/messages \
  -H "x-api-key: <your-key>" \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-fable-5","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'
```

python: `anthropic.Anthropic(base_url="https://pool.example.com", api_key="<your-key>")`
typescript: `new Anthropic({ baseURL: "https://pool.example.com", apiKey: "<your-key>" })`
streaming (SSE) fully supported.

## models

subscription-tier claude models. `claude-fable-5` is the primary alias; claude code defaults also work.

## public status

- human view: [`/status`](https://pool.example.com/status)
- machine-readable view: [`/status.json`](https://pool.example.com/status.json)

No key is required. The status view is anonymized and shows:

- pool capacity left, observed burn rate, projected depletion, and next weekly refill
- per-account `account-1..N` state, session and weekly use, reset clocks, burn forecast, and model buckets when the broker provides them
- aggregate public-edge requests and input/output tokens for today and all time
- broker reachability, snapshot age, and meter uptime

`/status.json` has top-level `updatedAt`, `usageRefreshedAt`, `pool`, `fable`, `allModels`, `urgency`, `perAccount`, `meter`, and `health` fields. Unknown clocks and forecasts are `null`; the HTML says `estimating...` rather than inventing a rate. It never includes account identifiers, emails, priorities, leases, consumer names, or API keys.

## bring your own token (BYO)

don't want to burn pooled quota? register your OWN provider token and the pool just proxies + meters it (against a separate `byo` bucket, never against pooled quota).

```bash
# register (anthropic | openai | openrouter)
curl -s https://pool.example.com/byo/credentials \
  -H "x-api-key: <your-pool-key>" -H "content-type: application/json" \
  -d '{"provider":"anthropic","token":"sk-ant-..."}'

# list what you've registered (masked, never echoes the token)
curl -s https://pool.example.com/byo/credentials -H "x-api-key: <your-pool-key>"

# remove
curl -s https://pool.example.com/byo/credentials/remove \
  -H "x-api-key: <your-pool-key>" -H "content-type: application/json" \
  -d '{"provider":"anthropic"}'
```

once registered, just call the matching leg with your pool key and it routes to the provider with YOUR token:

- anthropic: `POST /v1/messages`
- openai: `POST /openai/v1/responses`
- openrouter: `POST /openrouter/api/v1/chat/completions` (BYO-only — no pooled openrouter)

tokens are encrypted at rest (AES-256-GCM, key out-of-tree, 0600), never stored in the keys file, never logged, never echoed back. your BYO usage shows up under `byo` in [`/meter/me`](https://pool.example.com/meter/me).

## traces & privacy

**pooled usage is logged**: request + response text are captured (raw, access-controlled 0600 files) alongside token counts and latency. this may be included in future ANONYMIZED datasets used to improve the service — that's the deal for using donated quota. redaction (emails, phone numbers, api keys, ssh keys, seed phrases) runs before any dataset leaves the box. nothing is published or sold today; this is storage + an honest policy only.

**BYO traffic is NOT traced unless you opt in.** it's your token and your money. to opt in, ask shadow to set `traces:true` on your key. to opt OUT of pooled tracing, ask for `traces:false` (you keep pooled access; only the text capture stops).

## notes

- codex CLI and other openai-wire-format tools are NOT compatible (this is the anthropic messages API only).
- occasional `overloaded_error` = pool account rotating or briefly saturated. retry after a few seconds.
- be reasonable: this rides shared subscription quota and per-key usage is visible.
- keys can be rotated or revoked at any time.
