#!/usr/bin/env bash
# Thin BASH_ENV bootstrap for autonomous orchestrator surface (Issue #406).
# Operator coworker.env should point BASH_ENV here. Heavy interposer logic lives in
# autonomous-bash-env.sh (sourced below). Arms orchestrator surface from live AO_TMUX_NAME
# (*orchestrator*) when agentConfig.env does not reach the tmux shell (AO 0.9.x).

{
  _ao_bootstrap_self="${BASH_SOURCE[0]:-${BASH_ENV:-}}"
  if [[ -n "${_ao_bootstrap_self}" ]]; then
    _ao_pack_scripts="$(cd "$(dirname "${_ao_bootstrap_self}")" && pwd)"
    _ao_cleaned_path=""
    IFS=':' read -ra _ao_path_parts <<< "${PATH:-}"
    for _ao_part in "${_ao_path_parts[@]}"; do
      [[ -z "${_ao_part}" || "${_ao_part}" == "${_ao_pack_scripts}" ]] && continue
      _ao_cleaned_path="${_ao_cleaned_path:+${_ao_cleaned_path}:}${_ao_part}"
    done
    unset _ao_path_parts _ao_part
    export PATH="${_ao_pack_scripts}${_ao_cleaned_path:+:${_ao_cleaned_path}}"
    unset _ao_cleaned_path
  fi
  unset _ao_bootstrap_self _ao_pack_scripts
}

if [[ "${__AO_AUTONOMOUS_SURFACE_BOOTSTRAP:-}" == "1" ]]; then
  return 0
fi
__AO_AUTONOMOUS_SURFACE_BOOTSTRAP=1

__ao_surface_bootstrap_is_orchestrator_tmux() {
  [[ -n "${AO_TMUX_NAME:-}" ]] || return 1
  case "${AO_TMUX_NAME}" in
    *orchestrator*) return 0 ;;
  esac
  return 1
}

if __ao_surface_bootstrap_is_orchestrator_tmux; then
  export AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1
fi

PACK_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]:-${BASH_ENV:-}}")" && pwd)"
INTERPOSER="${PACK_SCRIPTS}/autonomous-bash-env.sh"
if [[ ! -r "${INTERPOSER}" ]]; then
  printf '%s\n' \
    'autonomous orchestrator interposer unavailable; aborting protected bash turn' >&2
  exit 93
fi
# shellcheck disable=SC1090
if ! source "${INTERPOSER}"; then
  printf '%s\n' \
    'autonomous orchestrator interposer failed to source; aborting protected bash turn' >&2
  exit 93
fi

if [[ "${AO_COMMAND_RUNTIME_PREFLIGHT_SKIP:-}" == "1" ]]; then
  export __AO_COMMAND_RUNTIME_PREFLIGHT_OK=1
elif __ao_surface_bootstrap_is_orchestrator_tmux && [[ "${__AO_COMMAND_RUNTIME_PREFLIGHT_OK:-}" != "1" ]]; then
  runtime_cli="${PACK_SCRIPTS}/lib/command-runtime-bootstrap.mjs"
  if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' 'command-runtime-bootstrap: missing tool node before preflight' >&2
    exit 93
  fi
  if ! node "${runtime_cli}" livePreflight --pack-root "$(cd "${PACK_SCRIPTS}/.." && pwd)"; then
    exit 93
  fi
  export __AO_COMMAND_RUNTIME_PREFLIGHT_OK=1
fi

if [[ -z "${GH_REPO:-}" ]]; then
  _ao_gh_repo_derive="${PACK_SCRIPTS}/lib/derive-gh-repo-from-checkout.mjs"
  if command -v node >/dev/null 2>&1 && [[ -r "${_ao_gh_repo_derive}" ]]; then
    _ao_pack_root="$(cd "${PACK_SCRIPTS}/.." && pwd)"
    _ao_derived_gh_repo="$(node "${_ao_gh_repo_derive}" --pack-root "${_ao_pack_root}" 2>/dev/null || true)"
    if [[ -n "${_ao_derived_gh_repo}" ]]; then
      export GH_REPO="${_ao_derived_gh_repo}"
    fi
    unset _ao_pack_root _ao_derived_gh_repo
  fi
  unset _ao_gh_repo_derive
fi
