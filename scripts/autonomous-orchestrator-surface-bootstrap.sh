#!/usr/bin/env bash
# Thin BASH_ENV bootstrap for autonomous orchestrator surface (Issue #406).
# Operator coworker.env should point BASH_ENV here. Heavy interposer logic lives in
# autonomous-bash-env.sh (sourced below). This file maps live session markers only.

{
  _ao_bootstrap_self="${BASH_SOURCE[0]:-${BASH_ENV:-}}"
  if [[ -n "${_ao_bootstrap_self}" ]]; then
    _ao_pack_scripts="$(cd "$(dirname "${_ao_bootstrap_self}")" && pwd)"
    case ":${PATH:-}:" in
      *:"${_ao_pack_scripts}":*) ;;
      *) export PATH="${_ao_pack_scripts}:${PATH:-}" ;;
    esac
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
if [[ -r "${INTERPOSER}" ]]; then
  # shellcheck disable=SC1090
  source "${INTERPOSER}"
fi
