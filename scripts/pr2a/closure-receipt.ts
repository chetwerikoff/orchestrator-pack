#!/usr/bin/env node
import '../toolchain/native-entrypoint-preflight.ts';

import { readFileSync } from 'node:fs';
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

function git(args: string[]): string {
  const result = runProcessSync({ command: 'git', args, cwd: repoRoot, inheritParentEnv: true });
  if (!result.ok) throw new Error(result.stderr || result.error || `git_${args.join('_')}_failed`);
  return result.stdout;
}


function readAt(ref: string, file: string): string {
  return git(['show', `${ref}:${file}`]);
}

function digestStructured(value: unknown): string {
  return sha256(stableJson(value));
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
  harnessSha256: string;
  harnessBytesArchived: true;
  operationMatrixSha256: string;
  replayCommand: string;
  replayInputsSha256: string;
  protocolVectorSha256: string;
  platform: string;
  filesystem: string;
  classes: string[];
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
  detachedDrainSha256: string;
  detachedDrainSurvivedRevert: true;
  zeroSurvivorsBeforeResume: true;
  legacyReadTsRecord: true;
  imports928ActivationMachinery: false;
  logSha256: string;
}

export interface VerificationCommandEvidence {
  command: string;
  exitCode: 0;
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

export function validateFinalVerificationAgainstReceipt(
  verification: FinalVerificationEvidence,
  receipt: Record<string, unknown>,
): string[] {
  const findings: string[] = [];
  const digestPattern = /^sha256:[0-9a-f]{64}$/u;
  const receiptSha256 = String(receipt.receiptSha256 ?? '');
  const lineage = receipt.lineage as Record<string, unknown> | undefined;
  const finalTreeOid = String(lineage?.finalTreeOid ?? '');
  const finalCommitSha = String(lineage?.finalCommitSha ?? '');
  const expectedReceiptSha256 = digestStructured(Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== 'receiptSha256'),
  ));
  if (!digestPattern.test(receiptSha256) || receiptSha256 !== expectedReceiptSha256) findings.push('receipt-digest-invalid');
  if (verification.result !== 'pass' || verification.receiptSha256 !== receiptSha256) findings.push('final-verification-receipt-mismatch');
  if (verification.finalTreeOid !== finalTreeOid || verification.checkoutTreeOid !== finalTreeOid) findings.push('receipt-and-final-verification-tree-differ');
  if (verification.checkoutCommitSha !== finalCommitSha) findings.push('final-evidence-commit-stale');
  if (!verification.cleanBefore || !verification.cleanAfter || verification.stagedBefore !== 0 || verification.stagedAfter !== 0 || verification.untrackedBefore !== 0 || verification.untrackedAfter !== 0) findings.push('final-checks-on-dirty-worktree');
  const commands = new Map(verification.commands.map((row) => [row.command, row]));
  for (const command of REQUIRED_FINAL_COMMANDS) {
    const row = commands.get(command);
    if (!row) findings.push(`required-suite-omitted-from-mandatory-path:${command}`);
    else if (row.exitCode !== 0 || !digestPattern.test(row.logSha256)) findings.push(`mandatory-command-or-lane-fails:${command}`);
  }
  return [...new Set(findings)].sort();
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

