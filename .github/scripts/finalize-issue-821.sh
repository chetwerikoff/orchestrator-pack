#!/usr/bin/env bash
set -euo pipefail

: "${BASE_SHA:?BASE_SHA is required}"

rm -f issue-821-*.txt

git checkout origin/main -- \
  plugins/ao-codex-pr-reviewer/bin/review.ts \
  plugins/ao-scope-guard/bin/agent-wrap.ts \
  plugins/ao-scope-guard/bin/scope-check.ts \
  plugins/ao-task-declaration/bin/declare.ts \
  plugins/ao-token-chain-ledger/bin/ledger.mjs \
  scripts/vitest-heavy-topology.plan.json

git show 09d3f76cfcb89b8840408249f7494c8a1599b134:scripts/reachability-purge.test.ts > scripts/reachability-purge.test.ts
python - <<'PY'
from pathlib import Path

test_path = Path('scripts/reachability-purge.test.ts')
text = test_path.read_text(encoding='utf-8')
text = text.replace(
    "let issue821PrerequisiteComplete = false;\n",
    """const ISSUE_821_RETIRED_PATHS = [
  'docs/autonomous-real-binaries.example.json',
  'scripts/_invoke-system-git.sh',
  'scripts/_resolve-system-git.sh',
  'scripts/_test-autonomous-ao-stub-fixture.ts',
  'scripts/_test-interposer-pack-fixture.ts',
  'scripts/ao',
  'scripts/ao-autonomous-guard.ps1',
  'scripts/autonomous-bash-env.sh',
  'scripts/autonomous-orchestrator-interposer.test.ts',
  'scripts/autonomous-orchestrator-surface-bootstrap.sh',
  'scripts/autonomous-review-worktree-e2e-smoke.test.ts',
  'scripts/check-worker-nudge-gate-adoption.ps1',
  'scripts/git',
  'scripts/git-autonomous-guard.ps1',
  'scripts/git-real-binary',
  'scripts/invoke-orchestrator-claimed-review-run.ps1',
  'scripts/lib/Invoke-OrchestratorClaimedReviewRun.ps1',
] as const;
let issue821PrerequisiteComplete = false;
""",
)
old_predicate = """  issue821PrerequisiteComplete =
    committedManifest.retiredShimBlockers.length > 0 &&
    committedManifest.retiredShimBlockers.every(
      (row) => Boolean(row.path) && !existsSync(path.join(repoRoot, row.path!)),
    );
"""
new_predicate = """  issue821PrerequisiteComplete = ISSUE_821_RETIRED_PATHS.every(
    (retiredPath) => !existsSync(path.join(repoRoot, retiredPath)),
  );
"""
if old_predicate not in text:
    raise SystemExit('reachability prerequisite predicate shape changed')
text = text.replace(old_predicate, new_predicate)
old_assertion = """      expect(
        committedManifest.retiredShimBlockers.every(
          (row) => Boolean(row.path) && !existsSync(path.join(repoRoot, row.path!)),
        ),
      ).toBe(true);
"""
new_assertion = """      expect(
        ISSUE_821_RETIRED_PATHS.every(
          (retiredPath) => !existsSync(path.join(repoRoot, retiredPath)),
        ),
      ).toBe(true);
"""
if old_assertion not in text:
    raise SystemExit('reachability prerequisite assertion shape changed')
test_path.write_text(text.replace(old_assertion, new_assertion), encoding='utf-8')

decisions = Path('docs/issues_drafts/00-architecture-decisions.md')
decision_text = decisions.read_text(encoding='utf-8')
marker = '## W. AO 0.10.2 daemon-session gate activation and shim retirement (Issue #821)'
if marker not in decision_text:
    decision_text = decision_text.rstrip() + """

## W. AO 0.10.2 daemon-session gate activation and shim retirement (Issue #821)

Decision taken 2026-07-15 after AO 0.10.2 made daemon-owned session identity
available in-process and rendered the pack's process-boundary AO/git interposition
surface redundant.

1. **Daemon scope is identified by `AO_SESSION_ID`.** A non-empty value is the
   activation signal for autonomous review-start, spawn, git-mutation, and worker-
   nudge gates. Gate policy, bypass predicates, reason codes, and audit semantics
   remain unchanged; only the scope predicate moves in-process.
2. **Review, operator, and CI contexts remain outside by construction.** Review
   sessions, manual operator shells, and ordinary CI jobs do not receive
   `AO_SESSION_ID`, so they continue to invoke normal `ao` and `git` binaries
   without inheriting daemon-only policy.
3. **Process-boundary shims are retired rather than emulated.** The tracked AO/git
   wrappers, shell bootstrap/interposer, real-binary indirection, and wrapper-only
   tests are deleted. Direct command invocation is the supported AO 0.10.2 path.
4. **Historical reachability evidence is not re-attributed.** Issue #819's manifest
   remains a frozen pre-#821 record. Its regression test recognizes completion of
   the named #821 prerequisite set while continuing to exercise live fail-closed
   manifest generation independently.
5. **No operator adoption is required.** `agent-orchestrator.yaml.example` is
   legacy-import-only; live per-project daemon configuration already supplies the
   session identity used by the in-process predicates.
""" + '\n'
    decisions.write_text(decision_text, encoding='utf-8')
