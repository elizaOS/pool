# Decisions

Record of source-selection and scrub decisions made while consolidating this
repo (2026-08-17).

## Source selection

- **pool-meter**: taken from the clean development repo (`repos/pool-meter`),
  not the runtime deployment directory (which holds ~4GB of logs, usage jsonl
  and backups). Code only.
- **broker-proxy**: taken from the working tree; only the five live files
  (`proxy.js`, `proxy.test.js`, `config.json`, `deploy-composable.sh`,
  `test-metadata-injection.js`). Throwaway scratch files (`renametest*.js`) and
  all `*.bak-*` snapshots excluded.
- **pool-edge**: **`army-pool-edge` chosen as canonical**, NOT the newer
  `pool-army` tree. Rationale: `pool-army`'s `worker.js` imports `./lib/docs.js`
  which does not exist on disk, so that tree is broken/incomplete.
  `army-pool-edge` is intact and its full test suite passes (96/96 after
  scrubbing). If the missing `docs.js` work from pool-army is recovered later,
  it can be ported on top of this package.
- **codex-proxy**: `codex-proxy.js` only; `*.bak-*` snapshots excluded.

## Scrub decisions

- **Reference domain** → all occurrences of the operator's real domain replaced
  with the `pool.example.com` / `example.com` placeholder family
  (README, join page, config defaults, nginx conf, tests, codex UA string).
- **Absolute home paths** → the operator's runtime tree genericized to
  `/opt/pool/...`; remaining home-dir paths genericized to `~`. systemd unit
  `User=` genericized to `pool`.
- **broker `config.json` `credentialsPath`** → placeholder
  `/path/to/oauth/.credentials.json`. This file is an operator-supplied OAuth
  refresh-token credentials file (Claude Code format); it must never be
  committed.
- **broker deploy script** → the live broker bearer token was hardcoded in
  `deploy-composable.sh`; replaced with a required env var
  (`ELIZA_ACCOUNT_BROKER_TOKEN`). The leaked value should be rotated on the
  live broker regardless, since it existed in a working tree.
- **`replacements` / `reverseMap` in broker `config.json`** ⚠️ FLAG FOR REVIEW:
  the real config maps platform-internal tool names to provider-facing
  conventions (the OC↔CC tool-name map). The mechanism is kept, but the actual
  mapping values were genericized to obvious placeholders
  (`internal_tool_name` → `ProviderFacingName`). Judgment call per brief:
  default was to genericize and flag. If the real map is deemed non-sensitive
  it can be restored; otherwise ship a `config.example.json` and gitignore the
  real one.
- **Real member/seat labels in tests** (donor names appearing in regression
  assertions and unit fixtures) → replaced with generic labels
  (`member-a`..`member-d`, `whale`/`mid`). Code comments in `proxy.js`
  referencing a specific member's incident reports were genericized.
- **pool-edge `forbidden-strings.test.mjs`** → the reference-instance needle
  list itself contained the real domain and real Cloudflare account/zone ids;
  replaced with placeholder needles so the test still demonstrates the
  contract without embedding the identities it exists to exclude.
- **Kept as-is**: localhost IPs and ports (18801/18807/18811/7803), they
  document the local service mesh and are not sensitive. Obvious test fixtures
  (`sk-ant-supersecrettoken9999`, `Bearer lease-token-a`, BIP39 seed-phrase
  redaction fixtures) are fake values used to test redaction and were kept.
