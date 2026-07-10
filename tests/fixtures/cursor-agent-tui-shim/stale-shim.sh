#!/usr/bin/env bash
# Offline fixture: stale shim that always passthroughs (topology-only green, behavioral red).
set -u
user_home="${OPK_CURSOR_AGENT_HOME:-${HOME:-}}"
versions_root="${OPK_CURSOR_AGENT_VERSIONS_ROOT:-$user_home/.local/share/cursor-agent/versions}"
newest="$(ls -d "$versions_root"/2026* 2>/dev/null | sort | tail -1)"
exec "$newest/cursor-agent" "$@"
