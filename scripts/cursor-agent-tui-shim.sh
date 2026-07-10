#!/usr/bin/env bash
# Pack-owned cursor-agent TUI argv interposition (Issue #725).
# Restores interactive Composer TUI for AO worker panes while preserving headless
# passthrough for reviews, draft-author runs, pipes, and manual use.
set -u

user_home="${OPK_CURSOR_AGENT_HOME:-${HOME:-}}"
versions_root="${OPK_CURSOR_AGENT_VERSIONS_ROOT:-$user_home/.local/share/cursor-agent/versions}"

resolve_real() {
  local newest=""
  if [[ -d "$versions_root" ]]; then
    newest="$(ls -d "$versions_root"/2026* 2>/dev/null | sort | tail -1 || true)"
    if [[ -z "$newest" ]]; then
      local alt
      alt="$(ls -d "$versions_root"/20* 2>/dev/null | sort | tail -1 || true)"
      [[ -n "$alt" ]] && newest="$alt"
    fi
  fi
  if [[ -z "$newest" || ! -x "$newest/cursor-agent" ]]; then
    echo "[cursor-agent-tui-shim] FATAL: no cursor-agent release under ${versions_root} (expected 2026* layout)" >&2
    exit 127
  fi
  printf '%s' "$newest/cursor-agent"
}

REAL="$(resolve_real)"

want_translate=0
if [[ -t 1 && "${AO_SESSION_ID:-}" =~ ^orchestrator-pack-[0-9]+$ ]]; then
  has_p=0
  has_sj=0
  for a in "$@"; do
    [[ "$a" == "-p" || "$a" == "--print" ]] && has_p=1
    [[ "$a" == "stream-json" ]] && has_sj=1
  done
  [[ $has_p -eq 1 && $has_sj -eq 1 ]] && want_translate=1
fi

if [[ $want_translate -eq 1 ]]; then
  out=()
  skip=0
  for a in "$@"; do
    if [[ $skip -eq 1 ]]; then
      skip=0
      continue
    fi
    case "$a" in
      -p | --print | --trust) ;;
      --output-format) skip=1 ;;
      *) out+=("$a") ;;
    esac
  done
  exec "$REAL" ${out[@]+"${out[@]}"}
fi

exec "$REAL" "$@"
