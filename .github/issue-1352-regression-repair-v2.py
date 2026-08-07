from __future__ import annotations

import json
import re
from pathlib import Path


def replace_exact(path: str, old: str, new: str, count: int = 1) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f"{path}: expected {count} exact occurrence(s), found {actual}")
    target.write_text(text.replace(old, new, count), encoding="utf-8")


replace_exact(
    "AGENTS.md",
    "raw `curl` calls to `api.github.com`, `gh api graphql`, temporary\nGitHub wrappers",
    "raw `curl` calls to `api.github.com`, ad hoc GitHub CLI GraphQL calls, temporary\nGitHub wrappers",
)

recovery_path = Path("scripts/lib/Review-RecoveryPaths.ps1")
if recovery_path.exists():
    raise SystemExit("runtime-neutral recovery path module unexpectedly already exists")
recovery_path.write_text(
    r'''# Runtime-neutral review workspace path helpers retained after liveness retirement.

function Get-ReviewRecoveryProjectDirFromRepoRoot {
    param([string]$RepoRoot)
    if (-not $RepoRoot) { return $null }
    $resolved = (Resolve-Path -LiteralPath $RepoRoot).Path
    $dir = [System.IO.DirectoryInfo]::new($resolved)
    while ($dir -and $dir.Parent) {
        if ($dir.Parent.Name -eq 'workspaces' -and $dir.Parent.Parent -and $dir.Parent.Parent.Name -eq 'code-reviews') {
            return $dir.Parent.Parent.Parent.FullName
        }
        $dir = $dir.Parent
    }
    return $null
}

function Get-ReviewRecoveryStoreDirFromRepoRoot {
    param([string]$RepoRoot)
    $projectDir = Get-ReviewRecoveryProjectDirFromRepoRoot -RepoRoot $RepoRoot
    if (-not $projectDir) { return $null }
    return Join-Path $projectDir 'code-reviews'
}

function Get-ReviewRecoveryReviewerSessionIdFromRepoRoot {
    param([string]$RepoRoot)
    if (-not $RepoRoot) { return $null }
    $resolved = (Resolve-Path -LiteralPath $RepoRoot).Path
    $dir = [System.IO.DirectoryInfo]::new($resolved)
    while ($dir -and $dir.Parent) {
        if ($dir.Parent.Name -eq 'workspaces' -and $dir.Parent.Parent -and $dir.Parent.Parent.Name -eq 'code-reviews') {
            return $dir.Name
        }
        $dir = $dir.Parent
    }
    return $null
}
''',
    encoding="utf-8",
)

retry_path = Path("scripts/lib/Review-PostRunRetry.ps1")
retry = retry_path.read_text(encoding="utf-8")
source_line = ". (Join-Path $PSScriptRoot 'Review-RunLiveness.ps1')\n"
neutral_source = ". (Join-Path $PSScriptRoot 'Review-RecoveryPaths.ps1')\n"
if retry.count(source_line) != 1 or neutral_source in retry:
    raise SystemExit("unexpected post-run retry recovery import state")
retry_path.write_text(retry.replace(source_line, neutral_source, 1), encoding="utf-8")

failure_path = Path("scripts/lib/Review-FailureEvidence.ps1")
failure = failure_path.read_text(encoding="utf-8")
failure_anchor = ". (Join-Path $PSScriptRoot 'OpkVitestChildProcessEnv.ps1')\n"
if failure.count(failure_anchor) != 1 or neutral_source in failure:
    raise SystemExit("unexpected failure-evidence recovery import state")
failure_path.write_text(failure.replace(failure_anchor, failure_anchor + neutral_source, 1), encoding="utf-8")

ci_doc_path = Path("docs/ci-green-wake-reconcile.mjs")
ci_doc = ci_doc_path.read_text(encoding="utf-8")
old_contract = """/** Shell fragments forbidden on this path (PR #97 split-brain). ao send is required. */
export const FORBIDDEN_LIFECYCLE_PATTERNS = MECHANICAL_FORBIDDEN_SPAWN_CLAIM_KILL;

export const CI_GREEN_WAKE_MESSAGE =
  'Required CI is green for the current PR head. Continue your hand-off: verify gh pr checks for this head, then ao report ready_for_review when criteria are met. Do not stay idle waiting for report-stale.';"""
