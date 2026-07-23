import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess, runProcessSync, type ProcessResult } from '../kernel/subprocess.ts';
import {
  acquireReviewStartClaim,
  assertSupportedClaimPlatform,
  atomicWriteJson,
  claimPath,
  completeReviewStartClaim,
  readClaimRecord,
} from '../lib/review-start-claim-store.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const bridgePath = path.join(repoRoot, 'scripts/lib/Review-StartClaimLifecycle.ps1');
const storeUrl = new URL('../lib/review-start-claim-store.ts', import.meta.url).href;
const roots: string[] = [];
const children: Array<{ controller: AbortController; result: Promise<ProcessResult> }> = [];

function makeRoot(prefix: string): string {
  const value = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

function waitForFiles(paths: string[], timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (paths.every((file) => existsSync(file) && statSync(file).size > 0)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${paths.join(',')}`));
      }
    }, 20);
  });
}

function spawnTsClaim(namespace: string, resultPath: string, startPath: string, releasePath: string): void {
  const code = `
    import { acquireReviewStartClaim } from ${JSON.stringify(storeUrl)};
    import { existsSync, writeFileSync } from 'node:fs';
    while (!existsSync(${JSON.stringify(startPath)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    const result = acquireReviewStartClaim({ prNumber: 948, headSha: 'a'.repeat(40), surface: 'ts-overlap', namespace: ${JSON.stringify(namespace)}, reviewRuns: [] });
    writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ acquired: result.acquired, reason: result.reason ?? '' }));
    while (!existsSync(${JSON.stringify(releasePath)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  `;
  const controller = new AbortController();
  const result = runProcess({
    command: process.execPath,
    args: ['--no-warnings', '--experimental-strip-types', '--input-type=module', '-e', code],
    cwd: repoRoot,
    inheritParentEnv: true,
    signal: controller.signal,
    timeoutMs: 60_000,
    allowEmptyStdout: true,
  });
  children.push({ controller, result });
}

function spawnBridgeClaim(namespace: string, resultPath: string, startPath: string, releasePath: string): void {
  const ps = `
    $ErrorActionPreference='Stop'
    . '${bridgePath.replaceAll("'", "''")}'
    while (-not (Test-Path -LiteralPath '${startPath.replaceAll("'", "''")}')) { Start-Sleep -Milliseconds 10 }
    $r = Acquire-ReviewStartClaim -PrNumber 948 -HeadSha $('a' * 40) -Surface 'bridge-overlap' -Namespace '${namespace.replaceAll("'", "''")}' -ReviewRuns @()
    @{ acquired=[bool]$r.acquired; reason=[string]$r.reason } | ConvertTo-Json -Compress | Set-Content -LiteralPath '${resultPath.replaceAll("'", "''")}' -Encoding utf8
    while (-not (Test-Path -LiteralPath '${releasePath.replaceAll("'", "''")}')) { Start-Sleep -Milliseconds 10 }
  `;
  const controller = new AbortController();
  const result = runProcess({
    command: 'pwsh', args: ['-NoProfile', '-Command', ps], cwd: repoRoot,
    inheritParentEnv: true, signal: controller.signal, timeoutMs: 60_000, allowEmptyStdout: true,
  });
  children.push({ controller, result });
}

afterEach(async () => {
  const active = children.splice(0);
  for (const child of active) child.controller.abort();
  await Promise.allSettled(active.map((child) => child.result));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Issue #948 persisted TypeScript claim authority', () => {
  it('fails unsupported Windows-mounted namespaces before creating claim state', () => {
    const namespace = `/mnt/c/opk-pr2a-unsupported-${process.pid}-${Date.now()}`;
    expect(() => assertSupportedClaimPlatform(namespace)).toThrow('unsupported_windows_mounted_filesystem');
    expect(existsSync(namespace)).toBe(false);
  });

  it('admits one winner under TS-vs-TS overlap', async () => {
    const root = makeRoot('pr2a-ts-overlap-');
    const start = path.join(root, 'start');
    const release = path.join(root, 'release');
    const results = Array.from({ length: 6 }, (_, index) => path.join(root, `result-${index}.json`));
    results.forEach((result) => spawnTsClaim(root, result, start, release));
    writeFileSync(start, 'go');
    await waitForFiles(results);
    const rows = results.map((file) => JSON.parse(readFileSync(file, 'utf8')) as { acquired: boolean; reason: string });
    expect(rows.filter((row) => row.acquired)).toHaveLength(1);
    expect(rows.filter((row) => !row.acquired).every((row) => row.reason === 'claimed')).toBe(true);
    writeFileSync(release, 'done');
  }, 60_000);

  it('admits one winner under passive PowerShell bridge vs direct TS overlap', async () => {
    const root = makeRoot('pr2a-mixed-overlap-');
    const start = path.join(root, 'start');
    const release = path.join(root, 'release');
    const tsResult = path.join(root, 'ts.json');
    const psResult = path.join(root, 'ps.json');
    spawnTsClaim(root, tsResult, start, release);
    spawnBridgeClaim(root, psResult, start, release);
    writeFileSync(start, 'go');
    await waitForFiles([tsResult, psResult]);
    const rows = [tsResult, psResult].map((file) => JSON.parse(readFileSync(file, 'utf8')) as { acquired: boolean; reason: string });
    expect(rows.filter((row) => row.acquired)).toHaveLength(1);
    expect(rows.find((row) => !row.acquired)?.reason).toBe('claimed');
    writeFileSync(release, 'done');
  }, 60_000);

  it('generation-fences completion from a superseded holder', () => {
    const root = makeRoot('pr2a-fence-');
    const sha = 'b'.repeat(40);
    const first = acquireReviewStartClaim({ prNumber: 948, headSha: sha, surface: 'first', namespace: root, reviewRuns: [] });
    expect(first.acquired).toBe(true);
    const file = claimPath(root, 948, sha);
    const stale = readClaimRecord(file).record!;
    stale.holder.pid = 2147483000;
    delete stale.holder.startTimeTicks;
    delete stale.holder.bootIdHash;
    stale.acquiredAtUtc = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    atomicWriteJson(file, stale);
    const second = acquireReviewStartClaim({ prNumber: 948, headSha: sha, surface: 'second', namespace: root, reviewRuns: [] });
    expect(second.acquired).toBe(true);
    const oldCompletion = completeReviewStartClaim(first, 'run_started', []);
    expect(oldCompletion.ok).toBe(false);
    expect((readClaimRecord(file).record?.holder.processGuid)).toBe(second.claim?.holder.processGuid);
  });

  it('reads committed legacy protocol vectors through TS and the passive bridge', () => {
    const root = makeRoot('pr2a-vector-');
    const vectors = JSON.parse(readFileSync(path.join(repoRoot, 'scripts/pr2a/review-start-claim-protocol-vectors.json'), 'utf8')) as {
      vectors: Array<{ record: Record<string, unknown> }>;
    };
    const record = structuredClone(vectors.vectors[0]!.record);
    const file = path.join(root, 'legacy.json');
    atomicWriteJson(file, record);
    expect(readClaimRecord(file).record).toMatchObject(record);
    const command = `. '${bridgePath.replaceAll("'", "''")}'; Read-ReviewStartClaimRecord -Path '${file.replaceAll("'", "''")}' | ConvertTo-Json -Compress -Depth 20`;
    const result = runProcessSync({
      command: 'pwsh', args: ['-NoProfile', '-Command', command], cwd: repoRoot, inheritParentEnv: true,
    });
    expect(result.ok, result.stderr || result.error).toBe(true);
    const bridged = JSON.parse(result.stdout).record as Record<string, unknown>;
    expect(bridged).toMatchObject({
      schemaVersion: record.schemaVersion, key: record.key, prNumber: record.prNumber,
      headSha: record.headSha, state: record.state, holder: record.holder,
      startReason: record.startReason, projectNamespace: record.projectNamespace,
      firstAttemptAtMonotonicMs: record.firstAttemptAtMonotonicMs,
      readinessStartMonotonicMs: record.readinessStartMonotonicMs,
    });
  });
});
