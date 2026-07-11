// Terminal guard scenarios for review-start preflight shield (#584).
import {
  claimHelperPath,
  describe,
  expect,
  fakeGhPath,
  functionBody,
  ghPrChecksPath,
  it,
  mkdtempSync,
  path,
  psString,
  readFileSync,
  repoRoot,
  rmSync,
  runPwsh,
  runScopedPreflight,
  shieldHelperPath,
  snapshotPath,
  stableHead,
  tmpdir,
} from './_test-review-start-preflight-shield-heavy.shared.js';

function missingGhPath(prefix: string) {
  const missingRoot = mkdtempSync(path.join(tmpdir(), prefix));
  rmSync(missingRoot, { recursive: true, force: true });
  return path.join(missingRoot, 'gh.ps1');
}

describe('review-start preflight transient shield (#584)', () => {
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
        reason = if ($lookup.targetStateDenial) { [string]$lookup.targetStateDenial.reason } else { [string]$lookup.transportFailure.reason }
        count = @($lookup.openPrs).Count
        transportFailure = [bool]$lookup.transportFailure
        targetStateDenial = [bool]$lookup.targetStateDenial
      } | ConvertTo-Json -Compress
    `,
      );
      expect(result.count).toBe(0);
      if (scenario === 'malformed_stdout') {
        expect(result.reason).toMatch(/malformed_child_output|structured_output_polluted/);
      } else {
        expect(result.reason).toBe(expectedReason);
      }
      if (scenario === 'closed_pr') {
        expect(result.transportFailure).toBe(false);
        expect(result.targetStateDenial).toBe(true);
      } else {
        expect(result.transportFailure).toBe(true);
        expect(result.targetStateDenial).toBe(false);
      }
    });

    it('does not stamp closed PR denials as infra_transport', () => {
      const result = runScopedPreflight(
        `
      $env:AO_REVIEW_START_SCOPED_GH_COMMAND = ${psString(fakeGhPath)}
      $env:AO_REVIEW_START_SCOPED_GH_SCENARIO = 'closed_pr'
      $lookup = Invoke-ReviewStartPreflightGhPrView -RepoRoot ${psString(repoRoot)} -PrNumber 584
      [pscustomobject]@{
        reason = [string]$lookup.targetStateDenial.reason
        transportFailure = [bool]$lookup.transportFailure
        targetStateDenial = [bool]$lookup.targetStateDenial
      } | ConvertTo-Json -Compress
    `,
      );
      expect(result.reason).toBe('pr_not_open');
      expect(result.transportFailure).toBe(false);
      expect(result.targetStateDenial).toBe(true);
    });

    it('returns gh_binary_missing for a missing scoped gh adoption command', () => {
      const missingGh = missingGhPath('missing-gh-');
      const result = runScopedPreflight(
        `
      $lookup = Invoke-ReviewStartPreflightGhPrView -RepoRoot ${psString(repoRoot)} -PrNumber 584
      [pscustomobject]@{
        reason = [string]$lookup.transportFailure.reason
        failureClass = [string]$lookup.transportFailure.failureClass
        count = @($lookup.openPrs).Count
        transportFailure = [bool]$lookup.transportFailure
      } | ConvertTo-Json -Compress
    `,
        {
          AO_REVIEW_START_SCOPED_GH_COMMAND: missingGh,
          AO_REVIEW_START_PREFLIGHT_SHIELD_MAX_ATTEMPTS: '1',
          AO_REVIEW_START_PREFLIGHT_SHIELD_JITTER_MS: '0',
        },
      );
      expect(result.count).toBe(0);
      expect(result.reason).toBe('gh_binary_missing');
      expect(result.failureClass).toBe('infra_transport');
      expect(result.transportFailure).toBe(true);
    });
  });

  describe('missing gh infra classification', () => {
    it('preserves infra_transport for gh_binary_missing recheck handling', () => {
      const claimHelperPath = path.join(repoRoot, 'scripts/lib/Review-StartClaim.ps1');
      const missingGh = missingGhPath('missing-gh-recheck-');
      const result = JSON.parse(runPwsh(
        `
        . ${psString(shieldHelperPath)}
        . ${psString(claimHelperPath)}
        $lookup = Invoke-ReviewStartPreflightGhPrView -RepoRoot ${psString(repoRoot)} -PrNumber 584
        $denial = Get-ReviewStartSupervisedGhInfraTransportRecheckDenial -Snapshot @{
          transportFailure = $lookup.transportFailure
        }
        [pscustomobject]@{
          reason = [string]$lookup.transportFailure.reason
          failureClass = [string]$lookup.transportFailure.failureClass
          transportFailure = [bool]$lookup.transportFailure
          targetStateDenial = [bool]$lookup.targetStateDenial
          denial = ($null -ne $denial)
        } | ConvertTo-Json -Compress
      `,
        { AO_REVIEW_START_SCOPED_GH_COMMAND: missingGh },
      ));
      expect(result.reason).toBe('gh_binary_missing');
      expect(result.failureClass).toBe('infra_transport');
      expect(result.transportFailure).toBe(true);
      expect(result.targetStateDenial).toBe(false);
      expect(result.denial).toBe(true);
    });
  });

  describe('manual review-start shield routing', () => {
    it('resolves manual head through scoped preflight shield', () => {
      const src = readFileSync(path.join(repoRoot, 'scripts/invoke-manual-review-run.ps1'), 'utf8');
      expect(src).toMatch(/Invoke-ReviewStartScopedGhPrView/);
      expect(src).not.toMatch(/Invoke-GhOpenPrList/);
    });

    it('manual closed PR fixture denies before ao review run', () => {
      const result = JSON.parse(runPwsh(
        `
        . ${psString(path.join(repoRoot, 'scripts/lib/Gh-PrChecks.ps1'))}
        $env:AO_REVIEW_START_SCOPED_GH_COMMAND = ${psString(fakeGhPath)}
        $env:AO_REVIEW_START_SCOPED_GH_SCENARIO = 'closed_pr'
        $message = 'started'
        try {
          & ${psString(path.join(repoRoot, 'scripts/invoke-manual-review-run.ps1'))} -SessionId opk-134 -PrNumber 584
          if ($LASTEXITCODE -ne 0) { $message = "exit:$LASTEXITCODE" }
        }
        catch {
          $message = [string]$_.Exception.Message
        }
        [pscustomobject]@{ message = $message } | ConvertTo-Json -Compress
      `,
      ));
      expect(result.message).toMatch(/pr_not_open/);
});
  });
});
