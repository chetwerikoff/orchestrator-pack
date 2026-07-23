import { createHash } from 'node:crypto';
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
import { validateClosureEvidenceBundle, validateFinalVerificationAgainstReceipt, type ClosureEvidenceBundle, type FinalVerificationEvidence } from './closure-receipt.ts';
import { stableJson } from './contracts.ts';
import {
  scanForbiddenExecutableReferences,
  validateBridgeSource,
  validateRunnerSource,
} from './final-conformance.ts';
import {
  exportDetachedRollbackDrain,
  readProcessIdentity,
  sameProcess,
  validateRollbackDrainArtifact,
  type RollbackDrainArtifact,
} from './rollback-drain.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const bridgePath = path.join(repoRoot, 'scripts/lib/Review-StartClaimLifecycle.ps1');
const storeUrl = new URL('../lib/review-start-claim-store.ts', import.meta.url).href;
const claimRoots: string[] = [];
const claimChildren: Array<{ controller: AbortController; result: Promise<ProcessResult> }> = [];

function makeRoot(prefix: string): string {
  const value = mkdtempSync(path.join(tmpdir(), prefix));
  claimRoots.push(value);
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
  claimChildren.push({ controller, result });
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
  claimChildren.push({ controller, result });
}


const rollbackChildren: Array<{ pid: number; controller: AbortController; result: Promise<ProcessResult> }> = [];
const rollbackRoots: string[] = [];


