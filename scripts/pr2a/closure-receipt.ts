#!/usr/bin/env node
import '../toolchain/native-entrypoint-preflight.ts';

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';
import { D928, sha256, stableJson, type PlanningManifest } from './contracts.ts';
import { buildConformanceReport } from './final-conformance.ts';

const repoRoot = path.resolve(process.cwd());
export const REQUIRED_OVERLAP_CLASSES = [
  'acquisition',
  'guarded-mutation',
  'terminal-audit',
  'release-completion',
  'recovery-reap',
  'interpretation',
  'generation-fence',
] as const;
export const REQUIRED_FINAL_COMMANDS = [
  'npm run typecheck:foundation',
  'npm run lint:foundation',
  'npm run test:contract-mutations',
  'npm run test:issue-948',
  'pwsh -NoProfile -File scripts/verify.ps1',
  'pwsh -NoProfile -File scripts/check-reusable.ps1',
  'pwsh -NoProfile -File scripts/test-all.ps1',
  'vitest-light',
  'vitest-heavy',
] as const;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const FULL_SHA = /^[0-9a-f]{40}$/u;
const UNSUPPORTED_FILESYSTEMS = new Set([
  '9p', 'drvfs', 'cifs', 'smbfs', 'nfs', 'nfs4', 'fuseblk', 'fuse.sshfs',
]);

export const CLOSURE_SOURCE_REQUIREMENTS = Object.freeze([
  ['function verifyArtifact', 'receipt-self-asserts-unverifiable-tree'],
  ['function verifyCommandLogs', 'receipt-generated-before-prerequisite-suites'],
  ['function verifyReplay', 'overlap-replay-command-missing'],
  ['function validateVerificationEnvironment', 'final-evidence-tree-or-platform-stale'],
  ['function validatePreReceiptVerificationEnvironment', 'pre-receipt-environment-validator-missing'],
  ['function validateFinalVerificationEnvironment', 'final-verification-environment-validator-missing'],
  ['verification.nodeVersion', 'verification-node-version-unbound'],
  ['verification.pwshVersion', 'verification-pwsh-version-unbound'],
  ['verification.filesystem', 'verification-filesystem-unbound'],
  ['preReceiptVerification.nodeVersion', 'pre-receipt-node-version-unbound'],
  ['preReceiptVerification.pwshVersion', 'pre-receipt-pwsh-version-unbound'],
  ['preReceiptVerification.filesystem', 'pre-receipt-filesystem-unbound'],
  ['command-result-tree-binding-mismatch', 'receipt-final-tree-or-lineage-invalid'],
  ['overlap-replay-not-bound-to-harness-and-inputs', 'overlap-harness-or-job-bytes-unbound'],
  ['overlap-operation-matrix-content-mismatch', 'overlap-operation-matrix-missing'],
  ['overlap.candidateCommitSha !== expected.finalCommitSha', 'overlap-candidate-binding-mismatch'],
  ['gitTreeOid(overlap.candidateCommitSha)', 'candidate-build-not-derived-from-final-tree'],
  ['buildCandidateBuildProvenance', 'candidate-build-attestation-invalid'],
  ['overlap.generatedAfterFinalTree !== true', 'overlap-evidence-generated-before-final-tree'],
  ['prerequisiteSuitesPassedBeforeReceipt', 'receipt-generated-before-prerequisite-suites'],
  ['buildConformanceReport(ref)', 'independent-pr2a-recompute-disagrees'],
  ['external-928-body-contract-mismatch', '928-admission-skips-current-recompute'],
  ['historicalInventoryEqualityNotRequired', '928-admission-requires-historical-inventory-equality'],
  ['receipt-and-final-verification-tree-differ', 'receipt-and-final-verification-tree-differ'],
  ['final-checks-on-dirty-worktree', 'final-checks-on-dirty-worktree'],
  ['verifyArtifact(evidenceRoot', 'evidence-tree-differs-from-executed-bytes'],
] as const);

function git(args: string[]): string {
  const result = runProcessSync({ command: 'git', args, cwd: repoRoot, inheritParentEnv: true });
  if (!result.ok) throw new Error(result.stderr || result.error || `git_${args.join('_')}_failed`);
  return result.stdout;
}
function readAt(ref: string, file: string): string { return git(['show', `${ref}:${file}`]); }
function digestStructured(value: unknown): string { return sha256(stableJson(value)); }
function unique(findings: string[]): string[] { return [...new Set(findings)].sort(); }
function major(version: string): number {
  const match = /^v?(\d+)(?:\.|$)/u.exec(String(version ?? '').trim());
  return match ? Number(match[1]) : 0;
}

