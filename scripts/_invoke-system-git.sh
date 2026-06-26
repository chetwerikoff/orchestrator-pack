#!/usr/bin/env bash
# Internal forwarder: exec host git from out-of-band config (Issue #324).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck disable=SC1091
. "${SCRIPT_DIR}/_resolve-system-git.sh"

if [[ "${AO_AUTONOMOUS_ORCHESTRATOR_SURFACE:-}" == "1" ]]; then
  exec "${SCRIPT_DIR}/git" "$@"
fi

exec "$(resolve_system_git)" "$@"