afterEach(async () => {
  const activeClaims = claimChildren.splice(0);
  for (const child of activeClaims) child.controller.abort();
  await Promise.allSettled(activeClaims.map((child) => child.result));
  for (const root of claimRoots.splice(0)) rmSync(root, { recursive: true, force: true });

  const activeRollback = rollbackChildren.splice(0);
  for (const child of activeRollback) child.controller.abort();
  await Promise.allSettled(activeRollback.map((child) => child.result));
  for (const root of rollbackRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Issue #948 final conformance mutations', () => {
  it('rejects a D928 execution edge from a test harness', () => {
    const findings = scanForbiddenExecutableReferences([{ path: 'scripts/example.test.ts', content: "spawn('pwsh', ['-File', 'scripts/orchestrator-wake-supervisor.ps1'])" }]);
    expect(findings.map((row) => row.code)).toContain('d928_test_or_harness_reference');
  });

  it('rejects a D928 execution edge from production code', () => {
    const findings = scanForbiddenExecutableReferences([{ path: 'scripts/example.ts', content: "const file = 'scripts/lib/Review-StartClaim.ps1'" }]);
    expect(findings.map((row) => row.code)).toContain('d928_external_executable_reference');
  });

  it('rejects policy/storage logic added to the passive bridge', () => {
    const findings = validateBridgeSource("function Invoke-ReviewStartClaimTsOperation(){}\nSet-Content x y\nreview-start-claim-cli.ts");
    expect(findings.map((row) => row.code)).toContain('bridge_policy_or_storage_logic');
  });

  it('rejects a runner that routes claims through PowerShell', () => {
    const findings = validateRunnerSource("import './lib/Review-StartClaimLifecycle.ps1'; async function acquireClaimLease(){ pwsh(); }");
    expect(findings.map((row) => row.code)).toContain('runner_claim_powershell_or_cli_edge');
    expect(findings.map((row) => row.code)).toContain('runner_claim_path_spawns_process');
  });
});


describe('Issue #948 closure receipt evidence', () => {
  const tree = 'a'.repeat(40);
  const commit = 'b'.repeat(40);
  const digest = `sha256:${'c'.repeat(64)}`;
  const valid = (): ClosureEvidenceBundle => ({
    schemaVersion: 1,
    overlap: {
      schemaVersion: 1, result: 'pass', generatedAfterFinalTree: true,
      finalTreeOid: tree, candidateTreeOid: tree, candidateBuildDigest: digest,
      legacyRepository: 'chetwerikoff/orchestrator-pack', legacyCommitSha: 'd'.repeat(40), legacyTreeOid: 'e'.repeat(40),
      candidateRepository: 'chetwerikoff/orchestrator-pack', candidateCommitSha: commit,
      harnessSha256: digest, harnessBytesArchived: true, operationMatrixSha256: digest,
      replayCommand: 'node replay.mjs', replayInputsSha256: digest, protocolVectorSha256: digest,
      platform: 'linux', filesystem: 'overlay',
      classes: ['acquisition', 'guarded-mutation', 'terminal-audit', 'release-completion', 'recovery-reap', 'interpretation', 'generation-fence'],
      logSha256: digest,
    },
    rollback: {
      schemaVersion: 1, result: 'pass', finalTreeOid: tree, isolatedCheckout: true,
      entryBlockedBeforeRevert: true, entryBlockedAfterRevert: true, quiescenceInventoryComplete: true,
      detachedDrainSha256: digest, detachedDrainSurvivedRevert: true, zeroSurvivorsBeforeResume: true,
      legacyReadTsRecord: true, imports928ActivationMachinery: false, logSha256: digest,
    },
    preReceiptVerification: {
      schemaVersion: 1, result: 'pass', finalTreeOid: tree, checkoutCommitSha: commit, checkoutTreeOid: tree,
      repository: 'chetwerikoff/orchestrator-pack', platform: 'linux', filesystem: 'overlay', nodeVersion: '22.16.0', pwshVersion: '7.6.3',
      cleanBefore: true, cleanAfter: true, stagedBefore: 0, stagedAfter: 0, untrackedBefore: 0, untrackedAfter: 0,
      prerequisiteSuitesPassedBeforeReceipt: true,
      commands: [
        'npm run typecheck:foundation', 'npm run lint:foundation', 'npm run test:contract-mutations', 'npm run test:issue-948',
        'pwsh -NoProfile -File scripts/verify.ps1', 'pwsh -NoProfile -File scripts/check-reusable.ps1',
        'pwsh -NoProfile -File scripts/test-all.ps1', 'vitest-light', 'vitest-heavy',
      ].map((command) => ({ command, exitCode: 0 as const, logSha256: digest })),
    },
    external928: {
      schemaVersion: 1, result: 'pass', url: 'https://github.com/chetwerikoff/orchestrator-pack/issues/928',
      repository: 'chetwerikoff/orchestrator-pack', issue: 928, revisionIdentity: 'updated:2026-07-23',
      updatedAt: '2026-07-23T00:00:00Z', capturedAt: '2026-07-23T01:00:00Z', actor: 'chetwerikoff', tool: 'GitHub API', bodySha256: digest,
      requirements: { consumesPr2aTsAuthority: true, consumesReceiptAsPrecedent: true, independentlyRecomputesCurrentClosure: true, invariantBasedRefusal: true, historicalInventoryEqualityNotRequired: true },
    },
  });

  it('accepts complete tree-bound overlap rollback verification and #928 evidence', () => {
    expect(validateClosureEvidenceBundle(valid(), { finalTreeOid: tree, finalCommitSha: commit, candidateBuildDigest: digest })).toEqual([]);
  });

  it('refuses stale overlap evidence, dirty verification, and incomplete #928 synchronization', () => {
    const evidence = valid();
    evidence.overlap.candidateTreeOid = 'f'.repeat(40);
    evidence.preReceiptVerification.cleanAfter = false as true;
    evidence.external928.requirements.independentlyRecomputesCurrentClosure = false as true;
    const findings = validateClosureEvidenceBundle(evidence, { finalTreeOid: tree, finalCommitSha: commit, candidateBuildDigest: digest });
    expect(findings).toContain('overlap-evidence-candidate-tree-mismatch');
    expect(findings).toContain('receipt-prerequisites-on-dirty-worktree');
    expect(findings).toContain('external-928-contract-incomplete');
  });

  it('validates receipt-bound final verification only after receipt generation', () => {
    const receiptCore = {
      schemaVersion: 2,
      lineage: { finalCommitSha: commit, finalTreeOid: tree },
      result: 'tree-bound-empty-external-reverse-closure',
    };
    const receiptSha256 = `sha256:${createHash('sha256').update(stableJson(receiptCore)).digest('hex')}`;
    const receipt = { ...receiptCore, receiptSha256 };
    const verification: FinalVerificationEvidence = {
      schemaVersion: 1, result: 'pass', receiptSha256, finalTreeOid: tree, checkoutCommitSha: commit, checkoutTreeOid: tree,
      repository: 'chetwerikoff/orchestrator-pack', platform: 'linux', filesystem: 'overlay', nodeVersion: '22.16.0', pwshVersion: '7.6.3',
      cleanBefore: true, cleanAfter: true, stagedBefore: 0, stagedAfter: 0, untrackedBefore: 0, untrackedAfter: 0,
      commands: [
        'npm run typecheck:foundation', 'npm run lint:foundation', 'npm run test:contract-mutations', 'npm run test:issue-948',
        'pwsh -NoProfile -File scripts/verify.ps1', 'pwsh -NoProfile -File scripts/check-reusable.ps1',
        'pwsh -NoProfile -File scripts/test-all.ps1', 'vitest-light', 'vitest-heavy',
      ].map((command) => ({ command, exitCode: 0 as const, logSha256: digest })),
    };
    expect(validateFinalVerificationAgainstReceipt(verification, receipt)).toEqual([]);
    verification.receiptSha256 = digest;
    expect(validateFinalVerificationAgainstReceipt(verification, receipt)).toContain('final-verification-receipt-mismatch');
  });

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

describe('Issue #948 detached rollback drain', () => {
  it('exports self-contained bytes and drains only the fenced process identity', async () => {
    const controller = new AbortController();
    let pid = 0;
    const childResult = runProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      inheritParentEnv: true,
      signal: controller.signal,
      timeoutMs: 60_000,
      allowEmptyStdout: true,
      onSpawn: (value) => { pid = value; },
    });
    expect(pid).toBeGreaterThan(1);
    rollbackChildren.push({ pid, controller, result: childResult });
    const identity = readProcessIdentity(pid);
    expect(identity).not.toBeNull();

    const output = mkdtempSync(path.join(tmpdir(), 'opk-pr2a-drain-'));
    rollbackRoots.push(output);
    const exported = exportDetachedRollbackDrain(output, 'candidate-generation-1', [pid]);
    const artifact = JSON.parse(readFileSync(exported.artifactPath, 'utf8')) as RollbackDrainArtifact;
    expect(() => validateRollbackDrainArtifact(artifact)).not.toThrow();

    const result = await runProcess({
      command: process.execPath,
      args: ['--experimental-strip-types', exported.runnerPath, 'drain', '--artifact', exported.artifactPath],
      inheritParentEnv: true,
      timeoutMs: 30_000,
      allowEmptyStdout: false,
    });
    expect(result.ok, result.stderr || result.error).toBe(true);
    expect(JSON.parse(result.stdout) as { drained: number[] }).toMatchObject({ drained: expect.arrayContaining([pid]) });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sameProcess(identity!)).toBe(false);
  });

  it('refuses a tampered artifact', () => {
    const artifact: RollbackDrainArtifact = {
      schemaVersion: 1,
      issue: 948,
      candidateGeneration: 'candidate-generation-2',
      entryBlocked: true,
      createdAtUtc: new Date().toISOString(),
      processes: [{ pid: 999_999, startTimeTicks: '1', bootId: 'boot' }],
      digest: 'sha256:bad',
    };
    expect(() => validateRollbackDrainArtifact(artifact)).toThrow('rollback_artifact_digest_invalid');
  });
});