export interface VerificationCommandEvidence {
  command: string;
  exitCode: 0;
  checkoutCommitSha: string;
  checkoutTreeOid: string;
  resultPath: string;
  resultSha256: string;
  logPath: string;
  logSha256: string;
}
export interface OverlapEvidence {
  schemaVersion: 1;
  result: 'pass';
  generatedAfterFinalTree: true;
  finalTreeOid: string;
  candidateTreeOid: string;
  candidateBuildDigest: string;
  legacyRepository: string;
  legacyCommitSha: string;
  legacyTreeOid: string;
  candidateRepository: string;
  candidateCommitSha: string;
  harnessPath: string;
  harnessSha256: string;
  harnessBytesArchived: true;
  operationMatrixPath: string;
  operationMatrixSha256: string;
  replayCommand: string;
  replayArgs: string[];
  replayCwd: string;
  replayInputsPath: string;
  replayInputsSha256: string;
  replayStdoutPath: string;
  replayStdoutSha256: string;
  replayExitCode: 0;
  protocolVectorPath: string;
  protocolVectorSha256: string;
  platform: string;
  filesystem: string;
  classes: string[];
  logPath: string;
  logSha256: string;
}
export interface RollbackEvidence {
  schemaVersion: 1;
  result: 'pass';
  finalTreeOid: string;
  isolatedCheckout: true;
  entryBlockedBeforeRevert: true;
  entryBlockedAfterRevert: true;
  quiescenceInventoryComplete: true;
  detachedDrainPath: string;
  detachedDrainSha256: string;
  detachedDrainSurvivedRevert: true;
  zeroSurvivorsBeforeResume: true;
  legacyReadTsRecord: true;
  imports928ActivationMachinery: false;
  logPath: string;
  logSha256: string;
}
export interface PreReceiptVerificationEvidence {
  schemaVersion: 1;
  result: 'pass';
  finalTreeOid: string;
  checkoutCommitSha: string;
  checkoutTreeOid: string;
  repository: string;
  platform: string;
  filesystem: string;
  nodeVersion: string;
  pwshVersion: string;
  cleanBefore: true;
  cleanAfter: true;
  stagedBefore: 0;
  stagedAfter: 0;
  untrackedBefore: 0;
  untrackedAfter: 0;
  prerequisiteSuitesPassedBeforeReceipt: true;
  commands: VerificationCommandEvidence[];
}
export interface FinalVerificationEvidence {
  schemaVersion: 1;
  result: 'pass';
  receiptSha256: string;
  finalTreeOid: string;
  checkoutCommitSha: string;
  checkoutTreeOid: string;
  repository: string;
  platform: string;
  filesystem: string;
  nodeVersion: string;
  pwshVersion: string;
  cleanBefore: true;
  cleanAfter: true;
  stagedBefore: 0;
  stagedAfter: 0;
  untrackedBefore: 0;
  untrackedAfter: 0;
  commands: VerificationCommandEvidence[];
}
export interface External928Evidence {
  schemaVersion: 1;
  result: 'pass';
  url: string;
  repository: 'chetwerikoff/orchestrator-pack';
  issue: 928;
  revisionIdentity: string;
  updatedAt: string;
  capturedAt: string;
  actor: string;
  tool: string;
  bodyPath: string;
  bodySha256: string;
  requirements: {
    consumesPr2aTsAuthority: true;
    consumesReceiptAsPrecedent: true;
    independentlyRecomputesCurrentClosure: true;
    invariantBasedRefusal: true;
    historicalInventoryEqualityNotRequired: true;
  };
}
export interface ClosureEvidenceBundle {
  schemaVersion: 1;
  overlap: OverlapEvidence;
  rollback: RollbackEvidence;
  preReceiptVerification: PreReceiptVerificationEvidence;
  external928: External928Evidence;
}
export interface CandidateBuildProvenance {
  command: string;
  nodeVersionPolicySha256: string;
  packageJsonSha256: string;
  packageLockSha256: string;
  tsconfigSha256: string;
  sourceDigests: Record<string, string>;
  digest: string;
}

type VerificationEnvironmentEvidence = Pick<
  PreReceiptVerificationEvidence,
  'repository' | 'platform' | 'filesystem' | 'nodeVersion' | 'pwshVersion'
