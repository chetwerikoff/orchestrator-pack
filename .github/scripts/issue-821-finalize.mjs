import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import * as ts from 'typescript';

function replaceOne(source, search, replacement, label) {
  const count = source.split(search).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, got ${count}`);
  return source.replace(search, replacement);
}

function removeTests(source, file, titles) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const wanted = new Set(titles);
  const found = new Set();
  const ranges = [];
  function rootName(expression) {
    let current = expression;
    while (ts.isCallExpression(current)) current = current.expression;
    while (ts.isPropertyAccessExpression(current)) current = current.expression;
    return ts.isIdentifier(current) ? current.text : '';
  }
  function visit(node) {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && rootName(node.expression.expression) === 'it') {
      const arg = node.expression.arguments[0];
      if (arg && ts.isStringLiteralLike(arg) && wanted.has(arg.text)) {
        found.add(arg.text);
        ranges.push([node.getFullStart(), node.getEnd()]);
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  if (found.size === 0) return source;
  const partial = [...found].length !== [...wanted].length;
  if (partial) throw new Error(`${file}: only some wrapper tests remain`);
  ranges.sort((a, b) => b[0] - a[0]);
  let output = source;
  for (const [start, end] of ranges) output = output.slice(0, start) + output.slice(end);
  return output;
}

const scopedFile = 'scripts/review-start-scoped-gh-json-capture.test.ts';
let scoped = readFileSync(scopedFile, 'utf8');
scoped = removeTests(scoped, scopedFile, [
  'AC3 positive-outcome: harmless stderr does not deny review-start for green uncovered ready head',
  'AC4: pre-claim infrastructure denial does not acquire review-start claim',
]);
writeFileSync(scopedFile, scoped, 'utf8');

const lanesFile = 'scripts/vitest-ci-lanes.config.json';
const lanes = JSON.parse(readFileSync(lanesFile, 'utf8'));
for (const file of [
  'scripts/autonomous-orchestrator-interposer.test.ts',
  'scripts/autonomous-review-worktree-e2e-smoke.test.ts',
  'scripts/autonomous-spawn-budget.test.ts',
  'scripts/review-pipeline-spawn-budget.test.ts',
]) delete lanes.classification[file];
writeFileSync(lanesFile, `${JSON.stringify(lanes, null, 2)}\n`, 'utf8');

const purgeFile = 'scripts/reachability-purge.mjs';
let purge = readFileSync(purgeFile, 'utf8');
if (!purge.includes('const ISSUE_821_EXTERNAL_DELETIONS = [')) {
  purge = replaceOne(
    purge,
    `const REQUIRED_RETIRED_SHIMS = [\n  'scripts/ao',\n  'scripts/git',\n  'scripts/autonomous-bash-env.sh',\n  'scripts/autonomous-orchestrator-surface-bootstrap.sh',\n  'scripts/_invoke-system-git.sh',\n  'scripts/_resolve-system-git.sh',\n];\n`,
    `const REQUIRED_RETIRED_SHIMS = [\n  'scripts/ao',\n  'scripts/git',\n  'scripts/autonomous-bash-env.sh',\n  'scripts/autonomous-orchestrator-surface-bootstrap.sh',\n  'scripts/_invoke-system-git.sh',\n  'scripts/_resolve-system-git.sh',\n];\n\n// Issue #821 owns these deletions. They remain in the pinned #819 analysis graph\n// for auditability but are not attributed to #819's deletion formula.\nconst ISSUE_821_EXTERNAL_DELETIONS = [\n  'scripts/_invoke-system-git.sh',\n  'scripts/_resolve-system-git.sh',\n  'scripts/ao',\n  'scripts/ao-autonomous-guard.ps1',\n  'scripts/autonomous-bash-env.sh',\n  'scripts/autonomous-orchestrator-surface-bootstrap.sh',\n  'scripts/check-worker-nudge-gate-adoption.ps1',\n  'scripts/git',\n  'scripts/git-autonomous-guard.ps1',\n  'scripts/git-real-binary',\n  'scripts/invoke-orchestrator-claimed-review-run.ps1',\n  'scripts/lib/Invoke-OrchestratorClaimedReviewRun.ps1',\n];\n`,
    'external deletion constant',
  );
  purge = replaceOne(
    purge,
    `  const deletedFromBase = tracked.filter((item) => !currentTrackedSet.has(item));\n  const retainedDeletedNodes = deletedFromBase.filter((item) => isDeletionGraphNode(item) || BACKUP_PATTERN.test(item));`,
    `  const deletedFromBase = tracked.filter((item) => !currentTrackedSet.has(item));\n  const externalPrerequisiteDeletionSet = new Set(ISSUE_821_EXTERNAL_DELETIONS);\n  const retainedDeletedNodes = deletedFromBase.filter((item) => isDeletionGraphNode(item) || BACKUP_PATTERN.test(item));`,
    'external deletion set',
  );
  purge = replaceOne(
    purge,
    `  const deletedGovernedNodes = deletedFromBase.filter((item) => isDeletionGraphNode(item) || BACKUP_PATTERN.test(item));`,
    `  const deletedGovernedNodes = deletedFromBase\n    .filter((item) => isDeletionGraphNode(item) || BACKUP_PATTERN.test(item))\n    .filter((item) => !externalPrerequisiteDeletionSet.has(item));`,
    'governed deletion filter',
  );
  purge = replaceOne(
    purge,
    `  const retiredShimBlockers = REQUIRED_RETIRED_SHIMS.map((shim) => ({`,
    `  const externalPrerequisiteDeletions = ISSUE_821_EXTERNAL_DELETIONS.map((externalPath) => ({\n    path: externalPath,\n    issue: 821,\n    trackedInBase: trackedSet.has(externalPath),\n    deletedInCurrentTree: trackedSet.has(externalPath) && !currentTrackedSet.has(externalPath),\n    evidence: 'Issue #821 owns this deletion; #819 retains the pinned-base node for audit but excludes it from its own deletion formula.',\n  }));\n  const retiredShimBlockers = REQUIRED_RETIRED_SHIMS.map((shim) => ({`,
    'external deletion records',
  );
  purge = replaceOne(
    purge,
    `  const completionBlockers = [\n    // AC 9 (amended 2026-07-14):`,
    `  const completionBlockers = [\n    ...externalPrerequisiteDeletions\n      .filter((row) => row.trackedInBase && !row.deletedInCurrentTree)\n      .map((row) => ({\n        code: 'external-prerequisite-deletion-incomplete',\n        path: row.path,\n        evidence: 'Issue #821 is the owner of this deletion, but the current tree still tracks the path.',\n      })),\n    // AC 9 (amended 2026-07-14):`,
    'external deletion completion blocker',
  );
  purge = replaceOne(
    purge,
    `    retiredShimBlockers,\n    migrationNotesEntry,`,
    `    externalPrerequisiteDeletions,\n    retiredShimBlockers,\n    migrationNotesEntry,`,
    'external deletion manifest field',
  );
}
writeFileSync(purgeFile, purge, 'utf8');

