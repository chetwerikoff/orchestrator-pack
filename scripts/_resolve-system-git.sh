#!/usr/bin/env bash
# Shared host git resolver for pack shims (Issue #324 / #462).
set -euo pipefail

_AO_RESOLVE_SYSTEM_GIT_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

resolve_system_git() {
  local pack_root config configured system_path
  pack_root="$(cd "${_AO_RESOLVE_SYSTEM_GIT_SCRIPT_DIR}/.." && pwd)"
  config="${pack_root}/.ao/autonomous-real-binaries.json"

  if [[ -f "${config}" ]]; then
    system_path="$(python3 -c "import json,sys; c=json.load(open(sys.argv[1])); print(c.get('gitSystemBinary') or '')" "${config}" 2>/dev/null || true)"
    if [[ -n "${system_path}" && -x "${system_path}" ]]; then
      printf '%s\n' "${system_path}"
      return 0
    fi
    configured="$(python3 -c "import json,sys; c=json.load(open(sys.argv[1])); print(c.get('git',''))" "${config}" 2>/dev/null || true)"
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