>;

function resolveEvidencePath(
  root: string,
  relativePath: string,
  code: string,
  findings: string[],
  allowRoot = false,
): string | null {
  const clean = String(relativePath ?? '').trim();
  if (!clean || path.isAbsolute(clean)) {
    findings.push(`${code}:path-invalid`);
    return null;
  }
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, clean);
  const rel = path.relative(absoluteRoot, absolute);
  if ((!allowRoot && !rel) || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    findings.push(`${code}:path-outside-root`);
    return null;
  }
  return absolute;
}

function verifyArtifact(root: string, relativePath: string, claimedDigest: string, code: string, findings: string[]): Buffer | null {
  if (!DIGEST.test(claimedDigest)) {
    findings.push(`${code}:digest-invalid`);
    return null;
  }
  const absolute = resolveEvidencePath(root, relativePath, code, findings);
  if (!absolute) return null;
  if (!existsSync(absolute)) {
    findings.push(`${code}:missing`);
    return null;
  }
  let bytes: Buffer;
  try { bytes = readFileSync(absolute); }
  catch { findings.push(`${code}:unreadable`); return null; }
  if (sha256(bytes) !== claimedDigest) findings.push(`${code}:digest-mismatch`);
  return bytes;
}

function parseJsonArtifact(bytes: Buffer | null, code: string, findings: string[]): Record<string, unknown> | null {
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not_object');
    return value as Record<string, unknown>;
  } catch {
    findings.push(`${code}:malformed`);
    return null;
  }
}

function mountInfoForPath(target: string): { mount: string; fsType: string } | null {
  if (process.platform !== 'linux') return null;
  try {
    const canonical = path.resolve(target);
    const rows = readFileSync('/proc/self/mountinfo', 'utf8').split(/\r?\n/u).filter(Boolean);
    let best: { mount: string; fsType: string } | null = null;
    for (const row of rows) {
      const split = row.split(' - ');
      if (split.length !== 2) continue;
      const left = split[0]?.split(' ') ?? [];
      const right = split[1]?.split(' ') ?? [];
      const mount = String(left[4] ?? '').replace(/\\040/gu, ' ');
      const fsType = String(right[0] ?? '');
      if (!mount || !(canonical === mount || (mount === '/' ? canonical.startsWith('/') : canonical.startsWith(`${mount}/`)))) continue;
      if (!best || mount.length > best.mount.length) best = { mount, fsType };
    }
    return best;
  } catch {
    return null;
  }
}

function observedPwshVersion(): string | null {
  const result = runProcessSync({
    command: 'pwsh',
    args: ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
    cwd: repoRoot,
    inheritParentEnv: true,
  });
  return result.ok ? result.stdout.trim() : null;
}

function validateVerificationEnvironment(
  verification: VerificationEnvironmentEvidence,
  evidenceRoot: string,
  prefix: string,
  findings: string[],
): void {
  if (verification.repository !== 'chetwerikoff/orchestrator-pack') findings.push(`${prefix}-repository-invalid`);
  const platformClaim = String(verification.platform ?? '').trim().toLowerCase();
  if (process.platform !== 'linux' || !['linux', 'wsl2'].includes(platformClaim)) {
    findings.push(`${prefix}-platform-unsupported`);
  }
  if (major(process.version) !== 22 || major(verification.nodeVersion) !== 22
    || verification.nodeVersion.replace(/^v/u, '') !== process.version.replace(/^v/u, '')) {
    findings.push(`${prefix}-node-version-mismatch`);
  }
  const pwsh = observedPwshVersion();
  if (!pwsh || major(pwsh) !== 7 || major(verification.pwshVersion) !== 7
    || verification.pwshVersion.replace(/^v/u, '') !== pwsh.replace(/^v/u, '')) {
    findings.push(`${prefix}-pwsh-version-mismatch`);
  }
  const root = path.resolve(evidenceRoot || repoRoot);
  if (/^\/mnt\/[a-z](?:\/|$)/iu.test(root)) findings.push(`${prefix}-filesystem-unsupported`);
  const mount = mountInfoForPath(root);
  const claimedFs = String(verification.filesystem ?? '').trim().toLowerCase();
  if (!mount || !claimedFs || UNSUPPORTED_FILESYSTEMS.has(mount.fsType.toLowerCase())
    || claimedFs !== mount.fsType.toLowerCase()) {
    findings.push(`${prefix}-filesystem-mismatch`);
  }
}

