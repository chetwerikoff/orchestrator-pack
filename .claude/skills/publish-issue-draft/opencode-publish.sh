#!/usr/bin/env bash
# Fast, isolated opencode runtime for publish / merge / issue-create delegation.
#
# WHY THIS EXISTS
#   opencode keeps per-instance state in a SQLite DB under its data dir
#   (XDG_DATA_HOME/opencode/opencode.db, WAL mode = many readers, ONE writer).
#   Several fixes are layered here:
#
#   1. PER-INVOCATION DATA DIR (mktemp). Each run is isolated from the orchestrator
#      and from every other publish run — no shared SQLite to contend on.
#
#   2. NON-REASONING MODEL. deepseek-chat (not deepseek-v4-flash): goes straight to
#      tool_calls. v4-flash emits reasoning_content every turn; on a multi-step
#      publish that balloons and, with no client timeout, opencode hung 14+ min.
#      A 180s provider timeout makes a stalled model call fail fast.
#
#   3. STARTUP-HANG RETRY (watchdog). A cold `opencode run` INTERMITTENTLY stalls
#      during startup ("bootstrapping"), before it ever reaches the model — an
#      opencode-internal concurrency behaviour (NOT data DB / DNS / deepseek /
#      CPU — all ruled out by strace; the precise internal mechanism was not
#      isolated). Because the stall is BEFORE any side effect (no issue/commit/PR
#      yet), it is SAFE to kill and retry. The watchdog watches the run's log:
#         - reaches "stream providerID" (model started) -> let it run FREELY to
#           completion (publish legitimately waits minutes for CI — never killed,
#           and never retried once work began, so no duplicate issue/PR);
#         - no model stream within STARTUP_DEADLINE and still alive -> startup
#           hang -> kill, fresh data dir, retry (up to MAX_ATTEMPTS).
#
#   lsp/autoupdate/watcher are disabled (publish needs none).
#
# USAGE
#   opencode-publish.sh <opencode run args...>   # run isolated, with startup retry
#   opencode-publish.sh --reap                   # ONLY reap orphaned opencode procs
#
# ORPHAN REAP (safe): kills only opencode reparented to init (ppid==1 = launcher
#   died) AND older than 60s. NEVER an AO-managed session (AO_SESSION_ID) and never
#   a fresh run (age guard) — cannot kill the orchestrator or a concurrent publish.
set -uo pipefail

STARTUP_DEADLINE="${OPENCODE_PUBLISH_STARTUP_DEADLINE:-60}"   # s to reach the model before declaring a startup hang
MAX_ATTEMPTS="${OPENCODE_PUBLISH_MAX_ATTEMPTS:-3}"

reap_orphans() {
  local p ppid age killed=0
  for p in $(pgrep -f "opencode" 2>/dev/null); do
    [ "$p" = "$$" ] && continue
    if grep -qaz "AO_SESSION_ID" "/proc/$p/environ" 2>/dev/null; then continue; fi
    ppid=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    [ "$ppid" = "1" ] || continue
    age=$(ps -o etimes= -p "$p" 2>/dev/null | tr -d ' ')
    [ -n "$age" ] && [ "$age" -gt 60 ] 2>/dev/null || continue
    kill "$p" 2>/dev/null && killed=$((killed+1))
  done
  echo "opencode-publish: reaped $killed orphaned opencode process(es) (ppid=1, age>60s)" >&2
}

if [ "${1:-}" = "--reap" ]; then reap_orphans; exit 0; fi

write_cfg() {
  cat > "$1" <<'CFG'
{
  "$schema": "https://opencode.ai/config.json",
  "model": "deepseek/deepseek-chat",
  "small_model": "deepseek/deepseek-chat",
  "lsp": false,
  "autoupdate": false,
  "snapshot": false,
  "watcher": { "ignore": ["**"] },
  "provider": { "deepseek": { "options": { "timeout": 180000 } } },
  "permission": { "bash": "allow", "edit": "allow", "write": "allow", "read": "allow" }
}
CFG
}

# Run once under a startup watchdog. Returns 124 ONLY for a startup hang (model
# never started -> safe to retry); otherwise the real opencode exit code.
run_once() {
  local data="$1"; shift
  local cfg="$data/config.json"
  write_cfg "$cfg"
  env XDG_DATA_HOME="$data" OPENCODE_CONFIG="$cfg" \
    opencode run "$@" &
  local oc=$!
  local started=0 waited=0
  while kill -0 "$oc" 2>/dev/null; do
    if grep -qs "stream providerID" "$data"/opencode/log/*.log 2>/dev/null; then
      started=1; break
    fi
    [ "$waited" -ge "$STARTUP_DEADLINE" ] && break
    sleep 2; waited=$((waited+2))
  done
  if [ "$started" = 1 ]; then
    wait "$oc"; return $?                       # work began -> run freely (CI wait etc.)
  fi
  if kill -0 "$oc" 2>/dev/null; then            # deadline hit, still no model -> startup hang
    kill "$oc" 2>/dev/null; sleep 1; kill -9 "$oc" 2>/dev/null
    wait "$oc" 2>/dev/null
    return 124
  fi
  wait "$oc"; return $?                          # exited on its own before the model (fast success/err)
}

reap_orphans
rc=124
for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  PUB_DATA="$(mktemp -d "${TMPDIR:-/tmp}/opencode-publish.XXXXXX")"
  run_once "$PUB_DATA" "$@"; rc=$?
  rm -rf "$PUB_DATA" 2>/dev/null
  if [ "$rc" != 124 ]; then break; fi          # 124 = startup hang only -> retry; else done
  [ "$attempt" -lt "$MAX_ATTEMPTS" ] && \
    echo "opencode-publish: startup hang (no model in ${STARTUP_DEADLINE}s), retry $((attempt+1))/$MAX_ATTEMPTS..." >&2
done
exit $rc
