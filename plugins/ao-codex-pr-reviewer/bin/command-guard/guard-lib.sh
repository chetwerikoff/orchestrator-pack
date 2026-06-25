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
    --|--coverage|--watch|--run|--passWithNoTests|--silent|--bail|--changed|--standalone|--merge-reports|-h|--help|--version|--yes|-y|--no-install|--no) return 1 ;;
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
      --)
        [ $# -gt 0 ] && return 0
        ;;
      -*)
        case "$arg" in
          *=*) ;;
          *)
            if option_consumes_value "$arg"; then
              [ $# -gt 0 ] && shift
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

scan_for_vitest_token() {
  while [ $# -gt 0 ]; do
    if [ "$1" = "vitest" ]; then
      return 0
    fi
    shift
  done
  return 1
}

vitest_tail_has_positional_selector() {
  executable="$1"
  shift
  case "$executable" in
    vitest)
      if [ "${1:-}" = "run" ]; then
        shift
      fi
      has_positional_selector "$@"
      return $?
      ;;
    npx|pnpm|yarn)
      while [ $# -gt 0 ]; do
        if [ "$1" = "vitest" ]; then
          shift
          if [ "${1:-}" = "run" ]; then
            shift
          fi
          has_positional_selector "$@"
          return $?
        fi
        case "$1" in
          exec|dlx|run) shift ;;
          --)
            shift
            has_positional_selector "$@"
            return $?
            ;;
          *=*) shift ;;
          -*)
            if option_consumes_value "$1"; then
              shift
              [ $# -gt 0 ] && shift
            else
              shift
            fi
            ;;
          *) shift ;;
        esac
      done
      return 1
      ;;
  esac
  return 1
}

has_targeted_test_selector() {
  executable="$1"
  shift
  case "$executable" in
    vitest|npx|pnpm|yarn)
      vitest_tail_has_positional_selector "$executable" "$@"
      return $?
      ;;
  esac
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
    vitest|npx|pnpm|yarn)
      if [ "$executable" != "vitest" ]; then
        scan_for_vitest_token "$@" || return 1
      fi
      if vitest_tail_has_positional_selector "$executable" "$@"; then
        return 1
      fi
      return 0
      ;;
  esac
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
  if has_targeted_test_selector "$executable" "$@"; then
    echo cheap_targeted
    return
  fi
  if is_bare_vitest_full_suite "$executable" "$@"; then
    echo full_suite
    return
  fi
  case "$joined" in
    *"npm test"*|*"npm run test"*|*"vitest run"*|*"pnpm test"*|*"yarn test"*|*"yarn run test"*)
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

is_executable_candidate() {
  [ -n "${1:-}" ] && [ -f "$1" ] && [ -x "$1" ]
}

probe_real_binary_in_dir() {
  dir="$1"
  name="$2"
  for ext in '' .exe .cmd .bat; do
    candidate="$dir/$name$ext"
    if is_executable_candidate "$candidate"; then
      echo "$candidate"
      return 0
    fi
  done
  if [ -n "${PATHEXT:-}" ]; then
    oldifs=$IFS
    IFS=';'
    for pathext in $PATHEXT; do
      IFS=$oldifs
      case "$pathext" in
        .*) candidate="$dir/$name$pathext" ;;
        *) candidate="$dir/$name.$pathext" ;;
      esac
      if is_executable_candidate "$candidate"; then
        echo "$candidate"
        return 0
      fi
    done
    IFS=$oldifs
  fi
  return 1
}

path_without_command_guard() {
  path_remain="${PATH:-}"
  filtered=""
  while [ -n "$path_remain" ]; do
    case "$path_remain" in
      *:*) dir="${path_remain%%:*}"; path_remain="${path_remain#*:}" ;;
      *) dir="$path_remain"; path_remain="" ;;
    esac
    case "$dir" in
      ""|*command-guard*) continue ;;
    esac
    if [ -z "$filtered" ]; then
      filtered="$dir"
    else
      filtered="$filtered:$dir"
    fi
  done
  printf '%s' "$filtered"
}

resolve_real_binary() {
  name="$1"
  path_remain="${PATH:-}"
  while [ -n "$path_remain" ]; do
    case "$path_remain" in
      *:*) dir="${path_remain%%:*}"; path_remain="${path_remain#*:}" ;;
      *) dir="$path_remain"; path_remain="" ;;
    esac
    case "$dir" in
      ""|*command-guard*) continue ;;
    esac
    case "$name" in
      npm|npx|pwsh|yarn|pnpm|vitest)
        resolved="$(probe_real_binary_in_dir "$dir" "$name" || true)"
        if [ -n "$resolved" ]; then
          echo "$resolved"
          return 0
        fi
        ;;
    esac
  done
  guard_free_path="$(path_without_command_guard)"
  if [ -n "$guard_free_path" ]; then
    PATH="$guard_free_path" resolved="$(command -v "$name" 2>/dev/null || true)"
    case "$resolved" in
      ""|*command-guard*) ;;
      *)
        if is_executable_candidate "$resolved"; then
          echo "$resolved"
          return 0
        fi
        resolved="$(probe_real_binary_in_dir "$(dirname "$resolved")" "$name" || true)"
        if [ -n "$resolved" ]; then
          echo "$resolved"
          return 0
        fi
        ;;
    esac
  fi
  return 1
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