export function validatePreReceiptVerificationEnvironment(
  verification: VerificationEnvironmentEvidence,
  evidenceRoot = '',
): string[] {
  const findings: string[] = [];
  validateVerificationEnvironment(verification, evidenceRoot, 'pre-receipt', findings);
  return unique(findings);
}

export function validateFinalVerificationEnvironment(
  verification: VerificationEnvironmentEvidence,
  evidenceRoot = '',
): string[] {
  const findings: string[] = [];
  validateVerificationEnvironment(verification, evidenceRoot, 'final-verification', findings);
  return unique(findings);
}

function verifyCommandLogs(
  root: string,
  rows: VerificationCommandEvidence[],
  expectedCommitSha: string,
  expectedTreeOid: string,
  findings: string[],
): void {
  const commands = new Map(rows.map((row) => [row.command, row]));
  for (const command of REQUIRED_FINAL_COMMANDS) {
    const row = commands.get(command);
    if (!row) {
      findings.push(`required-suite-omitted-from-mandatory-path:${command}`);
      continue;
    }
    if (row.exitCode !== 0) findings.push(`mandatory-command-or-lane-fails:${command}`);
    if (!sameTreeCommit(row.checkoutCommitSha, expectedCommitSha, expectedTreeOid) || row.checkoutTreeOid !== expectedTreeOid) {
      findings.push(`command-result-tree-binding-mismatch:${command}`);
    }
    const resultBytes = verifyArtifact(root, row.resultPath, row.resultSha256, `command-result:${command}`, findings);
    const result = parseJsonArtifact(resultBytes, `command-result:${command}`, findings);
    if (result) {
      if (String(result.command ?? '') !== command || Number(result.exitCode) !== 0) {
        findings.push(`command-result-content-mismatch:${command}`);
      }
      if (!sameTreeCommit(String(result.checkoutCommitSha ?? ''), expectedCommitSha, expectedTreeOid)
        || String(result.checkoutTreeOid ?? '') !== expectedTreeOid) {
        findings.push(`command-result-tree-binding-mismatch:${command}`);
      }
      const started = Date.parse(String(result.startedAtUtc ?? ''));
      const completed = Date.parse(String(result.completedAtUtc ?? ''));
      if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
        findings.push(`command-result-time-invalid:${command}`);
      }
    }
    const logBytes = verifyArtifact(root, row.logPath, row.logSha256, `command-log:${command}`, findings);
    if (logBytes && logBytes.length === 0) findings.push(`command-log:${command}:empty`);
  }
}

function verifyReplay(overlap: OverlapEvidence, evidenceRoot: string, findings: string[]): void {
  const cwd = resolveEvidencePath(evidenceRoot, overlap.replayCwd, 'overlap-replay-cwd', findings, true);
  const command = String(overlap.replayCommand ?? '').trim();
  if (!cwd || !command || /\s/u.test(command) || !Array.isArray(overlap.replayArgs)) {
    findings.push('overlap-replay-command-invalid');
    return;
  }
  const executable = path.basename(command).toLowerCase();
  if (command !== process.execPath && executable !== 'node' && executable !== 'node.exe') {
    findings.push('overlap-replay-executable-not-node');
    return;
  }
  const normalizedArgs = overlap.replayArgs.map(String);
  const harness = String(overlap.harnessPath ?? '');
  const inputs = String(overlap.replayInputsPath ?? '');
  if (!normalizedArgs.includes(harness) || !normalizedArgs.includes(inputs)) {
    findings.push('overlap-replay-not-bound-to-harness-and-inputs');
    return;
  }
  const result = runProcessSync({ command, args: normalizedArgs, cwd, inheritParentEnv: false });
  if (!result.ok || result.exitCode !== overlap.replayExitCode) findings.push('overlap-replay-failed');
  if (sha256(result.stdout) !== overlap.replayStdoutSha256) findings.push('overlap-replay-stdout-mismatch');
}

function gitTreeOid(commitSha: string): string | null {
  if (!FULL_SHA.test(commitSha)) return null;
  const result = runProcessSync({ command: 'git', args: ['rev-parse', `${commitSha}^{tree}`], cwd: repoRoot, inheritParentEnv: true });
  return result.ok && FULL_SHA.test(result.stdout.trim()) ? result.stdout.trim() : null;
}
function sameTreeCommit(observedCommitSha: string, expectedCommitSha: string, expectedTreeOid: string): boolean {
  if (!FULL_SHA.test(observedCommitSha) || !FULL_SHA.test(expectedCommitSha) || !FULL_SHA.test(expectedTreeOid)) return false;
  return observedCommitSha === expectedCommitSha || gitTreeOid(observedCommitSha) === expectedTreeOid;
}

