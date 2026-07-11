#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "status" && -n "${AO_WAKE_SUPERVISOR_STATUS_FAILURE:-}" ]]; then
  case "$AO_WAKE_SUPERVISOR_STATUS_FAILURE" in
    connection-refused)
      echo "dial tcp 127.0.0.1:3001: connect: connection refused" >&2
      exit 1
      ;;
    connection-reset)
      echo "read tcp 127.0.0.1:3001: read: connection reset by peer" >&2
      exit 1
      ;;
    http-503)
      echo "ao status failed (exit 1): HTTP 503 Service Unavailable" >&2
      exit 1
      ;;
  esac
fi
fixture="${AO_WAKE_SUPERVISOR_FIXTURE:-}"
if [[ -z "$fixture" || ! -f "$fixture" ]]; then
  echo "ao stub: missing AO_WAKE_SUPERVISOR_FIXTURE" >&2
  exit 1
fi
cat "$fixture"
