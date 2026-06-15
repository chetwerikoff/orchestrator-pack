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
#   OPENCODE_PUBLISH_INCLUDE="docs/issues_drafts/NN-x.md docs/issue_queue_index.md" \
#     opencode-publish.sh <opencode run args...> # run isolated, with startup retry
#   opencode-publish.sh --reap                   # ONLY reap orphaned opencode procs/scratch
#
# ORPHAN REAP (safe): kills only opencode reparented to init (ppid==1 = launcher
#   died) AND older than 60s. NEVER an AO-managed session (AO_SESSION_ID) and never
#   a fresh run (age guard) — cannot kill the orchestrator or a concurrent publish.
set -uo pipefail

STARTUP_DEADLINE="${OPENCODE_PUBLISH_STARTUP_DEADLINE:-60}"   # s to reach the model before declaring a startup hang
MAX_ATTEMPTS="${OPENCODE_PUBLISH_MAX_ATTEMPTS:-3}"
SCRATCH_PREFIX="opencode-publish-checkout"
SCRATCH_ROOT="${OPENCODE_PUBLISH_SCRATCH_ROOT:-${TMPDIR:-/tmp}}"
PUB_SCRATCH=""
CURRENT_DATA=""
OC_CHILD=""

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

reap_scratch_checkouts() {
  local root="$SCRATCH_ROOT" dir meta pid child_pid removed=0
  [ -d "$root" ] || return 0
  for dir in "$root"/"$SCRATCH_PREFIX".*; do
    [ -d "$dir" ] || continue
    meta="$dir/.opencode-publish-meta"
    pid=""
    child_pid=""
    [ -f "$meta" ] && pid="$(sed -n 's/^pid=//p' "$meta" | head -n 1)"
    [ -f "$meta" ] && child_pid="$(sed -n 's/^child_pid=//p' "$meta" | tail -n 1)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      continue
    fi
    if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then
      continue
    fi
    if rm -rf "$dir" 2>/dev/null; then
      removed=$((removed+1))
    else
      echo "opencode-publish: warning: failed to remove stale scratch checkout: $dir" >&2
    fi
  done
  echo "opencode-publish: reaped $removed stale scratch checkout(s)" >&2
}

if [ "${1:-}" = "--reap" ]; then reap_orphans; reap_scratch_checkouts; exit 0; fi

die() {
  echo "opencode-publish: ERROR: $*" >&2
  exit 1
}

validate_relpath() {
  local p="$1"
  case "$p" in
    ""|/*|*"/../"*|../*|*".."|*//$'\0'*) return 1 ;;
  esac
  [ "$p" != "." ] && [ "$p" != ".." ]
}

copy_publish_inputs() {
  local live_root="$1" scratch="$2" raw="${OPENCODE_PUBLISH_INCLUDE:-}" path
  raw="${raw//$'\n'/ }"
  raw="${raw//:/ }"
  [ -n "$raw" ] || return 0
  for path in $raw; do
    validate_relpath "$path" || die "refusing unsafe OPENCODE_PUBLISH_INCLUDE path: $path"
    [ -f "$live_root/$path" ] || die "publish input does not exist in live tree: $path"
    mkdir -p "$scratch/$(dirname "$path")" || die "cannot create scratch parent for $path"
    cp -p "$live_root/$path" "$scratch/$path" || die "cannot copy publish input into scratch checkout: $path"
  done
}