export function buildCandidateBuildProvenance(ref = 'HEAD'): CandidateBuildProvenance {
  const sourcePaths = [
    'scripts/lib/review-start-claim-store.ts',
    'scripts/lib/review-start-claim-cli.ts',
    'scripts/lib/Review-StartClaimLifecycle.ps1',
    'scripts/lib/orchestrator-side-process-observer.ts',
    'scripts/lib/orchestrator-side-process-observer-cli.ts',
    'scripts/pack-review-runner.ts',
    'scripts/pr2a/final-conformance.ts',
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
): string[] {
  const findings: string[] = [];
  const digestPattern = /^sha256:[0-9a-f]{64}$/u;
  if (bundle.schemaVersion !== 1) findings.push('evidence-schema-invalid');
  const { overlap, rollback, preReceiptVerification, external928 } = bundle;
  if (overlap.result !== 'pass' || overlap.generatedAfterFinalTree !== true) findings.push('overlap-evidence-generated-before-final-tree');
  if (overlap.finalTreeOid !== expected.finalTreeOid || overlap.candidateTreeOid !== expected.finalTreeOid) findings.push('overlap-evidence-candidate-tree-mismatch');
  if (overlap.candidateBuildDigest !== expected.candidateBuildDigest) findings.push('overlap-candidate-binding-mismatch');
  if (!overlap.harnessBytesArchived || !digestPattern.test(overlap.harnessSha256)) findings.push('overlap-harness-or-job-bytes-unbound');
  if (!digestPattern.test(overlap.operationMatrixSha256) || REQUIRED_OVERLAP_CLASSES.some((name) => !overlap.classes.includes(name))) findings.push('overlap-operation-matrix-missing');
  if (!overlap.replayCommand.trim() || !digestPattern.test(overlap.replayInputsSha256)) findings.push('overlap-replay-command-missing');
  if (!digestPattern.test(overlap.protocolVectorSha256) || !digestPattern.test(overlap.logSha256)) findings.push('overlap-evidence-incomplete');
  if (!overlap.legacyCommitSha.match(/^[0-9a-f]{40}$/u) || !overlap.legacyTreeOid.match(/^[0-9a-f]{40}$/u)) findings.push('overlap-legacy-binding-invalid');
  if (!overlap.candidateCommitSha.match(/^[0-9a-f]{40}$/u)) findings.push('overlap-candidate-commit-invalid');

  if (rollback.result !== 'pass' || rollback.finalTreeOid !== expected.finalTreeOid) findings.push('rollback-tree-mismatch');
  if (!rollback.isolatedCheckout) findings.push('rollback-rehearsal-in-evidence-checkout');
  if (!rollback.entryBlockedBeforeRevert || !rollback.entryBlockedAfterRevert) findings.push('rollback-cross-version-gate-not-existing-or-not-shared');
  if (!rollback.quiescenceInventoryComplete) findings.push('rollback-quiescence-inventory-incomplete');
  if (!rollback.detachedDrainSurvivedRevert || !digestPattern.test(rollback.detachedDrainSha256)) findings.push('rollback-detached-drain-artifact-invalid');
  if (!rollback.zeroSurvivorsBeforeResume) findings.push('rollback-entry-resumes-before-zero-survivors');
  if (!rollback.legacyReadTsRecord) findings.push('rollback-legacy-record-compatibility-unproven');
  if (rollback.imports928ActivationMachinery) findings.push('rollback-imports-928-activation-machinery');

  if (preReceiptVerification.result !== 'pass' || preReceiptVerification.finalTreeOid !== expected.finalTreeOid || preReceiptVerification.checkoutTreeOid !== expected.finalTreeOid) findings.push('receipt-prerequisite-tree-differ');
  if (preReceiptVerification.checkoutCommitSha !== expected.finalCommitSha) findings.push('receipt-prerequisite-commit-stale');
  if (!preReceiptVerification.cleanBefore || !preReceiptVerification.cleanAfter || preReceiptVerification.stagedBefore !== 0 || preReceiptVerification.stagedAfter !== 0 || preReceiptVerification.untrackedBefore !== 0 || preReceiptVerification.untrackedAfter !== 0) findings.push('receipt-prerequisites-on-dirty-worktree');
  if (!preReceiptVerification.prerequisiteSuitesPassedBeforeReceipt) findings.push('receipt-generated-before-prerequisite-suites');
  const commands = new Map(preReceiptVerification.commands.map((row) => [row.command, row]));
  for (const command of REQUIRED_FINAL_COMMANDS) {
    const row = commands.get(command);
    if (!row) findings.push(`required-suite-omitted-from-mandatory-path:${command}`);
    else if (row.exitCode !== 0 || !digestPattern.test(row.logSha256)) findings.push(`mandatory-command-or-lane-fails:${command}`);
  }

  if (external928.result !== 'pass' || external928.issue !== 928 || external928.repository !== 'chetwerikoff/orchestrator-pack') findings.push('external-928-sync-evidence-missing');
  if (!external928.url.includes('/issues/928') || !external928.revisionIdentity.trim() || !digestPattern.test(external928.bodySha256)) findings.push('external-928-identity-invalid');
  if (!external928.actor.trim() || !external928.tool.trim() || !Date.parse(external928.capturedAt) || !Date.parse(external928.updatedAt)) findings.push('external-928-capture-invalid');
  if (!external928.requirements.consumesPr2aTsAuthority
    || !external928.requirements.consumesReceiptAsPrecedent
    || !external928.requirements.independentlyRecomputesCurrentClosure
    || !external928.requirements.invariantBasedRefusal
    || !external928.requirements.historicalInventoryEqualityNotRequired) {
    findings.push('external-928-contract-incomplete');
  }
  return [...new Set(findings)].sort();
}

export function buildClosureReceipt(ref: string, evidence: ClosureEvidenceBundle): Record<string, unknown> {
  const conformance = buildConformanceReport(ref);
  if (conformance.result !== 'conformant') throw new Error(`final_conformance_failed:${conformance.findings.map((row) => row.code).join(',')}`);
  const manifest = JSON.parse(readAt(ref, 'scripts/pr2a/planning-manifest.json')) as PlanningManifest;
  const candidateBuild = buildCandidateBuildProvenance(ref);
  const evidenceFindings = validateClosureEvidenceBundle(evidence, {
    finalTreeOid: conformance.finalTreeOid,
    finalCommitSha: conformance.commitSha,
    candidateBuildDigest: candidateBuild.digest,
  });
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
      const verification = JSON.parse(readFileSync(path.resolve(finalVerificationFile), 'utf8')) as FinalVerificationEvidence;
      const receipt = JSON.parse(readFileSync(path.resolve(receiptFile), 'utf8')) as Record<string, unknown>;
      const findings = validateFinalVerificationAgainstReceipt(verification, receipt);
      process.stdout.write(stableJson({ result: findings.length === 0 ? 'pass' : 'fail', findings }));
      if (findings.length > 0) process.exitCode = 1;
    } else {
      const evidenceFile = arg('--evidence');
      if (!evidenceFile) throw new Error('usage: closure-receipt.ts --ref <ref> --evidence <bundle.json>');
      const evidence = JSON.parse(readFileSync(path.resolve(evidenceFile), 'utf8')) as ClosureEvidenceBundle;
      process.stdout.write(stableJson(buildClosureReceipt(ref, evidence)));
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
