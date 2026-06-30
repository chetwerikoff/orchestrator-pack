import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';
import {
  ATOMIC_REVIEW_START_CLAIM_CAPABILITY,
  ORCHESTRATOR_CLAIMED_REVIEW_RUN_GATE_VERSION,
  ORCHESTRATOR_TURN_SURFACE,
  buildRedactedAuditRecord,
  containsRawReviewRunInvocation,
  coalesceDenialAudit,
  evaluateAutonomousReviewRunBoundary,
  evaluateCurrentHeadCoverage,
  evaluateGatePreflight,
  evaluateOrchestratorTurnGate,
  evaluateScenarioMatrixCell,
  findForbiddenAutonomousReviewRunInvocations,
  isClaimedReviewRunParentCommandLine,
  isAoReviewRunGitWorktreeSetupCommandLine,
  isRawReviewRunInvocation,
  loadAutonomousReviewStartCapabilities,
  validateCapabilityInventory,
} from '../docs/orchestrator-claimed-review-run.mjs';

const fixturesDir = path.join(repoRoot, 'tests/fixtures/orchestrator-claimed-review-run');
const scriptsFixturesDir = path.join(repoRoot, 'scripts/fixtures/orchestrator-claimed-review-run');
const invokePath = path.join(repoRoot, 'scripts/invoke-orchestrator-claimed-review-run.ps1');
const helperPath = path.join(repoRoot, 'scripts/lib/Invoke-OrchestratorClaimedReviewRun.ps1');
const guardPath = path.join(repoRoot, 'scripts/ao-autonomous-guard.ps1');
const aoShimPath = path.join(repoRoot, 'scripts/ao');
const fullSha = 'abc3180000000000000000000000000000000000';

type TurnGateFixture = {
  prNumber: number;
  headSha?: string;
  eventHeadSha?: string;
  openPrs?: unknown[];
  reviewRuns?: unknown[];
  sessions?: unknown[];
  ciChecks?: unknown[];
  requiredCheckNames?: string[];
  requiredCheckLookupFailed?: boolean;
  sessionId?: string;
  claimWindow?: 'free' | 'held_by_other' | 'prior_terminal';
  provenanceAutonomous?: boolean;
  expect: { launch?: boolean; reason?: string; verdict?: string };
};

function loadFixture(name: string, fromScripts = false): TurnGateFixture {
  const dir = fromScripts ? scriptsFixturesDir : fixturesDir;
  return JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as TurnGateFixture;
}

function evaluateFixtureTurnGate(fixture: TurnGateFixture) {
  const { expect: _expect, ...input } = fixture;
  return evaluateOrchestratorTurnGate(
    input as Parameters<typeof evaluateOrchestratorTurnGate>[0],
  );
}