prepare_scratch_checkout() {
  local live_root origin_url scratch default_branch
  live_root="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repository"
  origin_url="$(git -C "$live_root" remote get-url origin 2>/dev/null)" || die "cannot read origin remote URL"
  scratch="$(mktemp -d "$SCRATCH_ROOT/$SCRATCH_PREFIX.XXXXXX")" || die "cannot create scratch checkout under $SCRATCH_ROOT"
  rmdir "$scratch" || die "cannot prepare empty scratch checkout path: $scratch"
  PUB_SCRATCH="$scratch"

  git clone --quiet --shared "$live_root" "$scratch" || die "cannot clone isolated checkout from $live_root"
  {
    echo "pid=$$"
    echo "live_root=$live_root"
    echo "created_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$scratch/.opencode-publish-meta"
  git -C "$scratch" remote set-url origin "$origin_url" || die "cannot set scratch origin remote"
  git -C "$scratch" fetch --quiet origin || die "cannot fetch origin in scratch checkout"
  default_branch="$(git -C "$scratch" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
  default_branch="${default_branch:-main}"
  git -C "$scratch" checkout --quiet -B "$default_branch" "origin/$default_branch" ||
    die "cannot check out origin/$default_branch in scratch checkout"
  copy_publish_inputs "$live_root" "$scratch"
}

rewrite_dir_arg() {
  local scratch="$1"; shift
  local out=() arg
  while [ "$#" -gt 0 ]; do
    arg="$1"; shift
    case "$arg" in
      --dir)
        out+=("--dir" "$scratch")
        [ "$#" -gt 0 ] && shift
        ;;
      --dir=*)
        out+=("--dir=$scratch")
        ;;
      *)
        out+=("$arg")
        ;;
    esac
  done
  printf '%s\0' "${out[@]}"
}

cleanup() {
  local rc=$?
  trap - EXIT HUP INT TERM
  if [ -n "${OC_CHILD:-}" ] && kill -0 "$OC_CHILD" 2>/dev/null; then
    kill "$OC_CHILD" 2>/dev/null || true
    sleep 1
    kill -9 "$OC_CHILD" 2>/dev/null || true
  fi
  [ -n "${CURRENT_DATA:-}" ] && rm -rf "$CURRENT_DATA" 2>/dev/null || true
  [ -n "${PUB_SCRATCH:-}" ] && rm -rf "$PUB_SCRATCH" 2>/dev/null || true
  exit "$rc"
}

trap cleanup EXIT HUP INT TERM

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
  OC_CHILD="$oc"
  [ -n "${PUB_SCRATCH:-}" ] && echo "child_pid=$oc" >> "$PUB_SCRATCH/.opencode-publish-meta"
  local started=0 waited=0
  while kill -0 "$oc" 2>/dev/null; do
    if grep -qs "stream providerID" "$data"/opencode/log/*.log 2>/dev/null; then
      started=1; break
    fi
    [ "$waited" -ge "$STARTUP_DEADLINE" ] && break
    sleep 2; waited=$((waited+2))
  done
  if [ "$started" = 1 ]; then
    wait "$oc"; local rc=$?; OC_CHILD=""; return "$rc" # work began -> run freely (CI wait etc.)
  fi
  if kill -0 "$oc" 2>/dev/null; then            # deadline hit, still no model -> startup hang
    kill "$oc" 2>/dev/null; sleep 1; kill -9 "$oc" 2>/dev/null
    wait "$oc" 2>/dev/null
    OC_CHILD=""
    return 124
  fi
  wait "$oc"; local rc=$?; OC_CHILD=""; return "$rc" # exited on its own before the model (fast success/err)
}

reap_orphans
reap_scratch_checkouts
prepare_scratch_checkout
SCRATCH_DIR="$PUB_SCRATCH"
mapfile -d '' OPENCODE_ARGS < <(rewrite_dir_arg "$SCRATCH_DIR" "$@")
rc=124
for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  PUB_DATA="$(mktemp -d "${TMPDIR:-/tmp}/opencode-publish.XXXXXX")"
  CURRENT_DATA="$PUB_DATA"
  run_once "$PUB_DATA" "${OPENCODE_ARGS[@]}"; rc=$?
  rm -rf "$PUB_DATA" 2>/dev/null
  CURRENT_DATA=""
  if [ "$rc" != 124 ]; then break; fi          # 124 = startup hang only -> retry; else done
  [ "$attempt" -lt "$MAX_ATTEMPTS" ] && \
    echo "opencode-publish: startup hang (no model in ${STARTUP_DEADLINE}s), retry $((attempt+1))/$MAX_ATTEMPTS..." >&2
done
exit $rc
