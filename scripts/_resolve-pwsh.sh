# Shared pwsh resolver for pack bash shims (Issue #406).
resolve_pwsh() {
  local trusted_only=0
  [[ "${AO_AUTONOMOUS_ORCHESTRATOR_SURFACE:-}" == "1" ]] && trusted_only=1

  if [[ "${trusted_only}" -eq 0 ]]; then
    if [[ -n "${AO_PWSH_BINARY:-}" && -x "${AO_PWSH_BINARY}" ]]; then
      printf '%s\n' "${AO_PWSH_BINARY}"
      return 0
    fi
    if command -v pwsh >/dev/null 2>&1; then
      command -v pwsh
      return 0
    fi
  fi

  local candidate
  if [[ "${trusted_only}" -eq 1 ]]; then
    for candidate in \
      /usr/local/bin/pwsh \
      /usr/bin/pwsh \
      /opt/microsoft/powershell/7/pwsh; do
      if [[ -x "${candidate}" ]]; then
        printf '%s\n' "${candidate}"
        return 0
      fi
    done
    printf '/usr/local/bin/pwsh\n'
    return 0
  fi

  for candidate in \
    /usr/local/bin/pwsh \
    /usr/bin/pwsh \
    /opt/microsoft/powershell/7/pwsh \
    "${HOME}/.local/bin/pwsh"; do
    if [[ -x "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  printf 'pwsh\n'
}
