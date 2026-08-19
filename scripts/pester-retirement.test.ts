// @vitest-ci-lane heavy

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess } from './kernel/subprocess.ts';

const ROOT = process.cwd();
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function processRun(command: string, args: readonly string[], env?: NodeJS.ProcessEnv) {
  return runProcess({
    command,
    args,
    cwd: ROOT,
    env: env ?? process.env,
    inheritParentEnv: env === undefined,
    allowEmptyStdout: true,
    timeoutMs: 30_000,
  });
}

async function pwsh(command: string, env?: NodeJS.ProcessEnv) {
  return processRun('pwsh', ['-NoProfile', '-Command', command], env);
}

function output(result: Awaited<ReturnType<typeof processRun>>): string {
  return `${result.stdout}\n${result.stderr}`;
}

describe('retired Pester population replacement coverage', () => {
  it('keeps the CI-red watchdog Node acceptance contract and worker quiescence semantics', async () => {
    const selfTest = await processRun(process.execPath, [path.join(ROOT, 'scripts/lib/ci-red-watchdog-selftest.mjs')]);
    expect(selfTest.ok, output(selfTest)).toBe(true);
    expect(output(selfTest)).toMatch(/\[PASS\] CI-red watchdog self-test \([0-9]+ cases\)/u);

    const result = await pwsh([
      ". './scripts/lib/Ci-Red-Watchdog.ps1'",
      "$worker = Resolve-CiRedWatchdogWorker -Sessions @([pscustomobject]@{ role='worker'; prNumber=755; headSha='abc123'; sessionId='worker-755'; generation='gen-1'; status='working'; activity='idle'; lastActivityAtMs=1800000000000 }) -PrNumber 755 -HeadSha 'abc123' -NowMs 1800000060000",
      "[pscustomobject]@{ ok=$worker.ok; alive=$worker.alive; quiescent=$worker.quiescent } | ConvertTo-Json -Compress",
    ].join('; '));
    expect(result.ok, output(result)).toBe(true);
    expect(JSON.parse(result.stdout.trim())).toEqual({ ok: true, alive: true, quiescent: true });

    const watchdog = readFileSync(path.join(ROOT, 'scripts/lib/Ci-Red-Watchdog.ps1'), 'utf8');
    const tick = readFileSync(path.join(ROOT, 'scripts/lib/Ci-Red-Watchdog-Tick.ps1'), 'utf8');
    const submit = readFileSync(path.join(ROOT, 'scripts/worker-message-submit-reconcile.ps1'), 'utf8');
    expect(watchdog).toContain('Ci-Red-Watchdog-Tick.ps1');
    expect(tick.indexOf("-Command 'transport-issued'")).toBeGreaterThan(0);
    expect(tick.indexOf('Invoke-PlannedCiFailureReconcileSend')).toBeGreaterThan(tick.indexOf("-Command 'transport-issued'"));
    expect(submit.indexOf('Invoke-WorkerInputDraftSubmit')).toBeGreaterThan(submit.indexOf('Test-CiRedWatchdogSubmitBoundary'));
    expect(submit).toContain('Release-CiRedWatchdogSubmitBoundaryAttempt');
    expect(submit).toContain("-DispatchOutcome 'send_failed'");
  });

  it('keeps mechanical JSON state defaults isolated and corrupt action tracking fail-closed', async () => {
    const stateRoot = makeRoot('opk-mechanical-json-');
    const missing = path.join(stateRoot, 'missing.json');
    const corrupt = path.join(stateRoot, 'corrupt.json');
    writeFileSync(corrupt, '{"sent":{', 'utf8');
    const env = { ...process.env, OPK_TEST_MISSING_STATE: missing, OPK_TEST_CORRUPT_STATE: corrupt };
    const result = await pwsh([
      ". './scripts/lib/MechanicalReconcileNode.ps1'",
      "$default = @{ sent=@{}; lastTickMs=$null }",
      "$first = Get-MechanicalJsonStateFile -Path $env:OPK_TEST_MISSING_STATE -DefaultState $default",
      "$first.sent['mutated'] = @{ sessionId='synthetic' }",
      "$second = Get-MechanicalJsonStateFile -Path $env:OPK_TEST_MISSING_STATE -DefaultState $default",
      "$corrupt = Get-MechanicalJsonStateFile -Path $env:OPK_TEST_CORRUPT_STATE -DefaultState $default -ActionTracking",
      "[pscustomobject]@{ rereadCount=$second.sent.Count; defaultCount=$default.sent.Count; corruptTrusted=(Test-MechanicalJsonStateFencesTrusted -State $corrupt) } | ConvertTo-Json -Compress",
    ].join('; '), env);
    expect(result.ok, output(result)).toBe(true);
    expect(JSON.parse(result.stdout.trim())).toEqual({ rereadCount: 0, defaultCount: 0, corruptTrusted: false });
  });

  it('keeps launch-health runtime relaxation separate from terminal/dead runtime states', async () => {
    const result = await pwsh([
      ". './scripts/lib/Get-OrchestratorLaunchHealth.ps1'",
      "$missing = Test-SessionRuntimeFieldLive -Session ([pscustomobject]@{ status='working' })",
      "$alive = Test-SessionRuntimeFieldLive -Session ([pscustomobject]@{ runtime='ALIVE' })",
      "$dead = Test-SessionRuntimeFieldLive -Session ([pscustomobject]@{ runtime='exited' })",
      "$stuck = Test-OrchestratorSessionLaunchHealthy -Session ([pscustomobject]@{ status='stuck'; activity='idle' })",
      "[pscustomobject]@{ missing=$missing; alive=$alive; dead=$dead; stuck=$stuck } | ConvertTo-Json -Compress",
    ].join('; '));
    expect(result.ok, output(result)).toBe(true);
    expect(JSON.parse(result.stdout.trim())).toEqual({ missing: true, alive: true, dead: false, stuck: false });
  });

  it('keeps review-failure evidence argument boundaries and output-tail configuration', async () => {
    const result = await pwsh([
      ". './scripts/lib/Review-FailureEvidence.ps1'",
      "$echoScript = Join-Path (Resolve-Path './scripts/fixtures/review-failure-evidence').Path 'echo-args.ps1'",
      "$psi = Get-PackReviewWrapperProcessStartInfo -PwshPath (Get-Command pwsh).Source -WrapperPath $echoScript -WrapperArgs @('--repo-root', '/tmp/path with spaces/repo', '--base', 'origin/main')",
      "$process = [System.Diagnostics.Process]::Start($psi)",
      "$streams = Read-PackReviewProcessStreams -Process $process",
      "$env:OPK_REVIEW_FAILURE_EVIDENCE_OUTPUT_TAIL_LIMIT='256'",
      "$limit = Get-ReviewFailureEvidenceOutputTailLimit",
      "$process.Dispose()",
      "[pscustomobject]@{ args=$streams.Stdout.Trim(); limit=$limit } | ConvertTo-Json -Compress",
    ].join('; '));
    expect(result.ok, output(result)).toBe(true);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      args: '--repo-root|/tmp/path with spaces/repo|--base|origin/main',
      limit: 256,
    });
  });

  it('keeps CI repo-slug parsing isolated from warning noise', async () => {
    const result = await pwsh([
      ". './scripts/lib/Ci-Failure-Notification-Common.ps1'",
      "$slug = ConvertTo-RepoSlugFromGhOutput -Raw @('warning: gh update available', 'chetwerikoff/orchestrator-pack')",
      "$slug",
    ].join('; '));
    expect(result.ok, output(result)).toBe(true);
    expect(result.stdout.trim()).toBe('chetwerikoff/orchestrator-pack');
  });

  it('keeps slash-containing branch refs encoded for GitHub protection lookup', async () => {
    const result = await pwsh(". './scripts/lib/Gh-PrChecks.ps1'; Get-GhEncodedBranchRef -BranchRef 'release/1.0'");
    expect(result.ok, output(result)).toBe(true);
    expect(result.stdout.trim()).toBe('release%2F1.0');
  });

  it('keeps self-architect strict behavior and diff-mode scope behavior', async () => {
    const duplicate = await processRun('pwsh', [
      '-NoProfile', '-File', path.join(ROOT, 'scripts/lint-self-architect.ps1'),
      '-FixtureRoot', path.join(ROOT, 'tests/fixtures/lint-self-architect/duplicate-literal'), '-Strict',
    ]);
    expect(duplicate.ok).toBe(false);
    expect(output(duplicate)).toMatch(/duplicate-literal/u);

    const negative = await processRun('pwsh', [
      '-NoProfile', '-File', path.join(ROOT, 'scripts/lint-self-architect.ps1'),
      '-FixtureRoot', path.join(ROOT, 'tests/fixtures/lint-self-architect/negative'), '-Strict',
    ]);
    expect(negative.ok, output(negative)).toBe(true);

    const repo = makeRoot('opk-lint-diff-');
    const promptDir = path.join(repo, 'prompts');
    const shared = [
      'Before implementing, staging, or committing, run this short check:',
      '',
      '1. Paired script/template edits: am I changing the same behavior in both a script',
      '   and a template? If yes, extract or generate from one source of truth.',
      '2. Duplicated prompt literals: did I copy a rule/prompt/path string into multiple',
      '   files? If yes, centralize it before continuing.',
      '3. Broad declarations: is the declared scope a whole directory or glob when a',
      '   file-level scope would work? If yes, narrow it or justify it explicitly.',
      '4. New subsystem smell: am I adding a new subsystem for behavior that AO already',
      '   has through config, reactions, session metadata, or plugin slots?',
      '5. Core patch smell: am I about to patch upstream AO core? If yes, stop and use',
      '   plugin/config/prompt/wrapper/hook/CI instead.',
    ].join('\n');
    await processRun('mkdir', ['-p', promptDir]);
    writeFileSync(path.join(promptDir, 'first.md'), `# First\n\n${shared}\n`, 'utf8');
    writeFileSync(path.join(promptDir, 'second.md'), `# Second\n\n${shared}\n`, 'utf8');
    const git = async (args: readonly string[]) => processRun('git', ['-C', repo, ...args]);
    expect((await git(['init'])).ok).toBe(true);
    expect((await git(['add', 'prompts/first.md', 'prompts/second.md'])).ok).toBe(true);
    expect((await git(['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'base'])).ok).toBe(true);
    const base = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    writeFileSync(path.join(repo, 'CLAUDE.md'), '# Architect rules only\n', 'utf8');
    expect((await git(['add', 'CLAUDE.md'])).ok).toBe(true);
    expect((await git(['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'out of scope'])).ok).toBe(true);
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const diff = await processRun('pwsh', [
      '-NoProfile', '-File', path.join(ROOT, 'scripts/lint-self-architect.ps1'),
      '-RepoRoot', repo, '-Strict', '-BaseRef', base, '-HeadRef', head,
    ]);
    expect(diff.ok, output(diff)).toBe(true);
    expect(output(diff)).toMatch(/Changed files: 0/u);
    expect(output(diff)).not.toMatch(/\[STRICT\]/u);
  });

  it('keeps trusted-root launcher protections after Pester retirement', () => {
    const resolve = readFileSync(path.join(ROOT, 'scripts/lib/Resolve-TrustedPackRoot.ps1'), 'utf8');
    const common = readFileSync(path.join(ROOT, 'scripts/lib/TrustedPackRoot-Common.ps1'), 'utf8');
    const launcher = readFileSync(path.join(ROOT, 'scripts/launch-contract-evidence-reverify.ps1'), 'utf8');
    expect(resolve).toMatch(/Test-TrustedMainWorktreeEligible -MainWorktreePath/u);
    expect(common).toMatch(/function Assert-TrustedRootOverrideEligible/u);
    expect(common).toMatch(/git status --porcelain/u);
    expect(launcher).toMatch(/Assert-LauncherInvokedOutsideReviewTarget/u);
    expect(launcher).toMatch(/refusing PR-checkout launcher/u);
    expect(launcher).toMatch(/git archive origin\/main -- @archiveRelativePaths/u);
  });
});
