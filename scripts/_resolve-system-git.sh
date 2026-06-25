#!/usr/bin/env bash
# Shared host git resolver for pack shims (Issue #324 / #462).
set -euo pipefail

_AO_RESOLVE_SYSTEM_GIT_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

__ao_resolve_system_git_path() {
  readlink -f "${1}" 2>/dev/null || realpath "${1}" 2>/dev/null || printf '%s' "${1}"
}

__ao_is_pack_git_shim_path() {
  local candidate="$1"
  local scripts_dir="$2"
  local resolved shim
  [[ -n "${candidate}" ]] || return 1
  [[ "${candidate}" == *git-autonomous-guard.ps1* ]] && return 0
  resolved="$(__ao_resolve_system_git_path "${candidate}")"
  shim="$(__ao_resolve_system_git_path "${scripts_dir}/git")"
  [[ "${resolved}" == "${shim}" ]]
}

__ao_is_pack_git_real_binary_path() {
  local candidate="$1"
  local pack_root="$2"
  local resolved real_binary
  [[ -n "${candidate}" ]] || return 1
  [[ "${candidate}" == *git-real-binary* ]] && return 0
  resolved="$(__ao_resolve_system_git_path "${candidate}")"
  real_binary="$(__ao_resolve_system_git_path "${pack_root}/scripts/git-real-binary")"
  [[ "${resolved}" == "${real_binary}" ]]
}

__ao_is_rejected_pack_git_wrapper() {
  local candidate="$1"
  local pack_root="$2"
  local scripts_dir="$3"
  __ao_is_pack_git_shim_path "${candidate}" "${scripts_dir}" && return 0
  __ao_is_pack_git_real_binary_path "${candidate}" "${pack_root}" && return 0
  return 1
}

__ao_try_emit_system_git_candidate() {
  local candidate="$1"
  local pack_root="$2"
  local scripts_dir="$3"
  [[ -n "${candidate}" && -x "${candidate}" ]] || return 1
  __ao_is_rejected_pack_git_wrapper "${candidate}" "${pack_root}" "${scripts_dir}" && return 1
  printf '%s\n' "$(__ao_resolve_system_git_path "${candidate}")"
  return 0
}

# Scan PATH for a host git binary, skipping the pack scripts dir and guard shims.
__ao_scan_path_for_host_git() {
  local scripts_dir="$1"
  local pack_root="$2"
  local self candidate resolved dir
  self="$(__ao_resolve_system_git_path "${scripts_dir}/git")"
  IFS=':' read -ra path_dirs <<< "${PATH:-}"
  for dir in "${path_dirs[@]}"; do
    [[ -z "${dir}" || "${dir}" == "${scripts_dir}" ]] && continue
    candidate="${dir%/}/git"
    [[ -x "${candidate}" ]] || continue
    resolved="$(__ao_resolve_system_git_path "${candidate}")"
    if [[ "${resolved}" != "${self}" && "${resolved}" != *git-autonomous-guard* ]]; then
      if ! __ao_is_rejected_pack_git_wrapper "${resolved}" "${pack_root}" "${scripts_dir}"; then
        printf '%s\n' "${resolved}"
        return 0
      fi
    fi
  done
  return 1
}

resolve_system_git() {
  local pack_root config configured system_path
  pack_root="$(cd "${_AO_RESOLVE_SYSTEM_GIT_SCRIPT_DIR}/.." && pwd)"
  config="${pack_root}/.ao/autonomous-real-binaries.json"

  if [[ -f "${config}" ]]; then
    system_path="$(python3 -c "import json,sys; c=json.load(open(sys.argv[1])); print(c.get('gitSystemBinary') or '')" "${config}" 2>/dev/null || true)"
    if __ao_try_emit_system_git_candidate "${system_path}" "${pack_root}" "${_AO_RESOLVE_SYSTEM_GIT_SCRIPT_DIR}"; then
      return 0
    fi
    configured="$(python3 -c "import json,sys; c=json.load(open(sys.argv[1])); print(c.get('git',''))" "${config}" 2>/dev/null || true)"
    if __ao_try_emit_system_git_candidate "${configured}" "${pack_root}" "${_AO_RESOLVE_SYSTEM_GIT_SCRIPT_DIR}"; then
      return 0
    fi
  fi

  if [[ "${AO_AUTONOMOUS_ORCHESTRATOR_SURFACE:-}" != "1" ]]; then
    if [[ -n "${GIT_SYSTEM_BINARY:-}" && -x "${GIT_SYSTEM_BINARY}" ]]; then
      printf '%s\n' "${GIT_SYSTEM_BINARY}"
      return 0
    fi
  fi

  for candidate in /usr/bin/git /bin/git /usr/local/bin/git; do
    if [[ -x "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  if __ao_scan_path_for_host_git "${_AO_RESOLVE_SYSTEM_GIT_SCRIPT_DIR}" "${pack_root}"; then
    return 0
  fi

  printf 'git\n'
}
