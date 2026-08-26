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
  if node "$SCRIPT_DIR/verify-cdp-owner.mjs" verify --profile "$PROFILE" --cdp "$CDP"; then
    echo "✓ automation Chrome already up on $CDP — reusing (dedicated profile verified)"
    exit 0
  fi
  echo "✗ CDP on $CDP is not the configured automation Chrome profile — refusing to reuse" >&2
  echo "  Close the foreign browser on :9222 or align DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR." >&2
  exit 1
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
#
# On WSL the Windows chrome.exe MUST be launched so that *Windows* owns its
# lifetime. A plain interop background job ("$CHROME" ... & disown) is torn
# down when the launching shell / interop relay exits — the CDP port never
# comes up and chrome.exe ends with 0 live processes (the "chrome_not_running"
# symptom). Hand the launch to a Windows-owned, detached process instead.
if [[ "$CHROME" == /mnt/* ]]; then
  # A Windows chrome.exe REQUIRES a Windows-owned launcher. powershell.exe is
  # frequently not on PATH in non-login shells (e.g. the agent's bash), so do
  # not gate on `command -v` and silently fall through to the broken `& disown`
  # interop path below — resolve a powershell first, and fail loudly if none.
  PS=""
  if command -v powershell.exe >/dev/null 2>&1; then
    PS="powershell.exe"
  elif [ -x /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]; then
    PS="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
  else
    echo "✗ Windows chrome.exe ($CHROME) needs powershell.exe to launch, but none was found" >&2
    echo "  (not on PATH and not at the default System32 location)." >&2
    echo "  Add powershell.exe to PATH or set DISCUSS_WITH_GPT_CHROME_PATH to a native Chrome." >&2
    exit 1
  fi
  CHROME_WIN="$(wslpath -w "$CHROME")"
  "$PS" -NoProfile -Command \
    "Start-Process -FilePath '$CHROME_WIN' -ArgumentList '--remote-debugging-port=9222','--remote-allow-origins=*','--user-data-dir=$PROFILE','$URL'" \
    >/dev/null 2>&1
else
  # Native (non-WSL) Chrome: background it directly.
  "$CHROME" --remote-debugging-port=9222 --remote-allow-origins=* \
    --user-data-dir="$PROFILE" "$URL" \
    </dev/null >/dev/null 2>&1 &
  disown || true
fi

if curl -s --retry 25 --retry-delay 1 --retry-all-errors "$CDP/json/version" >/dev/null 2>&1; then
  node "$SCRIPT_DIR/verify-cdp-owner.mjs" verify --profile "$PROFILE" --cdp "$CDP"
  echo "✓ up on $CDP (dedicated profile verified)"
  echo "  If this is the first launch on a fresh profile, log into ChatGPT once;"
  echo "  the session is then saved in $PROFILE and reused on every later launch."
else
  echo "✗ Chrome did not expose CDP on :9222 within timeout" >&2
  exit 1
fi