function verifyOverlapStructuredArtifacts(overlap: OverlapEvidence, evidenceRoot: string, findings: string[]): void {
  const matrix = parseJsonArtifact(
    verifyArtifact(evidenceRoot, overlap.operationMatrixPath, overlap.operationMatrixSha256, 'overlap-operation-matrix', findings),
    'overlap-operation-matrix', findings,
  );
  if (matrix) {
    const classes = Array.isArray(matrix.classes) ? matrix.classes.map(String) : [];
    if (REQUIRED_OVERLAP_CLASSES.some((name) => !classes.includes(name))) findings.push('overlap-operation-matrix-content-mismatch');
  }
  const vectors = parseJsonArtifact(
    verifyArtifact(evidenceRoot, overlap.protocolVectorPath, overlap.protocolVectorSha256, 'overlap-protocol-vector', findings),
    'overlap-protocol-vector', findings,
  );
  if (vectors && (!Array.isArray(vectors.vectors) || vectors.vectors.length === 0)) findings.push('overlap-protocol-vector-empty');
  const log = parseJsonArtifact(
    verifyArtifact(evidenceRoot, overlap.logPath, overlap.logSha256, 'overlap-log', findings),
    'overlap-log', findings,
  );
  if (log) {
    if (String(log.result ?? '') !== 'pass'
      || String(log.candidateCommitSha ?? '') !== overlap.candidateCommitSha
      || String(log.candidateTreeOid ?? '') !== overlap.candidateTreeOid
      || String(log.candidateBuildDigest ?? '') !== overlap.candidateBuildDigest) {
      findings.push('overlap-log-binding-mismatch');
    }
  }
}

export function validateClosureReceiptSourceContract(source: string): string[] {
  const findings: string[] = [];
  for (const [token, code] of CLOSURE_SOURCE_REQUIREMENTS) {
    if (!source.includes(token)) findings.push(code);
  }
  return unique(findings);
}

export function validateFinalVerificationAgainstReceipt(
  verification: FinalVerificationEvidence,
  receipt: Record<string, unknown>,
  evidenceRoot = '',
): string[] {
  const findings: string[] = [];
  if (!evidenceRoot) findings.push('final-verification-artifact-root-missing');
  const receiptSha256 = String(receipt.receiptSha256 ?? '');
  const lineage = receipt.lineage as Record<string, unknown> | undefined;
  const finalTreeOid = String(lineage?.finalTreeOid ?? '');
  const finalCommitSha = String(lineage?.finalCommitSha ?? '');
  const expectedReceiptSha256 = digestStructured(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'receiptSha256')));
  if (!DIGEST.test(receiptSha256) || receiptSha256 !== expectedReceiptSha256) findings.push('receipt-digest-invalid');
  if (verification.result !== 'pass' || verification.receiptSha256 !== receiptSha256) findings.push('final-verification-receipt-mismatch');
  if (verification.finalTreeOid !== finalTreeOid || verification.checkoutTreeOid !== finalTreeOid) findings.push('receipt-and-final-verification-tree-differ');
  if (!sameTreeCommit(verification.checkoutCommitSha, finalCommitSha, finalTreeOid)) findings.push('final-evidence-commit-stale');
  if (!verification.cleanBefore || !verification.cleanAfter || verification.stagedBefore !== 0 || verification.stagedAfter !== 0 || verification.untrackedBefore !== 0 || verification.untrackedAfter !== 0) findings.push('final-checks-on-dirty-worktree');
  findings.push(...validateFinalVerificationEnvironment(verification, evidenceRoot));
  if (evidenceRoot) verifyCommandLogs(evidenceRoot, verification.commands, finalCommitSha, finalTreeOid, findings);
  return unique(findings);
}

