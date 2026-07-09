import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { evaluateOrchestratorTurnGate } from '../docs/orchestrator-claimed-review-run.mjs';
import { functionBody, psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';
import {
  claimHelperPath,
  driftHeadB,
  fakeGhPath,
  ghPrChecksPath,
  listShieldAuditRecords,
  runScopedPreflight,
  shieldHelperPath,
  snapshotPath,
  stableHead,
} from './_test-review-start-preflight-shield-fixture.js';

describe('review-start preflight transient shield (#584)', () => {
  describe('static wiring', () => {
    it('routes scoped and claimed snapshot reads through the shield', () => {
      const ghSrc = readFileSync(ghPrChecksPath, 'utf8');
      const snapshotSrc = readFileSync(snapshotPath, 'utf8');
      expect(functionBody(ghSrc, 'Invoke-ReviewStartScopedGhPrView')).toMatch(/Invoke-ReviewStartPreflightGhPrView/);
      expect(snapshotSrc).toMatch(/Invoke-ReviewStartPreflightGhPrView/);
      const shieldSrc = readFileSync(shieldHelperPath, 'utf8');
      expect(functionBody(shieldSrc, 'Invoke-ReviewStartPreflightGhSingleCapture')).toMatch(/CaptureTimeoutMs/);
      expect(functionBody(shieldSrc, 'Invoke-ReviewStartPreflightGhPrView')).toMatch(/Resolve-ReviewStartPreflightShieldCaptureTimeoutMs/);
    });

    it('allocates and cleans a fresh implicit AO_BASE_DIR per PowerShell run', () => {
      const firstAoBase = runPwsh('$env:AO_BASE_DIR');
      const secondAoBase = runPwsh('$env:AO_BASE_DIR');
      expect(firstAoBase).toBeTruthy();
      expect(secondAoBase).toBeTruthy();
      expect(secondAoBase).not.toBe(firstAoBase);
      expect(existsSync(firstAoBase)).toBe(false);
      expect(existsSync(secondAoBase)).toBe(false);
    });

    it('resolves the implicit shield audit root under test-scoped AO_BASE_DIR', () => {
      const result = runScopedPreflight(
        `
      $env:AO_REVIEW_START_SCOPED_GH_COMMAND = ${psString(fakeGhPath)}
      $env:AO_REVIEW_START_SCOPED_GH_SCENARIO = 'always_rate_limit'
      $env:AO_REVIEW_START_SCOPED_GH_HEAD_SHA = ${psString(stableHead)}
      $env:AO_REVIEW_START_PREFLIGHT_SHIELD_MAX_ATTEMPTS = '1'
      $null = Invoke-ReviewStartPreflightGhPrView -RepoRoot ${psString(repoRoot)} -PrNumber 584
      $auditRoot = Get-OrchestratorReviewStartAuditRoot
      [pscustomobject]@{
        aoBase = [string]$env:AO_BASE_DIR
        auditRoot = [string]$auditRoot
        shieldAuditCount = @(
          Get-ChildItem -LiteralPath (Join-Path $auditRoot 'preflight-shield') -File -ErrorAction Stop
        ).Count
      } | ConvertTo-Json -Compress
    `,
      );
      expect(result.aoBase).toBeTruthy();
      expect(result.auditRoot.startsWith(result.aoBase)).toBe(true);
      expect(result.shieldAuditCount).toBeGreaterThan(0);
    });
  });

  describe('AC1 transient retry positive path', () => {
    it('retries primary 403 then succeeds with bounded jittered backoff', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'preflight-shield-ac1-'));
      const auditRoot = mkdtempSync(path.join(tmpdir(), 'preflight-shield-audit-ac1-'));
      const stateFile = path.join(dir, 'attempt.count');
      try {
        const result = runScopedPreflight(
          `
        $env:AO_REVIEW_START_SCOPED_GH_COMMAND = ${psString(fakeGhPath)}
        $env:AO_REVIEW_START_SCOPED_GH_SCENARIO = 'primary_rate_limit_then_ok'
        $env:AO_REVIEW_START_SCOPED_GH_STATE_FILE = ${psString(stateFile)}
        $env:AO_REVIEW_START_SCOPED_GH_HEAD_SHA = ${psString(stableHead)}
        $env:AO_REVIEW_START_PREFLIGHT_SHIELD_JITTER_MS = '0'
        $lookup = Invoke-ReviewStartPreflightGhPrView -RepoRoot ${psString(repoRoot)} -PrNumber 584 -AuditRoot ${psString(auditRoot)}
        [pscustomobject]@{
          transportFailure = [bool]$lookup.transportFailure
          head = [string]$lookup.openPrs[0].headRefOid
          attempts = [int](Get-Content -LiteralPath ${psString(stateFile)} -Raw)
        } | ConvertTo-Json -Compress
      `,
        );
        expect(result.transportFailure).toBe(false);
        expect(result.head).toBe(stableHead);
        expect(result.attempts).toBeGreaterThanOrEqual(2);
        const audits = listShieldAuditRecords(auditRoot);
        expect(audits.some((row) => row.disposition === 'transient_retry' && row.prNumber === 584)).toBe(true);
        expect(audits.every((row) => Object.prototype.hasOwnProperty.call(row, 'prNumber'))).toBe(true);
        expect(
          audits
            .filter((row) => row.disposition === 'transient_retry' || row.disposition === 'exhausted')
            .every((row) => typeof row.headSha === 'string' && row.headSha.length === 40),
        ).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(auditRoot, { recursive: true, force: true });
      }
    });
  });

  describe('AC2 fresh head on every retry', () => {
    it('re-reads drifted head after backoff without starting on old head', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'preflight-shield-ac2-'));
      const stateFile = path.join(dir, 'attempt.count');
      try {
        const result = runScopedPreflight(
          `
        $env:AO_REVIEW_START_SCOPED_GH_COMMAND = ${psString(fakeGhPath)}
        $env:AO_REVIEW_START_SCOPED_GH_SCENARIO = 'head_drift_then_ok'
        $env:AO_REVIEW_START_SCOPED_GH_STATE_FILE = ${psString(stateFile)}
        $env:AO_REVIEW_START_SCOPED_GH_HEAD_SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        $env:AO_REVIEW_START_SCOPED_GH_HEAD_SHA_B = ${psString(driftHeadB)}
        $env:AO_REVIEW_START_PREFLIGHT_SHIELD_JITTER_MS = '0'
        $lookup = Invoke-ReviewStartPreflightGhPrView -RepoRoot ${psString(repoRoot)} -PrNumber 584
        [pscustomobject]@{
          transportFailure = [bool]$lookup.transportFailure
          head = [string]$lookup.openPrs[0].headRefOid
        } | ConvertTo-Json -Compress
      `,
        );
        expect(result.transportFailure).toBe(false);
        expect(result.head).toBe(driftHeadB);
        expect(result.head).not.toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('AC3 no side effects on exhaustion', () => {
    it('returns preflight_transient_exhausted without open PR masquerade', () => {
      const result = runScopedPreflight(
        `
      $env:AO_REVIEW_START_SCOPED_GH_COMMAND = ${psString(fakeGhPath)}
      $env:AO_REVIEW_START_SCOPED_GH_SCENARIO = 'always_rate_limit'
      $env:AO_REVIEW_START_PREFLIGHT_SHIELD_MAX_ATTEMPTS = '2'
      $env:AO_REVIEW_START_PREFLIGHT_SHIELD_JITTER_MS = '0'
      $lookup = Invoke-ReviewStartPreflightGhPrView -RepoRoot ${psString(repoRoot)} -PrNumber 584
      [pscustomobject]@{
        count = @($lookup.openPrs).Count
        reason = [string]$lookup.transportFailure.reason
        failureClass = [string]$lookup.transportFailure.failureClass
      } | ConvertTo-Json -Compress
    `,
      );
      expect(result.count).toBe(0);
      expect(result.reason).toBe('preflight_transient_exhausted');
      expect(result.failureClass).toBe('infra_transport');
    });
  });

  describe('final configured attempt', () => {
    it('runs the second capture when maxAttempts is 2 and first transient failure recovers', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'preflight-shield-final-'));
      const stateFile = path.join(dir, 'attempt.count');
      try {
        const result = runScopedPreflight(
          `
        $env:AO_REVIEW_START_SCOPED_GH_COMMAND = ${psString(fakeGhPath)}
        $env:AO_REVIEW_START_SCOPED_GH_SCENARIO = 'primary_rate_limit_then_ok'
        $env:AO_REVIEW_START_SCOPED_GH_STATE_FILE = ${psString(stateFile)}
        $env:AO_REVIEW_START_SCOPED_GH_HEAD_SHA = ${psString(stableHead)}
        $env:AO_REVIEW_START_PREFLIGHT_SHIELD_MAX_ATTEMPTS = '2'
        $env:AO_REVIEW_START_PREFLIGHT_SHIELD_JITTER_MS = '0'
        $lookup = Invoke-ReviewStartPreflightGhPrView -RepoRoot ${psString(repoRoot)} -PrNumber 584
        [pscustomobject]@{
          transportFailure = [bool]$lookup.transportFailure
          head = [string]$lookup.openPrs[0].headRefOid
          attempts = [int](Get-Content -LiteralPath ${psString(stateFile)} -Raw)
        } | ConvertTo-Json -Compress
      `,
        );
        expect(result.transportFailure).toBe(false);
        expect(result.head).toBe(stableHead);
        expect(result.attempts).toBe(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('remaining budget capture cap', () => {
    it('resolves capture timeout as the minimum of configured and remaining budget', () => {
      const result = JSON.parse(runPwsh(
        `
        . ${psString(path.join(repoRoot, 'scripts/lib/Review-StartPreflightShield.ps1'))}
        $env:AO_REVIEW_START_PREFLIGHT_SHIELD_CAPTURE_TIMEOUT_MS = '800'
        [pscustomobject]@{
          configured = Resolve-ReviewStartPreflightShieldCaptureTimeoutMs -RemainingBudgetMs 900
          capped = Resolve-ReviewStartPreflightShieldCaptureTimeoutMs -RemainingBudgetMs 200
          floored = Resolve-ReviewStartPreflightShieldCaptureTimeoutMs -RemainingBudgetMs 1
          zero = Resolve-ReviewStartPreflightShieldCaptureTimeoutMs -RemainingBudgetMs 0
        } | ConvertTo-Json -Compress
      `,
      ));
      expect(result.configured).toBe(800);
      expect(result.capped).toBe(200);
      expect(result.floored).toBe(1);
      expect(result.zero).toBe(0);
    });
  });

  describe('unclaimed capture timeout', () => {
    it('classifies a hanging scoped gh pr view as transient timeout and retries', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'preflight-shield-timeout-'));
      const stateFile = path.join(dir, 'attempt.count');
      try {
        const result = runScopedPreflight(
          `
        $lookup = Invoke-ReviewStartPreflightGhPrView -RepoRoot ${psString(repoRoot)} -PrNumber 584
        [pscustomobject]@{
          transportFailure = [bool]$lookup.transportFailure
          head = [string]$lookup.openPrs[0].headRefOid
          attempts = [int](Get-Content -LiteralPath ${psString(stateFile)} -Raw)
        } | ConvertTo-Json -Compress
      `,
          {
            AO_REVIEW_START_SCOPED_GH_COMMAND: fakeGhPath,
            AO_REVIEW_START_SCOPED_GH_SCENARIO: 'hang_then_ok',
            AO_REVIEW_START_SCOPED_GH_STATE_FILE: stateFile,
            AO_REVIEW_START_SCOPED_GH_HEAD_SHA: stableHead,
            AO_REVIEW_START_PREFLIGHT_SHIELD_CAPTURE_TIMEOUT_MS: '2000',
            AO_REVIEW_START_PREFLIGHT_SHIELD_MAX_ATTEMPTS: '2',
            AO_REVIEW_START_PREFLIGHT_SHIELD_JITTER_MS: '0',
          },
        );
        expect(result.transportFailure).toBe(false);
        expect(result.head).toBe(stableHead);
        expect(result.attempts).toBe(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('AC5 no-claim sibling cell', () => {
    it('scoped success produces data but orchestrator gate still denies without claim path side effects', () => {
      const lookup = runScopedPreflight(
        `
      $env:AO_REVIEW_START_SCOPED_GH_COMMAND = ${psString(fakeGhPath)}
      $env:AO_REVIEW_START_SCOPED_GH_SCENARIO = 'bashdb_stderr_valid_json'
      $env:AO_REVIEW_START_SCOPED_GH_HEAD_SHA = ${psString(stableHead)}
      $lookup = Invoke-ReviewStartScopedGhPrView -RepoRoot ${psString(repoRoot)} -PrNumber 584
      [pscustomobject]@{
        count = @($lookup.openPrs).Count
        head = [string]$lookup.openPrs[0].headRefOid
      } | ConvertTo-Json -Compress
    `,
      );
      expect(lookup.count).toBe(1);
      const gate = evaluateOrchestratorTurnGate({
        prNumber: 584,
        provenanceAutonomous: true,
        openPrs: [{ number: 584, headRefOid: stableHead, baseRefName: 'main' } as { number: number; headRefOid: string; baseRefName: string }],
        reviewRuns: [],
        sessions: [],
        ciChecks: [],
        requiredCheckNames: [],
        requiredCheckLookupFailed: false,
        sessionId: 'sess-584',
        claimWindow: 'free',
      });
      expect(gate.launch).toBe(false);
      expect(gate.reason).not.toBe('gh_command_failed');
    });
  });

});
