#!/usr/bin/env bash
# Offline fixture: stand-in for ~/.local/share/cursor-agent/versions/<rel>/cursor-agent
set -u

has_p=0
for a in "$@"; do
  [[ "$a" == "-p" || "$a" == "--print" ]] && has_p=1
done

if [[ $has_p -eq 1 ]]; then
  echo "No prompt provided" >&2
  exit 1
fi

echo "CURSOR_AGENT_TUI_BANNER"
sleep "${OPK_MOCK_CURSOR_AGENT_SLEEP_SECONDS:-2}"
exit 0
