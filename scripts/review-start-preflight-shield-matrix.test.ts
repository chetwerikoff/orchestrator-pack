// Scenario matrix coverage for review-start preflight shield (#584).
import {
  describe,
  driftHeadB,
  expect,
  fakeGhPath,
  it,
  mkdtempSync,
  path,
  psString,
  repoRoot,
  rmSync,
  runScopedPreflight,
  stableHead,
  tmpdir,
} from './_test-review-start-preflight-shield-heavy.shared.js';

describe('review-start preflight transient shield (#584)', () => {
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
