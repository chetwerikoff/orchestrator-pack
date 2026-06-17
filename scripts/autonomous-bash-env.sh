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

  # Unquoted absolute binary at command start (BASH_ENV -c shape).
  if [[ "${cmd}" =~ ^(${abs_binary})(.*)$ ]]; then
    printf -v quoted_pack_target '%q' "${pack_target}"
    printf '%s%s' "${quoted_pack_target}" "${BASH_REMATCH[2]}"
    return 0
  fi

  # Unquoted absolute binary after a shell separator.
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

__ao_autonomous_trim_whitespace() {
  local value="${1-}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "${value}"
}

__ao_autonomous_assignment_matches_absolute_binary() {
  local trimmed="${1-}" leaf="${2-}" abs_binary=""
  abs_binary="$(__ao_autonomous_absolute_binary_pattern "${leaf}")"
  [[ "${trimmed}" =~ ^(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=\"(${abs_binary})\"$ ]] && return 0
  [[ "${trimmed}" =~ ^(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=\'(${abs_binary})\'$ ]] && return 0
  [[ "${trimmed}" =~ ^(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(${abs_binary})$ ]] && return 0
  return 1
}

__ao_autonomous_var_assigned_absolute_binary() {
  local cmd="${1-}" var="${2-}" leaf="${3-}" part trimmed=""
  local IFS=';'
  read -ra __ao_assign_parts <<< "${cmd}" || true
  for part in "${__ao_assign_parts[@]}"; do
    trimmed="$(__ao_autonomous_trim_whitespace "${part}")"
    [[ "${trimmed}" =~ ^(export[[:space:]]+)?${var}= ]] || continue
    __ao_autonomous_assignment_matches_absolute_binary "${trimmed}" "${leaf}" && return 0
  done
  return 1
}

__ao_autonomous_rewrite_shell_expansion_command() {
  local cmd="${1-}" pack_target="${2-}" leaf="${3-}" quoted_pack_target="" abs_binary=""
  local var prefix="" part trimmed="" quoted_invocation_pattern="" bare_invocation_pattern=""

  abs_binary="$(__ao_autonomous_absolute_binary_pattern "${leaf}")"
  printf -v quoted_pack_target '%q' "${pack_target}"

  local IFS=';'
  read -ra __ao_assign_parts <<< "${cmd}" || true
  for part in "${__ao_assign_parts[@]}"; do
    trimmed="$(__ao_autonomous_trim_whitespace "${part}")"
    __ao_autonomous_assignment_matches_absolute_binary "${trimmed}" "${leaf}" || continue
    [[ "${trimmed}" =~ ^(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)= ]] || continue
    var="${BASH_REMATCH[2]}"
    quoted_invocation_pattern="(^|[;|][[:space:]]*)\"\\$"
    quoted_invocation_pattern+="${var}"
    quoted_invocation_pattern+="\"(.*)$"
    if [[ "${cmd}" =~ ${quoted_invocation_pattern} ]]; then
      prefix="${cmd%%"${BASH_REMATCH[0]}"*}"
      printf '%s%s%s%s' "${prefix}" "${BASH_REMATCH[1]}" "${quoted_pack_target}" "${BASH_REMATCH[2]}"
      return 0
    fi
    bare_invocation_pattern="(^|[;|][[:space:]]*)\\$"
    bare_invocation_pattern+="${var}"
    bare_invocation_pattern+="([[:space:];&|]|$)(.*)$"
    if [[ "${cmd}" =~ ${bare_invocation_pattern} ]]; then
      prefix="${cmd%%"${BASH_REMATCH[0]}"*}"
      printf '%s%s%s%s%s' "${prefix}" "${BASH_REMATCH[1]}" "${quoted_pack_target}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
      return 0
    fi
  done

  return 1
}

__ao_autonomous_rewrite_all_shell_expansions_in_command() {
  local cmd="${1-}" pack_git="${2-}" pack_ao="${3-}" next=""

  for leaf_target in "git:${pack_git}" "ao:${pack_ao}"; do
    local leaf="${leaf_target%%:*}"
    local target="${leaf_target#*:}"
    while :; do
      if ! next="$(__ao_autonomous_rewrite_shell_expansion_command "${cmd}" "${target}" "${leaf}")"; then
        break
      fi
      if [[ "${next}" == "${cmd}" ]]; then
        break
      fi
      cmd="${next}"
    done
  done

  printf '%s' "${cmd}"
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
  cmd="$(__ao_autonomous_rewrite_all_shell_expansions_in_command "${cmd}" "${pack_git}" "${pack_ao}")"
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