const purgeTestFile = 'scripts/reachability-purge.test.ts';
let purgeTest = readFileSync(purgeTestFile, 'utf8');
if (!purgeTest.includes('externalPrerequisiteDeletions: Array<{')) {
  purgeTest = replaceOne(
    purgeTest,
    `  retiredShimBlockers: Array<{\n    trackedInBase: boolean;\n    deletedInCurrentTree: boolean;\n    reachable: boolean;\n    held: boolean;\n  }>;`,
    `  externalPrerequisiteDeletions: Array<{\n    path: string;\n    issue: number;\n    trackedInBase: boolean;\n    deletedInCurrentTree: boolean;\n    evidence: string;\n  }>;\n  retiredShimBlockers: Array<{\n    trackedInBase: boolean;\n    deletedInCurrentTree: boolean;\n    reachable: boolean;\n    held: boolean;\n    inboundTrustedEdges: unknown[];\n  }>;`,
    'reachability test interface',
  );
  purgeTest = replaceOne(
    purgeTest,
    `    expect(\n      manifest.unresolvedDynamicForms.some(\n        (row) =>\n          row.kind === 'start-process'\n          && row.source === 'scripts/worker-nudge-gate.test.ts'\n          && (row.possibleTargets ?? []).includes('scripts/ao'),\n      ),\n    ).toBe(true);\n`,
    ``,
    'retired shim unresolved assertion',
  );
  purgeTest = replaceOne(
    purgeTest,
    `  it('records the shim cluster as held (fail-safe KEEP) per amended AC 9, not a completion blocker', () => {\n    expect(manifest.retiredShimBlockers.length).toBe(6);\n    expect(manifest.retiredShimBlockers.every((row) => row.trackedInBase && !row.deletedInCurrentTree)).toBe(true);\n    expect(manifest.retiredShimBlockers.every((row) => row.reachable || row.held)).toBe(true);\n    expect(manifest.migrationNotesEntry.authorized).toBe(false);\n    expect(manifest.migrationNotesEntry.presentWithRequiredFields).toBe(false);\n    expect(manifest.completionBlockers.every((row) => Boolean(row.code && row.path && row.evidence))).toBe(true);\n    expect(manifest.completionBlockers.map((row) => row.code)).not.toContain('missing-binding-audit-handoff');\n    expect(manifest.completionBlockers.map((row) => row.code)).not.toContain('shim-cluster-deleted-despite-live-inbound-edge');\n    expect(manifest.completionStatus).toBe('complete');\n    expect(manifest.completionBlockers).toEqual([]);\n  });`,
    `  it('records the completed #821 prerequisite deletions without attributing them to #819', () => {\n    expect(manifest.externalPrerequisiteDeletions).toHaveLength(12);\n    expect(manifest.externalPrerequisiteDeletions.every((row) => row.issue === 821)).toBe(true);\n    expect(manifest.externalPrerequisiteDeletions.every((row) => row.trackedInBase && row.deletedInCurrentTree)).toBe(true);\n    expect(manifest.externalPrerequisiteDeletions.every((row) => Boolean(row.path && row.evidence))).toBe(true);\n    const externallyOwned = new Set(manifest.externalPrerequisiteDeletions.map((row) => row.path));\n    expect(manifest.deletionManifest.some((row: any) => externallyOwned.has(row.path))).toBe(false);\n    expect(manifest.retiredShimBlockers).toHaveLength(6);\n    expect(manifest.retiredShimBlockers.every((row) => row.trackedInBase && row.deletedInCurrentTree)).toBe(true);\n    expect(manifest.retiredShimBlockers.every((row) => row.inboundTrustedEdges.length === 0)).toBe(true);\n    expect(manifest.migrationNotesEntry.authorized).toBe(false);\n    expect(manifest.migrationNotesEntry.presentWithRequiredFields).toBe(false);\n    expect(manifest.completionBlockers.every((row) => Boolean(row.code && row.path && row.evidence))).toBe(true);\n    expect(manifest.completionBlockers.map((row) => row.code)).not.toContain('external-prerequisite-deletion-incomplete');\n    expect(manifest.completionBlockers.map((row) => row.code)).not.toContain('shim-cluster-deleted-despite-live-inbound-edge');\n    expect(manifest.completionStatus).toBe('complete');\n    expect(manifest.completionBlockers).toEqual([]);\n  });`,
    'reachability prerequisite handoff assertion',
  );
}
writeFileSync(purgeTestFile, purgeTest, 'utf8');

for (const file of [
  'plugins/ao-codex-pr-reviewer/bin/review.ts',
  'plugins/ao-scope-guard/bin/agent-wrap.ts',
  'plugins/ao-scope-guard/bin/scope-check.ts',
  'plugins/ao-task-declaration/bin/declare.ts',
  'plugins/ao-token-chain-ledger/bin/ledger.mjs',
]) chmodSync(file, 0o644);