export function buildCandidateBuildProvenance(ref = 'HEAD'): CandidateBuildProvenance {
  const sourcePaths = [
    'scripts/lib/review-start-claim-store.ts',
    'scripts/lib/review-start-claim-cli.ts',
    'scripts/lib/Review-StartClaimLifecycle.ps1',
    'scripts/lib/orchestrator-side-process-observer.ts',
    'scripts/lib/orchestrator-side-process-observer-cli.ts',
    'scripts/pack-review-runner.ts',
    'scripts/pr2a/final-conformance.ts',
    'scripts/pr2a/closure-receipt.ts',
    'scripts/pr2a/mutation-runner.ts',
    'scripts/pr2a/rollback-drain.ts',
  ];
  const sourceDigests = Object.fromEntries(sourcePaths.map((file) => [file, sha256(readAt(ref, file))]));
  const provenanceWithoutDigest = {
    command: 'npm ci --ignore-scripts && npm run typecheck:foundation && npm run lint:foundation && npm run test:contract-mutations && npm run test:issue-948',
    nodeVersionPolicySha256: sha256(readAt(ref, 'scripts/toolchain/node-version.json')),
    packageJsonSha256: sha256(readAt(ref, 'package.json')),
    packageLockSha256: sha256(readAt(ref, 'package-lock.json')),
    tsconfigSha256: sha256(readAt(ref, 'tsconfig.json')),
    sourceDigests,
  };
  return { ...provenanceWithoutDigest, digest: digestStructured(provenanceWithoutDigest) };
}

