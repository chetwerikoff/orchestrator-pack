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

has_targeted_test_selector() {
  after_npm_test_separator=0
  after_vitest_run=0
  prev=""
  for arg in "$@"; do
    if [ "$after_npm_test_separator" -eq 1 ]; then
      case "$arg" in
        -*) ;;
        *) return 0 ;;
      esac
      continue
    fi
    if [ "$after_vitest_run" -eq 1 ]; then
      case "$arg" in
        -*) ;;
        *) return 0 ;;
      esac
      continue
    fi
    if [ "$arg" = "--" ] && [ "$prev" = "test" ]; then
      after_npm_test_separator=1
      prev=""
      continue
    fi
    if [ "$arg" = "run" ] && [ "$prev" = "vitest" ]; then
      after_vitest_run=1
      prev=""
      continue
    fi
    prev="$arg"
  done
  return 1
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
  if has_targeted_test_selector "$@"; then
    echo cheap_targeted
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
    npm|npx|pwsh)
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
