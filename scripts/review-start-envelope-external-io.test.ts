import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { evaluateAttemptCeiling, evaluateReadinessEnvelopeWithPause, classifyInfraTransportFailure, createMonotonicClock, closeInfraPauseSegment, clearFirstAttemptOnCoveredHead, INFRA_TRANSPORT_FAILURE_CLASS } from '../docs/review-start-envelope-external-io.mjs';
import { evaluateReclaimDecision, evaluateReadinessEnvelope, resolveClaimLifecycleConfig } from '../docs/review-start-claim-lifecycle.mjs';
import { psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';
const fullSha = '943b6cefbc6071f785d99b0eaf745bd579644d85';
const claimHelperPath = path.join(repoRoot, 'scripts/lib/Review-StartClaim.ps1');
const lifecycleHelperPath = path.join(repoRoot, 'scripts/lib/Review-StartClaimLifecycle.ps1');
const supervisedGhPath = path.join(repoRoot, 'scripts/lib/Review-StartSupervisedGh.ps1');
const fakeGhPath = path.join(repoRoot, 'scripts/fixtures/review-start-envelope-external-io/fake-gh-scenario.ps1');
const snapshotHelperPath = path.join(repoRoot, 'scripts/lib/Get-ClaimedReviewStartSnapshot.ps1');
const ghChecksPath = path.join(repoRoot, 'scripts/lib/Gh-PrChecks.ps1');
const reconcileChecksPath = path.join(repoRoot, 'scripts/lib/Get-ReconcileChecksByPr.ps1');
function fakeHolder(overrides: Record<string, unknown> = {}) {
    return {
        surface: 'review-trigger-reconcile',
        pid: 424242,
        host: 'test-host',
        processGuid: 'guid-1',
        startTimeTicks: '100',
        bootIdHash: 'boot-a',
        ...overrides,
    };
}
function claimWithMono(startMono: number, pauseSegments: unknown[] = []) {
    return {
        state: 'active',
        prNumber: 510,
        headSha: fullSha,
        holder: fakeHolder(),
        acquiredAtUtc: '2026-06-28T12:00:00.000Z',
        firstAttemptAtMonotonicMs: startMono,
        readinessStartMonotonicMs: startMono,
        infraPauseSegments: pauseSegments,
    };
}
describe('review-start-envelope-external-io', () => {
    it('graphql-quota drill: review-start reconcile surfaces are inventory-classified (Issue #549)', async () => {
        const { validatePackGhReadInventoryCompleteness } = await import('./lib/graphql-quota-github-read-inventory.mjs');
        const result = validatePackGhReadInventoryCompleteness(repoRoot);
        expect(result.residualErrors).toEqual([]);
        const reviewStartHits = result.unclassified.filter((v) => /Gh-PrChecks|Get-AutoReviewPrContext|review-start|Review-Start/i.test(v.file));
        expect(reviewStartHits).toEqual([]);
    });
    it('infra-stall-not-envelope-exhausted', () => {
        const config = resolveClaimLifecycleConfig({ readinessEnvelopeMs: 30000 });
        const startMono = 1000000;
        const stallMs = 45000;
        const claim = claimWithMono(startMono, [
            {
                startedMonotonicMs: startMono + 1000,
                endedMonotonicMs: startMono + 1000 + stallMs,
                failureClass: INFRA_TRANSPORT_FAILURE_CLASS,
                shape: 'dns_timeout',
            },
        ]);
        const nowMono = startMono + stallMs + 5000;
        const envelope = evaluateReadinessEnvelopeWithPause({
            claim,
            nowMs: Date.parse('2026-06-28T12:01:00.000Z'),
            nowMonotonicMs: nowMono,
            config,
        });
        expect(envelope.exceeded).toBe(false);
        expect(envelope.pauseMs).toBe(stallMs);
        expect(envelope.ageMs).toBeLessThan(config.readinessEnvelopeMs);
        const decision = evaluateReclaimDecision({
            claim,
            holderLiveness: { outcome: 'alive', reason: 'alive' },
            reviewRuns: [],
            nowMs: Date.parse('2026-06-28T12:01:00.000Z'),
            nowMonotonicMs: nowMono,
            config,
            localHost: 'test-host',
        });
        expect(decision.action).toBe('skip');
        expect(decision.outcome).not.toBe('readiness_envelope_exceeded');
        expect(decision.outcome).not.toBe('hold_budget_exceeded');
    });
    it('pr510-shaped-pass-and-reproduce', () => {
        const config = resolveClaimLifecycleConfig({ readinessEnvelopeMs: 30000 });
        const startMono = 2000000;
        const stallMs = 35000;
        const claim = claimWithMono(startMono, [
            {
                startedMonotonicMs: startMono,
                endedMonotonicMs: startMono + stallMs,
                failureClass: INFRA_TRANSPORT_FAILURE_CLASS,
                shape: 'gh_wrapper_transport',
            },
        ]);
        const postRecoveryMono = startMono + stallMs + 2000;
        const envelope = evaluateReadinessEnvelope({
            claim,
            nowMs: Date.parse('2026-06-28T12:00:40.000Z'),
            nowMonotonicMs: postRecoveryMono,
            config,
        });
        expect(envelope.exceeded).toBe(false);
        const withoutPause = evaluateReadinessEnvelopeWithPause({
            claim: { ...claim, infraPauseSegments: [] },
            nowMs: Date.parse('2026-06-28T12:00:40.000Z'),
            nowMonotonicMs: postRecoveryMono,
            config,
        });
        expect(withoutPause.exceeded).toBe(true);
        const dir = mkdtempSync(path.join(tmpdir(), 'envelope-pr510-'));
        try {
            const script = `
        $env:AO_REVIEW_START_MONOTONIC_NOW_MS = '${postRecoveryMono}'
        $env:AO_REVIEW_START_SUPERVISED_GH_COMMAND = ${psString(fakeGhPath)}
        $env:AO_REVIEW_START_GH_SCENARIO = 'pr510'
        $env:AO_REVIEW_START_GH_CALL_COUNT = '2'
        . ${psString(claimHelperPath)}
        . ${psString(lifecycleHelperPath)}
        . ${psString(supervisedGhPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        $claim = Acquire-ReviewStartClaim -PrNumber 510 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        $transport = Invoke-ReviewStartSupervisedGh -ClaimResult $claim -RepoRoot ${psString(repoRoot)} -GhArguments @('pr','list','--state','open','--json','number,headRefOid,baseRefName','--limit','200')
        $gate = Confirm-ReviewStartClaimLaunchGate -ClaimResult $claim -ReviewRuns @() -DecisionSource 'hold_budget'
        [pscustomobject]@{
          transportOk = [bool]$transport.ok
          failureClass = [string]$transport.failureClass
          gateOk = [bool]$gate.ok
        } | ConvertTo-Json -Compress
      `;
            const result = JSON.parse(runPwsh(script));
            expect(result.transportOk).toBe(true);
            expect(result.gateOk).toBe(true);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('reaper-pause-parity', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'envelope-reaper-'));
        const startMono = 3000000;
        const stallMs = 40000;
        const nowMono = startMono + stallMs + 1000;
        try {
            const script = `
        $env:AO_REVIEW_START_MONOTONIC_NOW_MS = '${nowMono}'
        . ${psString(claimHelperPath)}
        . ${psString(lifecycleHelperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        $claim = Acquire-ReviewStartClaim -PrNumber 510 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        $record = Get-Content -LiteralPath $claim.path -Raw | ConvertFrom-Json
        $record | Add-Member -NotePropertyName infraPauseSegments -NotePropertyValue @(@{
          startedMonotonicMs = ${startMono}
          endedMonotonicMs = ${startMono + stallMs}
          failureClass = 'infra_transport'
          shape = 'connect_timeout'
        }) -Force
        $record | Add-Member -NotePropertyName activeInfraPause -NotePropertyValue @{ startedMonotonicMs = ${nowMono - 500}; supervisedGhPid = 999999 } -Force
        ($record | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $claim.path -Encoding UTF8
        $sweep = Invoke-ReviewStartClaimReaperSweep -Namespace $ns -ReviewRuns @() -LogWriter { param($m) }
        [pscustomobject]@{
          outcome = [string]($sweep.results | Select-Object -First 1).outcome
          action = [string]($sweep.results | Select-Object -First 1).action
        } | ConvertTo-Json -Compress
      `;
            const result = JSON.parse(runPwsh(script));
            expect(result.outcome).not.toBe('readiness_envelope_exceeded');
            expect(result.action).not.toBe('terminalize');
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('not-ready-and-auth-not-classified-as-infra', () => {
        const auth = classifyInfraTransportFailure({ stderr: 'HTTP 401: Bad credentials' });
        expect(auth.failureClass).toBeNull();
        expect(auth.shape).toBe('auth');
        const infra = classifyInfraTransportFailure({
            stderr: 'dial tcp: lookup api.github.com: i/o timeout',
        });
        expect(infra.failureClass).toBe(INFRA_TRANSPORT_FAILURE_CLASS);
        const closed = closeInfraPauseSegment({
            claim: { infraPauseSegments: [], activeInfraPause: { startedMonotonicMs: 1 } },
            nowMonotonicMs: 5000,
            stderr: 'HTTP 401: Bad credentials',
        });
        const classification = closed.classification as {
            failureClass: string | null;
        };
        expect(classification.failureClass).toBeNull();
        expect(closed.infraPauseSegments).toEqual([]);
    });
    it('monotonic-attempt-ceiling-terminalizes', () => {
        const config = resolveClaimLifecycleConfig({ attemptCeilingMs: 300000 });
        const startMono = 10000000;
        const claim = claimWithMono(startMono);
        const ceiling = evaluateAttemptCeiling({
            claim,
            nowMonotonicMs: startMono + 300001,
            reviewRuns: [],
            config,
        });
        expect(ceiling.exceeded).toBe(true);
        const decision = evaluateReclaimDecision({
            claim,
            holderLiveness: { outcome: 'alive', reason: 'alive' },
            reviewRuns: [],
            nowMs: Date.parse('2026-06-28T12:10:00.000Z'),
            nowMonotonicMs: startMono + 300001,
            config,
        });
        expect(decision.outcome).toBe('readiness_attempt_ceiling_exceeded');
        const wallJump = evaluateAttemptCeiling({
            claim,
            nowMonotonicMs: startMono + 1000,
            reviewRuns: [],
            config,
        });
        expect(wallJump.exceeded).toBe(false);
        const covered = evaluateAttemptCeiling({
            claim,
            nowMonotonicMs: startMono + 400000,
            reviewRuns: [{ prNumber: 510, targetSha: fullSha, status: 'clean' }],
            config,
        });
        expect(covered.exceeded).toBe(false);
        expect(covered.reason).toBe('covered');
        const staleHeadSha = 'a'.repeat(40);
        const staleCover = evaluateAttemptCeiling({
            claim,
            nowMonotonicMs: startMono + 400000,
            reviewRuns: [{ prNumber: 510, targetSha: staleHeadSha, status: 'clean' }],
            config,
        });
        expect(staleCover.reason).not.toBe('covered');
        expect(staleCover.exceeded).toBe(true);
        const clearStale = clearFirstAttemptOnCoveredHead({
            claim,
            reviewRuns: [{ prNumber: 510, targetSha: staleHeadSha, status: 'clean' }],
        });
        expect(clearStale.clear).toBe(false);
        expect(clearStale.reason).toBe('uncovered');
        const clearMatch = clearFirstAttemptOnCoveredHead({
            claim,
            reviewRuns: [{ prNumber: 510, targetSha: fullSha, status: 'clean' }],
        });
        expect(clearMatch.clear).toBe(true);
        const failedLatest = evaluateAttemptCeiling({
            claim,
            nowMonotonicMs: startMono + 400000,
            reviewRuns: [{
                    prNumber: 510,
                    targetSha: fullSha,
                    prReviewStatus: 'running',
                    latestRunStatus: 'failed',
                }],
            config,
        });
        expect(failedLatest.reason).not.toBe('covered');
        expect(failedLatest.exceeded).toBe(true);
        const clearFailedLatest = clearFirstAttemptOnCoveredHead({
            claim,
            reviewRuns: [{
                    prNumber: 510,
                    targetSha: fullSha,
                    prReviewStatus: 'running',
                    latestRunStatus: 'failed',
                }],
        });
        expect(clearFailedLatest.clear).toBe(false);
        expect(clearFailedLatest.reason).toBe('uncovered');
    });
    it('hung-gh-and-claim-loss-cleanup', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'envelope-hung-gh-'));
        try {
            const hangScript = path.join(dir, 'hang-gh.ps1');
            const hangBody = "Start-Sleep -Seconds 30\n";
            writeFileSync(hangScript, hangBody);
            const monoStart = 20000000;
            const script = `
        $env:AO_REVIEW_START_MONOTONIC_NOW_MS = '${monoStart}'
        $env:AO_REVIEW_START_SUPERVISED_GH_COMMAND = ${psString(hangScript)}
        . ${psString(claimHelperPath)}
        . ${psString(lifecycleHelperPath)}
        . ${psString(supervisedGhPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        $claim = Acquire-ReviewStartClaim -PrNumber 510 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        $transport = Invoke-ReviewStartSupervisedGh -ClaimResult $claim -RepoRoot ${psString(repoRoot)} -GhArguments @() -DeadlineMs 200
        $record = Get-Content -LiteralPath $claim.path -Raw | ConvertFrom-Json
        [pscustomobject]@{
          timedOut = [bool]$transport.timedOut
          failureClass = [string]$transport.failureClass
          activePause = [bool]$record.activeInfraPause
        } | ConvertTo-Json -Compress
      `;
            const hung = JSON.parse(runPwsh(script));
            expect(hung.timedOut).toBe(true);
            expect(hung.failureClass).toBe(INFRA_TRANSPORT_FAILURE_CLASS);
            expect(hung.activePause).toBe(false);
            const lossScript = `
        $env:AO_REVIEW_START_MONOTONIC_NOW_MS = '${monoStart + 100}'
        . ${psString(claimHelperPath)}
        . ${psString(lifecycleHelperPath)}
        . ${psString(supervisedGhPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        $first = Acquire-ReviewStartClaim -PrNumber 510 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        Update-ReviewStartClaimRecordFields -ClaimResult $first -Fields @{
          activeInfraPause = @{ startedMonotonicMs = ${monoStart}; supervisedGhPid = 999999 }
        } | Out-Null
        $second = Acquire-ReviewStartClaim -PrNumber 510 -HeadSha $sha -Surface 'review-wake-trigger' -Namespace $ns -ReviewRuns @()
        Invoke-ReviewStartClaimOwnershipLossCleanup -ClaimResult $first
        [pscustomobject]@{
          secondAcquired = [bool]$second.acquired
          firstStillActivePause = [bool]((Get-Content -LiteralPath $first.path -Raw | ConvertFrom-Json).activeInfraPause)
        } | ConvertTo-Json -Compress
      `;
            const loss = JSON.parse(runPwsh(lossScript));
            expect(loss.secondAcquired).toBe(false);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('ownership-loss-cleanup-does-not-kill-new-owner-supervised-gh', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'envelope-ownership-loss-'));
        const monoStart = 21000000;
        try {
            const script = `
        . ${psString(claimHelperPath)}
        . ${psString(lifecycleHelperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        $first = Acquire-ReviewStartClaim -PrNumber 510 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        $stalePid = 999999
        $first.claim.activeInfraPause = @{
          startedMonotonicMs = ${monoStart}
          supervisedGhPid    = $stalePid
        }
        $winner = Start-Process -FilePath 'sleep' -ArgumentList @('5') -PassThru -NoNewWindow
        Start-Sleep -Milliseconds 300
        $winnerPid = [int]$winner.Id
        $record = Get-Content -LiteralPath $first.path -Raw | ConvertFrom-Json
        $record.activeInfraPause = @{
          startedMonotonicMs = ${monoStart + 1}
          supervisedGhPid    = $winnerPid
        }
        $record.holder = New-ReviewStartClaimHolder -Surface 'winner-surface'
        ($record | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $first.path -Encoding UTF8
        Invoke-ReviewStartClaimOwnershipLossCleanup -ClaimResult $first
        $winnerAlive = $false
        try {
          $null = Get-Process -Id $winnerPid -ErrorAction Stop
          $winnerAlive = $true
        }
        catch { }
        if ($winnerAlive) {
          Stop-Process -Id $winnerPid -Force -ErrorAction SilentlyContinue
        }
        [pscustomobject]@{ winnerAlive = $winnerAlive } | ConvertTo-Json -Compress
      `;
            const result = JSON.parse(runPwsh(script));
            expect(result.winnerAlive).toBe(true);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('supervised-gh-kills-child-immediately-on-post-start-ownership-loss', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'envelope-post-start-loss-'));
        const stealScript = path.join(repoRoot, 'scripts/fixtures/review-start-envelope-external-io/steal-claim-then-hang.ps1');
        const childPidFile = path.join(dir, 'stolen-gh.pid');
        const monoStart = 23000000;
        try {
            const script = `
        $env:AO_REVIEW_START_MONOTONIC_NOW_MS = '${monoStart}'
        $env:AO_REVIEW_START_SUPERVISED_GH_COMMAND = ${psString(stealScript)}
        . ${psString(claimHelperPath)}
        . ${psString(lifecycleHelperPath)}
        . ${psString(supervisedGhPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        $claim = Acquire-ReviewStartClaim -PrNumber 510 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        $env:AO_REVIEW_START_TEST_CLAIM_PATH = $claim.path
        $env:AO_REVIEW_START_TEST_CHILD_PID_FILE = ${psString(childPidFile)}
        $env:AO_REVIEW_START_TEST_DELAY_BEFORE_PID_UPDATE_MS = '2500'
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $transport = Invoke-ReviewStartSupervisedGh -ClaimResult $claim -RepoRoot ${psString(repoRoot)} -GhArguments @() -DeadlineMs 30000
        $sw.Stop()
        $childPid = 0
        if (Test-Path -LiteralPath ${psString(childPidFile)}) {
          $parsed = 0
          if ([int]::TryParse((Get-Content -LiteralPath ${psString(childPidFile)} -Raw).Trim(), [ref]$parsed)) {
            $childPid = $parsed
          }
        }
        $childAlive = $false
        if ($childPid -gt 0) {
          try {
            $null = Get-Process -Id $childPid -ErrorAction Stop
            $childAlive = $true
          }
          catch { }
        }
        [pscustomobject]@{
          reason = [string]$transport.reason
          elapsedMs = [int64]$sw.ElapsedMilliseconds
          childAlive = $childAlive
          childPid = $childPid
        } | ConvertTo-Json -Compress
      `;
            const result = JSON.parse(runPwsh(script));
            expect(result.reason).toBe('claim_ownership_lost');
            expect(result.childPid).toBeGreaterThan(0);
            expect(result.childAlive).toBe(false);
            expect(result.elapsedMs).toBeLessThan(10000);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('kills-wrapper-spawned-child-on-supervised-gh-timeout', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'envelope-wrapper-tree-'));
        const childPidFile = path.join(dir, 'wrapper-child.pid');
        const monoStart = 22000000;
        try {
            const script = `
        $env:AO_REVIEW_START_MONOTONIC_NOW_MS = '${monoStart}'
        $env:AO_REVIEW_START_SUPERVISED_GH_COMMAND = ${psString(fakeGhPath)}
        $env:AO_REVIEW_START_GH_SCENARIO = 'wrapper_spawn_hang'
        $env:AO_REVIEW_START_WRAPPER_CHILD_PID_FILE = ${psString(childPidFile)}
        . ${psString(claimHelperPath)}
        . ${psString(lifecycleHelperPath)}
        . ${psString(supervisedGhPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        $claim = Acquire-ReviewStartClaim -PrNumber 510 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        $transport = Invoke-ReviewStartSupervisedGh -ClaimResult $claim -RepoRoot ${psString(repoRoot)} -GhArguments @() -DeadlineMs 500
        $childPid = 0
        if (Test-Path -LiteralPath ${psString(childPidFile)}) {
          $parsed = 0
          if ([int]::TryParse((Get-Content -LiteralPath ${psString(childPidFile)} -Raw), [ref]$parsed)) {
            $childPid = $parsed
          }
        }
        $childAlive = $false
        if ($childPid -gt 0) {
          try {
            $null = Get-Process -Id $childPid -ErrorAction Stop
            $childAlive = $true
          }
          catch { }
        }
        [pscustomobject]@{
          timedOut = [bool]$transport.timedOut
          childAlive = $childAlive
        } | ConvertTo-Json -Compress
      `;
            const result = JSON.parse(runPwsh(script));
            expect(result.timedOut).toBe(true);
            expect(result.childAlive).toBe(false);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('drains-redirected-gh-output-before-waiting-for-exit', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'envelope-large-stdout-'));
        const monoStart = 7000000;
        try {
            const script = `
        $env:AO_REVIEW_START_MONOTONIC_NOW_MS = '${monoStart}'
        $env:AO_REVIEW_START_SUPERVISED_GH_COMMAND = ${psString(fakeGhPath)}
        $env:AO_REVIEW_START_GH_SCENARIO = 'large_stdout'
        . ${psString(claimHelperPath)}
        . ${psString(lifecycleHelperPath)}
        . ${psString(supervisedGhPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        $claim = Acquire-ReviewStartClaim -PrNumber 510 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        $transport = Invoke-ReviewStartSupervisedGh -ClaimResult $claim -RepoRoot ${psString(repoRoot)} -GhArguments @('pr','list') -DeadlineMs 5000
        [pscustomobject]@{
          ok = [bool]$transport.ok
          timedOut = [bool]$transport.timedOut
          stdoutLength = [int]([string]$transport.stdout).Length
          failureClass = [string]$transport.failureClass
        } | ConvertTo-Json -Compress
      `;
            const result = JSON.parse(runPwsh(script));
            expect(result.timedOut).toBe(false);
            expect(result.ok).toBe(true);
            expect(result.stdoutLength).toBeGreaterThan(200000);
            expect(result.failureClass).not.toBe(INFRA_TRANSPORT_FAILURE_CLASS);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('preserves-first-attempt-monotonic-ms-across-recovered-claims', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'envelope-first-attempt-'));
        const firstMono = 50000000;
        const laterMono = firstMono + 310000;
        const config = resolveClaimLifecycleConfig({ attemptCeilingMs: 300000 });
        try {
            const script = `
        $env:AO_REVIEW_START_MONOTONIC_NOW_MS = '${firstMono}'
        . ${psString(claimHelperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        Initialize-ReviewStartClaimNamespace -Namespace $ns
        $record = New-ReviewStartClaimActiveRecord -PrNumber 510 -HeadSha $sha -Surface 'dead-starter' -Reason 'fixture'
        $record.holder.pid = 99999999
        $record.holder.startTimeTicks = '100'
        $record.holder.bootIdHash = 'dead-boot-hash'
        Write-ReviewStartClaimAtomic -Path (Get-ReviewStartClaimPath -Namespace $ns -PrNumber 510 -HeadSha $sha) -Record $record
        $env:AO_REVIEW_START_MONOTONIC_NOW_MS = '${laterMono}'
        $retry = Acquire-ReviewStartClaim -PrNumber 510 -HeadSha $sha -Surface 'recoverer' -Namespace $ns -ReviewRuns @()
        [pscustomobject]@{
          acquired = [bool]$retry.acquired
          recovered = [bool]$retry.recovered
          firstAttempt = [int64]$retry.claim.firstAttemptAtMonotonicMs
          readinessStart = [int64]$retry.claim.readinessStartMonotonicMs
        } | ConvertTo-Json -Compress
      `;
            const result = JSON.parse(runPwsh(script));
            expect(result.acquired).toBe(true);
            expect(result.recovered).toBe(true);
            expect(result.firstAttempt).toBe(firstMono);
            expect(result.readinessStart).toBe(laterMono);
            const ceiling = evaluateAttemptCeiling({
                claim: {
                    prNumber: 510,
                    headSha: fullSha,
                    firstAttemptAtMonotonicMs: result.firstAttempt,
                },
                nowMonotonicMs: laterMono,
                reviewRuns: [],
                config,
            });
            expect(ceiling.exceeded).toBe(true);
            expect(ceiling.reason).toBe('attempt_ceiling_exceeded');
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('readiness-envelope-uses-per-retry-start-after-terminal-reacquire', () => {
        const config = resolveClaimLifecycleConfig({ readinessEnvelopeMs: 30000 });
        const firstMono = 50000000;
        const laterMono = firstMono + 40000;
        const envelope = evaluateReadinessEnvelopeWithPause({
            claim: {
                firstAttemptAtMonotonicMs: firstMono,
                readinessStartMonotonicMs: laterMono,
                infraPauseSegments: [],
                acquiredAtUtc: '2026-06-28T12:00:00.000Z',
            },
            nowMs: Date.parse('2026-06-28T12:00:41.000Z'),
            nowMonotonicMs: laterMono + 1000,
            config,
        });
        expect(envelope.exceeded).toBe(false);
        expect(envelope.ageMs).toBe(1000);
    });
    it('supervised-gh-deadline-honors-configured-attempt-ceiling', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'envelope-gh-ceiling-'));
        const hangScript = path.join(dir, 'hang-gh.ps1');
        writeFileSync(hangScript, "Start-Sleep -Seconds 120\n");
        const firstMono = 10000000;
        const nowMono = firstMono + 50000;
        try {
            const script = `
        $env:AO_REVIEW_CLAIM_ATTEMPT_CEILING_MS = '60000'
        $env:AO_REVIEW_START_MONOTONIC_NOW_MS = '${firstMono}'
        $env:AO_REVIEW_START_SUPERVISED_GH_COMMAND = ${psString(hangScript)}
        . ${psString(claimHelperPath)}
        . ${psString(lifecycleHelperPath)}
        . ${psString(supervisedGhPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        $claim = Acquire-ReviewStartClaim -PrNumber 510 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        $env:AO_REVIEW_START_MONOTONIC_NOW_MS = '${nowMono}'
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $transport = Invoke-ReviewStartSupervisedGh -ClaimResult $claim -RepoRoot ${psString(repoRoot)} -GhArguments @()
        $sw.Stop()
        [pscustomobject]@{
          timedOut = [bool]$transport.timedOut
          elapsedMs = [int64]$sw.ElapsedMilliseconds
        } | ConvertTo-Json -Compress
      `;
            const result = JSON.parse(runPwsh(script));
            expect(result.timedOut).toBe(true);
            expect(result.elapsedMs).toBeLessThan(20000);
            expect(result.elapsedMs).toBeGreaterThan(1000);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('corrupt-run-evidence-blocks-before-attempt-ceiling', () => {
        const config = resolveClaimLifecycleConfig({ attemptCeilingMs: 300000 });
        const startMono = 10000000;
        const claim = {
            state: 'active',
            key: `pr-510-${fullSha}`,
            prNumber: 510,
            headSha: fullSha,
            firstAttemptAtMonotonicMs: startMono,
            holder: fakeHolder(),
            acquiredAtUtc: '2026-06-28T12:00:00.000Z',
        };
        const decision = evaluateReclaimDecision({
            claim,
            holderLiveness: { outcome: 'alive', reason: 'alive' },
            reviewRuns: [{ id: 'run-ambiguous', prNumber: 510, targetSha: fullSha, status: 'mystery' }],
            nowMs: Date.parse('2026-06-28T12:10:00.000Z'),
            nowMonotonicMs: startMono + 300001,
            config,
        });
        expect(decision.action).toBe('block');
        expect(decision.reason).toBe('corrupt_run_store_evidence');
    });
    it('preserves-first-attempt-monotonic-ms-across-aborted-by-recheck-retry', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'envelope-aborted-recheck-'));
        const firstMono = 60000000;
        const laterMono = firstMono + 120000;
        const config = resolveClaimLifecycleConfig({ attemptCeilingMs: 300000 });
        try {
            const script = `
        $env:AO_REVIEW_START_MONOTONIC_NOW_MS = '${firstMono}'
        . ${psString(claimHelperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(fullSha)}
        Initialize-ReviewStartClaimNamespace -Namespace $ns
        $first = Acquire-ReviewStartClaim -PrNumber 510 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        Complete-ReviewStartClaim -ClaimResult $first -Outcome 'aborted_by_recheck' -ReviewRuns @() -Extra @{ reason='transport_failure' } | Out-Null
        $env:AO_REVIEW_START_MONOTONIC_NOW_MS = '${laterMono}'
        $retry = Acquire-ReviewStartClaim -PrNumber 510 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        [pscustomobject]@{
          acquired = [bool]$retry.acquired
          recovered = [bool]$retry.recovered
          firstAttempt = [int64]$retry.claim.firstAttemptAtMonotonicMs
          readinessStart = [int64]$retry.claim.readinessStartMonotonicMs
        } | ConvertTo-Json -Compress
      `;
            const result = JSON.parse(runPwsh(script));
            expect(result.acquired).toBe(true);
            expect(result.recovered).toBe(false);
            expect(result.firstAttempt).toBe(firstMono);
            expect(result.readinessStart).toBe(laterMono);
            const ceiling = evaluateAttemptCeiling({
                claim: {
                    prNumber: 510,
                    headSha: fullSha,
                    firstAttemptAtMonotonicMs: result.firstAttempt,
                },
                nowMonotonicMs: laterMono,
                reviewRuns: [],
                config,
            });
            expect(ceiling.exceeded).toBe(false);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('hold-semantics-481-preserved', () => {
        const result = spawnSync(process.execPath, ['scripts/run-vitest-with-harness.mjs', 'run', 'review-start-claim-budget-semantics'], {
            cwd: repoRoot,
            encoding: 'utf8',
        });
        expect(result.status).toBe(0);
    }, 60000);
});
describe('review-start-envelope-external-io monotonic clock', () => {
    it('advances independently of wall clock', () => {
        const clock = createMonotonicClock(100);
        clock.advance(50000);
        expect(clock.now()).toBe(50100);
    });
});
