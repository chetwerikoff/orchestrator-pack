#!/usr/bin/env node
import '../toolchain/native-entrypoint-preflight.ts';

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';
import { D928, sha256, stableJson, type PlanningManifest } from './contracts.ts';
import { buildConformanceReport } from './final-conformance.ts';

const repoRoot = path.resolve(process.cwd());
const REQUIRED_OVERLAP_CLASSES = [
  'acquisition',
  'guarded-mutation',
  'terminal-audit',
  'release-completion',
  'recovery-reap',
  'interpretation',
  'generation-fence',
] as const;
const REQUIRED_FINAL_COMMANDS = [
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

function git(args: string[]): string {
  const result = runProcessSync({ command: 'git', args, cwd: repoRoot, inheritParentEnv: true });
  if (!result.ok) throw new Error(result.stderr || result.error || `git_${args.join('_')}_failed`);
  return result.stdout;
}
function readAt(ref: string, file: string): string { return git(['show', `${ref}:${file}`]); }
function digestStructured(value: unknown): string { return sha256(stableJson(value)); }
function unique(findings: string[]): string[] { return [...new Set(findings)].sort(); }

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
    if (row.checkoutCommitSha !== expectedCommitSha || row.checkoutTreeOid !== expectedTreeOid) {
      findings.push(`command-result-tree-binding-mismatch:${command}`);
    }
    const resultBytes = verifyArtifact(root, row.resultPath, row.resultSha256, `command-result:${command}`, findings);
    const result = parseJsonArtifact(resultBytes, `command-result:${command}`, findings);
    if (result) {
      if (String(result.command ?? '') !== command || Number(result.exitCode) !== 0) {
        findings.push(`command-result-content-mismatch:${command}`);
      }
      if (String(result.checkoutCommitSha ?? '') !== expectedCommitSha || String(result.checkoutTreeOid ?? '') !== expectedTreeOid) {
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
  if (!/^[0-9a-f]{40}$/u.test(commitSha)) return null;
  const result = runProcessSync({ command: 'git', args: ['rev-parse', `${commitSha}^{tree}`], cwd: repoRoot, inheritParentEnv: true });
  return result.ok && /^[0-9a-f]{40}$/u.test(result.stdout.trim()) ? result.stdout.trim() : null;
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
  if (verification.checkoutCommitSha !== finalCommitSha) findings.push('final-evidence-commit-stale');
  if (!verification.cleanBefore || !verification.cleanAfter || verification.stagedBefore !== 0 || verification.stagedAfter !== 0 || verification.untrackedBefore !== 0 || verification.untrackedAfter !== 0) findings.push('final-checks-on-dirty-worktree');
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
    || !/^[0-9a-f]{40}$/u.test(overlap.legacyCommitSha)
    || !/^[0-9a-f]{40}$/u.test(overlap.legacyTreeOid)
    || gitTreeOid(overlap.legacyCommitSha) !== overlap.legacyTreeOid) findings.push('overlap-legacy-binding-invalid');
  if (overlap.candidateRepository !== 'chetwerikoff/orchestrator-pack'
    || overlap.candidateCommitSha !== expected.finalCommitSha
    || gitTreeOid(overlap.candidateCommitSha) !== expected.finalTreeOid) findings.push('overlap-candidate-commit-invalid');
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
  if (preReceiptVerification.checkoutCommitSha !== expected.finalCommitSha) findings.push('receipt-prerequisite-commit-stale');
  if (!preReceiptVerification.cleanBefore || !preReceiptVerification.cleanAfter || preReceiptVerification.stagedBefore !== 0 || preReceiptVerification.stagedAfter !== 0 || preReceiptVerification.untrackedBefore !== 0 || preReceiptVerification.untrackedAfter !== 0) findings.push('receipt-prerequisites-on-dirty-worktree');
  if (!preReceiptVerification.prerequisiteSuitesPassedBeforeReceipt) findings.push('receipt-generated-before-prerequisite-suites');
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
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
