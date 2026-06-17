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

  if [[ "${cmd}" =~ (^|[;&|[:space:]])(/usr/bin/git|/usr/local/bin/git|/bin/git)(.*)$ ]]; then
    printf '%s%s%s' "${BASH_REMATCH[1]}" "${quoted_pack_git}" "${BASH_REMATCH[3]}"
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

__ao_autonomous_redirect_absolute_git() {
  local cmd="${BASH_COMMAND-}"
  [[ -n "${cmd}" ]] || return 0

  local pack_git rewritten="" ec
  pack_git="$(__ao_autonomous_pack_git)"
  # Skip our own shim invocations and guard subprocesses.
  [[ "${cmd}" == *"${pack_git}"* ]] && return 0
  [[ "${cmd}" == *git-autonomous-guard.ps1* ]] && return 0

  if ! rewritten="$(__ao_autonomous_rewrite_git_command "${cmd}" "${pack_git}")"; then
    return 0
  fi

  eval "${rewritten}"
  ec=$?
  if (( ec != 0 )); then
    __AO_AUTONOMOUS_ABSOLUTE_GIT_EC="${ec}"
    # Propagate shim denial to callers; allowed read-only paths use return 1 below.
    exit "${ec}"
  fi
  unset -v __AO_AUTONOMOUS_ABSOLUTE_GIT_EC 2>/dev/null || true
  # Skip the original absolute git invocation without terminating the shell.
  return 1
}

shopt -s extdebug
trap '__ao_autonomous_redirect_absolute_git' DEBUG
