#!/bin/sh
set -eu

now_ms() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import time; print(int(time.time() * 1000))'
    return
  fi
  echo $(($(date +%s) * 1000))
}

effective_budget_ms="${AO_REVIEW_EFFECTIVE_BUDGET_MS:-600000}"
started_ms="${AO_REVIEW_BUDGET_STARTED_MS:-$(now_ms)}"
test_budget_ms="${AO_REVIEW_TEST_BUDGET_MS:-120000}"
hard_deadline_ms="${AO_REVIEW_HARD_DEADLINE_MS:-$((started_ms + effective_budget_ms))}"

elapsed_ms() {
  now="$(now_ms)"
  echo $((now - started_ms))
}

remaining_review_ms() {
  now="$(now_ms)"
  remaining=$((hard_deadline_ms - now))
  if [ "$remaining" -lt 0 ]; then
    echo 0
  else
    echo "$remaining"
  fi
}

option_consumes_value() {
  arg="$1"
  case "$arg" in
    -|-*) ;;
    *) return 1 ;;
  esac
  case "$arg" in
    *=*) return 1 ;;
    --coverage|--watch|--run|--passWithNoTests|--silent|--bail|--changed|--standalone|--merge-reports|-h|--help|--version) return 1 ;;
    --*) return 0 ;;
    -?) return 0 ;;
    -*) return 1 ;;
  esac
}

has_positional_selector() {
  while [ $# -gt 0 ]; do
    arg="$1"
    shift
    case "$arg" in
      -*)
        case "$arg" in
          *=*) ;;
          *)
            if option_consumes_value "$arg"; then
              if [ $# -gt 0 ]; then
                shift
              fi
            fi
            ;;
        esac
        ;;
      *)
        return 0
        ;;
    esac
  done
  return 1
}

has_targeted_test_selector() {
  executable="$1"
  shift
  if [ "$executable" = "vitest" ]; then
    if [ "${1:-}" = "run" ]; then
      shift
    fi
    has_positional_selector "$@"
    return $?
  fi
  if [ "$executable" = "npx" ] && [ "${1:-}" = "vitest" ]; then
    shift
    if [ "${1:-}" = "run" ]; then
      shift
    fi
    has_positional_selector "$@"
    return $?
  fi
  set -- "$@"
  prev=""
  while [ $# -gt 0 ]; do
    arg="$1"
    shift
    if [ "$arg" = "--" ] && [ "$prev" = "test" ]; then
      has_positional_selector "$@"
      return $?
    fi
    if [ "$arg" = "run" ] && [ "$prev" = "vitest" ]; then
      has_positional_selector "$@"
      return $?
    fi
    prev="$arg"
  done
  return 1
}

is_bare_vitest_full_suite() {
  executable="$1"
  shift
  case "$executable" in
    vitest)
      if has_targeted_test_selector vitest "$@"; then
        return 1
      fi
      return 0
      ;;
    npx)
      if [ "${1:-}" != "vitest" ]; then
        return 1
      fi
      if has_targeted_test_selector npx "$@"; then
        return 1
      fi
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

classify_command() {
  executable="$1"
  shift
  joined="$executable $*"
  case "$joined" in
    *orchestrator-wake-supervisor.test.ts*|*orchestrator-wake-supervisor-test-child*|*scripts/verify.ps1*|*check-reusable.ps1*|*supervisor*)
      echo slow_test
      return
      ;;
  esac
  if has_targeted_test_selector "$executable" "$@"; then
    echo cheap_targeted
    return
  fi
  if is_bare_vitest_full_suite "$executable" "$@"; then
    echo full_suite
    return
  fi
  case "$joined" in
    *"npm test"*|*"npm run test"*|*"vitest run"*|*"pnpm test"*|*"yarn test"*)
      echo full_suite
      return
      ;;
  esac
  echo cheap_targeted
}

deny_slow_command() {
  executable="$1"
  shift
  command_class="$(classify_command "$executable" "$@")"
  review_remaining="$(remaining_review_ms)"
  if [ "$command_class" = "cheap_targeted" ] && [ "$review_remaining" -gt 0 ]; then
    return 1
  fi
  echo "review-test-budget:{\"executable\":\"$executable\",\"command\":\"$executable $*\",\"commandClass\":\"$command_class\",\"decision\":\"skipped_or_denied_slow_test\",\"reason\":\"slow/full-suite reviewer checks are denied; CI owns exhaustive tests\",\"testBudgetMs\":$test_budget_ms,\"elapsedMs\":$(elapsed_ms)}" >&2
  return 0
}

resolve_real_binary() {
  name="$1"
  case "$name" in
    npm|npx|pwsh|yarn|pnpm|vitest)
      for dir in $(echo "${PATH:-}" | tr ':' ' '); do
        case "$dir" in
          ""|*command-guard*) continue ;;
        esac
        candidate="$dir/$name"
        if [ -x "$candidate" ]; then
          echo "$candidate"
          return 0
        fi
      done
      ;;
  esac
  command -v "$name"
}

guard_dispatch() {
  executable="$1"
  shift
  if deny_slow_command "$executable" "$@"; then
    exit 127
  fi
  real_bin="$(resolve_real_binary "$executable")"
  exec "$real_bin" "$@"
}
