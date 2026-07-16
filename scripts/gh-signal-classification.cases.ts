import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { pruneCiRedWatchdogLookupFailures } from './lib/ci-red-watchdog-lookup-retention.mjs';
import { scanPowerShellGhMergedJson } from './lib/gh-signal-recon.ts';
import { repoRoot } from './_test-vitest-harness-env.js';
import { GH_SIGNAL_TEST_HEAD as HEAD, writeGhSignalFake } from './gh-signal-test-fixture.ts';

const NEXT_HEAD = 'b'.repeat(40);
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

const lookup = (headSha = HEAD, prNumber = 849) => ({
  repo: 'acme/repo',
  prNumber,
  requiredCheckContext: 'ci',
  headSha,
});
const lookupRetentionConfig = {
  maxAttempts: 1,
  backoffMs: [1],
  episodeLifetimeMs: 60_000,
  lookupResolvedRetentionMs: 1_000,
  lookupParkedRetentionMs: 5_000,
  lookupHistoryMaxEntries: 16,
};
const snapshot = (
  openPrs: Array<{ repo?: string; prNumber: number; headSha: string }>,
  available = true,
) => ({ available, repo: 'acme/repo', openPrs });

function seedResolved(storeDir: string, nowMs = 1_000): void {
  recordCiRedWatchdogLookupFailure({ storeDir, lookup: lookup(), nowMs, config: lookupRetentionConfig });
  resolveCiRedWatchdogLookupFailure({ storeDir, lookup: lookup(), nowMs: nowMs + 1, config: lookupRetentionConfig });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

export function registerGhSignalClassificationTests(): void {
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
    const identity = lookup();
    const config = { maxAttempts: 2, backoffMs: [1_000], episodeLifetimeMs: 60_000 };
    const first = recordCiRedWatchdogLookupFailure({ storeDir, lookup: identity, reason: 'check_runs_unavailable', nowMs: 10_000, config });
    expect(first).toMatchObject({ action: 'defer', record: { state: 'deferred', attempts: 1 } });
    const bounded = recordCiRedWatchdogLookupFailure({ storeDir, lookup: identity, reason: 'check_runs_unavailable', nowMs: 10_500, config });
    expect(bounded).toMatchObject({ action: 'defer', reason: 'authoritative_lookup_backoff_active', record: { attempts: 1 } });
    const parked = recordCiRedWatchdogLookupFailure({ storeDir, lookup: identity, reason: 'check_runs_unavailable', nowMs: 11_000, config });
    expect(parked).toMatchObject({ action: 'park', reason: 'authoritative_lookup_failure_ceiling', record: { state: 'parked', attempts: 2 } });

    const ledger = readCiRedWatchdogLedger(storeDir);
    const key = ciRedLookupFailureKey(identity);
    expect(ledger.lookupFailures[key]).toMatchObject({
      kind: 'authoritative-check-lookup',
      state: 'parked',
      lastDeferReason: 'check_runs_unavailable',
      parkedReason: 'authoritative_lookup_failure_ceiling',
    });
    expect(ledger.history.at(-1)).toMatchObject({ key, to: 'parked', reason: 'authoritative_lookup_failure_ceiling' });

    const resolved = resolveCiRedWatchdogLookupFailure({ storeDir, lookup: identity, nowMs: 12_000, config });
    expect(resolved).toMatchObject({ resolved: true, record: { state: 'resolved' } });
  });

  it('retains resolved lookup records until expiry and removes them afterward', () => {
    const storeDir = tempRoot('ci-red-lookup-resolved-');
    seedResolved(storeDir);
    const current = snapshot([{ prNumber: 849, headSha: HEAD }]);
    pruneCiRedWatchdogLookupFailures({ storeDir, snapshot: current, nowMs: 1_999, config: lookupRetentionConfig });
    expect(readCiRedWatchdogLedger(storeDir).lookupFailures[ciRedLookupFailureKey(lookup())]).toBeDefined();
    pruneCiRedWatchdogLookupFailures({ storeDir, snapshot: current, nowMs: 2_001, config: lookupRetentionConfig });
    expect(readCiRedWatchdogLedger(storeDir).lookupFailures[ciRedLookupFailureKey(lookup())]).toBeUndefined();
  });

  it('keeps parked lookup records operator-visible for the parked retention window', () => {
    const storeDir = tempRoot('ci-red-lookup-parked-');
    recordCiRedWatchdogLookupFailure({ storeDir, lookup: lookup(), nowMs: 1_000, config: lookupRetentionConfig });
    const current = snapshot([{ prNumber: 849, headSha: HEAD }]);
    pruneCiRedWatchdogLookupFailures({ storeDir, snapshot: current, nowMs: 5_999, config: lookupRetentionConfig });
    expect(readCiRedWatchdogLedger(storeDir).lookupFailures[ciRedLookupFailureKey(lookup())]?.state).toBe('parked');
    pruneCiRedWatchdogLookupFailures({ storeDir, snapshot: current, nowMs: 6_001, config: lookupRetentionConfig });
    expect(readCiRedWatchdogLedger(storeDir).lookupFailures[ciRedLookupFailureKey(lookup())]).toBeUndefined();
  });

  it('retains a just-parked lookup after head supersession until the parked horizon', () => {
    const storeDir = tempRoot('ci-red-lookup-parked-superseded-');
    const identity = lookup();
    const key = ciRedLookupFailureKey(identity);
    recordCiRedWatchdogLookupFailure({ storeDir, lookup: identity, nowMs: 1_000, config: lookupRetentionConfig });
    const superseded = snapshot([{ prNumber: 849, headSha: NEXT_HEAD }]);

    pruneCiRedWatchdogLookupFailures({ storeDir, snapshot: superseded, nowMs: 1_001, config: lookupRetentionConfig });
    let ledger = readCiRedWatchdogLedger(storeDir);
    expect(ledger.lookupFailures[key]?.state).toBe('parked');
    expect(ledger.history.some((entry) => entry.key === key && entry.to === 'parked')).toBe(true);

    pruneCiRedWatchdogLookupFailures({ storeDir, snapshot: superseded, nowMs: 6_001, config: lookupRetentionConfig });
    ledger = readCiRedWatchdogLedger(storeDir);
    expect(ledger.lookupFailures[key]).toBeUndefined();
    expect(ledger.history).toContainEqual(expect.objectContaining({
      key: 'lookup:retention',
      reason: 'parked_retention_expired',
      metadata: expect.objectContaining({
        lookupKey: key,
        repo: identity.repo,
        prNumber: identity.prNumber,
        headSha: identity.headSha,
        parkedReason: 'authoritative_lookup_failure_ceiling',
      }),
    }));
  });

  it('retains a just-parked lookup after PR closure until the parked horizon', () => {
    const storeDir = tempRoot('ci-red-lookup-parked-closed-');
    const identity = lookup();
    const key = ciRedLookupFailureKey(identity);
    recordCiRedWatchdogLookupFailure({ storeDir, lookup: identity, nowMs: 1_000, config: lookupRetentionConfig });
    const closed = snapshot([]);

    pruneCiRedWatchdogLookupFailures({ storeDir, snapshot: closed, nowMs: 1_001, config: lookupRetentionConfig });
    expect(readCiRedWatchdogLedger(storeDir).lookupFailures[key]?.state).toBe('parked');

    pruneCiRedWatchdogLookupFailures({ storeDir, snapshot: closed, nowMs: 6_001, config: lookupRetentionConfig });
    const ledger = readCiRedWatchdogLedger(storeDir);
    expect(ledger.lookupFailures[key]).toBeUndefined();
    expect(ledger.history).toContainEqual(expect.objectContaining({
      key: 'lookup:retention',
      reason: 'parked_retention_expired',
      metadata: expect.objectContaining({ lookupKey: key, prNumber: 849, headSha: HEAD }),
    }));
  });

  it('removes superseded heads only from an authoritative current-head snapshot', () => {
    const storeDir = tempRoot('ci-red-lookup-superseded-');
    recordCiRedWatchdogLookupFailure({ storeDir, lookup: lookup(), nowMs: 1_000, config: { ...lookupRetentionConfig, maxAttempts: 2 } });
    pruneCiRedWatchdogLookupFailures({ storeDir, snapshot: snapshot([], false), nowMs: 2_000, config: lookupRetentionConfig });
    expect(readCiRedWatchdogLedger(storeDir).lookupFailures[ciRedLookupFailureKey(lookup())]).toBeDefined();
    pruneCiRedWatchdogLookupFailures({
      storeDir,
      snapshot: snapshot([{ prNumber: 849, headSha: NEXT_HEAD }]),
      nowMs: 2_001,
      config: lookupRetentionConfig,
    });
    expect(readCiRedWatchdogLedger(storeDir).lookupFailures[ciRedLookupFailureKey(lookup())]).toBeUndefined();
  });

  it('removes lookup records for authoritatively closed or merged PRs', () => {
    const storeDir = tempRoot('ci-red-lookup-closed-');
    recordCiRedWatchdogLookupFailure({ storeDir, lookup: lookup(), nowMs: 1_000, config: { ...lookupRetentionConfig, maxAttempts: 2 } });
    pruneCiRedWatchdogLookupFailures({ storeDir, snapshot: snapshot([]), nowMs: 2_000, config: lookupRetentionConfig });
    expect(Object.keys(readCiRedWatchdogLedger(storeDir).lookupFailures)).toHaveLength(0);
  });

  it('fails closed when the authoritative GitHub snapshot is unavailable', () => {
    const storeDir = tempRoot('ci-red-lookup-unavailable-');
    seedResolved(storeDir);
    const result = pruneCiRedWatchdogLookupFailures({
      storeDir,
      snapshot: snapshot([], false),
      nowMs: 100_000,
      config: lookupRetentionConfig,
    });
    expect(result).toMatchObject({ pruned: false, reason: 'authoritative_open_pr_snapshot_unavailable' });
    expect(readCiRedWatchdogLedger(storeDir).lookupFailures[ciRedLookupFailureKey(lookup())]).toBeDefined();
  });

  it('does not delete an active deferred record for the current head', () => {
    const storeDir = tempRoot('ci-red-lookup-active-');
    recordCiRedWatchdogLookupFailure({ storeDir, lookup: lookup(), nowMs: 1_000, config: { ...lookupRetentionConfig, maxAttempts: 2 } });
    pruneCiRedWatchdogLookupFailures({
      storeDir,
      snapshot: snapshot([{ prNumber: 849, headSha: HEAD }]),
      nowMs: 100_000,
      config: lookupRetentionConfig,
    });
    expect(readCiRedWatchdogLedger(storeDir).lookupFailures[ciRedLookupFailureKey(lookup())]?.state).toBe('deferred');
  });

  it('bounds lookup transition history while preserving unrelated episode history', () => {
    const storeDir = tempRoot('ci-red-lookup-history-');
    for (let index = 0; index < 30; index += 1) {
      recordCiRedWatchdogLookupFailure({
        storeDir,
        lookup: lookup(index % 2 === 0 ? HEAD : NEXT_HEAD, 900 + index),
        nowMs: 1_000 + index,
        config: { ...lookupRetentionConfig, maxAttempts: 2 },
      });
    }
    const ledgerPath = join(storeDir, 'ledger.json');
    const raw = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    raw.history.push({ sequence: raw.nextSequence++, atMs: 1, key: 'episode:keep', to: 'kept' });
    writeFileSync(ledgerPath, JSON.stringify(raw));
    const result = pruneCiRedWatchdogLookupFailures({
      storeDir,
      snapshot: snapshot([]),
      nowMs: 10_000,
      config: lookupRetentionConfig,
    });
    expect(result.historyCompacted).toBe(true);
    const ledger = readCiRedWatchdogLedger(storeDir);
    expect(ledger.history.filter((entry) => String(entry.key).startsWith('lookup:')).length).toBeLessThanOrEqual(16);
    expect(ledger.history.some((entry) => entry.key === 'episode:keep')).toBe(true);
  });

  it('reads a legacy ledger without lookupFailures compatibly', () => {
    const storeDir = tempRoot('ci-red-lookup-legacy-');
    mkdirSync(storeDir, { recursive: true });
    const schemaVersion = readCiRedWatchdogLedger(storeDir).schemaVersion;
    writeFileSync(join(storeDir, 'ledger.json'), JSON.stringify({ schemaVersion, nextSequence: 1, episodes: {}, history: [] }));
    expect(readCiRedWatchdogLedger(storeDir).lookupFailures).toEqual({});
  });

  it('recon sweep finds no unapproved merged gh JSON parser sites', () => {
    expect(scanPowerShellGhMergedJson(allPowerShellFiles(repoRoot), repoRoot)).toEqual([]);
  });

  it('AST recon catches multiline, api, splatted, variable-command, and wrapper merged streams', () => {
    const root = tempRoot('gh-signal-recon-fixtures-');
    const scripts = join(root, 'scripts');
    mkdirSync(scripts, { recursive: true });
    const fixtures: Record<string, string> = {
      'inline.ps1': `$raw = gh pr view 849 --json number 2>&1\n$raw | ConvertFrom-Json`,
      'multiline.ps1': `$raw = gh pr view 849 \`\n  --json number,headRefOid \`\n  2>&1\n$raw | ConvertFrom-Json`,
      'api.ps1': `$raw = gh api repos/acme/repo/pulls/849 2>&1\n$parsed = $raw | ConvertFrom-Json`,
      'splat.ps1': `$args = @('pr','view','849','--json','number')\n$raw = gh @args 2>&1\n$raw | ConvertFrom-Json`,
      'variable.ps1': `$gh = 'gh'\n$args = @('pr','view','849')\n$raw = & $gh @args 2>&1\n$raw | ConvertFrom-Json`,
      'wrapper.ps1': `$wrapper = Join-Path $PSScriptRoot 'scripts/gh'\n$raw = & $wrapper pr view 849 --json number 2>&1\n$raw | ConvertFrom-Json`,
    };
    const files = Object.entries(fixtures).map(([name, source]) => {
      const file = join(scripts, name);
      writeFileSync(file, source);
      return file;
    });
    const findings = scanPowerShellGhMergedJson(files, root);
    expect(findings.map((finding) => finding.file).sort()).toEqual(
      Object.keys(fixtures).map((name) => `scripts/${name}`).sort(),
    );
    expect(findings.every((finding) => finding.reason === 'merged-gh-json-stream')).toBe(true);
  });

  it('keeps the shipped narrow scalar exception exact rather than broadening it', () => {
    const root = tempRoot('gh-signal-recon-allowed-');
    const file = join(root, 'scripts/lib/Ci-Failure-Notification-Common.ps1');
    mkdirSync(join(root, 'scripts/lib'), { recursive: true });
    writeFileSync(file, 'gh repo view --json nameWithOwner 2>&1');
    expect(scanPowerShellGhMergedJson([file], root)).toEqual([]);
    writeFileSync(file, `$raw = gh repo view --json nameWithOwner 2>&1\n$raw | ConvertFrom-Json`);
    expect(scanPowerShellGhMergedJson([file], root)).toHaveLength(1);
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
    const watchdog = readFileSync(join(repoRoot, 'scripts/lib/Ci-Red-Watchdog.ps1'), 'utf8');
    expect(watchdog).toContain("Invoke-CiRedWatchdogCli -Command 'prune-lookup-failures'");
    const wrapper = readFileSync(join(repoRoot, 'scripts/lib/gh-wrapper.mjs'), 'utf8');
    expect(wrapper).toContain('appendAuditJsonlLine(filePath, line');
    expect(wrapper).toContain("process.env.GH_WRAPPER_AUDIT !== '1'");
    expect(wrapper).toContain('gh-wrapper-audit-retention:');
  });
});
}
