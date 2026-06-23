# Shared pwsh resolver for pack bash shims (Issue #406).
resolve_pwsh() {
  # Turn-visible AO_PWSH_BINARY must not override the guard interpreter on protected surfaces.
  if [[ "${AO_AUTONOMOUS_ORCHESTRATOR_SURFACE:-}" != "1" ]]; then
    if [[ -n "${AO_PWSH_BINARY:-}" && -x "${AO_PWSH_BINARY}" ]]; then
      printf '%s\n' "${AO_PWSH_BINARY}"
      return 0
    fi
  fi
  if command -v pwsh >/dev/null 2>&1; then
    command -v pwsh
    return 0
  fi
  local candidate
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
