#!/usr/bin/env bash
set -euo pipefail

audit_file="${GH_FLEET_TEST_AUDIT_FILE:-}"
if [[ -n "$audit_file" ]]; then
  mkdir -p "$(dirname "$audit_file")"
  printf '%s\n' "$*" >>"$audit_file"
fi

joined="$*"
case "$joined" in
  *"pr list"*)
    if [[ -n "${GH_FLEET_TEST_LIST_JSON:-}" ]]; then
      cat "$GH_FLEET_TEST_LIST_JSON"
    else
      echo '[{"number":1,"headRefOid":"sha1111111111111111111111111111111111111111","baseRefName":"main"},{"number":2,"headRefOid":"sha2222222222222222222222222222222222222222","baseRefName":"main"}]'
    fi
  ;;
  *"repo view"*)
  if [[ "$joined" == *"-q .nameWithOwner"* ]]; then
    echo 'test-owner/test-repo'
  else
    echo '{"nameWithOwner":"test-owner/test-repo"}'
  fi
  ;;
  *"commits/sha1111111111111111111111111111111111111111"*)
  echo '2024-06-01T12:00:00Z'
  ;;
  *"commits/sha2222222222222222222222222222222222222222"*)
  echo '2024-06-02T12:00:00Z'
  ;;
  *"commits/"*)
  echo '2024-06-03T12:00:00Z'
  ;;
  *)
  echo "fake-gh: unhandled argv: $joined" >&2
  exit 1
  ;;
esac
