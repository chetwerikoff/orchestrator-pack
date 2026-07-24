import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess, runProcessSync, type ProcessResult } from '../kernel/subprocess.ts';
import {
  acquireReviewStartClaim,
  assertSupportedClaimPlatform,
  atomicWriteJson,
  claimLockDir,
  claimPath,
  completeReviewStartClaim,
  readClaimRecord,
} from '../lib/review-start-claim-store.ts';
import {
  REQUIRED_DATA_VECTOR_CLASSES,
  REQUIRED_FINAL_COMMANDS,
  REQUIRED_OVERLAP_CLASSES,
  REQUIRED_PROTOCOL_VECTOR_CLASSES,
  REQUIRED_ROLLBACK_ENTRYPOINT_CLASSES,
  validateClosureEvidenceBundle,
  validateFinalVerificationAgainstReceipt,
  validateFinalVerificationEnvironment,
  validatePreReceiptVerificationEnvironment,
  type ClosureEvidenceBundle,
  type FinalVerificationEvidence,
  type VerificationCommandEvidence,
} from './closure-receipt.ts';
import { stableJson } from './contracts.ts';
import {
  scanForbiddenExecutableReferences,
  validateBridgeSource,
  validateClaimStoreSource,
  validateClosureReceiptSource,
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
const rollbackChildren: Array<{ pid: number; controller: AbortController; result: Promise<ProcessResult> }> = [];
const rollbackRoots: string[] = [];
const LEGACY_FOUNDATION_COMMIT = 'b967dfe156838039e1d6d137e7064dc9d1b10b4d';

function makeRoot(prefix: string): string {
  const value = mkdtempSync(path.join(tmpdir(), prefix));
  claimRoots.push(value);
  return value;
}
function digest(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
function git(args: string[]): string {
  const result = runProcessSync({ command: 'git', args, cwd: repoRoot, inheritParentEnv: true });
  if (!result.ok) throw new Error(result.stderr || result.error || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}
function observedVerificationEnvironment(root: string): {
  platform: string;
  filesystem: string;
  nodeVersion: string;
  pwshVersion: string;
} {
  if (process.platform !== 'linux') throw new Error(`unsupported_test_platform:${process.platform}`);
  const canonical = path.resolve(root);
  let best: { mount: string; fsType: string } | null = null;
  for (const row of readFileSync('/proc/self/mountinfo', 'utf8').split(/\r?\n/u).filter(Boolean)) {
    const split = row.split(' - ');
    if (split.length !== 2) continue;
    const left = split[0]?.split(' ') ?? [];
    const right = split[1]?.split(' ') ?? [];
    const mount = String(left[4] ?? '').replace(/\\040/gu, ' ');
    const fsType = String(right[0] ?? '').toLowerCase();
    if (!mount || !(canonical === mount || (mount === '/' ? canonical.startsWith('/') : canonical.startsWith(`${mount}/`)))) continue;
    if (!best || mount.length > best.mount.length) best = { mount, fsType };
  }
  if (!best) throw new Error(`test_mountinfo_missing:${canonical}`);
  const pwsh = runProcessSync({
    command: 'pwsh',
    args: ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
    cwd: repoRoot,
    inheritParentEnv: true,
  });
  if (!pwsh.ok || !pwsh.stdout.trim()) throw new Error(pwsh.stderr || pwsh.error || 'test_pwsh_version_missing');
  return {
    platform: 'linux',
    filesystem: best.fsType,
    nodeVersion: process.version,
    pwshVersion: pwsh.stdout.trim(),
  };
}
function writeArtifact(root: string, relative: string, value: string | Buffer): string {
  const absolute = path.join(root, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, value);
  return digest(value);
}
function waitForCondition(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error('timed out waiting for condition'));
      }
    }, 20);
  });
}
function waitForFiles(paths: string[], timeoutMs = 30_000): Promise<void> {
  return waitForCondition(() => paths.every((file) => existsSync(file) && statSync(file).size > 0), timeoutMs);
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

function spawnStaleRecoverer(namespace: string, barrier: string, resultPath: string, releasePath: string): void {
  const code = `
    import { acquireReviewStartClaim } from ${JSON.stringify(storeUrl)};
    import { existsSync, writeFileSync } from 'node:fs';
    const result = acquireReviewStartClaim({ prNumber: 948, headSha: 'c'.repeat(40), surface: 'stale-recoverer', namespace: ${JSON.stringify(namespace)}, reviewRuns: [] });
    writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ acquired: result.acquired, reason: result.reason ?? '' }));
    while (!existsSync(${JSON.stringify(releasePath)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  `;
  const controller = new AbortController();
  const result = runProcess({
    command: process.execPath,
    args: ['--no-warnings', '--experimental-strip-types', '--input-type=module', '-e', code],
    cwd: repoRoot,
    inheritParentEnv: true,
    env: {
      OPK_VITEST_HARNESS: '1',
      AO_REVIEW_CLAIM_TEST_STALE_BARRIER_DIR: barrier,
      AO_REVIEW_CLAIM_MUTEX_STALE_SECONDS: '1',
    },
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

function verificationCommands(root: string, commit: string, tree: string): VerificationCommandEvidence[] {
  return REQUIRED_FINAL_COMMANDS.map((command, index) => {
    const logPath = `commands/${index}.log`;
    const resultPath = `commands/${index}.json`;
    const log = `${command}\nPASS\n`;
    const result = `${JSON.stringify({
      schemaVersion: 1,
      command,
      exitCode: 0,
      checkoutCommitSha: commit,
      checkoutTreeOid: tree,
      startedAtUtc: '2026-07-24T00:00:00.000Z',
      completedAtUtc: '2026-07-24T00:00:01.000Z',
    })}\n`;
    return {
      command,
      exitCode: 0 as const,
      checkoutCommitSha: commit,
      checkoutTreeOid: tree,
      resultPath,
      resultSha256: writeArtifact(root, resultPath, result),
      logPath,
      logSha256: writeArtifact(root, logPath, log),
    };
  });
}

function matrixFixture(root: string, legacyCommit: string, legacyTree: string, candidateCommit: string, candidateTree: string) {
  return REQUIRED_OVERLAP_CLASSES.map((className, index) => {
    const id = `matrix-${index}-${className}`;
    const legacyLogPath = `overlap/rows/${id}-legacy.log`;
    const candidateLogPath = `overlap/rows/${id}-candidate.log`;
    const legacyLogSha256 = writeArtifact(root, legacyLogPath, `legacy ${className} PASS\n`);
    const candidateLogSha256 = writeArtifact(root, candidateLogPath, `candidate ${className} PASS\n`);
    const legacyResultPath = `overlap/rows/${id}-legacy.json`;
    const candidateResultPath = `overlap/rows/${id}-candidate.json`;
    const legacyResult = `${JSON.stringify({
      schemaVersion: 1,
      result: 'pass',
      side: 'legacy',
      matrixRowId: id,
      class: className,
      command: `legacy-${className}`,
      exitCode: 0,
      commitSha: legacyCommit,
      treeOid: legacyTree,
      logPath: legacyLogPath,
      logSha256: legacyLogSha256,
    })}\n`;
    const candidateResult = `${JSON.stringify({
      schemaVersion: 1,
      result: 'pass',
      side: 'candidate',
      matrixRowId: id,
      class: className,
      command: `candidate-${className}`,
      exitCode: 0,
      commitSha: candidateCommit,
      treeOid: candidateTree,
      logPath: candidateLogPath,
      logSha256: candidateLogSha256,
    })}\n`;
    return {
      id,
      class: className,
      legacyOperation: `legacy-${className}`,
      candidateOperation: `candidate-${className}`,
      legacyCommitSha: legacyCommit,
      legacyTreeOid: legacyTree,
      candidateCommitSha: candidateCommit,
      candidateTreeOid: candidateTree,
      legacyResultPath,
      legacyResultSha256: writeArtifact(root, legacyResultPath, legacyResult),
      candidateResultPath,
      candidateResultSha256: writeArtifact(root, candidateResultPath, candidateResult),
    };
  });
}

function rollbackProofFixture(
  root: string,
  finalTree: string,
  legacyCommit: string,
  legacyTree: string,
  drainDigest: string,
) {
  const entrypoints = REQUIRED_ROLLBACK_ENTRYPOINT_CLASSES.map((className) => ({ class: className, blocked: true, zero: true }));
  const exportPath = 'rollback/export.json';
  const drainResultPath = 'rollback/drain-result.json';
  const tsClaimPath = 'rollback/ts-claim.json';
  const legacyReadPath = 'rollback/legacy-read.json';
  const claimRecordPath = '/tmp/pr2a-rollback/claim.json';
  const exportBytes = `${JSON.stringify({ schemaVersion: 1, result: 'pass', detachedDrainSha256: drainDigest })}\n`;
  const drainResultBytes = `${JSON.stringify({ schemaVersion: 1, result: 'pass', drained: ['424242'], zeroSurvivorsBeforeResume: true })}\n`;
  const tsClaimBytes = `${JSON.stringify({ schemaVersion: 1, result: 'pass', recordPath: claimRecordPath })}\n`;
  const legacyReadBytes = `${JSON.stringify({
    schemaVersion: 1,
    result: 'pass',
    legacyCommitSha: legacyCommit,
    legacyTreeOid: legacyTree,
    recordPath: claimRecordPath,
  })}\n`;
  const artifacts = {
    export: { path: exportPath, sha256: writeArtifact(root, exportPath, exportBytes) },
    drainResult: { path: drainResultPath, sha256: writeArtifact(root, drainResultPath, drainResultBytes) },
    tsClaim: { path: tsClaimPath, sha256: writeArtifact(root, tsClaimPath, tsClaimBytes) },
    legacyRead: { path: legacyReadPath, sha256: writeArtifact(root, legacyReadPath, legacyReadBytes) },
  };
  return {
    schemaVersion: 1,
    result: 'pass',
    finalTreeOid: finalTree,
    legacyCommitSha: legacyCommit,
    legacyTreeOid: legacyTree,
    imports928ActivationMachinery: false,
    entryBefore: { mode: 'total-entrypoint-quiescence', result: 'pass', entrypoints },
    entryAfter: { mode: 'total-entrypoint-quiescence', result: 'pass', entrypoints },
    quiescence: { complete: true, zeroSurvivorsBeforeResume: true, entrypoints },
    fullRevert: {
      completed: true,
      fromTreeOid: finalTree,
      toCommitSha: legacyCommit,
      toTreeOid: legacyTree,
      detachedDrainSha256Before: drainDigest,
      detachedDrainSha256After: drainDigest,
    },
    artifacts,
  };
}

function evidenceFixture(): {
  root: string;
  evidence: ClosureEvidenceBundle;
  expected: { finalTreeOid: string; finalCommitSha: string; candidateBuildDigest: string };
} {
  const root = makeRoot('pr2a-evidence-');
  const environment = observedVerificationEnvironment(root);
  const commit = git(['rev-parse', 'HEAD']);
  const tree = git(['rev-parse', 'HEAD^{tree}']);
  const legacyCommit = LEGACY_FOUNDATION_COMMIT;
  const legacyTree = git(['rev-parse', `${legacyCommit}^{tree}`]);
  const candidateBuildDigest = digest('candidate-build');
  const harnessPath = 'overlap/replay.mjs';
  const inputsPath = 'overlap/inputs.json';
  const stdoutPath = 'overlap/stdout.txt';
  const matrixPath = 'overlap/matrix.json';
  const vectorsPath = 'overlap/vectors.json';
  const overlapLogPath = 'overlap/result.json';
  const drainPath = 'rollback/drain.json';
  const rollbackLogPath = 'rollback/result.json';
  const rollbackProofPath = 'rollback/proof.json';
  const bodyPath = 'external/issue-928.md';
  const matrixRows = matrixFixture(root, legacyCommit, legacyTree, commit, tree);
  const matrix = `${JSON.stringify({ schemaVersion: 2, classes: REQUIRED_OVERLAP_CLASSES, rows: matrixRows })}\n`;
  const vectors = readFileSync(path.join(repoRoot, 'scripts/pr2a/review-start-claim-protocol-vectors.json'), 'utf8');
  const replayResult = {
    schemaVersion: 1,
    result: 'pass',
    legacyCommitSha: legacyCommit,
    legacyTreeOid: legacyTree,
    candidateCommitSha: commit,
    candidateTreeOid: tree,
    classes: [...REQUIRED_OVERLAP_CLASSES],
    dataVectorClasses: [...REQUIRED_DATA_VECTOR_CLASSES],
    protocolVectorClasses: [...REQUIRED_PROTOCOL_VECTOR_CLASSES],
    executedRows: matrixRows.map((row) => row.id),
  };
  const harness = "import { readFileSync } from 'node:fs'; const input=JSON.parse(readFileSync(process.argv[2], 'utf8')); process.stdout.write(JSON.stringify(input.replayResult)+'\\n');\n";
  const inputs = `${JSON.stringify({ replayResult })}\n`;
  const stdout = `${JSON.stringify(replayResult)}\n`;
  const drain = `${JSON.stringify({ schemaVersion: 1, issue: 948, result: 'drained' })}\n`;
  const drainDigest = writeArtifact(root, drainPath, drain);
  const rollbackProof = rollbackProofFixture(root, tree, legacyCommit, legacyTree, drainDigest);
  const rollbackProofBytes = `${JSON.stringify(rollbackProof)}\n`;
  const overlapLog = `${JSON.stringify({
    schemaVersion: 1,
    result: 'pass',
    legacyCommitSha: legacyCommit,
    legacyTreeOid: legacyTree,
    candidateCommitSha: commit,
    candidateTreeOid: tree,
    candidateBuildDigest,
    classes: REQUIRED_OVERLAP_CLASSES,
  })}\n`;
  const rollbackLog = `${JSON.stringify({
    schemaVersion: 1,
    result: 'pass',
    finalTreeOid: tree,
    zeroSurvivorsBeforeResume: true,
    detachedDrainSha256: drainDigest,
  })}\n`;
  const issueBody = '#928 consumes #948 TypeScript authority, independently recomputes current closure, and refuses receipt-only trust.\n';

  const evidence: ClosureEvidenceBundle = {
    schemaVersion: 1,
    overlap: {
      schemaVersion: 1,
      result: 'pass',
      generatedAfterFinalTree: true,
      finalTreeOid: tree,
      candidateTreeOid: tree,
      candidateBuildDigest,
      legacyRepository: 'chetwerikoff/orchestrator-pack',
      legacyCommitSha: legacyCommit,
      legacyTreeOid: legacyTree,
      candidateRepository: 'chetwerikoff/orchestrator-pack',
      candidateCommitSha: commit,
      harnessPath,
      harnessSha256: writeArtifact(root, harnessPath, harness),
      harnessBytesArchived: true,
      operationMatrixPath: matrixPath,
      operationMatrixSha256: writeArtifact(root, matrixPath, matrix),
      replayCommand: process.execPath,
      replayArgs: [harnessPath, inputsPath, matrixPath, vectorsPath],
      replayCwd: '.',
      replayInputsPath: inputsPath,
      replayInputsSha256: writeArtifact(root, inputsPath, inputs),
      replayStdoutPath: stdoutPath,
      replayStdoutSha256: writeArtifact(root, stdoutPath, stdout),
      replayExitCode: 0,
      protocolVectorPath: vectorsPath,
      protocolVectorSha256: writeArtifact(root, vectorsPath, vectors),
      platform: environment.platform,
      filesystem: environment.filesystem,
      classes: [...REQUIRED_OVERLAP_CLASSES],
      logPath: overlapLogPath,
      logSha256: writeArtifact(root, overlapLogPath, overlapLog),
    },
    rollback: {
      schemaVersion: 1,
      result: 'pass',
      finalTreeOid: tree,
      isolatedCheckout: true,
      entryBlockedBeforeRevert: true,
      entryBlockedAfterRevert: true,
      quiescenceInventoryComplete: true,
      detachedDrainPath: drainPath,
      detachedDrainSha256: drainDigest,
      detachedDrainSurvivedRevert: true,
      zeroSurvivorsBeforeResume: true,
      legacyReadTsRecord: true,
      imports928ActivationMachinery: false,
      legacyCommitSha: legacyCommit,
      legacyTreeOid: legacyTree,
      proofPath: rollbackProofPath,
      proofSha256: writeArtifact(root, rollbackProofPath, rollbackProofBytes),
      logPath: rollbackLogPath,
      logSha256: writeArtifact(root, rollbackLogPath, rollbackLog),
    },
    preReceiptVerification: {
      schemaVersion: 1,
      result: 'pass',
      finalTreeOid: tree,
      checkoutCommitSha: commit,
      checkoutTreeOid: tree,
      repository: 'chetwerikoff/orchestrator-pack',
      platform: environment.platform,
      filesystem: environment.filesystem,
      nodeVersion: environment.nodeVersion,
      pwshVersion: environment.pwshVersion,
      cleanBefore: true,
      cleanAfter: true,
      stagedBefore: 0,
      stagedAfter: 0,
      untrackedBefore: 0,
      untrackedAfter: 0,
      prerequisiteSuitesPassedBeforeReceipt: true,
      commands: verificationCommands(root, commit, tree),
    },
    external928: {
      schemaVersion: 1,
      result: 'pass',
      url: 'https://github.com/chetwerikoff/orchestrator-pack/issues/928',
      repository: 'chetwerikoff/orchestrator-pack',
      issue: 928,
      revisionIdentity: 'updated:2026-07-24',
      updatedAt: '2026-07-24T00:00:00Z',
      capturedAt: '2026-07-24T00:01:00Z',
      actor: 'chetwerikoff',
      tool: 'GitHub API',
      bodyPath,
      bodySha256: writeArtifact(root, bodyPath, issueBody),
      requirements: {
        consumesPr2aTsAuthority: true,
        consumesReceiptAsPrecedent: true,
        independentlyRecomputesCurrentClosure: true,
        invariantBasedRefusal: true,
        historicalInventoryEqualityNotRequired: true,
      },
    },
  };
  return { root, evidence, expected: { finalTreeOid: tree, finalCommitSha: commit, candidateBuildDigest } };
}

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
    const findings = validateBridgeSource("function Invoke-ReviewStartClaimTsOperation(){}\nSet-Content x y\nreview-start-claim-store.ts");
    expect(findings.map((row) => row.code)).toContain('bridge_policy_or_storage_logic');
  });

  it('rejects a runner that routes claims through PowerShell', () => {
    const findings = validateRunnerSource("import './lib/Review-StartClaimLifecycle.ps1'; async function acquireClaimLease(){ pwsh(); }");
    expect(findings.map((row) => row.code)).toContain('runner_claim_powershell_or_cli_edge');
    expect(findings.map((row) => row.code)).toContain('runner_claim_path_spawns_process');
  });

  it('rejects an unfenced store and a shape-only closure verifier', () => {
    expect(validateClaimStoreSource("await import('./review-start-claim-cli.ts'); PollOnce").map((row) => row.code))
      .toContain('claim_store_protocol_guard_missing');
    expect(validateClosureReceiptSource('const DIGEST=/x/; const result="pass";').map((row) => row.code))
      .toContain('closure_receipt_independent_verification_missing');
  });
});

