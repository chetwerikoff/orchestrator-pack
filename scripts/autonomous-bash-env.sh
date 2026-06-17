#!/usr/bin/env bash
# Optional BASH_ENV interposer for autonomous orchestrator bash turns (Issue #324).
# Redirects absolute host git/ao binaries through pack scripts/git and scripts/ao.
[[ "${AO_AUTONOMOUS_ORCHESTRATOR_SURFACE:-}" == "1" ]] || return 0

__ao_autonomous_pack_script_dir() {
  cd "$(dirname "${BASH_SOURCE[0]}")" && pwd
}

__ao_autonomous_pack_git() {
  local script_dir
  script_dir="$(__ao_autonomous_pack_script_dir)"
  printf '%s\n' "${script_dir}/git"
}

__ao_autonomous_pack_ao() {
  local script_dir
  script_dir="$(__ao_autonomous_pack_script_dir)"
  printf '%s\n' "${script_dir}/ao"
}

__ao_autonomous_absolute_binary_pattern() {
  local leaf="${1-}"
  printf '/[^[:space:];&|\"'"'"']+/%s' "${leaf}"
}

__ao_autonomous_rewrite_binary_command() {
  local cmd="${1-}" pack_target="${2-}" leaf="${3-}" quoted_pack_target prefix=""
  local abs_binary boundary abs_match

  abs_binary="$(__ao_autonomous_absolute_binary_pattern "${leaf}")"
  boundary='(^|[;&|[:space:]]|[\"'"'"'])'

  # Quoted absolute binary at command start (common BASH_ENV -c shape).
  if [[ "${cmd}" =~ ^\"(${abs_binary})\"(.*)$ ]]; then
    printf -v quoted_pack_target '%q' "${pack_target}"
    printf '%s%s' "${quoted_pack_target}" "${BASH_REMATCH[2]}"
    return 0
  fi

  if [[ "${cmd}" =~ ^\'(${abs_binary})\'(.*)$ ]]; then
    printf -v quoted_pack_target '%q' "${pack_target}"
    printf '%s%s' "${quoted_pack_target}" "${BASH_REMATCH[2]}"
    return 0
  fi

  # Double-quoted absolute binary after command start, shell separator, or opening quote.
  if [[ "${cmd}" =~ ${boundary}\"(${abs_binary})\"(.*)$ ]]; then
    printf -v quoted_pack_target '%q' "${pack_target}"
    prefix="${cmd%%"${BASH_REMATCH[0]}"*}"
    printf '%s%s%s%s' "${prefix}" "${BASH_REMATCH[1]}" "${quoted_pack_target}" "${BASH_REMATCH[3]}"
    return 0
  fi

  # Single-quoted absolute binary after command start, shell separator, or opening quote.
  if [[ "${cmd}" =~ ${boundary}\'(${abs_binary})\'(.*)$ ]]; then
    printf -v quoted_pack_target '%q' "${pack_target}"
    prefix="${cmd%%"${BASH_REMATCH[0]}"*}"
    printf '%s%s%s%s' "${prefix}" "${BASH_REMATCH[1]}" "${quoted_pack_target}" "${BASH_REMATCH[3]}"
    return 0
  fi

  # String-concatenated quoted absolute binary (e.g. foo"/path/git" …).
  if [[ "${cmd}" =~ \"(${abs_binary})\"(.*)$ ]]; then
    printf -v quoted_pack_target '%q' "${pack_target}"
    abs_match="${BASH_REMATCH[1]}"
    prefix="${cmd%%\"${abs_match}\"*}"
    printf '%s%s%s%s' "${prefix}" "\"" "${quoted_pack_target}" "${BASH_REMATCH[2]}"
    return 0
  fi

  if [[ "${cmd}" =~ \'(${abs_binary})\'(.*)$ ]]; then
    printf -v quoted_pack_target '%q' "${pack_target}"
    abs_match="${BASH_REMATCH[1]}"
    prefix="${cmd%%\'${abs_match}\'*}"
    printf '%s%s%s%s' "${prefix}" "'" "${quoted_pack_target}" "${BASH_REMATCH[2]}"
    return 0
  fi

  # Unquoted absolute binary.
  if [[ "${cmd}" =~ (^|[;&|[:space:]])(${abs_binary})(.*)$ ]]; then
    printf -v quoted_pack_target '%q' "${pack_target}"
    prefix="${cmd%%"${BASH_REMATCH[0]}"*}"
    printf '%s%s%s%s' "${prefix}" "${BASH_REMATCH[1]}" "${quoted_pack_target}" "${BASH_REMATCH[3]}"
    return 0
  fi

  if [[ "${leaf}" == "git" ]]; then
    if [[ "${cmd}" =~ (^|[;&|[:space:]])(/usr/bin/env|env)([[:space:]]+.*[[:space:]])git(.*)$ ]]; then
      # Drop PATH=/usr/bin:… env wrappers — they hide pwsh from scripts/git on the guard path.
      printf -v quoted_pack_target '%q' "${pack_target}"
      prefix="${cmd%%"${BASH_REMATCH[0]}"*}"
      printf '%s%s%s%s' "${prefix}" "${BASH_REMATCH[1]}" "${quoted_pack_target}" "${BASH_REMATCH[4]}"
      return 0
    fi

    if [[ "${cmd}" =~ ^(([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+)+)git(.*)$ ]]; then
      printf -v quoted_pack_target '%q' "${pack_target}"
      prefix="${cmd%%"${BASH_REMATCH[0]}"*}"
      printf '%s%s%s%s' "${prefix}" "${BASH_REMATCH[1]}" "${quoted_pack_target}" "${BASH_REMATCH[3]}"
      return 0
    fi
  fi

  return 1
}

__ao_autonomous_rewrite_all_of_binary_in_command() {
  local cmd="${1-}" pack_target="${2-}" leaf="${3-}" next=""

  while :; do
    if ! next="$(__ao_autonomous_rewrite_binary_command "${cmd}" "${pack_target}" "${leaf}")"; then
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

__ao_autonomous_rewrite_all_binaries_in_command() {
  local cmd="${1-}" pack_git="${2-}" pack_ao="${3-}"

  cmd="$(__ao_autonomous_rewrite_all_of_binary_in_command "${cmd}" "${pack_git}" "git")"
  cmd="$(__ao_autonomous_rewrite_all_of_binary_in_command "${cmd}" "${pack_ao}" "ao")"
  printf '%s' "${cmd}"
}

__ao_autonomous_interpose_execution_string() {
  [[ "${__AO_AUTONOMOUS_BASH_INTERPOSED:-}" == "1" ]] && return 0
  [[ -n "${BASH_EXECUTION_STRING:-}" ]] || return 0

  local pack_git pack_ao rewritten="" ec
  pack_git="$(__ao_autonomous_pack_git)"
  pack_ao="$(__ao_autonomous_pack_ao)"
  rewritten="$(__ao_autonomous_rewrite_all_binaries_in_command "${BASH_EXECUTION_STRING}" "${pack_git}" "${pack_ao}")"
  if [[ "${rewritten}" == "${BASH_EXECUTION_STRING}" ]]; then
    return 0
  fi

  __AO_AUTONOMOUS_BASH_INTERPOSED=1
  eval "${rewritten}"
  ec=$?
  exit "${ec}"
}

__ao_autonomous_interpose_execution_string
