#!/usr/bin/env bash
# Optional BASH_ENV interposer for autonomous orchestrator bash turns (Issue #324).
# Redirects absolute host git binaries through pack scripts/git so the guard runs.
[[ "${AO_AUTONOMOUS_ORCHESTRATOR_SURFACE:-}" == "1" ]] || return 0

__ao_autonomous_pack_git() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  printf '%s\n' "${script_dir}/git"
}

__ao_autonomous_rewrite_git_command() {
  local cmd="${1-}" pack_git="${2-}" quoted_pack_git

  printf -v quoted_pack_git '%q' "${pack_git}"

  if [[ "${cmd}" =~ (^|[;&|[:space:]])([\"']?)(/usr/bin/git|/usr/local/bin/git|/bin/git)([\"']?)(.*)$ ]]; then
    printf '%s%s%s' "${BASH_REMATCH[1]}" "${quoted_pack_git}" "${BASH_REMATCH[5]}"
    return 0
  fi

  if [[ "${cmd}" =~ (^|[;&|[:space:]])(/usr/bin/env|env)([[:space:]]+.*[[:space:]])git(.*)$ ]]; then
    # Drop PATH=/usr/bin:… env wrappers — they hide pwsh from scripts/git on the guard path.
    printf '%s%s%s' "${BASH_REMATCH[1]}" "${quoted_pack_git}" "${BASH_REMATCH[4]}"
    return 0
  fi

  if [[ "${cmd}" =~ ^(([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+)+)git(.*)$ ]]; then
    printf '%s%s%s' "${BASH_REMATCH[1]}" "${quoted_pack_git}" "${BASH_REMATCH[3]}"
    return 0
  fi

  return 1
}

__ao_autonomous_rewrite_all_git_in_command() {
  local cmd="${1-}" pack_git="${2-}" next=""

  while :; do
    if ! next="$(__ao_autonomous_rewrite_git_command "${cmd}" "${pack_git}")"; then
      printf '%s' "${cmd}"
      return 0
    fi
    if [[ "${next}" == "${cmd}" ]]; then
      break
    fi
    cmd="${next}"
  done

  printf '%s' "${cmd}"
}

__ao_autonomous_interpose_execution_string() {
  [[ "${__AO_AUTONOMOUS_BASH_INTERPOSED:-}" == "1" ]] && return 0
  [[ -n "${BASH_EXECUTION_STRING:-}" ]] || return 0

  local pack_git rewritten="" ec
  pack_git="$(__ao_autonomous_pack_git)"
  rewritten="$(__ao_autonomous_rewrite_all_git_in_command "${BASH_EXECUTION_STRING}" "${pack_git}")"
  if [[ "${rewritten}" == "${BASH_EXECUTION_STRING}" ]]; then
    return 0
  fi

  __AO_AUTONOMOUS_BASH_INTERPOSED=1
  eval "${rewritten}"
  ec=$?
  exit "${ec}"
}

__ao_autonomous_interpose_execution_string
