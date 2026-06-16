#!/usr/bin/env bash
# Ensure the automation Chrome for discuss-with-gpt is up on CDP :9222 with the
# operator's dedicated profile. Idempotent: reuses an already-running instance.
#
# Operator config (required): DISCUSS_WITH_GPT_PROJECT_URL and
# DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR, or local.config.json in this directory
# (see local.config.example.json).
#
# Usage: .claude/skills/discuss-with-gpt/launch-chrome.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CDP="http://localhost:9222"

config_out="$(node "$SCRIPT_DIR/config.mjs" --shell)" || exit 1
# shellcheck disable=SC1090
eval "$config_out"

CHROME="${DISCUSS_WITH_GPT_CHROME_PATH}"
PROFILE="${DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR}"
URL="${DISCUSS_WITH_GPT_PROJECT_URL}"

if curl -s "$CDP/json/version" >/dev/null 2>&1; then
  echo "✓ automation Chrome already up on $CDP — reusing (login preserved)"
  exit 0
fi

if [ ! -x "$CHROME" ]; then
  echo "✗ Chrome not found at: $CHROME" >&2
  echo "  Set DISCUSS_WITH_GPT_CHROME_PATH or chromePath in local.config.json" >&2
  exit 1
fi

echo "launching automation Chrome (persistent profile $PROFILE)…"
# --remote-allow-origins=* is REQUIRED on Chrome 111+: without it the CDP
# websocket upgrades but Chrome silently drops Playwright's protocol messages,
# so connectOverCDP() hangs until timeout (looks like "chrome_not_running").
"$CHROME" --remote-debugging-port=9222 --remote-allow-origins=* \
  --user-data-dir="$PROFILE" "$URL" \
  </dev/null >/dev/null 2>&1 &
disown || true

if curl -s --retry 25 --retry-delay 1 --retry-all-errors "$CDP/json/version" >/dev/null 2>&1; then
  echo "✓ up on $CDP"
  echo "  If this is the first launch on a fresh profile, log into ChatGPT once;"
  echo "  the session is then saved in $PROFILE and reused on every later launch."
else
  echo "✗ Chrome did not expose CDP on :9222 within timeout" >&2
  exit 1
fi
