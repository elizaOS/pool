#!/usr/bin/env bash
# deploy.sh — rsync this checkout to the live service directory and restart.
#
# Deployment model (chosen over a symlinked checkout on purpose):
#   The runtime directory /opt/pool/services/pool-meter also holds
#   historical .bak-* files and is referenced by an existing systemd unit and
#   nginx alias. rsync of src/ keeps the repo as the source of truth for code
#   while leaving that runtime state, and the out-of-tree secrets, untouched.
#
# Guarantees:
#   - timestamped backup of the live entrypoint before anything is written
#   - syntax check of every file BEFORE the live copy is replaced
#   - only pool-meter.service is restarted; the broker (7803) and the account
#     pool proxy (18807) are never touched
#   - post-deploy health gate with automatic rollback
#
# Usage: ./scripts/deploy.sh [--dry-run]

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE_DIR="${POOL_METER_LIVE_DIR:-/opt/pool/services/pool-meter}"
SERVICE="pool-meter.service"
STAMP="$(date +%Y%m%d-%H%M%S)"
DRY=""
[[ "${1:-}" == "--dry-run" ]] && DRY="--dry-run"

echo "==> repo: $REPO_DIR"
echo "==> live: $LIVE_DIR"

# 1. syntax check everything in the repo first
echo "==> syntax checking"
while IFS= read -r f; do
  node --check "$f" || { echo "SYNTAX ERROR in $f, aborting"; exit 1; }
done < <(find "$REPO_DIR/src" -name '*.js')
echo "    all files parse"

# 2. backup the live code set.
#
# The entrypoint alone is NOT enough: a deploy can change src/lib/*.js and add
# new modules, so restoring only pool-meter.js would leave the entrypoint from
# release N-1 next to libraries from release N. Snapshot the whole live code
# set into an out-of-the-way rollback dir, and keep the historical
# pool-meter.js.bak-* for continuity with earlier releases.
ROLLBACK_DIR="$LIVE_DIR/.rollback-$STAMP"
if [[ -z "$DRY" ]]; then
  mkdir -p "$ROLLBACK_DIR"
  rsync -a --exclude '*.bak-*' --exclude '.rollback-*' --exclude 'logs' \
    "$LIVE_DIR/" "$ROLLBACK_DIR/"
  [[ -f "$LIVE_DIR/pool-meter.js" ]] && cp -p "$LIVE_DIR/pool-meter.js" "$LIVE_DIR/pool-meter.js.bak-v2-$STAMP"
  echo "==> backup: $ROLLBACK_DIR (full code set) + pool-meter.js.bak-v2-$STAMP"
fi

# 3. sync code only. Secrets and logs live elsewhere and are never synced.
echo "==> syncing src/ -> $LIVE_DIR"
rsync -a $DRY --itemize-changes \
  --exclude '*.bak-*' \
  "$REPO_DIR/src/" "$LIVE_DIR/"

if [[ -n "$DRY" ]]; then echo "==> dry run complete"; exit 0; fi

# 4. restart ONLY the meter
echo "==> restarting $SERVICE (broker 7803 and upstream 18807 untouched)"
sudo systemctl restart "$SERVICE"
sleep 4

# 5. health gate, rollback on failure
PORT="$(grep -oP 'listenPort"\s*:\s*\K\d+' /opt/pool/secrets/pool-meter.config.json 2>/dev/null || echo 18811)"
code="$(curl -sS -o /dev/null -w '%{http_code}' -m 15 "http://127.0.0.1:${PORT}/status.json" || echo 000)"
if [[ "$code" != "200" ]]; then
  echo "!! health check failed (/status.json -> $code), rolling back full code set"
  # --delete so files ADDED by the bad deploy (new modules) are removed too.
  rsync -a --delete --exclude '*.bak-*' --exclude '.rollback-*' --exclude 'logs' \
    "$ROLLBACK_DIR/" "$LIVE_DIR/"
  sudo systemctl restart "$SERVICE"
  sleep 4
  rb="$(curl -sS -o /dev/null -w '%{http_code}' -m 15 "http://127.0.0.1:${PORT}/status.json" || echo 000)"
  echo "!! rolled back; post-rollback health: $rb"
  exit 1
fi

# 6. prune rollback snapshots, keeping the 5 most recent
ls -1dt "$LIVE_DIR"/.rollback-* 2>/dev/null | tail -n +6 | xargs -r rm -rf

echo "==> deployed and healthy (/status.json 200)"
systemctl --no-pager status "$SERVICE" | head -6