export function validateClosureEvidenceBundle(
  bundle: ClosureEvidenceBundle,
  expected: { finalTreeOid: string; finalCommitSha: string; candidateBuildDigest: string },
  evidenceRoot = '',
): string[] {
  const findings: string[] = [];
  if (!evidenceRoot) findings.push('evidence-artifact-root-missing');
  if (bundle.schemaVersion !== 1) findings.push('evidence-schema-invalid');
  const { overlap, rollback, preReceiptVerification, external928 } = bundle;

  if (overlap.result !== 'pass' || overlap.generatedAfterFinalTree !== true) findings.push('overlap-evidence-generated-before-final-tree');
  if (overlap.finalTreeOid !== expected.finalTreeOid || overlap.candidateTreeOid !== expected.finalTreeOid) findings.push('overlap-evidence-candidate-tree-mismatch');
  if (overlap.candidateBuildDigest !== expected.candidateBuildDigest) findings.push('overlap-candidate-binding-mismatch');
  if (!overlap.harnessBytesArchived) findings.push('overlap-harness-or-job-bytes-unbound');
  if (REQUIRED_OVERLAP_CLASSES.some((name) => !overlap.classes.includes(name))) findings.push('overlap-operation-matrix-missing');
  if (overlap.legacyRepository !== 'chetwerikoff/orchestrator-pack'
    || !FULL_SHA.test(overlap.legacyCommitSha)
    || !FULL_SHA.test(overlap.legacyTreeOid)
    || gitTreeOid(overlap.legacyCommitSha) !== overlap.legacyTreeOid) findings.push('overlap-legacy-binding-invalid');
  if (overlap.candidateRepository !== 'chetwerikoff/orchestrator-pack'
    || (overlap.candidateCommitSha !== expected.finalCommitSha
      && gitTreeOid(overlap.candidateCommitSha) !== expected.finalTreeOid)) findings.push('overlap-candidate-commit-invalid');
  validateVerificationEnvironment({
    repository: overlap.candidateRepository,
    platform: overlap.platform,
    filesystem: overlap.filesystem,
    nodeVersion: process.version,
    pwshVersion: observedPwshVersion() ?? '',
  }, evidenceRoot, 'overlap', findings);
  if (evidenceRoot) {
    verifyArtifact(evidenceRoot, overlap.harnessPath, overlap.harnessSha256, 'overlap-harness', findings);
    verifyArtifact(evidenceRoot, overlap.replayInputsPath, overlap.replayInputsSha256, 'overlap-replay-inputs', findings);
    verifyArtifact(evidenceRoot, overlap.replayStdoutPath, overlap.replayStdoutSha256, 'overlap-replay-stdout', findings);
    verifyOverlapStructuredArtifacts(overlap, evidenceRoot, findings);
    verifyReplay(overlap, evidenceRoot, findings);
  }

  if (rollback.result !== 'pass' || rollback.finalTreeOid !== expected.finalTreeOid) findings.push('rollback-tree-mismatch');
  if (!rollback.isolatedCheckout) findings.push('rollback-rehearsal-in-evidence-checkout');
  if (!rollback.entryBlockedBeforeRevert || !rollback.entryBlockedAfterRevert) findings.push('rollback-cross-version-gate-not-existing-or-not-shared');
  if (!rollback.quiescenceInventoryComplete) findings.push('rollback-quiescence-inventory-incomplete');
  if (!rollback.detachedDrainSurvivedRevert) findings.push('rollback-detached-drain-artifact-invalid');
  if (!rollback.zeroSurvivorsBeforeResume) findings.push('rollback-entry-resumes-before-zero-survivors');
  if (!rollback.legacyReadTsRecord) findings.push('rollback-legacy-record-compatibility-unproven');
  if (rollback.imports928ActivationMachinery) findings.push('rollback-imports-928-activation-machinery');
  if (evidenceRoot) {
    verifyArtifact(evidenceRoot, rollback.detachedDrainPath, rollback.detachedDrainSha256, 'rollback-detached-drain', findings);
    const rollbackLog = parseJsonArtifact(
      verifyArtifact(evidenceRoot, rollback.logPath, rollback.logSha256, 'rollback-log', findings),
      'rollback-log', findings,
    );
    if (rollbackLog && (String(rollbackLog.result ?? '') !== 'pass'
      || String(rollbackLog.finalTreeOid ?? '') !== expected.finalTreeOid
      || rollbackLog.zeroSurvivorsBeforeResume !== true
      || String(rollbackLog.detachedDrainSha256 ?? '') !== rollback.detachedDrainSha256)) {
      findings.push('rollback-log-binding-mismatch');
    }
  }

  if (preReceiptVerification.result !== 'pass' || preReceiptVerification.finalTreeOid !== expected.finalTreeOid || preReceiptVerification.checkoutTreeOid !== expected.finalTreeOid) findings.push('receipt-prerequisite-tree-differ');
  if (!sameTreeCommit(preReceiptVerification.checkoutCommitSha, expected.finalCommitSha, expected.finalTreeOid)) findings.push('receipt-prerequisite-commit-stale');
  if (!preReceiptVerification.cleanBefore || !preReceiptVerification.cleanAfter || preReceiptVerification.stagedBefore !== 0 || preReceiptVerification.stagedAfter !== 0 || preReceiptVerification.untrackedBefore !== 0 || preReceiptVerification.untrackedAfter !== 0) findings.push('receipt-prerequisites-on-dirty-worktree');
  if (!preReceiptVerification.prerequisiteSuitesPassedBeforeReceipt) findings.push('receipt-generated-before-prerequisite-suites');
  findings.push(...validatePreReceiptVerificationEnvironment(preReceiptVerification, evidenceRoot));
  if (evidenceRoot) verifyCommandLogs(evidenceRoot, preReceiptVerification.commands, expected.finalCommitSha, expected.finalTreeOid, findings);

  if (external928.result !== 'pass' || external928.issue !== 928 || external928.repository !== 'chetwerikoff/orchestrator-pack') findings.push('external-928-sync-evidence-missing');
  if (!external928.url.includes('/issues/928') || !external928.revisionIdentity.trim()) findings.push('external-928-identity-invalid');
  if (!external928.actor.trim() || !external928.tool.trim() || !Date.parse(external928.capturedAt) || !Date.parse(external928.updatedAt)) findings.push('external-928-capture-invalid');
  if (evidenceRoot) {
    const bodyBytes = verifyArtifact(evidenceRoot, external928.bodyPath, external928.bodySha256, 'external-928-body', findings);
    const body = bodyBytes?.toString('utf8') ?? '';
    if (!body.includes('#948') || !/(?:TypeScript|TS authority)/iu.test(body)
      || !/independent(?:ly)?\s+(?:recompute|rerun)/iu.test(body)
      || !/receipt/iu.test(body)
      || !/(?:refus|fail(?:s|ed)?\s+closed|receipt-only)/iu.test(body)) {
      findings.push('external-928-body-contract-mismatch');
    }
  }
  if (!external928.requirements.consumesPr2aTsAuthority
    || !external928.requirements.consumesReceiptAsPrecedent
    || !external928.requirements.independentlyRecomputesCurrentClosure
    || !external928.requirements.invariantBasedRefusal
    || !external928.requirements.historicalInventoryEqualityNotRequired) findings.push('external-928-contract-incomplete');

  return unique(findings);
}

