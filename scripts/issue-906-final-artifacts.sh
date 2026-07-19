#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR="${RUNNER_TEMP:?}/issue-906-final-artifacts"
mkdir -p "$ARTIFACT_DIR/docs/declarations" "$ARTIFACT_DIR/scripts/estate-cut"

git fetch origin main
rm -f .github/workflows/issue-906-scope-finalize.yml
rm -f scripts/issue-906-final-artifacts.sh
git checkout origin/main -- .github/workflows/typescript-foundation.yml \
  plugins/ao-codex-pr-reviewer/bin/review.ts \
  plugins/ao-scope-guard/bin/agent-wrap.ts \
  plugins/ao-scope-guard/bin/scope-check.ts \
  plugins/ao-task-declaration/bin/declare.ts \
  plugins/ao-token-chain-ledger/bin/ledger.mjs

gh api "repos/${GITHUB_REPOSITORY}/issues/906" --jq .body > "$ARTIFACT_DIR/issue-906-body.md"
ISSUE_BODY="$ARTIFACT_DIR/issue-906-body.md" python - <<'PY'
from pathlib import Path
import os
import re

body = Path(os.environ['ISSUE_BODY']).read_text()
match = re.search(r'```allowed-roots\n(.*?)\n```', body, flags=re.S)
if not match:
    raise SystemExit('issue-906: authoritative allowed-roots block is missing')
rows = {line.strip() for line in match.group(1).splitlines() if line.strip()}
missing = {'package.json', 'vitest.config.ts'} - rows
if missing:
    raise SystemExit(f"issue-906: authoritative allowed-roots block is missing: {', '.join(sorted(missing))}")
PY

node --experimental-strip-types scripts/estate-cut/manifest-generator.mjs --write --check
ISSUE_BODY="$ARTIFACT_DIR/issue-906-body.md" node --experimental-strip-types --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseIssueBody } from './plugins/_shared/lib/issue_parser.ts';

const baseCommitSha = JSON.parse(readFileSync('scripts/estate-cut/issue-906.config.json', 'utf8')).baseCommitSha;
const constraints = parseIssueBody(readFileSync(process.env.ISSUE_BODY, 'utf8'));
const runGit = (args) => execFileSync('git', args, { encoding: 'utf8' });
const splitZero = (value) => value.split('\0').filter(Boolean).map((value) => value.replaceAll('\\', '/'));
const changed = splitZero(runGit(['diff', '--name-only', '-z', 'origin/main', '--']));
const untracked = splitZero(runGit(['ls-files', '--others', '--exclude-standard', '-z']));
const control = new Set(['docs/declarations/906.chatgpt-estate-cut.json']);
const declaredPaths = [...new Set([...changed, ...untracked])].filter((path) => !control.has(path)).sort();
const payload = {
  declared_paths: declaredPaths,
  declared_globs: [],
  issue_denylist: [...constraints.denylist].sort(),
};
if (constraints.allowed_roots !== undefined) payload.issue_allowed_roots = [...constraints.allowed_roots].sort();
const activeScopeHash = `sha256:${createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')}`;
const snapshot = JSON.parse(readFileSync('docs/declarations/906.chatgpt-estate-cut.json', 'utf8'));
snapshot.created_at = new Date().toISOString();
snapshot.baseline = { commit_sha: baseCommitSha, worktree_dirty: false, active_scope_hash: activeScopeHash };
snapshot.declared_paths = declaredPaths;
snapshot.declared_globs = [];
snapshot.amendments = [];
writeFileSync('docs/declarations/906.chatgpt-estate-cut.json', `${JSON.stringify(snapshot, null, 2)}\n`);
NODE
node --experimental-strip-types scripts/estate-cut/manifest-generator.mjs --write --check

npm run estate-cut:check
npm run typecheck:foundation
npm run lint:foundation
npm run test:issue-906
pwsh -NoProfile -File ./scripts/check-reusable.ps1
git diff --check

test ! -e .github/workflows/issue-906-scope-finalize.yml
test ! -e scripts/issue-906-final-artifacts.sh
git diff --quiet origin/main -- .github/workflows/typescript-foundation.yml \
  plugins/ao-codex-pr-reviewer/bin/review.ts \
  plugins/ao-scope-guard/bin/agent-wrap.ts \
  plugins/ao-scope-guard/bin/scope-check.ts \
  plugins/ao-task-declaration/bin/declare.ts \
  plugins/ao-token-chain-ledger/bin/ledger.mjs

cp scripts/estate-cut/issue-906.manifest.json "$ARTIFACT_DIR/scripts/estate-cut/issue-906.manifest.json"
cp docs/declarations/906.chatgpt-estate-cut.json "$ARTIFACT_DIR/docs/declarations/906.chatgpt-estate-cut.json"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A
git commit -m "fix: align issue 906 declaration scope"
git push origin HEAD:agent/issue-906-estate-cut
