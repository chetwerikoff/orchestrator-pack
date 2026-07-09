// Closed-PR denial and audit coverage for review-start preflight shield (#584).
import {
  claimHelperPath,
  describe,
  evaluateOrchestratorTurnGate,
  expect,
  fakeGhPath,
  it,
  listShieldAuditRecords,
  mkdtempSync,
  path,
  psString,
  repoRoot,
  rmSync,
  runPwsh,
  runScopedPreflight,
  shieldHelperPath,
  stableHead,
  tmpdir,
  writeFileSync,
} from './_test-review-start-preflight-shield-heavy.shared.js';

describe('review-start preflight transient shield (#584)', () => {
  describe('closed PR recheck denial', () => {
    it('treats pr_not_open snapshot transport as target-state not infra retry', () => {
      const claimHelperPath = path.join(repoRoot, 'scripts/lib/Review-StartClaim.ps1');
      const result = JSON.parse(runPwsh(
        `
        . ${psString(shieldHelperPath)}
        . ${psString(claimHelperPath)}
        $env:AO_REVIEW_START_SCOPED_GH_COMMAND = ${psString(fakeGhPath)}
        $env:AO_REVIEW_START_SCOPED_GH_SCENARIO = 'closed_pr'
        $lookup = Invoke-ReviewStartPreflightGhPrView -RepoRoot ${psString(repoRoot)} -PrNumber 584
        $denial = Get-ReviewStartSupervisedGhInfraTransportRecheckDenial -Snapshot @{
          transportFailure = $lookup.transportFailure
        }
        [pscustomobject]@{
          reason = [string]$lookup.targetStateDenial.reason
          transportFailure = [bool]$lookup.transportFailure
          targetStateDenial = [bool]$lookup.targetStateDenial
          denial = ($null -ne $denial)
        } | ConvertTo-Json -Compress
      `,
      ));
      expect(result.reason).toBe('pr_not_open');
      expect(result.transportFailure).toBe(false);
      expect(result.targetStateDenial).toBe(true);
      expect(result.denial).toBe(false);
    });

    it('evaluateTurnGate treats pr_not_open target-state denial as per_start_denial not infrastructure', () => {
      const gate = evaluateOrchestratorTurnGate({
        prNumber: 584,
        provenanceAutonomous: true,
        openPrs: [],
        reviewRuns: [],
        sessions: [],
        targetStateDenial: { ok: false, reason: 'pr_not_open' },
      });
      expect(gate.launch).toBe(false);
      expect(gate.reason).toBe('pr_not_open');
      expect(gate.auditShape).toBe('per_start_denial');
    });

    it('claimed pre-recheck preserves pr_not_open target-state denial', () => {
      const invokeHelperPath = path.join(repoRoot, 'scripts/lib/Invoke-OrchestratorClaimedReviewRun.ps1');
      const result = JSON.parse(runPwsh(
        `
        . ${psString(invokeHelperPath)}
        $recheck = Invoke-OrchestratorClaimedReviewRunPreRecheck -PlannedAction @{
          prNumber = 584
          headSha = 'abc3180000000000000000000000000000000000'
          sessionId = 'opk-134'
          startReason = 'test'
        } -Snapshot @{
          targetStateDenial = @{ ok = $false; reason = 'pr_not_open' }
          openPrs = @()
          reviewRuns = @()
          sessions = @()
          ciChecksByPr = @{}
          requiredCheckNamesByPr = @{}
          requiredCheckLookupFailedByPr = @{}
        }
        [pscustomobject]@{
          emit = [bool]$recheck.emitReviewRun
          reason = [string]$recheck.reason
        } | ConvertTo-Json -Compress
      `,
      ));
      expect(result.emit).toBe(false);
      expect(result.reason).toBe('pr_not_open');
    });

    it('evaluateTurnGate still infrastructure-denies gh_binary_missing transport', () => {
      const gate = evaluateOrchestratorTurnGate({
        prNumber: 584,
        provenanceAutonomous: true,
        openPrs: [],
        reviewRuns: [],
        sessions: [],
        transportFailure: { ok: false, reason: 'gh_binary_missing', failureClass: 'infra_transport' },
      });
      expect(gate.launch).toBe(false);
      expect(gate.reason).toBe('gh_binary_missing');
      expect(gate.auditShape).toBe('infrastructure_denial');
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

});
