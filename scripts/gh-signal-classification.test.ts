import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyGhJsonCapture,
  runGhJsonCommand,
} from './lib/gh-signal-classifier.ts';
import { routePrChecks } from './lib/gh-rest-routes.mjs';
import {
  ciRedLookupFailureKey,
  readCiRedWatchdogLedger,
  recordCiRedWatchdogLookupFailure,
  resolveCiRedWatchdogLookupFailure,
} from './lib/ci-red-watchdog-ledger.mjs';
import { repoRoot } from './_test-vitest-harness-env.js';
import { GH_SIGNAL_TEST_HEAD as HEAD, writeGhSignalFake } from './gh-signal-test-fixture.ts';

const tempRoots: string[] = [];
function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function allPowerShellFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) visit(full);
      else if (name.endsWith('.ps1')) files.push(full);
    }
  };
  visit(join(root, 'scripts'));
  return files;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('gh signal classification (Issue #849)', () => {
  it('parses stdout only while preserving arbitrary stderr evidence', () => {
    const stderr = [
      'gh-wrapper-audit: complete route=pr-view',
      'gh-wrapper-audit-retention: rotate files=1',
      'warning: arbitrary native gh diagnostic',
    ].join('\n');
    const result = classifyGhJsonCapture(
      { exitCode: 0, stdout: '{"number":849}\n', stderr },
      { expectedRoot: 'object' },
    );
    expect(result).toMatchObject({ ok: true, classification: 'success', value: { number: 849 }, stderr });
  });

  it('keeps real command and parse failures distinct from valid JSON', () => {
    const malformed = classifyGhJsonCapture(
      { exitCode: 0, stdout: 'warning before json\n{}', stderr: '' },
      { expectedRoot: 'object' },
    );
    expect(malformed).toMatchObject({ ok: false, classification: 'malformed-json', reason: 'gh_json_parse_failed' });

    const failed = classifyGhJsonCapture(
      { exitCode: 7, stdout: '{}', stderr: 'network unavailable' },
      { expectedRoot: 'object' },
    );
    expect(failed).toMatchObject({ ok: false, classification: 'command-failure', reason: 'gh_command_failed', exitCode: 7 });
  });

  it('represents a successful zero-check response as structured valid-empty', () => {
    const result = classifyGhJsonCapture(
      { exitCode: 0, stdout: '[]\n', stderr: 'warning: checks are not populated yet\n' },
      { expectedRoot: 'array' },
    );
    expect(result).toMatchObject({ ok: true, classification: 'empty', reason: 'gh_json_empty_success', value: [] });
  });

  it('captures real child stdout and stderr on independent channels', () => {
    const root = tempRoot('gh-signal-child-');
    const fakeGh = writeGhSignalFake(root);
    const result = runGhJsonCommand({ command: fakeGh, args: ['issue', 'view', '849', '--json', 'body'], expectedRoot: 'object' });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ body: 'Issue body from authoritative read' });
    expect(result.stderr).toContain('gh-wrapper-audit:');
    expect(result.stderr).toContain('arbitrary native gh diagnostic');
  });

  it('REST pr-checks route returns an empty array rather than an infrastructure error', () => {
    const root = tempRoot('gh-signal-route-');
    const fakeGh = writeGhSignalFake(root);
    const previous = process.env.GH_SIGNAL_FAKE_SCENARIO;
    process.env.GH_SIGNAL_FAKE_SCENARIO = 'empty-route';
    try {
      expect(routePrChecks(fakeGh, { slug: 'acme/repo', host: 'github.com' }, 1, repoRoot)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.GH_SIGNAL_FAKE_SCENARIO;
      else process.env.GH_SIGNAL_FAKE_SCENARIO = previous;
    }
  });

  it('parks repeated pre-episode lookup failures in the durable watchdog ledger', () => {
    const storeDir = tempRoot('ci-red-lookup-ledger-');
    const lookup = {
      repo: 'acme/repo',
      prNumber: 849,
      requiredCheckContext: 'ci',
      headSha: HEAD,
    };
    const config = { maxAttempts: 2, backoffMs: [1_000], episodeLifetimeMs: 60_000 };
    const first = recordCiRedWatchdogLookupFailure({ storeDir, lookup, reason: 'check_runs_unavailable', nowMs: 10_000, config });
    expect(first).toMatchObject({ action: 'defer', record: { state: 'deferred', attempts: 1 } });
    const bounded = recordCiRedWatchdogLookupFailure({ storeDir, lookup, reason: 'check_runs_unavailable', nowMs: 10_500, config });
    expect(bounded).toMatchObject({ action: 'defer', reason: 'authoritative_lookup_backoff_active', record: { attempts: 1 } });
    const parked = recordCiRedWatchdogLookupFailure({ storeDir, lookup, reason: 'check_runs_unavailable', nowMs: 11_000, config });
    expect(parked).toMatchObject({ action: 'park', reason: 'authoritative_lookup_failure_ceiling', record: { state: 'parked', attempts: 2 } });

    const ledger = readCiRedWatchdogLedger(storeDir);
    const key = ciRedLookupFailureKey(lookup);
    expect(ledger.lookupFailures[key]).toMatchObject({
      kind: 'authoritative-check-lookup',
      state: 'parked',
      lastDeferReason: 'check_runs_unavailable',
      parkedReason: 'authoritative_lookup_failure_ceiling',
    });
    expect(ledger.history.at(-1)).toMatchObject({ key, to: 'parked', reason: 'authoritative_lookup_failure_ceiling' });

    const resolved = resolveCiRedWatchdogLookupFailure({ storeDir, lookup, nowMs: 12_000, config });
    expect(resolved).toMatchObject({ resolved: true, record: { state: 'resolved' } });
  });

  it('recon sweep finds no unapproved merged gh JSON parser sites', () => {
    const violations: string[] = [];
    for (const file of allPowerShellFiles(repoRoot)) {
      const rel = relative(repoRoot, file).replaceAll('\\', '/');
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        const mergedGh = /(?:^|[\s(&])gh\b.*2>&1/.test(line) || /scripts\/gh[^\n]*2>&1/.test(line);
        const jsonProducing = /--json\b|\bgh\s+api\b|&\s*gh\s+@Arguments\b/.test(line);
        if (!mergedGh || !jsonProducing) return;
        const allowedShippedNarrowScalar = rel === 'scripts/lib/Ci-Failure-Notification-Common.ps1'
          && line.includes('gh repo view --json nameWithOwner');
        if (!allowedShippedNarrowScalar) violations.push(`${rel}:${index + 1}:${line.trim()}`);
      });
    }
    expect(violations).toEqual([]);
  });

  it('keeps PowerShell consumers thin and leaves structured audit ownership unchanged', () => {
    const ghConsumers = [
      'scripts/dead-worker-reconcile.ps1',
      'scripts/lib/Gh-FleetInventoryCache.ps1',
      'scripts/lib/Ci-Red-Watchdog-GitHub.ps1',
      'scripts/pr-scope-check.ps1',
    ];
    for (const consumer of ghConsumers) {
      const source = readFileSync(join(repoRoot, consumer), 'utf8');
      expect(source, consumer).toContain('Invoke-GhSignalJsonCommand');
      expect(source, consumer).not.toContain('ConvertFrom-GhFleetMixedJsonOutput');
      expect(source, consumer).not.toContain('Get-DeadWorkerJsonBridgePayload');
    }
    const tick = readFileSync(join(repoRoot, 'scripts/lib/Ci-Red-Watchdog-Tick.ps1'), 'utf8');
    expect(tick).toContain("Invoke-CiRedWatchdogCli -Command 'record-lookup-failure'");
    expect(tick).toContain("Invoke-CiRedWatchdogCli -Command 'resolve-lookup-failure'");
    const wrapper = readFileSync(join(repoRoot, 'scripts/lib/gh-wrapper.mjs'), 'utf8');
    expect(wrapper).toContain('appendAuditJsonlLine(filePath, line');
    expect(wrapper).toContain("process.env.GH_WRAPPER_AUDIT !== '1'");
    expect(wrapper).toContain('gh-wrapper-audit-retention:');
  });
});