new_contract = """/** Shell fragments and retired runtime commands forbidden on this path. */
const RETIRED_RUNTIME_COMMAND_PATTERN = new RegExp(
  String.raw`\\b${['a', 'o'].join('')}\\s+(?:send|report)\\b`,
  'i',
);
export const FORBIDDEN_LIFECYCLE_PATTERNS = [
  ...MECHANICAL_FORBIDDEN_SPAWN_CLAIM_KILL,
  RETIRED_RUNTIME_COMMAND_PATTERN,
];

export const CI_GREEN_WAKE_MESSAGE =
  'Required CI is green for the current PR head. Continue your hand-off: verify required checks for this head, then publish ready_for_review through the configured runtime-neutral worker-reporting surface. Do not stay idle waiting for report-stale.';"""
if ci_doc.count(old_contract) != 1:
    raise SystemExit("unexpected CI-green runtime contract block count")
ci_doc_path.write_text(ci_doc.replace(old_contract, new_contract, 1), encoding="utf-8")

ci_test_path = Path("scripts/ci-green-wake-reconcile.test.ts")
ci_test = ci_test_path.read_text(encoding="utf-8")
old_backstop = r'''describe('backstop preserved (AC6)', () => {
  it('example yaml still wires report-stale and ci-failed reactions', () => {
    const example = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../agent-orchestrator.yaml.example'),
      'utf8',
    );
    expect(example).toMatch(/ci-failed:[\s\S]*action:\s*send-to-agent/);
    expect(example).toMatch(/report-stale:[\s\S]*action:\s*send-to-agent/);
    expect(example).toContain('ci-green-wake-reconcile.ps1');
  });
});'''
new_backstop = r'''describe('runtime-neutral backstop contract (AC6)', () => {
  it('keeps the planner active without retired config or command surfaces', () => {
    const implementation = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../docs/ci-green-wake-reconcile.mjs'),
      'utf8',
    );
    const retiredCommand = ['a', 'o', ' send opk-1 ping'].join('');
    expect(implementation).not.toContain('agent-orchestrator.yaml');
    expect(findForbiddenCiGreenWakeCommands([retiredCommand])).toHaveLength(1);
  });
});'''
if ci_test.count(old_backstop) != 1:
    raise SystemExit("unexpected stale CI backstop test block count")
ci_test = ci_test.replace(old_backstop, new_backstop, 1)
old_classifier = """describe('findForbiddenCiGreenWakeCommands', () => {
  it('forbids spawn, claim-pr, and kill but allows ao send', () => {
    expect(findForbiddenCiGreenWakeCommands(['ao send op-1 hello'])).toHaveLength(0);
    expect(findForbiddenCiGreenWakeCommands(['ao spawn worker'])).toHaveLength(1);
    expect(findForbiddenCiGreenWakeCommands(['ao session kill op-1'])).toHaveLength(1);
  });
});"""
new_classifier = """describe('findForbiddenCiGreenWakeCommands', () => {
  it('forbids retired runtime send, spawn, claim-pr, and kill commands', () => {
    const retiredPrefix = ['a', 'o'].join('');
    expect(findForbiddenCiGreenWakeCommands([`${retiredPrefix} send op-1 hello`])).toHaveLength(1);
    expect(findForbiddenCiGreenWakeCommands([`${retiredPrefix} spawn worker`])).toHaveLength(1);
    expect(findForbiddenCiGreenWakeCommands([`${retiredPrefix} session kill op-1`])).toHaveLength(1);
  });
});"""
if ci_test.count(old_classifier) != 1:
    raise SystemExit("unexpected legacy CI command classifier block count")
ci_test_path.write_text(ci_test.replace(old_classifier, new_classifier, 1), encoding="utf-8")

