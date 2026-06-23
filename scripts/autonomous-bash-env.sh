#!/usr/bin/env bash
# Optional BASH_ENV interposer for autonomous orchestrator bash turns (Issue #324, #406).
# Redirects absolute host git/ao binaries through pack scripts/git and scripts/ao.
[[ "${__AO_AUTONOMOUS_BASH_INTERPOSED:-}" == "1" ]] && return 0

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

__ao_autonomous_resolve_path() {
  local candidate="${1-}"
  readlink -f "${candidate}" 2>/dev/null || realpath "${candidate}" 2>/dev/null || printf '%s' "${candidate}"
}

__ao_autonomous_is_guard_forwarder_shim() {
  local script_path="${0#./}"
  [[ -n "${script_path}" && -f "${script_path}" ]] || return 1
  [[ "${script_path}" == *"/autonomous-bash-env.sh" ]] && return 1
  [[ "${script_path}" == *"/autonomous-orchestrator-surface-bootstrap.sh" ]] && return 1

  local resolved pack_git pack_ao pack_scripts
  resolved="$(__ao_autonomous_resolve_path "${script_path}")"
  pack_git="$(__ao_autonomous_pack_git)"
  pack_ao="$(__ao_autonomous_pack_ao)"
  pack_scripts="$(dirname "${pack_git}")"

  [[ "${resolved}" == "${pack_git}" || "${resolved}" == "${pack_ao}" ]] && return 0

  case "${resolved}" in
    "${pack_scripts}/git-real-binary" | "${pack_scripts}/_invoke-system-git.sh") return 0 ;;
  esac

  if [[ "${resolved##*/}" == "ao" || "${resolved##*/}" == "git" ]]; then
    if [[ -x "${resolved}" ]] && grep -Eq 'ao-autonomous-guard|git-autonomous-guard|scripts/ao|scripts/git|REAL_AO=|REAL_GIT=' "${resolved}" 2>/dev/null; then
      return 0
    fi
  fi

  return 1
}

# Forwarder shims executed as $0 must not be rewritten/reexec'd (#406).
if __ao_autonomous_is_guard_forwarder_shim; then
  return 0
fi

[[ "${AO_AUTONOMOUS_ORCHESTRATOR_SURFACE:-}" == "1" ]] || return 0

__ao_autonomous_absolute_binary_pattern() {
  local leaf="${1-}"
  printf '/[^[:space:];&|\"'"'"']+/%s' "${leaf}"
}

