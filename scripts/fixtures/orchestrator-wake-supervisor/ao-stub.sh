#!/usr/bin/env bash
set -euo pipefail
fixture="${AO_WAKE_SUPERVISOR_FIXTURE:-}"
if [[ -z "$fixture" || ! -f "$fixture" ]]; then
  echo "ao stub: missing AO_WAKE_SUPERVISOR_FIXTURE" >&2
  exit 1
fi
cat "$fixture"
