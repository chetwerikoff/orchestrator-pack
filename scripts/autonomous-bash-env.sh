#!/usr/bin/env bash
# Optional BASH_ENV interposer for autonomous orchestrator bash turns (Issue #324).
# Redirects absolute host git binaries through pack scripts/git so the guard runs.
[[ "${AO_AUTONOMOUS_ORCHESTRATOR_SURFACE:-}" == "1" ]] || return 0

__ao_autonomous_pack_git() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  printf '%s\n' "${script_dir}/git"
}

__ao_autonomous_redirect_absolute_git() {
  local cmd="${BASH_COMMAND-}"
  [[ -n "${cmd}" ]] || return 0
  [[ "${cmd}" =~ ^(/usr/bin/git|/bin/git|/usr/local/bin/git)([[:space:]]|$) ]] || return 0

  local pack_git args ec
  pack_git="$(__ao_autonomous_pack_git)"
  if [[ "${cmd}" =~ ^(/usr/bin/git|/bin/git|/usr/local/bin/git)[[:space:]]+(.*)$ ]]; then
    args="${BASH_REMATCH[2]}"
  else
    args=""
  fi

  # shellcheck disable=SC2086
  "${pack_git}" ${args}
  ec=$?
  if (( ec != 0 )); then
    return "$ec"
  fi
  # Skip the original absolute git invocation without terminating the shell.
  return 1
}

shopt -s extdebug
trap '__ao_autonomous_redirect_absolute_git' DEBUG
