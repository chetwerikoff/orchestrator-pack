#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = process.cwd();
const expected = (process.env.EXPECTED_HEAD_SHA ?? '').trim();
if (!/^[0-9a-f]{40}$/i.test(expected)) throw new Error('EXPECTED_HEAD_SHA is required');
const git = (args, inherit = false) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
const norm = (value) => value.replaceAll('\\', '/').replace(/^\.\//, '');
const excluded = new Set([
  '.github/workflows/typescript-foundation.yml', '.github/scripts/finalize-issue-821.sh',
  'scripts/apply-issue-821-final-fixes.mjs', 'scripts/apply-issue-821-clean-rebuild.mjs',
  '.local/state/gh/device-id', '.vitest-runtime-report-light.json', 'scripts/vitest-heavy-topology.plan.json',
  'plugins/ao-codex-pr-reviewer/bin/review.ts', 'plugins/ao-scope-guard/bin/agent-wrap.ts',
  'plugins/ao-scope-guard/bin/scope-check.ts', 'plugins/ao-task-declaration/bin/declare.ts',
  'plugins/ao-token-chain-ledger/bin/ledger.mjs', 'docs/autonomous-spawn-budget.json',
  'docs/review-pipeline-spawn-budget-attribution.mjs',
  'scripts/generate-review-pipeline-spawn-captures.ts',
  'scripts/lib/Invoke-PackSpawnBudgetGates.ps1', 'scripts/review-pipeline-spawn-budget.test.ts',
  'scripts/vitest-ci-lanes.config.json',
  'tests/external-output-references/review-pipeline-spawn-budget/capture-wrapped-positive-covered-clean.json',
  'tests/external-output-references/review-pipeline-spawn-budget/capture-wrapped-positive-uncovered-ready.json',
  'tests/external-output-references/review-pipeline-spawn-budget/reduced-post-change.capture.json',
  'tests/external-output-references/review-pipeline-spawn-budget/storm-baseline.capture.json',
]);
const skip = (rel) => excluded.has(rel) || rel.startsWith('node_modules/') || rel.startsWith('trusted-scope-guard/') || rel.startsWith('.local/') || /^issue-821-.*\.txt$/i.test(rel);
function rows(raw) {
  const tokens = raw.split('\0'); if (tokens.at(-1) === '') tokens.pop();
  const out = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    if (/^[RC]/.test(status)) { i++; out.push({ status, path: tokens[i++] }); }
    else out.push({ status, path: tokens[i++] });
  }
  return out;
}
if (git(['rev-parse', 'HEAD']).trim() !== expected) throw new Error('branch head moved before rebuild');
git(['fetch', '--no-tags', 'origin', 'main']);
const stash = mkdtempSync(path.join(tmpdir(), 'opk-821-'));
const retained = [];
try {
  for (const row of rows(git(['diff', '--name-status', '-z', 'origin/main...HEAD']))) {
    const rel = norm(row.path); if (skip(rel)) continue;
    const deleted = row.status.startsWith('D'); retained.push({ rel, deleted });
    if (!deleted) {
      const source = path.join(root, rel); if (!existsSync(source)) throw new Error(`missing changed path: ${rel}`);
      const target = path.join(stash, rel); mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target); chmodSync(target, statSync(source).mode);
    }
  }
  git(['reset', '--hard', 'origin/main'], true); git(['clean', '-ffdx'], true);
  for (const item of retained) {
    const target = path.join(root, item.rel);
    if (item.deleted) rmSync(target, { recursive: true, force: true });
    else { const source = path.join(stash, item.rel); mkdirSync(path.dirname(target), { recursive: true }); copyFileSync(source, target); chmodSync(target, statSync(source).mode); }
  }
} finally { rmSync(stash, { recursive: true, force: true }); }
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const write = (rel, text) => { const target = path.join(root, rel); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, text.endsWith('\n') ? text : `${text}\n`, 'utf8'); };

