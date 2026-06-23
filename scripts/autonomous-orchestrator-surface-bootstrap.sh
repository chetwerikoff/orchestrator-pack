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
