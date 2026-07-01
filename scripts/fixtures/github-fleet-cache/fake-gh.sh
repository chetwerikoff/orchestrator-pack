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
    if [[ "$joined" == *"--head"* ]]; then
      if [[ -n "${GH_FLEET_TEST_HEAD_BRANCH_NO_PR:-}" ]]; then
        echo '[]'
      elif [[ "$joined" == *"feat/no-pr-branch"* ]]; then
        echo '[]'
      else
        echo '[{"number":1}]'
      fi
    elif [[ -n "${GH_FLEET_TEST_LIST_JSON:-}" ]]; then
      cat "$GH_FLEET_TEST_LIST_JSON"
    else
      echo '[{"number":1,"headRefOid":"sha1111111111111111111111111111111111111111","baseRefName":"main","headRefName":"feat/pr-1"},{"number":2,"headRefOid":"sha2222222222222222222222222222222222222222","baseRefName":"main","headRefName":"feat/pr-2"}]'
    fi
    ;;
  *"pr view"*)
    if [[ "$joined" == *" 1"* ]] || [[ "$joined" == *" 1 --"* ]]; then
      if [[ -n "${GH_FLEET_TEST_PR1_VIEW_JSON:-}" ]]; then
        cat "$GH_FLEET_TEST_PR1_VIEW_JSON"
      else
        echo '{"number":1,"headRefOid":"sha1111111111111111111111111111111111111111","baseRefName":"main","headRefName":"feat/pr-1","state":"OPEN","isDraft":false,"mergeable":"MERGEABLE"}'
      fi
    elif [[ "$joined" == *" 2"* ]] || [[ "$joined" == *" 2 --"* ]]; then
      echo '{"number":2,"headRefOid":"sha2222222222222222222222222222222222222222","baseRefName":"main","headRefName":"feat/pr-2","state":"OPEN","isDraft":false,"mergeable":"MERGEABLE"}'
    else
      echo "fake-gh: unhandled pr view argv: $joined" >&2
      exit 1
    fi
    ;;
  *"pr checks"*)
    if [[ "$joined" == *" 1"* ]] || [[ "$joined" == *" 1 --"* ]]; then
      echo '[{"name":"Verify orchestrator-pack structure","state":"SUCCESS","bucket":"pass","workflow":"scope-guard"}]'
    elif [[ "$joined" == *" 2"* ]] || [[ "$joined" == *" 2 --"* ]]; then
      echo '[{"name":"Verify orchestrator-pack structure","state":"PENDING","bucket":"pending","workflow":"scope-guard"}]'
    else
      echo '[]'
    fi
    ;;
  *"branches/"*"protection"*)
    echo '{"required_status_checks":{"contexts":["Verify orchestrator-pack structure"],"checks":[]}}'
    ;;
  *"pulls/"*"/reviews"*)
    echo '2'
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
