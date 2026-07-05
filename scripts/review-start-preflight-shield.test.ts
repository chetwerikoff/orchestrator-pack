import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyPreflightGhOutcome,
  computePreflightBackoffMs,
  evaluatePreflightRetryBudget,
  parseRateLimitHeadersFromStderr,
} from '../docs/review-start-preflight-shield.mjs';
import { evaluateOrchestratorTurnGate } from '../docs/orchestrator-claimed-review-run.mjs';
import { functionBody, psString, repoRoot, runPwsh } from './_test-pwsh-helpers.js';

const shieldHelperPath = path.join(repoRoot, 'scripts/lib/Review-StartPreflightShield.ps1');
const ghPrChecksPath = path.join(repoRoot, 'scripts/lib/Gh-PrChecks.ps1');
const snapshotPath = path.join(repoRoot, 'scripts/lib/Get-ClaimedReviewStartSnapshot.ps1');
const claimHelperPath = path.join(repoRoot, 'scripts/lib/Review-StartClaim.ps1');
const fakeGhPath = path.join(
  repoRoot,
  'scripts/fixtures/review-start-scoped-gh-json-capture/fake-gh-scenario.ps1',
);

const stableHead = '31fc8c6143c23e6db1b47fa8525aced110e2f84e';
const driftHeadB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function runScopedPreflight(scriptBody: string, env: Record<string, string> = {}) {
  const script = `
    . ${psString(shieldHelperPath)}
  ${scriptBody}
  `;
  return JSON.parse(runPwsh(script, env));
}

function listShieldAuditRecords(auditRoot: string) {
  const dir = path.join(auditRoot, 'preflight-shield');
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8')));
  } catch {
    return [];
  }
}

