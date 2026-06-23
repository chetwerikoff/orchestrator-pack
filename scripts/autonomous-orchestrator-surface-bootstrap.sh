#!/usr/bin/env bash
# Thin BASH_ENV bootstrap for autonomous orchestrator surface (Issue #406).
# Operator coworker.env should point BASH_ENV here. Heavy interposer logic lives in
# autonomous-bash-env.sh (sourced below). This file maps live session markers only.

if [[ "${__AO_AUTONOMOUS_SURFACE_BOOTSTRAP:-}" == "1" ]]; then
  PACK_SCRIPTS="$(__ao_surface_bootstrap_script_dir)"
  case ":${PATH:-}:" in
    *:"${PACK_SCRIPTS}":*) ;;
    *) export PATH="${PACK_SCRIPTS}:${PATH:-}" ;;
  esac
  return 0
fi
__AO_AUTONOMOUS_SURFACE_BOOTSTRAP=1

__ao_surface_bootstrap_script_dir() {
  local source_path="${BASH_SOURCE[0]:-}"
  if [[ -z "${source_path}" || ! -f "${source_path}" ]]; then
    source_path="${BASH_ENV:-}"
  fi
  cd "$(dirname "${source_path}")" && pwd
}

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

PACK_SCRIPTS="$(__ao_surface_bootstrap_script_dir)"
case ":${PATH:-}:" in
  *:"${PACK_SCRIPTS}":*) ;;
  *) export PATH="${PACK_SCRIPTS}:${PATH:-}" ;;
esac

INTERPOSER="${PACK_SCRIPTS}/autonomous-bash-env.sh"
if [[ -r "${INTERPOSER}" ]]; then
  # shellcheck disable=SC1090
  source "${INTERPOSER}"
fi
