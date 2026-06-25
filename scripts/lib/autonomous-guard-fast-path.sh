#!/usr/bin/env bash
# Bash-side guard fast-path classification (Issue #462).
# Mirrors docs/autonomous-orchestrator-boundary.mjs for read-only git/ao shapes so
# autonomous shims can exec real binaries without per-command pwsh guard startup.
set -euo pipefail

__ao_autonomous_audit_guard_pwsh_spawn() {
  local shim="${1:-unknown}"
  if [[ -n "${AO_AUTONOMOUS_GUARD_SPAWN_AUDIT_FILE:-}" ]]; then
    printf 'pwsh-guard:%s\n' "${shim}" >>"${AO_AUTONOMOUS_GUARD_SPAWN_AUDIT_FILE}"
  fi
}

__ao_autonomous_git_argv_subcommand_index() {
  local index=0
  local token=""
  while [[ ${index} -lt $# ]]; do
    index=$((index + 1))
    token="${!index}"
    case "${token}" in
      -C | -c | --git-dir | --work-tree | --exec-path | --namespace)
        index=$((index + 1))
        continue
        ;;
      --*=*)
        continue
        ;;
      -c* | -C*)
        if [[ "${token}" != "-c" && "${token}" != "-C" ]]; then
          continue
        fi
        ;;
      -*)
        continue
        ;;
      *)
        printf '%s' "${index}"
        return 0
        ;;
    esac
  done
  printf '%s' $((index + 1))
}

__ao_autonomous_git_argv_defines_alias() {
  local index=0
  local token=""
  while [[ ${index} -lt $# ]]; do
    index=$((index + 1))
    token="${!index}"
    if [[ "${token}" == "-c" ]]; then
      index=$((index + 1))
      [[ ${index} -le $# ]] || return 1
      token="${!index}"
      [[ "${token}" == alias.* ]] && return 0
      continue
    fi
    if [[ "${token}" == -c* && "${token}" != "-c" ]]; then
      [[ "${token#-c}" == alias.* ]] && return 0
    fi
  done
  return 1
}

__ao_autonomous_git_token_is_exact_option() {
  local token="${1,,}"
  local option="${2,,}"
  [[ "${token}" == "${option}" || "${token}" == "${option}="* ]]
}

__ao_autonomous_git_argv_tail_has_positional_operand_from() {
  local sub_index="$1"
  shift
  local i token
  for ((i = sub_index + 1; i <= $#; i++)); do
    token="${!i}"
    [[ "${token}" == -* ]] || return 0
  done
  return 1
}

__ao_autonomous_git_token_is_config_get_option() {
  case "${1,,}" in
    --get | --get-all | --get-regexp | --get-urlmatch) return 0 ;;
    --get=* | --get-all=* | --get-regexp=* | --get-urlmatch=*) return 0 ;;
  esac
  return 1
}

__ao_autonomous_git_argv_config_tail_is_get_read_only_from() {
  local sub_index="$1"
  shift
  local saw_get=0 j config_token
  for ((j = sub_index + 1; j <= $#; j++)); do
    config_token="${!j}"
    if __ao_autonomous_git_token_is_config_get_option "${config_token}"; then
      saw_get=1
      continue
    fi
    [[ "${config_token}" == -* ]] && continue
    [[ ${saw_get} -eq 1 ]] && continue
    return 1
  done
  [[ ${saw_get} -eq 1 ]] && return 0
  return 1
}

__ao_autonomous_git_argv_is_read_only() {
  if [[ $# -eq 0 ]]; then
    return 0
  fi
  if __ao_autonomous_git_argv_defines_alias "$@"; then
    return 1
  fi

  local sub_index sub
  sub_index="$(__ao_autonomous_git_argv_subcommand_index "$@")"
  if [[ ${sub_index} -gt $# ]]; then
    return 0
  fi
  sub="${!sub_index}"
  sub="${sub,,}"

  case "${sub}" in
    fetch)
      local i fetch_token
      for ((i = sub_index + 1; i <= $#; i++)); do
        fetch_token="${!i}"
        if __ao_autonomous_git_token_is_exact_option "${fetch_token}" "--dry-run"; then
          return 0
        fi
      done
      return 1
      ;;
    stash)
      if [[ $((sub_index + 1)) -gt $# ]]; then
        return 1
      fi
      local stash_arg_index=$((sub_index + 1))
      local stash_sub="${!stash_arg_index}"
      stash_sub="${stash_sub,,}"
      [[ "${stash_sub}" == "list" || "${stash_sub}" == "show" ]] && return 0
      return 1
      ;;
    config)
      __ao_autonomous_git_argv_config_tail_is_get_read_only_from "${sub_index}" "$@" && return 0
      return 1
      ;;
    branch)
      if __ao_autonomous_git_argv_tail_has_positional_operand_from "${sub_index}" "$@"; then
        return 1
      fi
      local k branch_token
      for ((k = sub_index + 1; k <= $#; k++)); do
        branch_token="${!k}"
        if __ao_autonomous_git_token_is_exact_option "${branch_token}" "--show-current"; then
          return 0
        fi
      done
      return 1
      ;;
    status | log | rev-parse | diff | show | ls-files | ls-tree | cat-file | merge-base | grep | check-ignore | check-attr | describe | for-each-ref | show-ref | name-rev | var | version | help | rev-list)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

__ao_autonomous_ao_argv_is_read_fast_path() {
  local sub="" next="" found=0 arg
  for arg in "$@"; do
    [[ "${arg}" == -* ]] && continue
    if [[ ${found} -eq 0 ]]; then
      sub="${arg,,}"
      found=1
      continue
    fi
    next="${arg,,}"
    break
  done
  [[ ${found} -eq 0 ]] && return 1
  case "${sub}" in
    status)
      return 0
      ;;
    review)
      [[ "${next}" == "list" ]] && return 0
      return 1
      ;;
    *)
      return 1
      ;;
  esac
}