{
  const rel = 'scripts/lib/Orchestrator-AutonomousBoundary.ps1'; let source = read(rel);
  if (!source.includes('function Resolve-RealAoExecutable')) {
    const marker = "function Test-OrchestratorAutonomousSurfaceActiveForBoundary {\n    return -not [string]::IsNullOrEmpty([string]$env:AO_SESSION_ID)\n}\n";
    const block = `${marker}\nfunction Resolve-RealAoExecutable {\n    param([string]$PackRoot = '')\n    $command = Get-Command -Name 'ao' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1\n    if ($command -and $command.Source) { return [string]$command.Source }\n    return 'ao'\n}\n\nfunction Resolve-SystemGitExecutable {\n    param([string]$PackRoot = '')\n    $command = Get-Command -Name 'git' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1\n    if ($command -and $command.Source) { return [string]$command.Source }\n    return 'git'\n}\n\nfunction Resolve-RealGitExecutable {\n    param([string]$PackRoot = '')\n    return Resolve-SystemGitExecutable -PackRoot $PackRoot\n}\n`;
    if (!source.includes(marker)) throw new Error(`${rel}: predicate marker missing`);
    write(rel, source.replace(marker, block));
  }
}

{
  const rel = 'scripts/lib/Worker-Recovery.ps1'; let source = read(rel);
  if (!source.includes('[Console]::Error.WriteLine([string]$gate.auditLine)')) {
    const old = "    $gate = Test-AutonomousSpawnDenied -Argv $argv -PackRoot $PackRoot -FixturePolicy $SpawnPolicy -FixtureMode:$FixtureMode\n    if ($gate.denied) {\n        return @{ ok = $false; started = $false; reason = [string]$gate.reason; grantDenied = $true }\n    }\n";
    const next = "    $gate = Test-AutonomousSpawnDenied -Argv $argv -PackRoot $PackRoot -FixturePolicy $SpawnPolicy -FixtureMode:$FixtureMode\n    if ($gate.auditLine) { [Console]::Error.WriteLine([string]$gate.auditLine) }\n    if ($gate.denied) {\n        return @{ ok = $false; started = $false; reason = [string]$gate.reason; grantDenied = $true; auditLine = [string]$gate.auditLine }\n    }\n";
    if (!source.includes(old)) throw new Error(`${rel}: spawn gate marker missing`);
    source = source.replace(old, next)
      .replace("return @{ ok = $true; started = $true; reason = 'spawn_started_dry_run'; grantDenied = $false }", "return @{ ok = $true; started = $true; reason = 'spawn_started_dry_run'; grantDenied = $false; auditLine = [string]$gate.auditLine }")
      .replace("return @{ ok = $true; started = $true; reason = 'spawn_started_fixture'; grantDenied = $false }", "return @{ ok = $true; started = $true; reason = 'spawn_started_fixture'; grantDenied = $false; auditLine = [string]$gate.auditLine }");
    write(rel, source);
  }
}