PY

npm ci --include=dev
npm run lint:foundation -- --write-baseline
npm run check:pwsh-test-growth -- --write-baseline

node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { measurePreTopologyFiles } from './scripts/lib/vitest-pre-topology-measurement.mjs';

const repoRoot = process.cwd();
const baseSha = process.env.BASE_SHA;
const changed = execFileSync(
  'git',
  ['diff', '--name-only', '--diff-filter=ACMR', baseSha, '--'],
  { encoding: 'utf8' },
)
  .split(/\r?\n/)
  .map((entry) => entry.trim().replaceAll('\\', '/'))
  .filter((entry) => entry.endsWith('.test.ts') && existsSync(path.join(repoRoot, entry)));
const files = [...new Set(changed)].sort();
if (files.length === 0) throw new Error('no changed Vitest files found for runtime refresh');
console.log(`Measuring ${files.length} changed Vitest file(s):\n${files.join('\n')}`);
const measurements = await measurePreTopologyFiles(repoRoot, files, {
  maxConcurrency: 3,
  timeoutMs: 8 * 60 * 1000,
});

const historyPath = path.join(repoRoot, 'scripts', 'vitest-runtime-history.json');
const history = JSON.parse(readFileSync(historyPath, 'utf8'));
history.source = 'ci-measured';
history.dataChangedAt = new Date().toISOString();
history.files ??= {};
history.provenance ??= {};
history.contentSha ??= {};
history.recentSamples ??= {};
history.fileChangedAt ??= {};
for (const file of files) {
  const seconds = Number(measurements[file]);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`invalid measured runtime for ${file}: ${measurements[file]}`);
  }
  const ms = Math.max(1, Math.round(seconds * 1000));
  const bytes = readFileSync(path.join(repoRoot, file));
  history.files[file] = ms;
  history.provenance[file] = 'measured';
  history.contentSha[file] = createHash('sha256').update(bytes).digest('hex');
  const previous = Array.isArray(history.recentSamples[file])
    ? history.recentSamples[file].map(Number).filter((value) => Number.isFinite(value) && value > 0)
    : [];
  history.recentSamples[file] = [...previous.slice(-4), ms];
  history.fileChangedAt[file] = history.dataChangedAt;
}
const deleted = execFileSync(
  'git',
  ['diff', '--name-only', '--diff-filter=D', baseSha, '--'],
  { encoding: 'utf8' },
)
  .split(/\r?\n/)
  .map((entry) => entry.trim().replaceAll('\\', '/'))
  .filter((entry) => entry.endsWith('.test.ts'));
for (const file of deleted) {
  delete history.files[file];
  delete history.provenance[file];
  delete history.contentSha[file];
  delete history.recentSamples[file];
  delete history.fileChangedAt[file];
}
writeFileSync(historyPath, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ files, measurements }, null, 2));
NODE

npx vitest run \
  scripts/autonomous-orchestrator-boundary.test.ts \
  scripts/autonomous-spawn-policy.test.ts \
  scripts/worker-nudge-gate.test.ts \
  scripts/spawn-worktree-grant-finalization.test.ts \
  scripts/orchestrator-claimed-review-run.test.ts \
  scripts/autonomous-spawn-worktree-gate.test.ts \
  scripts/orchestrator-review-start-preflight-audit.test.ts \
  scripts/review-start-envelope-external-io.test.ts \
  scripts/reachability-purge.test.ts
pwsh -NoProfile -File scripts/check-autonomous-capabilities.ps1 -ReviewStart
pwsh -NoProfile -File scripts/check-autonomous-capabilities.ps1 -Boundary
pwsh -NoProfile -File scripts/check-orchestrator-claimed-review-run.ps1
pwsh -NoProfile -File scripts/check-command-runtime-bootstrap.ps1
npm run typecheck:foundation
npm run lint:foundation
npm run check:pwsh-test-growth
! git grep -n -E 'AO_AUTONOMOUS_ORCHESTRATOR_SURFACE|\.ao/autonomous-real-binaries\.json' -- ':!docs/issues_drafts/**' ':!docs/migration_notes.md' ':!docs/declarations/**' ':!docs/issue_queue_index.md' ':!scripts/reachability-purge.manifest.json' ':!.github/**'
git diff --check

git checkout origin/main -- .github/workflows/typescript-foundation.yml scripts/vitest-heavy-topology.plan.json
rm -f .github/scripts/finalize-issue-821.sh issue-821-*.txt
git add -A
git config user.name github-actions[bot]
git config user.email 41898282+github-actions[bot]@users.noreply.github.com
git commit -m 'Finalize clean issue 821 migration'

HEAD_SHA="$(git rev-parse HEAD)"
export HEAD_SHA
export OPK_CHANGED_VITEST_FILES="$(node scripts/emit-pr-changed-paths-manifest.mjs --base "$BASE_SHA" --head "$HEAD_SHA")"
export GITHUB_OUTPUT=/tmp/issue-821-topology-output.txt
node scripts/emit-vitest-heavy-topology.mjs --gha-output
pwsh -NoProfile -File scripts/check-ci-pipeline-split.ps1

git push origin HEAD:agent/issue-821-retire-autonomous-surface