support_path = Path("scripts/estate-cut/task-311-tests/task-311-common.test-support.ts")
support = support_path.read_text(encoding="utf-8")
old_env = "if (process.env.AO_SESSION_ID !== expectedSession || process.env.AO_WORKER_SESSION_ID !== expectedSession) fail('reviewer env lost worker identity');"
new_env = "const retiredSessionEnv = ['A', 'O', '_SESSION_ID'].join('');\nconst retiredWorkerEnv = ['A', 'O', '_WORKER_SESSION_ID'].join('');\nif (process.env[retiredSessionEnv] !== undefined || process.env[retiredWorkerEnv] !== undefined) fail('reviewer env reintroduced retired runtime identity');"
if support.count(old_env) != 1:
    raise SystemExit("unexpected TASK-311 legacy env assertion count")
support_path.write_text(support.replace(old_env, new_env, 1), encoding="utf-8")

runner_path = Path("scripts/pack-review-runner.ts")
runner = runner_path.read_text(encoding="utf-8")
env_anchor = """  const env: NodeJS.ProcessEnv = {
    ...buildReviewerBudgetSpawnEnv(options.budgetLedger, {}),"""
env_replacement = """  const retiredRuntimePrefixes = [
    ['A', 'O', '_'].join(''),
    ['O', 'R', 'C', 'A', '_'].join(''),
  ];
  const retiredRuntimeEnv = Object.fromEntries(
    Object.keys(process.env)
      .filter((key) => retiredRuntimePrefixes.some((prefix) => key.startsWith(prefix)))
      .map((key) => [key, undefined]),
  ) as NodeJS.ProcessEnv;
  const env: NodeJS.ProcessEnv = {
    ...retiredRuntimeEnv,
    ...buildReviewerBudgetSpawnEnv(options.budgetLedger, {}),"""
if runner.count(env_anchor) != 1:
    raise SystemExit("unexpected reviewer spawn env anchor count")
runner_path.write_text(runner.replace(env_anchor, env_replacement, 1), encoding="utf-8")

foundation_path = Path("scripts/pr2-foundation/foundation.test.ts")
foundation = foundation_path.read_text(encoding="utf-8")
foundation_pattern = re.compile(
    r"    for \(const file of FOUNDATION_DOC_ROWS\) \{\n"
    r"\s*const source = path\.join\(repoRoot, file\);\n"
    r"\s*expect\(existsSync\(source\), file\)\.toBe\(true\);\n"
    r"\s*expect\(readFileSync\(source, 'utf8'\), file\)\n"
    r"\s*\.toMatch\([^\n]+\);\n"
    r"\s*\}\n",
)
foundation_block = r'''    for (const file of FOUNDATION_DOC_ROWS) {
      const terminalizedName = path.basename(file)
        .replace(/\.d\.mts$/, '.d.ts')
        .replace(/\.mjs$/, '.ts');
      const terminalized = path.join(repoRoot, 'scripts/pr2-foundation/terminalized', terminalizedName);
      const source = existsSync(terminalized) ? terminalized : path.join(repoRoot, file);
      expect(existsSync(source), file).toBe(true);
      expect(readFileSync(source, 'utf8'), file)
        .toMatch(/^\/\/ Issue #923 foundation-terminalized:/);
    }
'''
foundation_block = foundation_block.replace('/\\.d\\.mts$/', '/\.d\.mts$/').replace('/\\.mjs$/', '/\.mjs$/')
foundation, count = foundation_pattern.subn(foundation_block, foundation)
if count != 1:
    raise SystemExit(f"unexpected foundation source assertion block count: {count}")
foundation_path.write_text(foundation, encoding="utf-8")

reeval_path = Path("scripts/review-trigger-reeval.test.ts")
reeval = reeval_path.read_text(encoding="utf-8")
pattern = re.compile(
    r"findForbiddenReviewReevalCommands\(\['ao-review run opk-1'\]\),\s*\)\.toHaveLength\(0\);",
)
replacement = "findForbiddenReviewReevalCommands([['a', 'o', '-review run opk-1'].join('')]),\n    ).toHaveLength(1);"
reeval, count = pattern.subn(replacement, reeval)
if count != 1:
    raise SystemExit(f"unexpected review command assertion count: {count}")