describe('orchestrator claimed review-run gate (#318)', () => {
  it('exports stable gate capability markers', () => {
    expect(ORCHESTRATOR_CLAIMED_REVIEW_RUN_GATE_VERSION).toBe('orchestrator-claimed-review-run/v1');
    expect(ATOMIC_REVIEW_START_CLAIM_CAPABILITY).toBe('review-start-claim-atomic/v1');
    expect(ORCHESTRATOR_TURN_SURFACE).toBe('orchestrator-turn');
  });

  it('positive-outcome: uncovered ready head launches through gate evaluation', () => {
    const fixture = loadFixture('positive-uncovered-ready.json');
    const result = evaluateFixtureTurnGate(fixture);
    expect(result.launch).toBe(fixture.expect.launch);
  });

  it('positive-outcome: clean covered head aborts with capture-backed shape', () => {
    const fixture = loadFixture('positive-covered-clean.json');
    const result = evaluateFixtureTurnGate(fixture);
    expect(result.launch).toBe(false);
    expect(result.reason).toMatch(/head_covered|covered/);
  });

  it('mixed-row fixture ignores stale superseded-head clean row', () => {
    const fixture = loadFixture('mixed-row-stale-head.json');
    const coverage = evaluateCurrentHeadCoverage(
      fixture.reviewRuns as never,
      fixture.prNumber,
      fixture.headSha ?? fullSha,
    );
    expect(coverage.verdict).toBe(fixture.expect.verdict);
  });

  it('failed findingCount 0 is failed_or_cancelled not clean', () => {
    const fixture = loadFixture('failed-empty-not-clean.json', true);
    const cell = evaluateScenarioMatrixCell({
      claimWindow: 'free',
      reviewRuns: fixture.reviewRuns as never,
      prNumber: fixture.prNumber,
      headSha: fixture.headSha ?? fullSha,
    });
    expect(cell.launch).toBe(true);
    expect(cell.reason).toBe('failed_retry_once');
  });

  it('retry-eligible failed run launches through full turn gate recheck', () => {
    const fixture = loadFixture('failed-retry-turn-gate.json', true);
    const result = evaluateFixtureTurnGate(fixture);
    expect(result.launch).toBe(fixture.expect.launch);
    expect(result.reason).toBe(fixture.expect.reason);
  });

  it('latest exhausted failed row blocks orchestrator-turn retry launches', () => {
    const fixture = loadFixture('failed-retry-exhausted-turn-gate.json');
    const result = evaluateFixtureTurnGate(fixture);
    expect(result.launch).toBe(fixture.expect.launch);
    expect(result.reason).toBe(fixture.expect.reason);
  });

  it('records post-run retry ledger only inside orchestrator side-effect fence', () => {
    const src = readFileSync(helperPath, 'utf8');
    const fenceIdx = src.indexOf('Invoke-OrchestratorSideEffectFenced');
    const ledgerIdx = src.indexOf('Register-PostRunAutonomousRetryAttemptFromClaim');
    expect(fenceIdx).toBeGreaterThan(-1);
    expect(ledgerIdx).toBeGreaterThan(fenceIdx);
    const beforeFence = src.slice(0, fenceIdx);
    expect(beforeFence).not.toContain('Register-PostRunAutonomousRetryAttemptFromClaim');
  });

  const matrixStatuses = [
    { status: 'none', runs: [], free: true, held: false, terminal: true },
    { status: 'running', runs: [{ status: 'running' }], free: false, held: false, terminal: false },
    { status: 'clean', runs: [{ status: 'clean' }], free: false, held: false, terminal: false },
    { status: 'needs_triage', runs: [{ status: 'needs_triage' }], free: false, held: false, terminal: false },
    { status: 'waiting_update', runs: [{ status: 'waiting_update' }], free: false, held: false, terminal: false },
    { status: 'failed', runs: [{ status: 'failed', retryEligible: true, findingCount: 0, terminationReason: 'reviewer-evidence:{"reviewer":{"effectiveBudgetMs":600000,"failureClass":"timeout_no_verdict"}}' }], free: true, held: false, terminal: true },
    { status: 'cancelled', runs: [{ status: 'cancelled', retryEligible: true, findingCount: 0, terminationReason: 'reviewer-evidence:{"reviewer":{"effectiveBudgetMs":600000,"failureClass":"timeout_no_verdict"}}' }], free: true, held: false, terminal: true },
  ];

  it.each(matrixStatuses)(
    'scenario matrix status=$status claim-free launch=$free',
  ({ status, runs, free }) => {
      const headSha = fullSha;
      const reviewRuns = runs.map((row, index) => ({
        id: `run-${status}-${index}`,
        prNumber: 318,
        targetSha: headSha,
        createdAt: '2026-06-16T00:00:00.000Z',
        ...row,
      }));
      const cell = evaluateScenarioMatrixCell({
        claimWindow: 'free',
        reviewRuns,
        prNumber: 318,
        headSha,
      });
      expect(cell.launch).toBe(free);
    },
  );

  it('claim held by other starter aborts deterministically', () => {
    const cell = evaluateScenarioMatrixCell({
      claimWindow: 'held_by_other',
      reviewRuns: [],
      prNumber: 318,
      headSha: fullSha,
    });
    expect(cell.launch).toBe(false);
    expect(cell.reason).toBe('claim_lost_race');
  });

  it('denies autonomous raw review run invocations across command spellings', () => {
    const blocked = findForbiddenAutonomousReviewRunInvocations([
      'ao review run opk-1 --execute --command echo',
      'ao.cmd review run opk-1 --execute --command echo',
      'pwsh -c "ao review run opk-1 --execute --command echo"',
      '/usr/local/bin/ao review run opk-1 --execute --command echo',
    ]);
    expect(blocked).toHaveLength(4);
    for (const entry of blocked) {
      expect(entry.verdict.allowed).toBe(false);
    }
    expect(
      evaluateAutonomousReviewRunBoundary({
        commandLine: 'ao review run opk-1 --execute --command echo',
        autonomousSurface: false,
      }).allowed,
    ).toBe(true);
    expect(isRawReviewRunInvocation('pwsh -c "git branch -m blocked # ao review run"')).toBe(true);
    expect(isClaimedReviewRunParentCommandLine('pwsh -c "git branch -m blocked # ao review run"')).toBe(false);
    expect(
      isClaimedReviewRunParentCommandLine('ao review run opk-1 --execute --command "git worktree add wt main"'),
    ).toBe(true);
    expect(
      isAoReviewRunGitWorktreeSetupCommandLine('ao review run opk-1 --execute --command "git worktree add wt main"'),
    ).toBe(true);
    expect(
      isAoReviewRunGitWorktreeSetupCommandLine('ao review run opk-1 --execute --command echo'),
    ).toBe(false);
    expect(
      isClaimedReviewRunParentCommandLine('ao review run opk-1 --execute --command echo; git branch -m bypass'),
    ).toBe(false);
    expect(
      evaluateAutonomousReviewRunBoundary({
        commandLine: 'git checkout main && ao review run opk-1 --execute --command echo',
        autonomousSurface: true,
      }).allowed,
    ).toBe(false);
  });

  it('preflight fails closed on stale gate marker or missing atomic claim capability', () => {
    expect(
      evaluateGatePreflight({
        loadedGateVersion: 'stale/v0',
        atomicClaimPresent: true,
        liveCapabilities: [{ id: 'invoke-orchestrator-claimed-review-run', classification: 'gated' }],
      }).ok,
    ).toBe(false);
    expect(
      evaluateGatePreflight({
        loadedGateVersion: ORCHESTRATOR_CLAIMED_REVIEW_RUN_GATE_VERSION,
        atomicClaimPresent: false,
        liveCapabilities: [{ id: 'invoke-orchestrator-claimed-review-run', classification: 'gated' }],
      }).ok,
    ).toBe(false);
  });

  it('stale event head keys on authoritative current head', () => {
    const result = evaluateOrchestratorTurnGate({
      prNumber: 318,
      eventHeadSha: 'deadbeef00000000000000000000000000000000',
      openPrs: [{
        number: 318,
        headRefOid: fullSha,
        headCommittedAt: '2026-06-16T00:00:00.000Z',
      }],
      reviewRuns: [
        {
          prNumber: 318,
          targetSha: 'deadbeef00000000000000000000000000000000',
          status: 'clean',
        },
      ],
      sessions: [
        {
          sessionId: 'opk-75',
          name: 'opk-75',
          prNumber: 318,
          reports: [{ reportState: 'ready_for_review', reportedAt: '2026-06-16T00:00:00.000Z' }],
        },
      ],
      ciChecks: [{ name: 'Verify orchestrator-pack structure', state: 'SUCCESS' }],
      requiredCheckNames: ['Verify orchestrator-pack structure'],
      sessionId: 'opk-75',
      claimWindow: 'free',
    });
    expect(result.currentHeadSha).toBe(fullSha);
    expect(result.staleEventHead).toBe(true);
    expect(result.launch).toBe(true);
  });

  it('unknown run-list row is fail-closed', () => {
    const coverage = evaluateCurrentHeadCoverage(
      [{ prNumber: 318, targetSha: fullSha, status: 'mystery' }],
      318,
      fullSha,
    );
    expect(coverage.verdict).toBe('unknown');
  });

  it('coalesces denial audit records and redacts secrets', () => {
    const first = coalesceDenialAudit(null, {
      reason: 'head_covered',
      provenance: ORCHESTRATOR_TURN_SURFACE,
      atUtc: '2026-06-16T00:00:00.000Z',
      token: 'secret',
    });
    const second = coalesceDenialAudit(first, {
      reason: 'head_covered',
      provenance: ORCHESTRATOR_TURN_SURFACE,
      atUtc: '2026-06-16T00:01:00.000Z',
      commandLine: 'ao review run opk-1 --token abc',
    });
    expect(second.count).toBe(2);
    expect(buildRedactedAuditRecord(second)).not.toHaveProperty('token');
    expect(buildRedactedAuditRecord(second)).not.toHaveProperty('commandLine');
  });

  it('validates capability inventory artifact', () => {
    const inventory = loadAutonomousReviewStartCapabilities();
    const result = validateCapabilityInventory({
      repoInventory: inventory.capabilities,
      liveSurfaces: inventory.capabilities,
    });
    expect(result.ok).toBe(true);
  });

  it('dry-run invoke leaves no active claim on covered abort', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-claimed-audit-'));
    try {
      const fixture = loadFixture('positive-covered-clean.json');
      const fixturePath = path.join(dir, 'fixture.json');
      writeFileSync(
        fixturePath,
        JSON.stringify({
          openPrs: fixture.openPrs,
          reviewRuns: fixture.reviewRuns,
          sessions: fixture.sessions,
          ciChecksByPr: { '318': fixture.ciChecks },
          requiredCheckNamesByPr: { '318': fixture.requiredCheckNames },
          requiredCheckLookupFailedByPr: { '318': false },
        }),
      );
      const output = runPwsh(`
        . ${psString(helperPath)}
        $env:AO_REVIEW_CLAIM_DIR = ${psString(path.join(dir, 'claims'))}
        $audit = ${psString(path.join(dir, 'audit'))}
        $result = Invoke-OrchestratorClaimedReviewRun -SessionId 'opk-75' -ReviewCommand 'echo review' -PrNumber 318 -Project 'orchestrator-pack' -FixtureSnapshot (Get-Content -LiteralPath ${psString(fixturePath)} -Raw | ConvertFrom-Json -AsHashtable) -DryRun -AuditRoot $audit -LogWriter { param($m) }
        [pscustomobject]@{ started=[bool]$result.started; active=(Test-Path -LiteralPath (Join-Path $env:AO_REVIEW_CLAIM_DIR 'pr-318-${fullSha}.json')) } | ConvertTo-Json -Compress
      `);
      const parsed = JSON.parse(output);
      expect(parsed.started).toBe(false);
      expect(parsed.active).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('probe mode denies covered sentinel without production mutation', () => {
    const output = runPwsh(`
      & ${psString(invokePath)} -SessionId probe-session -PrNumber 999999 -Probe -DryRun 2>$null
    `);
    const parsed = JSON.parse(output.trim());
    expect(parsed.started).toBe(false);
    expect(String(parsed.reason)).toMatch(/head_covered|covered/);
  });

  it('probe mode runs without SessionId or PrNumber', () => {
    const output = runPwsh(`
      & ${psString(invokePath)} -Probe -DryRun 2>$null
    `);
    const parsed = JSON.parse(output.trim());
    expect(parsed.started).toBe(false);
    expect(String(parsed.reason)).toMatch(/head_covered|covered/);
  });

  it('autonomous guard denies raw ao review run when surface marker is set', () => {
    const result = spawnSync(
      'pwsh',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', guardPath, 'review', 'run', 'opk-1'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '1' },
      },
    );
    expect(result.status).toBe(93);
    expect(result.stderr).toMatch(/autonomous review-starts paused/i);
  });

  it('scripts/ao shim denies raw review run on autonomous surface', () => {
    const result = spawnSync(
      aoShimPath,
      ['review', 'run', 'opk-1'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '1' },
      },
    );
    expect(result.status).toBe(93);
    expect(result.stderr).toMatch(/autonomous review-starts paused/i);
  });
});