describe('Issue #948 closure receipt evidence', () => {
  it('accepts replayed, artifact-bound, tree-bound evidence', () => {
    const fixture = evidenceFixture();
    expect(validateClosureEvidenceBundle(fixture.evidence, fixture.expected, fixture.root)).toEqual([]);
  });

  it('fails closed on unsupported pre-receipt and final verification environments', () => {
    const unsupported = {
      repository: 'chetwerikoff/orchestrator-pack',
      platform: 'win32',
      filesystem: 'cifs',
      nodeVersion: 'v20.0.0',
      pwshVersion: '5.1.0',
    };
    expect(validatePreReceiptVerificationEnvironment(unsupported)).toEqual(expect.arrayContaining([
      'pre-receipt-platform-unsupported',
      'pre-receipt-node-version-mismatch',
      'pre-receipt-pwsh-version-mismatch',
      'pre-receipt-filesystem-mismatch',
    ]));
    expect(validateFinalVerificationEnvironment(unsupported)).toEqual(expect.arrayContaining([
      'final-verification-platform-unsupported',
      'final-verification-node-version-mismatch',
      'final-verification-pwsh-version-mismatch',
      'final-verification-filesystem-mismatch',
    ]));
  });

  it('refuses missing, tampered, or wrong-content artifacts despite unchanged claims', () => {
    const fixture = evidenceFixture();
    writeFileSync(path.join(fixture.root, fixture.evidence.overlap.harnessPath), 'tampered\n');
    rmSync(path.join(fixture.root, fixture.evidence.overlap.operationMatrixPath));
    writeFileSync(path.join(fixture.root, fixture.evidence.external928.bodyPath), 'unrelated body\n');
    const findings = validateClosureEvidenceBundle(fixture.evidence, fixture.expected, fixture.root);
    expect(findings).toContain('overlap-harness:digest-mismatch');
    expect(findings).toContain('overlap-operation-matrix:missing');
    expect(findings).toContain('external-928-body:digest-mismatch');
    expect(findings).toContain('external-928-body-contract-mismatch');
  });

  it('rejects incomplete matrix/vector coverage and tampered rollback proof semantics', () => {
    const fixture = evidenceFixture();
    const matrixPath = path.join(fixture.root, fixture.evidence.overlap.operationMatrixPath);
    const matrix = JSON.parse(readFileSync(matrixPath, 'utf8')) as { rows: Array<{ class: string }>; classes: string[] };
    matrix.rows = matrix.rows.filter((row) => row.class !== 'interpretation');
    const matrixBytes = `${JSON.stringify(matrix)}\n`;
    writeFileSync(matrixPath, matrixBytes);
    fixture.evidence.overlap.operationMatrixSha256 = digest(matrixBytes);

    const vectorsPath = path.join(fixture.root, fixture.evidence.overlap.protocolVectorPath);
    const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as { protocolVectors: Array<{ class: string }> };
    vectors.protocolVectors = vectors.protocolVectors.filter((row) => row.class !== 'crash-points');
    const vectorBytes = `${JSON.stringify(vectors)}\n`;
    writeFileSync(vectorsPath, vectorBytes);
    fixture.evidence.overlap.protocolVectorSha256 = digest(vectorBytes);

    const proofPath = path.join(fixture.root, fixture.evidence.rollback.proofPath);
    const proof = JSON.parse(readFileSync(proofPath, 'utf8')) as { fullRevert: { completed: boolean } };
    proof.fullRevert.completed = false;
    const proofBytes = `${JSON.stringify(proof)}\n`;
    writeFileSync(proofPath, proofBytes);
    fixture.evidence.rollback.proofSha256 = digest(proofBytes);

    const findings = validateClosureEvidenceBundle(fixture.evidence, fixture.expected, fixture.root);
    expect(findings).toContain('overlap-operation-matrix-row-coverage-mismatch');
    expect(findings).toContain('overlap-protocol-vector-class-missing:crash-points');
    expect(findings).toContain('rollback-full-revert-proof-incomplete');
  });

  it('validates receipt-bound final verification through concrete result and log artifacts', () => {
    const fixture = evidenceFixture();
    const environment = observedVerificationEnvironment(fixture.root);
    const receiptCore = {
      schemaVersion: 2,
      lineage: { finalCommitSha: fixture.expected.finalCommitSha, finalTreeOid: fixture.expected.finalTreeOid },
      result: 'tree-bound-empty-external-reverse-closure',
    };
    const receiptSha256 = `sha256:${createHash('sha256').update(stableJson(receiptCore)).digest('hex')}`;
    const receipt = { ...receiptCore, receiptSha256 };
    const verification: FinalVerificationEvidence = {
      schemaVersion: 1,
      result: 'pass',
      receiptSha256,
      finalTreeOid: fixture.expected.finalTreeOid,
      checkoutCommitSha: fixture.expected.finalCommitSha,
      checkoutTreeOid: fixture.expected.finalTreeOid,
      repository: 'chetwerikoff/orchestrator-pack',
      platform: environment.platform,
      filesystem: environment.filesystem,
      nodeVersion: environment.nodeVersion,
      pwshVersion: environment.pwshVersion,
      cleanBefore: true,
      cleanAfter: true,
      stagedBefore: 0,
      stagedAfter: 0,
      untrackedBefore: 0,
      untrackedAfter: 0,
      commands: fixture.evidence.preReceiptVerification.commands,
    };
    expect(validateFinalVerificationAgainstReceipt(verification, receipt, fixture.root)).toEqual([]);
    writeFileSync(path.join(fixture.root, verification.commands[0]!.resultPath), '{}\n');
    expect(validateFinalVerificationAgainstReceipt(verification, receipt, fixture.root))
      .toContain(`command-result:${verification.commands[0]!.command}:digest-mismatch`);
  });
});