__ao_autonomous_rewrite_binary_command() {
  local cmd="${1-}" pack_target="${2-}" leaf="${3-}" quoted_pack_target prefix=""
  local abs_binary boundary abs_match

  abs_binary="$(__ao_autonomous_absolute_binary_pattern "${leaf}")"
  boundary='(^|[;&|[:space:]()]|[\"'"'"'])'

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

  # Unquoted absolute binary after a shell separator or subshell/command-substitution opener.
  if [[ "${cmd}" =~ (^|[;&|[:space:]()])(${abs_binary})(.*)$ ]]; then
    printf -v quoted_pack_target '%q' "${pack_target}"
    prefix="${cmd%%"${BASH_REMATCH[0]}"*}"
    printf '%s%s%s%s' "${prefix}" "${BASH_REMATCH[1]}" "${quoted_pack_target}" "${BASH_REMATCH[3]}"
    return 0
  fi

  # Command substitution: $(/absolute/leaf …)
  if [[ "${cmd}" =~ \$\((${abs_binary})(.*)\) ]]; then
    printf -v quoted_pack_target '%q' "${pack_target}"
    prefix="${cmd%%"${BASH_REMATCH[0]}"*}"
    printf '%s$(%s%s)' "${prefix}" "${quoted_pack_target}" "${BASH_REMATCH[2]}"
    return 0
  fi

  # Backtick command substitution: `/absolute/leaf …`
  if [[ "${cmd}" =~ \`(${abs_binary})([^\`]*)[\`] ]]; then
    printf -v quoted_pack_target '%q' "${pack_target}"
    prefix="${cmd%%"${BASH_REMATCH[0]}"*}"
    printf '%s`%s%s`' "${prefix}" "${quoted_pack_target}" "${BASH_REMATCH[2]}"
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

__ao_autonomous_script_content_needs_interposer() {
  local content="${1-}" line trimmed="" abs_git abs_ao
  abs_git="$(__ao_autonomous_absolute_binary_pattern "git")"
  abs_ao="$(__ao_autonomous_absolute_binary_pattern "ao")"
  [[ "${content}" =~ ${abs_git} ]] && return 0
  [[ "${content}" =~ ${abs_ao} ]] && return 0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    trimmed="$(__ao_autonomous_trim_whitespace "${line}")"
    __ao_autonomous_assignment_matches_absolute_binary "${trimmed}" "git" && return 0
    __ao_autonomous_assignment_matches_absolute_binary "${trimmed}" "ao" && return 0
  done <<< "${content}"
  return 1
}

__ao_autonomous_prepend_pack_scripts_path() {
  local pack_scripts="${1-}"
  [[ -n "${pack_scripts}" ]] || return 0
  case ":${PATH:-}:" in
    *:"${pack_scripts}":*) return 0 ;;
    *) export PATH="${pack_scripts}:${PATH:-}" ;;
  esac
}

__ao_autonomous_entry_script_is_shell_binary() {
  local script_path="${0#./}"
  case "${script_path##*/}" in
    bash | sh | dash) return 0 ;;
  esac
  [[ "${script_path}" == */bin/bash || "${script_path}" == */bin/sh ]] && return 0
  return 1
}

__ao_autonomous_maybe_reexec_preprocessed_script() {
  [[ -n "${BASH_EXECUTION_STRING:-}" ]] && return 1
  [[ "${__AO_AUTONOMOUS_SCRIPT_REEXECED:-}" == "1" ]] && return 1
  __ao_autonomous_is_guard_forwarder_shim && return 1
  __ao_autonomous_entry_script_is_shell_binary && return 1

  local script_path="${0#./}"
  [[ -f "${script_path}" ]] || return 1
  [[ "${script_path}" == *"/autonomous-bash-env.sh" ]] && return 1

  local pack_git pack_ao content rewritten tmp=""
  pack_git="$(__ao_autonomous_pack_git)"
  pack_ao="$(__ao_autonomous_pack_ao)"
  content="$(<"${script_path}")"
  if ! __ao_autonomous_script_content_needs_interposer "${content}"; then
    return 1
  fi

  rewritten="$(__ao_autonomous_rewrite_all_binaries_in_command "${content}" "${pack_git}" "${pack_ao}")"
  if [[ "${rewritten}" == "${content}" ]]; then
    return 1
  fi

  tmp="$(mktemp "${TMPDIR:-/tmp}/ao-autonomous-script.XXXXXX")"
  printf '%s' "${rewritten}" > "${tmp}"
  chmod +x "${tmp}" 2>/dev/null || true
  __AO_AUTONOMOUS_SCRIPT_REEXECED=1
  BASH_ENV= exec bash "${tmp}" "$@"
}

__ao_autonomous_interpose_execution_string() {
  [[ "${__AO_AUTONOMOUS_BASH_INTERPOSED:-}" == "1" ]] && return 0

  local pack_git pack_ao pack_scripts rewritten="" ec
  pack_git="$(__ao_autonomous_pack_git)"
  pack_ao="$(__ao_autonomous_pack_ao)"
  pack_scripts="$(dirname "${pack_git}")"

  __ao_autonomous_prepend_pack_scripts_path "${pack_scripts}"

  if [[ -n "${BASH_EXECUTION_STRING:-}" ]]; then
    rewritten="$(__ao_autonomous_rewrite_all_binaries_in_command "${BASH_EXECUTION_STRING}" "${pack_git}" "${pack_ao}")"
    if [[ "${rewritten}" != "${BASH_EXECUTION_STRING}" ]]; then
      __AO_AUTONOMOUS_BASH_INTERPOSED=1
      BASH_ENV= eval "${rewritten}"
      ec=$?
      exit "${ec}"
    fi
    # Eval-hidden (#406): unchanged wrapper still arms DEBUG trap for hidden absolutes.
  fi

  if __ao_autonomous_maybe_reexec_preprocessed_script; then
    exit $?
  fi

  __ao_autonomous_install_debug_interposer "${pack_git}" "${pack_ao}" "${pack_scripts}"
}

__ao_autonomous_debug_trap() {
  local pack_git="${__AO_AUTONOMOUS_DEBUG_PACK_GIT:-}"
  local pack_ao="${__AO_AUTONOMOUS_DEBUG_PACK_AO:-}"
  local pack_scripts="${__AO_AUTONOMOUS_DEBUG_PACK_SCRIPTS:-}"
  local rewritten="" ec=0

  [[ "${BASH_COMMAND}" == __ao_autonomous_debug_trap ]] && return 0
  [[ "${BASH_COMMAND}" == *__ao_autonomous_* ]] && return 0
  [[ "${__AO_AUTONOMOUS_DEBUG_ACTIVE:-}" == 1 ]] && return 0
  [[ -z "${pack_git}" || -z "${pack_ao}" ]] && return 0

  __ao_autonomous_prepend_pack_scripts_path "${pack_scripts}"

  rewritten="$(__ao_autonomous_rewrite_all_binaries_in_command "${BASH_COMMAND}" "${pack_git}" "${pack_ao}")"
  if [[ "${rewritten}" == "${BASH_COMMAND}" ]]; then
    return 0
  fi

  __AO_AUTONOMOUS_DEBUG_ACTIVE=1
  BASH_ENV= __AO_AUTONOMOUS_BASH_INTERPOSED=1 eval "${rewritten}"
  ec=$?
  __AO_AUTONOMOUS_DEBUG_ACTIVE=0
  if [[ ${ec} -eq 93 ]]; then
    exit 93
  fi
  if [[ ${ec} -eq 0 ]]; then
    return 1
  fi
  return "${ec}"
}

__ao_autonomous_install_debug_interposer() {
  local pack_git="${1-}" pack_ao="${2-}" pack_scripts="${3-}"
  [[ "${__AO_AUTONOMOUS_DEBUG_TRAP_INSTALLED:-}" == 1 ]] && return 0

  __AO_AUTONOMOUS_DEBUG_PACK_GIT="${pack_git}"
  __AO_AUTONOMOUS_DEBUG_PACK_AO="${pack_ao}"
  __AO_AUTONOMOUS_DEBUG_PACK_SCRIPTS="${pack_scripts}"
  shopt -s extdebug
  trap '__ao_autonomous_debug_trap' DEBUG
  __AO_AUTONOMOUS_DEBUG_TRAP_INSTALLED=1
}

__ao_autonomous_interpose_execution_string