{
  const rel = 'scripts/reachability-purge.test.ts'; let source = git(['show', '09d3f76cfcb89b8840408249f7494c8a1599b134:scripts/reachability-purge.test.ts']);
  const list = `const ISSUE_821_RETIRED_PATHS = [\n  'docs/autonomous-real-binaries.example.json',\n  'scripts/_invoke-system-git.sh',\n  'scripts/_resolve-system-git.sh',\n  'scripts/_test-autonomous-ao-stub-fixture.ts',\n  'scripts/_test-interposer-pack-fixture.ts',\n  'scripts/ao',\n  'scripts/ao-autonomous-guard.ps1',\n  'scripts/autonomous-bash-env.sh',\n  'scripts/autonomous-orchestrator-interposer.test.ts',\n  'scripts/autonomous-orchestrator-surface-bootstrap.sh',\n  'scripts/autonomous-review-worktree-e2e-smoke.test.ts',\n  'scripts/check-worker-nudge-gate-adoption.ps1',\n  'scripts/git',\n  'scripts/git-autonomous-guard.ps1',\n  'scripts/git-real-binary',\n  'scripts/invoke-orchestrator-claimed-review-run.ps1',\n  'scripts/lib/Invoke-OrchestratorClaimedReviewRun.ps1',\n] as const;\nlet issue821PrerequisiteComplete = false;\n`;
  source = source.replace('let issue821PrerequisiteComplete = false;\n', list);
  source = source.replace(/  issue821PrerequisiteComplete =\n    committedManifest\.retiredShimBlockers\.length > 0 &&\n    committedManifest\.retiredShimBlockers\.every\(\n      \(row\) => Boolean\(row\.path\) && !existsSync\(path\.join\(repoRoot, row\.path!\)\),\n    \);/, "  issue821PrerequisiteComplete = ISSUE_821_RETIRED_PATHS.every(\n    (retiredPath) => !existsSync(path.join(repoRoot, retiredPath)),\n  );");
  source = source.replace(/      expect\(\n        committedManifest\.retiredShimBlockers\.every\(\n          \(row\) => Boolean\(row\.path\) && !existsSync\(path\.join\(repoRoot, row\.path!\)\),\n        \),\n      \)\.toBe\(true\);/, "      expect(\n        ISSUE_821_RETIRED_PATHS.every(\n          (retiredPath) => !existsSync(path.join(repoRoot, retiredPath)),\n        ),\n      ).toBe(true);");
  write(rel, source);
}

{
  const rel = 'docs/issues_drafts/00-architecture-decisions.md'; let source = read(rel);
  const marker = '## W. AO_SESSION_ID in-process gate activation (Issue #821)';
  if (!source.includes(marker)) write(rel, `${source.trimEnd()}\n\n${marker}\n\n1. A non-empty \`AO_SESSION_ID\` activates the spawn, review-start, worker-nudge, and mutating-git in-process gates. Policy, bypass, grant, reason, and audit contracts are unchanged.\n2. AO 0.10.2 live evidence confirms the variable for orchestrator and worker roles; the sampled review-role session lacked it. Manual shells and ordinary CI remain outside this predicate.\n3. PATH shims, shell interposers, and real-binary configuration are retired. Direct operator \`ao\` and \`git\` calls are intentionally not intercepted; enforcement belongs to tracked in-process entry points.\n4. \`Resolve-RealAoExecutable\` and \`Resolve-SystemGitExecutable\` survive only as ordinary PATH-resolution compatibility helpers.\n5. No operator adoption is required because the tracked example config is legacy-import-only. Future loss of AO_SESSION_ID injection is a documented fail-open residual suitable for periodic producer-contract re-verification.\n`);
}

{
  const rel = 'agent-orchestrator.yaml.example'; let source = read(rel);
  source = source.replace('# GitHub reads use the tracked scripts/gh REST wrapper.\n# GitHub reads use the tracked scripts/gh wrapper.\n', '# GitHub reads use the tracked scripts/gh REST wrapper.\n');
  write(rel, source);
}
const grep = spawnSync('git', ['grep', '-n', '-E', 'AO_AUTONOMOUS_ORCHESTRATOR_SURFACE|\\.ao/autonomous-real-binaries\\.json', '--', ':!docs/issues_drafts/**', ':!docs/migration_notes.md', ':!docs/declarations/**', ':!docs/issue_queue_index.md', ':!scripts/reachability-purge.manifest.json', ':!tests/external-output-references/captures/spawn-worktree-branch-operand-binding/integration-spawn-561-feat-issue-561.raw.txt', ':!.github/**'], { cwd: root, encoding: 'utf8' });
if (![0, 1].includes(grep.status ?? 2)) throw new Error(grep.stderr);
if (grep.stdout.trim()) throw new Error(`retired references remain:\n${grep.stdout}`);
console.log(JSON.stringify({ rebuiltFrom: 'origin/main', expected, retained: retained.length }, null, 2));