export function buildClosureReceipt(ref: string, evidence: ClosureEvidenceBundle, evidenceRoot: string): Record<string, unknown> {
  const sourceFindings = validateClosureReceiptSourceContract(readAt(ref, 'scripts/pr2a/closure-receipt.ts'));
  if (sourceFindings.length > 0) throw new Error(`closure_source_contract_invalid:${sourceFindings.join(',')}`);
  const conformance = buildConformanceReport(ref);
  if (conformance.result !== 'conformant') throw new Error(`final_conformance_failed:${conformance.findings.map((row) => row.code).join(',')}`);
  const manifest = JSON.parse(readAt(ref, 'scripts/pr2a/planning-manifest.json')) as PlanningManifest;
  const candidateBuild = buildCandidateBuildProvenance(ref);
  const evidenceFindings = validateClosureEvidenceBundle(evidence, {
    finalTreeOid: conformance.finalTreeOid,
    finalCommitSha: conformance.commitSha,
    candidateBuildDigest: candidateBuild.digest,
  }, evidenceRoot);
  if (evidenceFindings.length > 0) throw new Error(`closure_evidence_invalid:${evidenceFindings.join(',')}`);
  const diff = git(['diff', '--binary', conformance.planningBarrierCommit, ref]);
  const receipt = {
    schemaVersion: 2,
    issue: 948,
    repository: 'chetwerikoff/orchestrator-pack',
    generatedAtUtc: new Date().toISOString(),
    lineage: {
      foundationCommit: manifest.lineage.foundationCommit,
      planningCommit: conformance.planningCommit,
      planningBarrierCommit: conformance.planningBarrierCommit,
      planningBaseTreeOid: conformance.planningBaseTreeOid,
      finalCommitSha: conformance.commitSha,
      finalTreeOid: conformance.finalTreeOid,
    },
    planningTooling: manifest.tooling,
    planningManifestSha256: sha256(readAt(ref, 'scripts/pr2a/planning-manifest.json')),
    inventoryDigests: {
      denominator: digestStructured(manifest.denominator),
      references: digestStructured(manifest.references),
      lifecycle: digestStructured(manifest.lifecycle),
      plannedOperations: digestStructured(manifest.plannedOperations),
    },
    finalInvariant: {
      result: conformance.result,
      findings: conformance.findings,
      emptyExternalReverseClosure: conformance.findings.every((row) => !row.code.includes('external_executable_reference')),
      unresolved: [],
      dynamicUnsupported: [],
      changedPaths: conformance.changedPaths,
      diffSha256: sha256(diff),
    },
    candidateBuild,
    d928Sha256: Object.fromEntries(D928.map((file) => [file, sha256(readAt(ref, file))])),
    evidence: {
      bundleSha256: digestStructured(evidence),
      artifactRoot: path.resolve(evidenceRoot),
      overlap: evidence.overlap,
      rollback: evidence.rollback,
      preReceiptVerification: evidence.preReceiptVerification,
      external928: evidence.external928,
    },
    results: conformance.results,
    result: 'tree-bound-empty-external-reverse-closure',
  };
  return { ...receipt, receiptSha256: digestStructured(receipt) };
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    const sourceFile = arg('--validate-source');
    if (sourceFile) {
      const findings = validateClosureReceiptSourceContract(readFileSync(path.resolve(sourceFile), 'utf8'));
      process.stdout.write(stableJson({ result: findings.length === 0 ? 'pass' : 'fail', findings }));
      if (findings.length > 0) process.exitCode = 1;
    } else {
      const ref = arg('--ref') ?? 'HEAD';
      const finalVerificationFile = arg('--final-verification');
      const receiptFile = arg('--receipt');
      if (finalVerificationFile || receiptFile) {
        if (!finalVerificationFile || !receiptFile) throw new Error('usage: closure-receipt.ts --final-verification <evidence.json> --receipt <receipt.json>');
        const verificationPath = path.resolve(finalVerificationFile);
        const verification = JSON.parse(readFileSync(verificationPath, 'utf8')) as FinalVerificationEvidence;
        const receipt = JSON.parse(readFileSync(path.resolve(receiptFile), 'utf8')) as Record<string, unknown>;
        const findings = validateFinalVerificationAgainstReceipt(verification, receipt, path.dirname(verificationPath));
        process.stdout.write(stableJson({ result: findings.length === 0 ? 'pass' : 'fail', findings }));
        if (findings.length > 0) process.exitCode = 1;
      } else {
        const evidenceFile = arg('--evidence');
        if (!evidenceFile) throw new Error('usage: closure-receipt.ts --ref <ref> --evidence <bundle.json>');
        const evidencePath = path.resolve(evidenceFile);
        const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as ClosureEvidenceBundle;
        process.stdout.write(stableJson(buildClosureReceipt(ref, evidence, path.dirname(evidencePath))));
      }
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
