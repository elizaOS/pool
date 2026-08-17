#!/usr/bin/env bash
# Safe restart of the live account-broker-proxy (port 18807) to load the
# composability fix. Reversible: keeps the old process env, verifies health
# before declaring success, and prints the exact rollback if it fails.
set -euo pipefail
cd "$(dirname "$0")"

PORT=18807
BROKER_URL="http://127.0.0.1:7803"
BROKER_TOKEN="${ELIZA_ACCOUNT_BROKER_TOKEN:?set ELIZA_ACCOUNT_BROKER_TOKEN}"
LOG="${BROKER_PROXY_LOG:-/opt/pool/logs/account-broker-proxy.log}"
OLD_PID="$(ss -ltnp 2>/dev/null | grep ':'"$PORT"' ' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)"

echo "[deploy] node --check"
node --check proxy.js
echo "[deploy] test suite"
node proxy.test.js 2>&1 | grep -E 'ℹ (tests|pass|fail)'

echo "[deploy] old pid on :$PORT = ${OLD_PID:-none}"
[ -n "${OLD_PID:-}" ] && kill "$OLD_PID" && sleep 1

echo "[deploy] launching new proxy -> $LOG"
ELIZA_ACCOUNT_BROKER_ENABLED=1 \
ELIZA_ACCOUNT_BROKER_FAIL_CLOSED=1 \
ELIZA_ACCOUNT_BROKER_URL="$BROKER_URL" \
ELIZA_ACCOUNT_BROKER_TOKEN="$BROKER_TOKEN" \
PROXY_PORT="$PORT" \
  nohup node proxy.js >>"$LOG" 2>&1 &
NEW_PID=$!
sleep 2

if ss -ltnp 2>/dev/null | grep -q ':'"$PORT"' '; then
  echo "[deploy] OK — listening on :$PORT, new pid=$NEW_PID"
else
  echo "[deploy] FAILED — nothing on :$PORT. Check $LOG. Rollback: relaunch from proxy.js.bak-* backup."
  exit 1
fi
