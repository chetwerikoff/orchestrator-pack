import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateOrchestratorTurnGate } from '../docs/orchestrator-claimed-review-run.mjs';
import { parseStructuredCommandOutput } from './lib/command-runtime-bootstrap.mjs';
import { functionBody, psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';
const ghPrChecksPath = path.join(repoRoot, 'scripts/lib/Gh-PrChecks.ps1');
const snapshotPath = path.join(repoRoot, 'scripts/lib/Get-ClaimedReviewStartSnapshot.ps1');
const seedPath = path.join(repoRoot, 'scripts/lib/Invoke-ReviewReadyReportStateSeed.ps1');
const fakeGhPath = path.join(repoRoot, 'scripts/fixtures/review-start-scoped-gh-json-capture/fake-gh-scenario.ps1');
const issue566Sha = '31fc8c6143c23e6db1b47fa8525aced110e2f84e';
describe('review-start scoped gh JSON capture (#566)', () => {
    const ghSrc = readFileSync(ghPrChecksPath, 'utf8');
    const scopedBody = functionBody(ghSrc, 'Invoke-GhOpenPrListForNumbers');
    const reviewStartBody = functionBody(ghSrc, 'Invoke-ReviewStartScopedGhPrView');
    const captureBody = functionBody(ghSrc, 'Invoke-GhPrViewStructuredCapture');
    it('static guard: scoped lookup does not merge stderr into JSON parse input', () => {
        expect(scopedBody).not.toMatch(/2>&1/);
        expect(reviewStartBody).toMatch(/Invoke-ReviewStartPreflightGhPrView/);
        expect(captureBody).toMatch(/RedirectStandardOutput\s*=\s*\$true/);
        expect(captureBody).toMatch(/RedirectStandardError\s*=\s*\$true/);
        expect(captureBody).toMatch(/ReadToEndAsync/);
        expect(captureBody).not.toMatch(/StandardOutput\.ReadToEnd\(\)/);
        expect(captureBody).not.toMatch(/StandardError\.ReadToEnd\(\)/);
        expect(captureBody).not.toMatch(/2>&1/);
        const snapshotSrc = readFileSync(snapshotPath, 'utf8');
        expect(snapshotSrc).toMatch(/Invoke-ReviewStartScopedGhPrView/);
        expect(snapshotSrc).not.toMatch(/Invoke-GhOpenPrListForNumbers/);
    });
    it('AC1: valid PR JSON stdout plus bash-debugger stderr resolves head from stdout only', () => {
        const stdout = JSON.stringify({
            number: 565,
            headRefOid: issue566Sha,
            baseRefName: 'main',
            state: 'OPEN',
        });
        const stderr = '/usr/share/bashdb/debugger-support.db: No such file or directory';
        const parsed = parseStructuredCommandOutput({ stdout, stderr });
        expect(parsed.ok).toBe(true);
        expect((parsed.value as {
            headRefOid?: string;
        }).headRefOid).toBe(issue566Sha);
        const dir = mkdtempSync(path.join(tmpdir(), 'scoped-gh-566-ac1-'));
        try {
            const script = `
        . ${psString(ghPrChecksPath)}
        $env:AO_REVIEW_START_SCOPED_GH_COMMAND = ${psString(fakeGhPath)}
        $env:AO_REVIEW_START_SCOPED_GH_SCENARIO = 'bashdb_stderr_valid_json'
        $env:AO_REVIEW_START_SCOPED_GH_HEAD_SHA = ${psString(issue566Sha)}
        $lookup = Invoke-ReviewStartScopedGhPrView -RepoRoot ${psString(repoRoot)} -PrNumber 565
        [pscustomobject]@{
          transportFailure = [bool]$lookup.transportFailure
          head = [string]$lookup.openPrs[0].headRefOid
          count = @($lookup.openPrs).Count
        } | ConvertTo-Json -Compress
      `;
            const result = JSON.parse(runPwsh(script));
            expect(result.transportFailure).toBe(false);
            expect(result.count).toBe(1);
            expect(result.head).toBe(issue566Sha);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('AC2: malformed stdout yields infrastructure denial, not empty open-PR masquerade', () => {
        const polluted = parseStructuredCommandOutput({ stdout: 'not-json', stderr: '' });
        expect(polluted.ok).toBe(false);
        expect(polluted.reason).toMatch(/malformed_child_output|structured_output_polluted/);
        const script = `
      . ${psString(ghPrChecksPath)}
      $env:AO_REVIEW_START_SCOPED_GH_COMMAND = ${psString(fakeGhPath)}
      $env:AO_REVIEW_START_SCOPED_GH_SCENARIO = 'malformed_stdout'
      $lookup = Invoke-ReviewStartScopedGhPrView -RepoRoot ${psString(repoRoot)} -PrNumber 565
      [pscustomobject]@{
        count = @($lookup.openPrs).Count
        reason = [string]$lookup.transportFailure.reason
      } | ConvertTo-Json -Compress
    `;
        const result = JSON.parse(runPwsh(script));
        expect(result.count).toBe(0);
        expect(result.reason).toMatch(/malformed_child_output|structured_output_polluted/);
        expect(result.reason).not.toBe('head_resolution_failed');
    });
    it('AC2b: non-zero gh exit reports gh_command_failed before parse-failure reasons', () => {
        const script = `
      . ${psString(ghPrChecksPath)}
      $env:AO_REVIEW_START_SCOPED_GH_COMMAND = ${psString(fakeGhPath)}
      $env:AO_REVIEW_START_SCOPED_GH_SCENARIO = 'gh_command_failed'
      $lookup = Invoke-ReviewStartScopedGhPrView -RepoRoot ${psString(repoRoot)} -PrNumber 565
      [pscustomobject]@{
        count = @($lookup.openPrs).Count
        reason = [string]$lookup.transportFailure.reason
      } | ConvertTo-Json -Compress
    `;
        const result = JSON.parse(runPwsh(script));
        expect(result.count).toBe(0);
        expect(result.reason).toBe('gh_command_failed');
        expect(result.reason).not.toMatch(/empty_child_output|malformed_child_output/);
    });
    it('AC2c: drains stdout and stderr concurrently without pipe deadlock', () => {
        const script = `
      . ${psString(ghPrChecksPath)}
      $env:AO_REVIEW_START_SCOPED_GH_COMMAND = ${psString(fakeGhPath)}
      $env:AO_REVIEW_START_SCOPED_GH_SCENARIO = 'fill_stderr_then_valid_json'
      $env:AO_REVIEW_START_SCOPED_GH_HEAD_SHA = ${psString(issue566Sha)}
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      $lookup = Invoke-ReviewStartScopedGhPrView -RepoRoot ${psString(repoRoot)} -PrNumber 565
      $sw.Stop()
      [pscustomobject]@{
        elapsedSec = $sw.Elapsed.TotalSeconds
        transportFailure = [bool]$lookup.transportFailure
        head = [string]$lookup.openPrs[0].headRefOid
      } | ConvertTo-Json -Compress
    `;
        const result = JSON.parse(runPwsh(script));
        expect(result.elapsedSec).toBeLessThan(10);
        expect(result.transportFailure).toBe(false);
        expect(result.head).toBe(issue566Sha);
    });
    it('AC3 positive-outcome: harmless stderr does not deny review-start for green uncovered ready head', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'scoped-gh-566-ac3-'));
        try {
            const script = `
        . ${psString(helperPath)}
        $env:AO_REVIEW_CLAIM_DIR = ${psString(path.join(dir, 'claims'))}
        $env:AO_REVIEW_START_SCOPED_GH_COMMAND = ${psString(fakeGhPath)}
        $env:AO_REVIEW_START_SCOPED_GH_SCENARIO = 'bashdb_stderr_valid_json'
        $env:AO_REVIEW_START_SCOPED_GH_HEAD_SHA = ${psString(issue566Sha)}
        function Invoke-GhOpenPrList {
          param([string]$RepoRoot)
          throw 'full open-PR list must not run on claimed review-start path'
        }
        function Get-AoReviewRuns { param([string]$Project) @() }
        function Get-AoStatusSessions {
          @(@{
            name = 'opk-566'
            role = 'worker'
            prNumber = 565
            status = 'ready_for_review'
            reports = @(@{ reportState = 'ready_for_review'; reportedAt = '2026-07-01T00:00:00.000Z'; headRefOid = ${psString(issue566Sha)} })
          })
        }
        function Get-GhChecksBundleByPr {
          param([string]$RepoRoot, [array]$OpenPrs, [scriptblock]$MergeRequiredNames, [string]$ProtectionLookupWarningTemplate)
          @{
            ciChecksByPr = @{
              '565' = @(
                @{ name = 'Verify orchestrator-pack structure'; state = 'SUCCESS' },
                @{ name = 'PR scope guard'; state = 'SUCCESS' },
                @{ name = 'Run pack contract tests'; state = 'SUCCESS' },
                @{ name = 'Self-architect lint'; state = 'SUCCESS' }
              )
            }
            requiredCheckNamesByPr = @{
              '565' = @(
                'Verify orchestrator-pack structure',
                'PR scope guard',
                'Run pack contract tests',
                'Self-architect lint'
              )
            }
            requiredCheckLookupFailedByPr = @{ '565' = $false }
          }
        }
        $result = Invoke-OrchestratorClaimedReviewRun -SessionId 'opk-566' -ReviewCommand 'echo review' -PrNumber 565 -Project 'orchestrator-pack' -RepoRoot ${psString(repoRoot)} -DryRun -AuditRoot ${psString(path.join(dir, 'audit'))} -LogWriter { param($m) }
        [pscustomobject]@{
          started = [bool]$result.started
          reason = [string]$result.reason
          deniedBeforeClaim = [bool]$result.deniedBeforeClaim
        } | ConvertTo-Json -Compress
      `;
            const result = JSON.parse(runPwsh(script));
            expect(result.deniedBeforeClaim).toBe(false);
            expect(result.started).toBe(true);
            expect(result.reason).toBe('dry_run');
            expect(result.reason).not.toBe('head_resolution_failed');
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('AC5 diagnostic matrix preserves infrastructure vs PR-state vs command failures', () => {
        const openWithStderr = evaluateOrchestratorTurnGate({
            prNumber: 565,
            openPrs: [{ number: 565, headRefOid: issue566Sha, baseRefName: 'main' }],
            reviewRuns: [],
            sessions: [{ name: 'opk-566', prNumber: 565, status: 'ready_for_review' }],
            sessionId: 'opk-566',
            provenanceAutonomous: true,
        });
        expect(openWithStderr.reason).not.toBe('head_resolution_failed');
        const infra = evaluateOrchestratorTurnGate({
            prNumber: 565,
            openPrs: [],
            transportFailure: { ok: false, reason: 'structured_output_polluted' },
            provenanceAutonomous: true,
        });
        expect(infra.launch).toBe(false);
        expect(infra.reason).toBe('structured_output_polluted');
        const missing = evaluateOrchestratorTurnGate({
            prNumber: 565,
            openPrs: [],
            provenanceAutonomous: true,
        });
        expect(missing.reason).toBe('head_resolution_failed');
        const ghFailed = evaluateOrchestratorTurnGate({
            prNumber: 565,
            openPrs: [],
            transportFailure: { ok: false, reason: 'gh_command_failed' },
            provenanceAutonomous: true,
        });
        expect(ghFailed.reason).toBe('gh_command_failed');
        const closedScript = `
      . ${psString(ghPrChecksPath)}
      $env:AO_REVIEW_START_SCOPED_GH_COMMAND = ${psString(fakeGhPath)}
      $env:AO_REVIEW_START_SCOPED_GH_SCENARIO = 'closed_pr'
      $lookup = Invoke-ReviewStartScopedGhPrView -RepoRoot ${psString(repoRoot)} -PrNumber 565
      [pscustomobject]@{
        count = @($lookup.openPrs).Count
        transportFailure = [bool]$lookup.transportFailure
        targetStateDenial = [bool]$lookup.targetStateDenial
        reason = [string]$lookup.targetStateDenial.reason
      } | ConvertTo-Json -Compress
    `;
        const closed = JSON.parse(runPwsh(closedScript));
        expect(closed.count).toBe(0);
        expect(closed.transportFailure).toBe(false);
        expect(closed.targetStateDenial).toBe(true);
        expect(closed.reason).toBe('pr_not_open');
    });
    it('AC3b: pre-claim scoped transport failure short-circuits before live AO reads', () => {
        const script = `
      function Get-AoReviewRuns { throw 'ao unavailable without agent-orchestrator.yaml' }
      function Get-AoStatusSessions { throw 'ao unavailable without agent-orchestrator.yaml' }
      . ${psString(snapshotPath)}
      $env:AO_REVIEW_START_SCOPED_GH_COMMAND = ${psString(fakeGhPath)}
      $env:AO_REVIEW_START_SCOPED_GH_SCENARIO = 'malformed_stdout'
      $snap = Get-ClaimedReviewStartSnapshot -PrNumber 565 -Project 'orchestrator-pack' -RepoRoot ${psString(repoRoot)} -ClaimResult $null -ResolveChecksBundle {
        param($openPrs, $prNumber, $repoRoot)
        @{ ciChecksByPr = @{}; requiredCheckNamesByPr = @{}; requiredCheckLookupFailedByPr = @{} }
      }
      [pscustomobject]@{
        transportOk = [bool]$snap.transportFailure.ok
        reason = [string]$snap.transportFailure.reason
        reviewRunCount = @($snap.reviewRuns).Count
        sessionCount = @($snap.sessions).Count
      } | ConvertTo-Json -Compress
    `;
        const result = JSON.parse(runPwsh(script));
        expect(result.transportOk).toBe(false);
        expect(result.reason).toMatch(/malformed_child_output|structured_output_polluted/);
        expect(result.reviewRunCount).toBe(0);
        expect(result.sessionCount).toBe(0);
    });
    it('AC4: pre-claim infrastructure denial does not acquire review-start claim', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'scoped-gh-566-ac4-'));
        try {
            const script = `
        . ${psString(helperPath)}
        $env:AO_REVIEW_CLAIM_DIR = ${psString(path.join(dir, 'claims'))}
        $env:AO_REVIEW_START_SCOPED_GH_COMMAND = ${psString(fakeGhPath)}
        $env:AO_REVIEW_START_SCOPED_GH_SCENARIO = 'malformed_stdout'
        function Get-AoReviewRuns { param([string]$Project) @() }
        function Get-AoStatusSessions { return @() }
        function Get-GhChecksBundleByPr {
          param([string]$RepoRoot, [array]$OpenPrs, [scriptblock]$MergeRequiredNames, [string]$ProtectionLookupWarningTemplate)
          @{ ciChecksByPr = @{}; requiredCheckNamesByPr = @{}; requiredCheckLookupFailedByPr = @{} }
        }
        $result = Invoke-OrchestratorClaimedReviewRun -SessionId 'opk-566' -ReviewCommand 'echo review' -PrNumber 565 -Project 'orchestrator-pack' -RepoRoot ${psString(repoRoot)} -DryRun -AuditRoot ${psString(path.join(dir, 'audit'))} -LogWriter { param($m) }
        $claimFiles = @(Get-ChildItem -LiteralPath ${psString(path.join(dir, 'claims'))} -File -ErrorAction SilentlyContinue)
        [pscustomobject]@{
          deniedBeforeClaim = [bool]$result.deniedBeforeClaim
          reason = [string]$result.reason
          claimCount = $claimFiles.Count
        } | ConvertTo-Json -Compress
      `;
            const result = JSON.parse(runPwsh(script));
            expect(result.deniedBeforeClaim).toBe(true);
            expect(result.reason).toMatch(/malformed_child_output|structured_output_polluted/);
            expect(result.claimCount).toBe(0);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('AC6 static guard: no workaround transports in scoped capture path', () => {
        const forbidden = /curl\s+api\.github\.com|gh api graphql|unset GH_WRAPPER_ACTIVE|\/tmp\/gh-rest-bin/;
        expect(captureBody).not.toMatch(forbidden);
        expect(reviewStartBody).not.toMatch(forbidden);
    });
    it('AC7: report-state seed scoped transport failure short-circuits before live reads', () => {
        const src = readFileSync(seedPath, 'utf8');
        const block = src.match(/if \(\$lookup\.transportFailure\) \{([\s\S]*?)\n                    \}/);
        expect(block).not.toBeNull();
        const body = block![1];
        expect(body).not.toMatch(/Get-GhChecksBundleByPr/);
        expect(body).not.toMatch(/Get-AoReviewRuns/);
        expect(body).not.toMatch(/Get-AoStatusSessionsIncludingTerminated/);
        expect(body).toMatch(/transportFailure\s*=\s*\$lookup\.transportFailure/);
    });
    it('AC7b: report-state seed denies before reeval on scoped transport failure', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'scoped-gh-566-ac7-'));
        try {
            const script = `
        . ${psString(seedPath)}
        $env:AO_REVIEW_CLAIM_DIR = ${psString(dir)}
        $env:AO_REVIEW_START_SCOPED_GH_COMMAND = ${psString(fakeGhPath)}
        $env:AO_REVIEW_START_SCOPED_GH_SCENARIO = 'malformed_stdout'
        $denial = Get-ReportStateSeedPreClaimTransportDenial -PrNumber 565 -RepoRoot ${psString(repoRoot)}
        $claimFiles = @(Get-ChildItem -LiteralPath ${psString(dir)} -Recurse -File -ErrorAction SilentlyContinue)
        [pscustomobject]@{
          denied = [bool]$denial
          reason = [string]$denial.reason
          claimFileCount = $claimFiles.Count
        } | ConvertTo-Json -Compress
      `;
            const result = JSON.parse(runPwsh(script));
            expect(result.denied).toBe(true);
            expect(result.reason).toBe('supervised_gh_transport_failure');
            expect(result.claimFileCount).toBe(0);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('AC7c: report-state seed skips reeval invoke when pre-claim transport denied', () => {
        const src = readFileSync(seedPath, 'utf8');
        expect(src).toMatch(/Get-ReportStateSeedPreClaimTransportDenial/);
        expect(src).toMatch(/if \(\$preClaimDenial\)/);
        expect(src).toMatch(/if \(-not \$result\) \{\s*\n\s*\$result = Invoke-ReviewTriggerReevalPlannedRun/);
    });
});
