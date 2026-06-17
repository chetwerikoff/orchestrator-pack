#!/usr/bin/env bash
# Internal forwarder: exec host git from out-of-band config (Issue #324).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACK_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG="${PACK_ROOT}/.ao/autonomous-real-binaries.json"

if [[ "${AO_AUTONOMOUS_ORCHESTRATOR_SURFACE:-}" == "1" && "${AO_AUTONOMOUS_GIT_INTERNAL_EXEC:-}" != "1" ]]; then
  exec "${SCRIPT_DIR}/git" "$@"
fi

resolve_system_git() {
  local configured system_path
  if [[ -f "${CONFIG}" ]]; then
    system_path="$(python3 -c "import json,sys; c=json.load(open(sys.argv[1])); print(c.get('gitSystemBinary') or '')" "${CONFIG}" 2>/dev/null || true)"
    if [[ -n "${system_path}" && -x "${system_path}" ]]; then
      printf '%s\n' "${system_path}"
      return 0
    fi
    configured="$(python3 -c "import json,sys; c=json.load(open(sys.argv[1])); print(c.get('git',''))" "${CONFIG}" 2>/dev/null || true)"
    if [[ -n "${configured}" && "${configured}" != *git-real-binary* && -x "${configured}" ]]; then
      printf '%s\n' "${configured}"
      return 0
    fi
  fi

  if [[ "${AO_AUTONOMOUS_ORCHESTRATOR_SURFACE:-}" != "1" && -n "${GIT_SYSTEM_BINARY:-}" && -x "${GIT_SYSTEM_BINARY}" ]]; then
    printf '%s\n' "${GIT_SYSTEM_BINARY}"
    return 0
  fi

  for candidate in /usr/bin/git /bin/git /usr/local/bin/git; do
    if [[ -x "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  printf 'git\n'
}

exec "$(resolve_system_git)" "$@"