describe('claimed review-start dependency closure (#335)', () => {
  const reconcileChecksHelperPath = path.join(repoRoot, 'scripts/lib/Get-ReconcileChecksByPr.ps1');
  const issue335Sha = 'abc3350000000000000000000000000000000000';

  function listGetReconcileChecksByPrDefinitions(): string[] {
    const matches: string[] = [];
    const scan = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath);
          continue;
        }
        if (!entry.name.endsWith('.ps1')) {
          continue;
        }
        const text = readFileSync(fullPath, 'utf8');
        if (/function\s+Get-ReconcileChecksByPr\b/.test(text)) {
          matches.push(path.relative(repoRoot, fullPath));
        }
      }
    };
    scan(path.join(repoRoot, 'scripts'));
    return matches.sort();
  }

  it('defines Get-ReconcileChecksByPr exactly once in scripts/lib', () => {
    expect(listGetReconcileChecksByPrDefinitions()).toEqual(['scripts/lib/Get-ReconcileChecksByPr.ps1']);
  });

  it('loads Get-ReconcileChecksByPr into the claimed path closure', () => {
    const output = runPwsh(`
      . ${psString(helperPath)}
      if (-not (Get-Command Get-ReconcileChecksByPr -ErrorAction SilentlyContinue)) {
        throw 'Get-ReconcileChecksByPr missing from claimed review-start load closure'
      }
      'ok'
    `);
    expect(output).toBe('ok');
  });

  it('non-fixture snapshot resolves checks bundle and reaches head-ready gate evaluation', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-claimed-nonfixture-'));
    try {
      const script = `
        . ${psString(helperPath)}
        $env:AO_REVIEW_CLAIM_DIR = ${psString(path.join(dir, 'claims'))}
        function Invoke-GhOpenPrListForNumbers {
          param([string]$RepoRoot, [int[]]$PrNumbers, [scriptblock]$ProgressWriter = $null)
          @(@{ number = 335; headRefOid = '${issue335Sha}'; headCommittedAt = '2026-06-18T00:00:00.000Z'; state = 'OPEN' })
        }
        function Invoke-GhOpenPrList {
          param([string]$RepoRoot)
          throw 'full open-PR list must not run on claimed review-start path (#557)'
        }
        function Get-AoReviewRuns { param([string]$Project) @() }
        function Get-AoStatusSessions {
          @(@{
            name = 'opk-335'
            role = 'worker'
            prNumber = 335
            status = 'ready_for_review'
            reports = @(@{ reportState = 'ready_for_review'; reportedAt = '2026-06-18T00:00:00.000Z' })
          })
        }
        $script:resolveCalls = 0
        function Get-GhChecksBundleByPr {
          param([string]$RepoRoot, [array]$OpenPrs, [scriptblock]$MergeRequiredNames, [string]$ProtectionLookupWarningTemplate)
          $script:resolveCalls++
          @{
            ciChecksByPr = @{
              '335' = @(
                @{ name = 'Verify orchestrator-pack structure'; state = 'SUCCESS' },
                @{ name = 'PR scope guard'; state = 'SUCCESS' },
                @{ name = 'Run pack contract tests'; state = 'SUCCESS' },
                @{ name = 'Self-architect lint'; state = 'SUCCESS' }
              )
            }
            requiredCheckNamesByPr = @{
              '335' = @(
                'Verify orchestrator-pack structure',
                'PR scope guard',
                'Run pack contract tests',
                'Self-architect lint'
              )
            }
            requiredCheckLookupFailedByPr = @{ '335' = $false }
          }
        }
        $snap = Get-OrchestratorClaimedReviewSnapshot -PrNumber 335 -Project 'orchestrator-pack' -RepoRoot ${psString(repoRoot)} -FixtureSnapshot $null
        if ($script:resolveCalls -lt 1) { throw 'checks-bundle resolver was not invoked on non-fixture path' }
        if (-not $snap.ciChecksByPr.ContainsKey('335')) { throw 'snapshot missing ciChecksByPr for target PR' }
        $result = Invoke-OrchestratorClaimedReviewRun -SessionId 'opk-335' -ReviewCommand 'echo review' -PrNumber 335 -Project 'orchestrator-pack' -RepoRoot ${psString(repoRoot)} -DryRun -AuditRoot ${psString(path.join(dir, 'audit'))} -LogWriter { param($m) }
        [pscustomobject]@{
          resolveCalls = $script:resolveCalls
          started = [bool]$result.started
          reason = [string]$result.reason
          deniedBeforeClaim = [bool]$result.deniedBeforeClaim
        } | ConvertTo-Json -Compress
      `;
      const parsed = JSON.parse(runPwsh(script));
      expect(parsed.resolveCalls).toBeGreaterThanOrEqual(1);
      expect(parsed.started).toBe(true);
      expect(parsed.reason).toBe('dry_run');
      expect(parsed.deniedBeforeClaim).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shared reconcile helper is loadable without review-trigger-reconcile.ps1', () => {
    const output = runPwsh(`
      . ${psString(reconcileChecksHelperPath)}
      if (-not (Get-Command Get-ReconcileChecksByPr -ErrorAction SilentlyContinue)) {
        throw 'shared helper failed to define Get-ReconcileChecksByPr'
      }
      'ok'
    `);
    expect(output).toBe('ok');
  });

  it('returns an empty bundle when OpenPrs is an empty collection', () => {
    const output = runPwsh(`
      . ${psString(reconcileChecksHelperPath)}
      $bundle = Get-ReconcileChecksByPr -RepoRoot ${psString(repoRoot)} -OpenPrs @()
      if (@($bundle.ciChecksByPr.Keys).Count -ne 0) { throw 'expected empty ciChecksByPr' }
      if (@($bundle.requiredCheckNamesByPr.Keys).Count -ne 0) { throw 'expected empty requiredCheckNamesByPr' }
      'ok'
    `);
    expect(output).toBe('ok');
  });
});
describe('claimed review-start scoped PR lookup (#557)', () => {
  const snapshotHelperPath = path.join(repoRoot, 'scripts/lib/Get-ClaimedReviewStartSnapshot.ps1');
  const issue557Sha = 'abc5570000000000000000000000000000000000';

  it('static regression guard: snapshot helper avoids full open-PR list for known PR', () => {
    const src = readFileSync(snapshotHelperPath, 'utf8');
    expect(src).not.toMatch(/(?<!ForNumbers)Invoke-GhOpenPrList\b/);
    expect(src).not.toMatch(/'pr',\s*'list'/);
    expect(src).toMatch(/Invoke-GhOpenPrListForNumbers/);
    expect(src).toMatch(/'pr',\s*'view'/);
  });

  it('positive-outcome: scoped lookup reaches gate when full open-PR list would fail', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-claimed-scoped-557-'));
    try {
      const script = `
        . ${psString(helperPath)}
        $env:AO_REVIEW_CLAIM_DIR = ${psString(path.join(dir, 'claims'))}
        function Invoke-GhOpenPrListForNumbers {
          param([string]$RepoRoot, [int[]]$PrNumbers, [scriptblock]$ProgressWriter = $null)
          @(@{ number = 557; headRefOid = '${issue557Sha}'; headCommittedAt = '2026-06-30T00:00:00.000Z'; state = 'OPEN'; baseRefName = 'main' })
        }
        function Invoke-GhOpenPrList {
          param([string]$RepoRoot)
          throw 'HTTP 403: rate limit exceeded for gh pr list --state open'
        }
        function Get-AoReviewRuns { param([string]$Project) @() }
        function Get-AoStatusSessions {
          @(@{
            name = 'opk-557'
            role = 'worker'
            prNumber = 557
            status = 'ready_for_review'
            reports = @(@{ reportState = 'ready_for_review'; reportedAt = '2026-06-30T00:00:00.000Z' })
          })
        }
        $script:resolveCalls = 0
        function Get-GhChecksBundleByPr {
          param([string]$RepoRoot, [array]$OpenPrs, [scriptblock]$MergeRequiredNames, [string]$ProtectionLookupWarningTemplate)
          $script:resolveCalls++
          @{
            ciChecksByPr = @{
              '557' = @(
                @{ name = 'Verify orchestrator-pack structure'; state = 'SUCCESS' },
                @{ name = 'PR scope guard'; state = 'SUCCESS' },
                @{ name = 'Run pack contract tests'; state = 'SUCCESS' },
                @{ name = 'Self-architect lint'; state = 'SUCCESS' }
              )
            }
            requiredCheckNamesByPr = @{
              '557' = @(
                'Verify orchestrator-pack structure',
                'PR scope guard',
                'Run pack contract tests',
                'Self-architect lint'
              )
            }
            requiredCheckLookupFailedByPr = @{ '557' = $false }
          }
        }
        $result = Invoke-OrchestratorClaimedReviewRun -SessionId 'opk-557' -ReviewCommand 'echo review' -PrNumber 557 -Project 'orchestrator-pack' -RepoRoot ${psString(repoRoot)} -DryRun -AuditRoot ${psString(path.join(dir, 'audit'))} -LogWriter { param($m) }
        [pscustomobject]@{
          resolveCalls = $script:resolveCalls
          started = [bool]$result.started
          reason = [string]$result.reason
          deniedBeforeClaim = [bool]$result.deniedBeforeClaim
        } | ConvertTo-Json -Compress
      `;
      const parsed = JSON.parse(runPwsh(script));
      expect(parsed.resolveCalls).toBeGreaterThanOrEqual(1);
      expect(parsed.started).toBe(true);
      expect(parsed.reason).toBe('dry_run');
      expect(parsed.deniedBeforeClaim).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('denies when scoped lookup finds no open PR without full-list fallback', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-claimed-scoped-deny-557-'));
    try {
      const script = `
        . ${psString(helperPath)}
        $env:AO_REVIEW_CLAIM_DIR = ${psString(path.join(dir, 'claims'))}
        function Invoke-GhOpenPrListForNumbers {
          param([string]$RepoRoot, [int[]]$PrNumbers, [scriptblock]$ProgressWriter = $null)
          @()
        }
        $script:fullListCalls = 0
        function Invoke-GhOpenPrList {
          param([string]$RepoRoot)
          $script:fullListCalls++
          @(@{ number = 557; headRefOid = '${issue557Sha}'; headCommittedAt = '2026-06-30T00:00:00.000Z'; state = 'OPEN' })
        }
        function Get-AoReviewRuns { param([string]$Project) @() }
        function Get-AoStatusSessions { return @() }
        function Get-GhChecksBundleByPr {
          param([string]$RepoRoot, [array]$OpenPrs, [scriptblock]$MergeRequiredNames, [string]$ProtectionLookupWarningTemplate)
          @{ ciChecksByPr = @{}; requiredCheckNamesByPr = @{}; requiredCheckLookupFailedByPr = @{} }
        }
        $result = Invoke-OrchestratorClaimedReviewRun -SessionId 'opk-557' -ReviewCommand 'echo review' -PrNumber 557 -Project 'orchestrator-pack' -RepoRoot ${psString(repoRoot)} -DryRun -AuditRoot ${psString(path.join(dir, 'audit'))} -LogWriter { param($m) }
        [pscustomobject]@{
          fullListCalls = $script:fullListCalls
          started = [bool]$result.started
          deniedBeforeClaim = [bool]$result.deniedBeforeClaim
          reason = [string]$result.reason
        } | ConvertTo-Json -Compress
      `;
      const parsed = JSON.parse(runPwsh(script));
      expect(parsed.fullListCalls).toBe(0);
      expect(parsed.started).toBe(false);
      expect(parsed.deniedBeforeClaim).toBe(true);
      expect(parsed.reason).toMatch(/head_unresolved|head_resolution_failed|pr_not_found|not_found/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('post-claim recheck uses scoped pr view transport, not full open-PR list', () => {
    const src = readFileSync(snapshotHelperPath, 'utf8');
    const acquiredIdx = src.indexOf('if ($ClaimResult -and $ClaimResult.acquired)');
    expect(acquiredIdx).toBeGreaterThanOrEqual(0);
    const elseIdx = src.indexOf('else {', acquiredIdx);
    expect(elseIdx).toBeGreaterThan(acquiredIdx);
    const block = src.slice(acquiredIdx, elseIdx);
    expect(block).toMatch(/'pr',\s*'view'/);
    expect(block).not.toMatch(/'pr',\s*'list'/);
    expect(block).not.toMatch(/(?<!ForNumbers)Invoke-GhOpenPrList\b/);
  });
});