describe('review-start preflight transient shield (#584)', () => {
  describe('mechanical classifier', () => {
    it('classifies primary rate-limit 403 as transient', () => {
      const result = classifyPreflightGhOutcome({
        exitCode: 1,
        stderr: 'HTTP 403: API rate limit exceeded for user',
      });
      expect(result.disposition).toBe('transient');
      expect(result.reason).toBe('rate_limit');
    });

    it('classifies 429 and 5xx as transient', () => {
      expect(classifyPreflightGhOutcome({ exitCode: 1, stderr: 'HTTP 429: Too Many Requests' }).disposition).toBe(
        'transient',
      );
      expect(classifyPreflightGhOutcome({ exitCode: 1, stderr: 'HTTP 502: Bad Gateway' }).disposition).toBe(
        'transient',
      );
    });

    it('classifies abuse-detection 403 as transient', () => {
      const result = classifyPreflightGhOutcome({
        exitCode: 1,
        stderr:
          'retry-after: 1\nHTTP 403: You have triggered an abuse detection mechanism. Please wait before retrying.',
      });
      expect(result.disposition).toBe('transient');
      expect(result.reason).toBe('rate_limit');
    });

    it('classifies auth and parse pollution as terminal', () => {
      expect(classifyPreflightGhOutcome({ exitCode: 1, stderr: 'HTTP 401: Bad credentials' }).disposition).toBe(
        'terminal',
      );
      expect(
        classifyPreflightGhOutcome({ exitCode: 0, parseOk: false, parseReason: 'structured_output_polluted' })
          .disposition,
      ).toBe('terminal');
    });

    it('honors retry-after headers and degrades without headers', () => {
      const headers = parseRateLimitHeadersFromStderr('retry-after: 2\nx-ratelimit-remaining: 0\n');
      const withHeaders = computePreflightBackoffMs({ attempt: 1, headers, injectedJitterMs: 0 });
      expect(withHeaders.backoffMs).toBe(2000);
      expect(withHeaders.headerDegraded).toBe(false);

      const withoutHeaders = computePreflightBackoffMs({ attempt: 1, headers: {}, injectedJitterMs: 50 });
      expect(withoutHeaders.headerDegraded).toBe(true);
      expect(withoutHeaders.backoffMs).toBeGreaterThanOrEqual(1050);
    });

    it('evaluates retry budget exhaustion', () => {
      const exhausted = evaluatePreflightRetryBudget({
        attempt: 4,
        maxAttempts: 4,
        startedMonotonicMs: 0,
        nowMonotonicMs: 1000,
        wallClockBudgetMs: 60_000,
      });
      expect(exhausted.canRetry).toBe(false);
    });

    it('allows the final configured capture when attempt equals maxAttempts', () => {
      const finalCapture = evaluatePreflightRetryBudget({
        attempt: 2,
        maxAttempts: 2,
        startedMonotonicMs: 0,
        nowMonotonicMs: 1000,
        wallClockBudgetMs: 60_000,
      });
      expect(finalCapture.canCapture).toBe(true);
      expect(finalCapture.canRetry).toBe(false);
      expect(finalCapture.attemptsRemaining).toBe(1);
    });
  });

  describe('static wiring', () => {
    it('routes scoped and claimed snapshot reads through the shield', () => {
      const ghSrc = readFileSync(ghPrChecksPath, 'utf8');
      const snapshotSrc = readFileSync(snapshotPath, 'utf8');
      expect(functionBody(ghSrc, 'Invoke-ReviewStartScopedGhPrView')).toMatch(/Invoke-ReviewStartPreflightGhPrView/);
      expect(snapshotSrc).toMatch(/Invoke-ReviewStartPreflightGhPrView/);
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

  describe('AC6 terminal guard', () => {
    it.each([
      ['gh_auth_failed', 'gh_auth_failed'],
      ['policy_denied', 'policy_denied'],
      ['malformed_stdout', 'structured_output_polluted'],
      ['gh_command_failed', 'gh_command_failed'],
      ['closed_pr', 'pr_not_open'],
    ])('scenario %s stays terminal (%s)', (scenario, expectedReason) => {
      const result = runScopedPreflight(
        `
      $env:AO_REVIEW_START_SCOPED_GH_COMMAND = ${psString(fakeGhPath)}
      $env:AO_REVIEW_START_SCOPED_GH_SCENARIO = ${psString(scenario)}
      $lookup = Invoke-ReviewStartPreflightGhPrView -RepoRoot ${psString(repoRoot)} -PrNumber 584
      [pscustomobject]@{
        reason = [string]$lookup.transportFailure.reason
        count = @($lookup.openPrs).Count
        transportFailure = [bool]$lookup.transportFailure
      } | ConvertTo-Json -Compress
    `,
      );
      expect(result.count).toBe(0);
      if (scenario === 'malformed_stdout') {
        expect(result.reason).toMatch(/malformed_child_output|structured_output_polluted/);
      } else {
        expect(result.reason).toBe(expectedReason);
      }
      expect(result.transportFailure).toBe(true);
    });
  });

  describe('AC8 audit head keying', () => {
    it('keys exhausted transient audits with PR number and head SHA', () => {
      const auditRoot = mkdtempSync(path.join(tmpdir(), 'preflight-shield-audit-ac8-'));
      try {
        runPwsh(
          `
        . ${psString(shieldHelperPath)}
        $env:AO_REVIEW_START_SCOPED_GH_COMMAND = ${psString(fakeGhPath)}
        $env:AO_REVIEW_START_SCOPED_GH_SCENARIO = 'always_rate_limit'
        $env:AO_REVIEW_START_SCOPED_GH_HEAD_SHA = ${psString(stableHead)}
        $env:AO_REVIEW_START_PREFLIGHT_SHIELD_MAX_ATTEMPTS = '1'
        $null = Invoke-ReviewStartPreflightGhPrView -RepoRoot ${psString(repoRoot)} -PrNumber 584 -AuditRoot ${psString(auditRoot)}
        'done'
      `,
        );
        const audits = listShieldAuditRecords(auditRoot);
        expect(audits.some((row) => row.disposition === 'exhausted' && row.prNumber === 584)).toBe(true);
        expect(
          audits
            .filter((row) => row.disposition === 'exhausted')
            .every((row) => row.headSha === stableHead),
        ).toBe(true);
      } finally {
        rmSync(auditRoot, { recursive: true, force: true });
      }
    });
  });

  describe('AC4 grant expiry during backoff', () => {
    it('releases cleanly when claim ownership is lost during shield backoff', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'preflight-shield-ac4-'));
      const stateFile = path.join(dir, 'attempt.count');
      writeFileSync(stateFile, '0', 'utf8');
      try {
        const result = runScopedPreflight(
          `
        . ${psString(claimHelperPath)}
        $ns = ${psString(dir)}
        $sha = ${psString(stableHead)}
        $claim = Acquire-ReviewStartClaim -PrNumber 584 -HeadSha $sha -Surface 'review-trigger-reconcile' -Namespace $ns -ReviewRuns @()
        $env:AO_REVIEW_START_SCOPED_GH_COMMAND = ${psString(fakeGhPath)}
        $env:AO_REVIEW_START_SCOPED_GH_SCENARIO = 'always_rate_limit'
        $env:AO_REVIEW_START_SCOPED_GH_STATE_FILE = ${psString(stateFile)}
        $env:AO_REVIEW_START_PREFLIGHT_SHIELD_MAX_ATTEMPTS = '3'
        $env:AO_REVIEW_START_PREFLIGHT_SHIELD_JITTER_MS = '5000'
        Remove-Item -LiteralPath $claim.path -Force
        $lookup = Invoke-ReviewStartPreflightGhPrView -RepoRoot ${psString(repoRoot)} -PrNumber 584 -ClaimResult $claim
        [pscustomobject]@{
          reason = [string]$lookup.transportFailure.reason
          count = @($lookup.openPrs).Count
        } | ConvertTo-Json -Compress
      `,
        );
        expect(result.count).toBe(0);
        expect(['claim_ownership_lost', 'preflight_transient_exhausted']).toContain(result.reason);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('AC7 header degradation audit', () => {
    it('records headerDegraded on fixed backoff without rate-limit headers', () => {
      const auditRoot = mkdtempSync(path.join(tmpdir(), 'preflight-shield-audit-ac7-'));
      try {
        runPwsh(
          `
        . ${psString(shieldHelperPath)}
        $env:AO_REVIEW_START_SCOPED_GH_COMMAND = ${psString(fakeGhPath)}
        $env:AO_REVIEW_START_SCOPED_GH_SCENARIO = 'always_rate_limit'
        $env:AO_REVIEW_START_PREFLIGHT_SHIELD_MAX_ATTEMPTS = '1'
        $null = Invoke-ReviewStartPreflightGhPrView -RepoRoot ${psString(repoRoot)} -PrNumber 584 -AuditRoot ${psString(auditRoot)}
        'done'
      `,
        );
        const audits = listShieldAuditRecords(auditRoot);
        expect(audits.some((row) => row.headerDegraded === true && row.prNumber === 584)).toBe(true);
      } finally {
        rmSync(auditRoot, { recursive: true, force: true });
      }
    });
  });

  describe('AC9 scenario matrix reachable cells', () => {
    const matrix: Array<{
      name: string;
      scenario: string;
      env?: Record<string, string>;
      expectRun: boolean;
      expectReason?: string;
    }> = [
      { name: 'ok stable', scenario: 'bashdb_stderr_valid_json', expectRun: true },
      { name: '429 then ok', scenario: 'http_429_then_ok', env: { AO_REVIEW_START_PREFLIGHT_SHIELD_JITTER_MS: '0' }, expectRun: true },
      { name: 'secondary abuse 403 then ok', scenario: 'secondary_403_then_ok', env: { AO_REVIEW_START_PREFLIGHT_SHIELD_JITTER_MS: '0' }, expectRun: true },
      { name: '502 then ok', scenario: 'upstream_502_then_ok', env: { AO_REVIEW_START_PREFLIGHT_SHIELD_JITTER_MS: '0' }, expectRun: true },
      { name: 'exhausted transient', scenario: 'always_rate_limit', env: { AO_REVIEW_START_PREFLIGHT_SHIELD_MAX_ATTEMPTS: '2', AO_REVIEW_START_PREFLIGHT_SHIELD_JITTER_MS: '0' }, expectRun: false, expectReason: 'preflight_transient_exhausted' },
      { name: 'terminal auth', scenario: 'gh_auth_failed', expectRun: false, expectReason: 'gh_auth_failed' },
    ];

    it.each(matrix)('$name', { timeout: 60_000 }, ({ scenario, env, expectRun, expectReason }) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'preflight-shield-matrix-'));
      const stateFile = path.join(dir, 'attempt.count');
      const jitter = env?.AO_REVIEW_START_PREFLIGHT_SHIELD_JITTER_MS ?? '0';
      const maxAttempts = env?.AO_REVIEW_START_PREFLIGHT_SHIELD_MAX_ATTEMPTS ?? '';
      try {
        const result = runScopedPreflight(
          `
        $env:AO_REVIEW_START_SCOPED_GH_COMMAND = ${psString(fakeGhPath)}
        $env:AO_REVIEW_START_SCOPED_GH_SCENARIO = ${psString(scenario)}
        $env:AO_REVIEW_START_SCOPED_GH_STATE_FILE = ${psString(stateFile)}
        $env:AO_REVIEW_START_SCOPED_GH_HEAD_SHA = ${psString(stableHead)}
        $env:AO_REVIEW_START_PREFLIGHT_SHIELD_JITTER_MS = ${psString(jitter)}
        ${maxAttempts ? `$env:AO_REVIEW_START_PREFLIGHT_SHIELD_MAX_ATTEMPTS = ${psString(maxAttempts)}` : ''}
        $lookup = Invoke-ReviewStartPreflightGhPrView -RepoRoot ${psString(repoRoot)} -PrNumber 584
        [pscustomobject]@{
          count = @($lookup.openPrs).Count
          reason = [string]$lookup.transportFailure.reason
        } | ConvertTo-Json -Compress
      `,
          env ?? {},
        );
        if (expectRun) {
          expect(result.count).toBe(1);
        } else {
          expect(result.count).toBe(0);
          if (expectReason) expect(result.reason).toBe(expectReason);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