describe('Issue #948 persisted TypeScript claim authority', () => {
  it('fails unsupported Windows-mounted namespaces before creating claim state', () => {
    const namespace = `/mnt/c/opk-pr2a-unsupported-${process.pid}-${Date.now()}`;
    expect(() => assertSupportedClaimPlatform(namespace)).toThrow('unsupported_windows_mounted_filesystem');
    expect(existsSync(namespace)).toBe(false);
  });

  it('fails closed on unsupported schema and contradictory canonical identity without mutating the record', () => {
    const root = makeRoot('pr2a-invalid-record-');
    const sha = '6'.repeat(40);
    const file = claimPath(root, 948, sha);
    const base = {
      schemaVersion: 1,
      key: `pr-948-${sha}`,
      prNumber: 948,
      headSha: sha,
      state: 'active',
      holder: { surface: 'invalid-record', pid: 2_147_483_000, host: 'candidate-host', generation: 'g', processGuid: 'invalid-guid' },
      acquiredAtUtc: new Date().toISOString(),
      startReason: 'automatic',
      projectNamespace: 'orchestrator-pack',
      firstAttemptAtMonotonicMs: 1,
      readinessStartMonotonicMs: 1,
    };

    atomicWriteJson(file, { ...base, schemaVersion: 2 });
    const unsupportedBytes = readFileSync(file, 'utf8');
    const unsupported = readClaimRecord(file);
    expect(unsupported.ok).toBe(false);
    expect(`${unsupported.reason}:${unsupported.error}`).toContain('unsupported_schema_version');
    const unsupportedAcquire = acquireReviewStartClaim({ prNumber: 948, headSha: sha, surface: 'candidate', namespace: root, reviewRuns: [] });
    expect(unsupportedAcquire).toMatchObject({ acquired: false, reason: 'ambiguous_claim' });
    expect(readFileSync(file, 'utf8')).toBe(unsupportedBytes);

    atomicWriteJson(file, { ...base, key: `pr-999-${sha}` });
    const contradictoryBytes = readFileSync(file, 'utf8');
    const contradictory = readClaimRecord(file);
    expect(contradictory.ok).toBe(false);
    expect(`${contradictory.reason}:${contradictory.error}`).toContain('claim_identity_mismatch');
    const contradictoryAcquire = acquireReviewStartClaim({ prNumber: 948, headSha: sha, surface: 'candidate', namespace: root, reviewRuns: [] });
    expect(contradictoryAcquire).toMatchObject({ acquired: false, reason: 'ambiguous_claim' });
    expect(readFileSync(file, 'utf8')).toBe(contradictoryBytes);
  });

  it('admits one winner under TS-vs-TS overlap', async () => {
    const root = makeRoot('pr2a-ts-overlap-');
    const start = path.join(root, 'start');
    const release = path.join(root, 'release');
    const results = Array.from({ length: 6 }, (_, index) => path.join(root, `result-${index}.json`));
    results.forEach((result) => spawnTsClaim(root, result, start, release));
    writeFileSync(start, 'go');
    await waitForFiles(results);
    const resultRows = results.map((fileName) => JSON.parse(readFileSync(fileName, 'utf8')) as { acquired: boolean; reason: string });
    expect(resultRows.filter((row) => row.acquired)).toHaveLength(1);
    expect(resultRows.filter((row) => !row.acquired).every((row) => row.reason === 'claimed')).toBe(true);
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
    const resultRows = [tsResult, psResult].map((fileName) => JSON.parse(readFileSync(fileName, 'utf8')) as { acquired: boolean; reason: string });
    expect(resultRows.filter((row) => row.acquired)).toHaveLength(1);
    expect(resultRows.find((row) => !row.acquired)?.reason).toBe('claimed');
    writeFileSync(release, 'done');
  }, 60_000);

  it('owner-binds stale-lock takeover under two barrier-controlled recoverers', async () => {
    const root = makeRoot('pr2a-stale-takeover-');
    const sha = 'c'.repeat(40);
    const seed = acquireReviewStartClaim({ prNumber: 948, headSha: sha, surface: 'stale-seed', namespace: root, reviewRuns: [] });
    expect(seed.acquired).toBe(true);
    const recordPath = claimPath(root, 948, sha);
    const stale = readClaimRecord(recordPath).record!;
    stale.holder.pid = 2_147_483_000;
    stale.holder.processGuid = 'stale-holder';
    delete stale.holder.startTimeTicks;
    delete stale.holder.bootIdHash;
    stale.acquiredAtUtc = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    atomicWriteJson(recordPath, stale);
    const lock = claimLockDir(root, 948, sha);
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(lock, 'owner.json'), `${JSON.stringify({
      pid: 2_147_483_000,
      processGuid: 'stale-lock-owner',
      acquiredAtUtc: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    })}\n`);
    const barrier = path.join(root, 'barrier');
    const release = path.join(root, 'release');
    const results = [path.join(root, 'recover-a.json'), path.join(root, 'recover-b.json')];
    results.forEach((result) => spawnStaleRecoverer(root, barrier, result, release));
    await waitForCondition(() => existsSync(barrier)
      && readdirSync(barrier).filter((name) => name.endsWith('.observed')).length === 2);
    writeFileSync(path.join(barrier, 'go'), 'go\n');
    await waitForFiles(results);
    const resultRows = results.map((fileName) => JSON.parse(readFileSync(fileName, 'utf8')) as { acquired: boolean; reason: string });
    expect(resultRows.filter((row) => row.acquired)).toHaveLength(1);
    expect(resultRows.filter((row) => !row.acquired)).toHaveLength(1);
    expect(resultRows.find((row) => !row.acquired)?.reason).toBe('claimed');
    writeFileSync(release, 'done');
  }, 60_000);

  it('refreshes the run store on every bridge visibility poll', () => {
    const root = makeRoot('pr2a-live-visibility-');
    const sha = 'd'.repeat(40);
    const script = `
      $ErrorActionPreference='Stop'
      . '${bridgePath.replaceAll("'", "''")}'
      $claim = Acquire-ReviewStartClaim -PrNumber 948 -HeadSha '${sha}' -Surface 'visibility-test' -Namespace '${root.replaceAll("'", "''")}' -ReviewRuns @()
      $script:calls = 0
      $result = Complete-ReviewStartClaimAfterRunInvoke -ClaimResult $claim -ReviewRuns @() -ResolveReviewRuns {
        $script:calls++
        if ($script:calls -eq 1) { return @() }
        return @(@{ id='opk-rev-visible'; prNumber=948; targetSha='${sha}'; status='running' })
      }
      @{ calls=$script:calls; ok=[bool]$result.ok; outcome=[string]$result.outcome; reason=[string]$result.reason } | ConvertTo-Json -Compress
    `;
    const result = runProcessSync({ command: 'pwsh', args: ['-NoProfile', '-Command', script], cwd: repoRoot, inheritParentEnv: true });
    expect(result.ok, result.stderr || result.error).toBe(true);
    const row = JSON.parse(result.stdout) as { calls: number; ok: boolean; outcome: string };
    expect(row.calls).toBeGreaterThanOrEqual(2);
    expect(row).toMatchObject({ ok: true, outcome: 'run_started' });
  }, 60_000);

  it('generation-fences completion from a superseded holder', () => {
    const root = makeRoot('pr2a-fence-');
    const sha = 'b'.repeat(40);
    const first = acquireReviewStartClaim({ prNumber: 948, headSha: sha, surface: 'first', namespace: root, reviewRuns: [] });
    expect(first.acquired).toBe(true);
    const file = claimPath(root, 948, sha);
    const stale = readClaimRecord(file).record!;
    stale.holder.pid = 2_147_483_000;
    delete stale.holder.startTimeTicks;
    delete stale.holder.bootIdHash;
    stale.acquiredAtUtc = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    atomicWriteJson(file, stale);
    const second = acquireReviewStartClaim({ prNumber: 948, headSha: sha, surface: 'second', namespace: root, reviewRuns: [] });
    expect(second.acquired).toBe(true);
    const oldCompletion = completeReviewStartClaim(first, 'run_started', []);
    expect(oldCompletion.ok).toBe(false);
    expect(readClaimRecord(file).record?.holder.processGuid).toBe(second.claim?.holder.processGuid);
  });

  it('executes committed claim-record vectors through the shared store and covers every declared vector class', () => {
    const root = makeRoot('pr2a-vector-');
    const vectorDocument = JSON.parse(readFileSync(path.join(repoRoot, 'scripts/pr2a/review-start-claim-protocol-vectors.json'), 'utf8')) as {
      vectors: Array<{ id: string; class: string; kind: string; record?: Record<string, unknown>; expect: { readable?: boolean; reason?: string } }>;
      protocolVectors: Array<{ id: string; class: string; steps: string[]; sourceTest: string }>;
    };
    for (const className of REQUIRED_DATA_VECTOR_CLASSES) expect(vectorDocument.vectors.some((row) => row.class === className)).toBe(true);
    for (const className of REQUIRED_PROTOCOL_VECTOR_CLASSES) expect(vectorDocument.protocolVectors.some((row) => row.class === className)).toBe(true);
    expect(vectorDocument.protocolVectors.every((row) => row.steps.length > 0 && row.sourceTest.length > 0)).toBe(true);

    for (const vector of vectorDocument.vectors.filter((row) => row.kind === 'claim-record')) {
      const file = path.join(root, `${vector.id}.json`);
      if (vector.record) atomicWriteJson(file, vector.record);
      const read = readClaimRecord(file);
      if (vector.expect.readable === true) {
        expect(read.ok, `${vector.id}:${read.reason}:${read.error}`).toBe(true);
        expect(read.record).toMatchObject(vector.record ?? {});
      } else {
        expect(read.ok, vector.id).toBe(false);
        if (vector.expect.reason) expect(`${read.reason}:${read.error}`).toContain(vector.expect.reason);
      }
    }

    const legacy = vectorDocument.vectors.find((row) => row.id === 'legacy-active-v1')!;
    const file = path.join(root, 'legacy-bridge.json');
    atomicWriteJson(file, legacy.record);
    const command = `. '${bridgePath.replaceAll("'", "''")}'; Read-ReviewStartClaimRecord -Path '${file.replaceAll("'", "''")}' | ConvertTo-Json -Compress -Depth 20`;
    const result = runProcessSync({ command: 'pwsh', args: ['-NoProfile', '-Command', command], cwd: repoRoot, inheritParentEnv: true });
    expect(result.ok, result.stderr || result.error).toBe(true);
    const bridged = JSON.parse(result.stdout).record as Record<string, unknown>;
    const legacyRecord = legacy.record ?? {};
    expect(bridged).toMatchObject({
      schemaVersion: legacyRecord.schemaVersion,
      key: legacyRecord.key,
      prNumber: legacyRecord.prNumber,
      headSha: legacyRecord.headSha,
      state: legacyRecord.state,
      holder: legacyRecord.holder,
      startReason: legacyRecord.startReason,
      projectNamespace: legacyRecord.projectNamespace,
      firstAttemptAtMonotonicMs: legacyRecord.firstAttemptAtMonotonicMs,
      readinessStartMonotonicMs: legacyRecord.readinessStartMonotonicMs,
    });
    expect(Date.parse(String(bridged.acquiredAtUtc))).toBe(Date.parse(String(legacyRecord.acquiredAtUtc)));
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