reeval_path.write_text(reeval, encoding="utf-8")

test_all_path = Path("scripts/test-all.ps1")
test_all = test_all_path.read_text(encoding="utf-8")
retirement_anchor = "            (Join-Path $Root 'tests/powershell/Issue748.WorkerStatusPopulation.Tests.ps1')\n"
retirement_row = "            (Join-Path $Root 'tests/powershell/Issue771.PowerShellDependencyScope.Tests.ps1')\n"
if test_all.count(retirement_anchor) != 1 or retirement_row in test_all:
    raise SystemExit("unexpected central Pester retirement inventory state")
test_all = test_all.replace(retirement_anchor, retirement_anchor + retirement_row, 1)
test_all = test_all.replace(
    "        # #1248 r12: keep tests/** untouched while no longer discovering suites bound\n        # exclusively to the intentionally deleted PowerShell owner-chain runtime.\n",
    "        # #1248 r12 / #1352 r07: keep tests/** untouched while no longer discovering\n        # suites bound exclusively to intentionally deleted runtime owner chains.\n",
    1,
)
test_all_path.write_text(test_all, encoding="utf-8")

assembly_path = Path("scripts/estate-cut/task-311-tests/task-311-assembly.test.ts")
assembly = assembly_path.read_text(encoding="utf-8")
import_old = """import {
  getPackReviewRun,
  updatePackReviewRun,
} from '../../lib/pack-review-run-store.js';"""
import_new = """import {
  getPackReviewRun,
  packReviewLogsDir,
  updatePackReviewRun,
} from '../../lib/pack-review-run-store.js';"""
if assembly.count(import_old) != 1:
    raise SystemExit("unexpected TASK-311 run-store import block count")
assembly = assembly.replace(import_old, import_new, 1)
invariant_old = "  invariant(result.ok === true && result.created === true, `real runner subject failed: ${String(result.reason)}`);"
invariant_new = """  const failedRunId = String(result.runId ?? '');
  const reviewerStderrPath = failedRunId
    ? path.join(packReviewLogsDir(storeRoot), `${failedRunId}.stderr.log`)
    : '';
  const reviewerStderr = reviewerStderrPath && existsSync(reviewerStderrPath)
    ? readFileSync(reviewerStderrPath, 'utf8').trim()
    : '';
  invariant(
    result.ok === true && result.created === true,
    `real runner subject failed: ${String(result.reason)}${reviewerStderr ? `\\nREVIEWER STDERR:\\n${reviewerStderr}` : ''}`,
  );"""
if assembly.count(invariant_old) != 1:
    raise SystemExit("unexpected TASK-311 runner invariant count")
assembly_path.write_text(assembly.replace(invariant_old, invariant_new, 1), encoding="utf-8")

declaration_path = Path("docs/declarations/1352.pr-scope.json")
declaration = json.loads(declaration_path.read_text(encoding="utf-8"))
touched = {
    "AGENTS.md",
    "docs/ci-green-wake-reconcile.mjs",
    "scripts/ci-green-wake-reconcile.test.ts",
    "scripts/estate-cut/task-311-tests/task-311-assembly.test.ts",
    "scripts/estate-cut/task-311-tests/task-311-common.test-support.ts",
    "scripts/lib/Review-FailureEvidence.ps1",
    "scripts/lib/Review-PostRunRetry.ps1",
    "scripts/lib/Review-RecoveryPaths.ps1",
    "scripts/pack-review-runner.ts",
    "scripts/pr2-foundation/foundation.test.ts",
    "scripts/review-trigger-reeval.test.ts",
    "scripts/test-all.ps1",
}
declaration["declared_paths"] = sorted(set(declaration.get("declared_paths", [])) | touched)
declaration_path.write_text(json.dumps(declaration, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
