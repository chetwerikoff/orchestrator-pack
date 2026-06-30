#!/usr/bin/env bash
# Stub gh for prInfoFromView REST integration tests (Issue #530).
# Fails GraphQL (quota exhaustion simulation); serves pull JSON via gh api only.
set -euo pipefail

joined="$*"
case "$joined" in
  *"api graphql"*)
    echo "GraphQL API rate limit exceeded; remaining: 0" >&2
    exit 1
    ;;
  *"api repos/"*"/pulls/"*|*"api repos/"*"/pulls/"*)
    if [[ -n "${GH_PR_INFO_FIXTURE_PULL_JSON:-}" ]]; then
      cat "$GH_PR_INFO_FIXTURE_PULL_JSON"
    else
      echo '{"number":530,"title":"Test PR","html_url":"https://github.com/o/r/pull/530","head":{"ref":"feat/530","sha":"abc"},"base":{"ref":"main"},"draft":false,"state":"open"}'
    fi
    ;;
  *"api repos/"*"/pulls?state=open"*)
    if [[ -n "${GH_PR_INFO_FIXTURE_LIST_JSON:-}" ]]; then
      cat "$GH_PR_INFO_FIXTURE_LIST_JSON"
    else
      echo '[{"number":530,"title":"Test PR","html_url":"https://github.com/o/r/pull/530","head":{"ref":"feat/530","sha":"abc"},"base":{"ref":"main"},"draft":false,"state":"open"}]'
    fi
    ;;
  *)
    echo "fake-gh-pr-info: unhandled argv: $joined" >&2
    exit 1
    ;;
esac
