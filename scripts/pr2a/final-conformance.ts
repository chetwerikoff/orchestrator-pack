#!/usr/bin/env node
import '../toolchain/native-entrypoint-preflight.ts';

import { existsSync } from 'node:fs';
import path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';
import {
  DENYLIST,
  D928,
  FOUNDATION_COMMIT,
  normalizeRepoPath,
  sha256,
  type PlanningManifest,
} from './contracts.ts';

export interface ConformanceFinding {
  code: string;
  path?: string;
  detail?: string;
}

export interface ConformanceReport {
  schemaVersion: 1;
  issue: 948;
  ref: string;
  baseCommitSha: string;
  commitSha: string;
  finalTreeOid: string;
  planningCommit: string;
  planningBarrierCommit: string;
  planningBaseTreeOid: string;
  changedPaths: string[];
  findings: ConformanceFinding[];
  results: {
    AC1: 'pass' | 'fail';
    AC2: 'pass' | 'fail';
    AC3: 'pass' | 'fail';
    AC4: 'pass' | 'fail';
    AC5: 'pass' | 'fail';
    AC6: 'pass' | 'fail';
    AC7: 'pass' | 'fail';
    AC8: 'pass' | 'fail';
  };
  result: 'conformant' | 'nonconformant';
}

interface DiffRow {
  status: string;
  path: string;
  operation: 'add' | 'modify' | 'delete';
}

interface RefBinding {
  baseCommitSha: string;
  candidateCommitSha: string;
  candidateTreeOid: string;
}

interface DeclaredSourceInvariant {
  ac: `AC${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
  mutationId: string;
  path: string;
  kind: 'required' | 'forbidden';
  token: string;
}

const repoRoot = path.resolve(process.cwd());
const planningPath = 'scripts/pr2a/planning-manifest.json';
const executableExtensions = new Set(['.ps1', '.psm1', '.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.sh', '.yml', '.yaml']);
const liveReferenceManifests = [
  'scripts/orchestrator-escalation-emitter-inventory.json',
  'scripts/orchestrator-message-audit-roots.manifest.json',
  'scripts/orchestrator-message-owner-mechanisms.manifest.json',
  'scripts/orchestrator-message-protected-runtime.manifest.json',
  'scripts/fixtures/mechanical-json-state/state-coverage-manifest.json',
  'scripts/vitest-live-store-inventory.json',
] as const;

const declaredSourceInvariants: readonly DeclaredSourceInvariant[] = Object.freeze([
  { ac: 'AC2', mutationId: 'claim-namespace-or-key-changed', path: 'scripts/lib/review-start-claim-cli.ts', kind: 'required', token: 'return `pr-${positiveInteger(prNumber, 0)}-${normalizeHeadSha(headSha)}`;' },
  { ac: 'AC2', mutationId: 'persisted-path-or-schema-changed', path: 'scripts/lib/review-start-claim-cli.ts', kind: 'required', token: 'export const REVIEW_START_CLAIM_SCHEMA_VERSION = 1;' },
  { ac: 'AC2', mutationId: 'protocol-ordering-changed', path: 'scripts/lib/review-start-claim-cli.ts', kind: 'required', token: 'renameSync(temporary, path);\n  syncDirectory(dirname(path));' },
  { ac: 'AC2', mutationId: 'record-reread-under-exclusion-omitted', path: 'scripts/lib/review-start-claim-cli.ts', kind: 'required', token: "const read = readClaimRecord(required.path);\n    if (!read.ok || !read.record) return { ok: false, reason: 'ambiguous_claim', detail: read.reason };\n    if (!sameGeneration(read.record, required.claim)) return { ok: false, reason: 'lost_ownership', holder: read.record.holder };\n    const record: ReviewStartClaimRecord = { ...read.record, ...fields };" },
  { ac: 'AC2', mutationId: 'generation-fence-weakened', path: 'scripts/lib/review-start-claim-cli.ts', kind: 'required', token: "if (!sameGeneration(read.record, required.claim)) return { ok: false, reason: 'lost_ownership', holder: read.record.holder };\n    const record: ReviewStartClaimRecord = { ...read.record, ...fields };" },
  { ac: 'AC2', mutationId: 'lock-loss-or-reacquisition-uses-cached-authority', path: 'scripts/lib/review-start-claim-cli.ts', kind: 'required', token: "if (!sameGeneration(read.record, input.expected)) return { ok: false, reason: 'lost_ownership' };" },
  { ac: 'AC2', mutationId: 'crash-point-breaks-single-authority', path: 'scripts/lib/review-start-claim-cli.ts', kind: 'required', token: "const lock = claimLockDir(required.namespace, required.claim.prNumber, required.claim.headSha);\n  return withMutex(lock, () => {\n    const read = readClaimRecord(required.path);\n    if (!read.ok || !read.record) return { ok: false, reason: 'ambiguous_claim', detail: read.reason };\n    if (!sameGeneration(read.record, required.claim)) return { ok: false, reason: 'lost_ownership', holder: read.record.holder };\n    const record: ReviewStartClaimRecord = { ...read.record, ...fields };" },
  { ac: 'AC2', mutationId: 'legacy-record-class-unreadable', path: 'scripts/lib/review-start-claim-cli.ts', kind: 'required', token: "for (const required of ['schemaVersion', 'key', 'prNumber', 'headSha', 'holder', 'acquiredAtUtc', 'state'] as const)" },
  { ac: 'AC2', mutationId: 'identity-ambiguity-reclaimed', path: 'scripts/lib/review-start-claim-cli.ts', kind: 'required', token: "if (asString(owner.host) && asString(owner.host) !== hostname()) return true;" },
  { ac: 'AC2', mutationId: 'policy-semantics-changed', path: 'scripts/lib/review-start-claim-cli.ts', kind: 'required', token: '  evaluateReadinessEnvelope,\n  evaluateReclaimDecision,\n  evaluateSweep,' },
  { ac: 'AC2', mutationId: 'declared-reap-trigger-broken', path: 'scripts/lib/review-start-claim-cli.ts', kind: 'required', token: 'const sweep = asRecord(evaluateSweep({' },
  { ac: 'AC2', mutationId: 'new-reaper-scheduler-added', path: 'scripts/lib/review-start-claim-cli.ts', kind: 'forbidden', token: 'setInterval(() => reaperSweep({}), 1000);' },
  { ac: 'AC2', mutationId: 'unsupported-boundary-accepted', path: 'scripts/lib/review-start-claim-cli.ts', kind: 'required', token: "if (platform() !== 'linux') throw new Error('unsupported_claim_platform');" },
  { ac: 'AC2', mutationId: 'tracked-legacy-oracle-used', path: 'scripts/lib/review-start-claim-cli.ts', kind: 'forbidden', token: "const trackedLegacyOracle = 'scripts/lib/Review-StartClaim.ps1';" },
  { ac: 'AC2', mutationId: 'protocol-matrix-duplicated-with-divergent-primitive', path: 'scripts/lib/review-start-claim-cli.ts', kind: 'forbidden', token: "const divergentProtocolLockRoot = '.takeover';" },

  { ac: 'AC3', mutationId: 'claimant-family-still-reaches-powershell-claim', path: 'scripts/pack-review-runner.ts', kind: 'required', token: "from './lib/review-start-claim-store.ts'" },
  { ac: 'AC3', mutationId: 'supported-lifecycle-unit-still-interprets-in-powershell', path: 'scripts/lib/Review-StartClaimLifecycle.ps1', kind: 'forbidden', token: "function Get-MutatedClaimPolicy { param($Record) if ($Record.state -eq 'active') { return $true } return $false }" },
  { ac: 'AC3', mutationId: 'supported-lifecycle-unit-still-mutates-in-powershell', path: 'scripts/lib/Review-StartClaimLifecycle.ps1', kind: 'forbidden', token: "Set-Content -LiteralPath 'mutation-claim.json' -Value '{}'" },
  { ac: 'AC3', mutationId: 'internal-lifecycle-helper-bypasses-disposition', path: 'scripts/lib/Review-StartClaimLifecycle.ps1', kind: 'required', token: "ReviewStartClaimTsCli = Join-Path $PSScriptRoot 'review-start-claim-store.ts'" },
  { ac: 'AC3', mutationId: 'retain-read-only-unit-returns-policy-result', path: 'scripts/lib/Review-StartClaimLifecycle.ps1', kind: 'forbidden', token: 'function Get-MutatedPolicyResult { return @{ launchable = $true } }' },
  { ac: 'AC3', mutationId: 'cli-verb-bypasses-typescript-authority', path: 'scripts/lib/Review-StartClaimLifecycle.ps1', kind: 'required', token: "function Get-ReviewStartClaimLifecycleConfig { return Invoke-ReviewStartClaimTsOperation 'Get-ReviewStartClaimLifecycleConfig' @{} }" },
  { ac: 'AC3', mutationId: 'powershell-bridge-contains-policy-or-locking', path: 'scripts/lib/Review-StartClaimLifecycle.ps1', kind: 'forbidden', token: "New-Item -ItemType Directory -Path '.locks/mutation' -Force | Out-Null" },
  { ac: 'AC3', mutationId: 'typescript-dispatches-to-powershell', path: 'scripts/lib/review-start-claim-store.ts', kind: 'forbidden', token: "const mutationPwshDispatch = ['pwsh','-File','Review-StartClaim.ps1'];" },
  { ac: 'AC3', mutationId: 'second-namespace-or-lock-tree-created', path: 'scripts/lib/review-start-claim-store.ts', kind: 'forbidden', token: "const mutationSecondNamespace = '.takeover';" },
  { ac: 'AC3', mutationId: 'operation-semantic-primitive-usage-test-missing', path: 'package.json', kind: 'required', token: 'scripts/review-start-claim.test.ts' },
  { ac: 'AC3', mutationId: 'operation-specific-durability-test-missing', path: 'package.json', kind: 'required', token: 'scripts/pr2a/final-conformance.test.ts' },
  { ac: 'AC3', mutationId: 'representative-overlap-class-missing', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: "  'generation-fence'," },
  { ac: 'AC3', mutationId: 'external-root-reaches-target-internal-claim-unit', path: 'scripts/pack-review-runner.ts', kind: 'forbidden', token: "const mutationTargetInternalEdge = 'scripts/lib/Review-StartClaim.ps1';" },

  { ac: 'AC4', mutationId: 'retired-guard-or-verifier-edge-remains', path: 'scripts/verify.ps1', kind: 'forbidden', token: "& (Join-Path $PSScriptRoot 'check-side-process-launch-contract.ps1')" },
  { ac: 'AC4', mutationId: 'surviving-launch-assertion-lost', path: 'scripts/lib/orchestrator-side-process-observer.ts', kind: 'required', token: 'PassProjectId: child.passProjectId === true,' },
  { ac: 'AC4', mutationId: 'supervisor-reverse-edge-remains', path: 'scripts/pack-review-runner.ts', kind: 'forbidden', token: "const mutationSupervisorEdge = 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1';" },
  { ac: 'AC4', mutationId: 'claim-reverse-edge-remains', path: 'scripts/pack-review-runner.ts', kind: 'forbidden', token: "const mutationClaimEdge = 'scripts/lib/Review-StartClaim.ps1';" },
  { ac: 'AC4', mutationId: 'powershell-policy-unit-remains-reachable', path: 'scripts/lib/Review-StartClaimLifecycle.ps1', kind: 'forbidden', token: "function Test-MutatedActiveClaim { param($Record) return $Record.state -eq 'active' }" },
  { ac: 'AC4', mutationId: 'tracked-d928-execution-surface-remains', path: 'scripts/review-start-claim.test.ts', kind: 'forbidden', token: "const mutationD928Execution = 'scripts/review-start-claim-reaper.ps1';" },

  { ac: 'AC5', mutationId: 'receipt-final-tree-or-lineage-invalid', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: 'return observedCommitSha === expectedCommitSha || gitTreeOid(observedCommitSha) === expectedTreeOid;' },
  { ac: 'AC5', mutationId: 'receipt-self-asserts-unverifiable-tree', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: 'function verifyArtifact(' },
  { ac: 'AC5', mutationId: 'receipt-final-invariant-incomplete', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: "const conformance = buildConformanceReport(ref);\n  if (conformance.result !== 'conformant') throw new Error(`final_conformance_failed:${conformance.findings.map((row) => row.code).join(',')}`);" },
  { ac: 'AC5', mutationId: 'overlap-harness-or-job-bytes-unbound', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: 'verifyArtifact(evidenceRoot, overlap.harnessPath' },
  { ac: 'AC5', mutationId: 'overlap-operation-matrix-missing', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: 'verifyOverlapStructuredArtifacts(overlap, evidenceRoot, findings);' },
  { ac: 'AC5', mutationId: 'overlap-replay-command-missing', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: 'verifyReplay(overlap, evidenceRoot, findings);' },
  { ac: 'AC5', mutationId: 'candidate-build-not-derived-from-final-tree', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: "sourceDigests = Object.fromEntries(sourcePaths.map((file) => [file, sha256(readAt(ref, file))]));" },
  { ac: 'AC5', mutationId: 'candidate-build-attestation-invalid', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: 'return { ...provenanceWithoutDigest, digest: digestStructured(provenanceWithoutDigest) };' },
  { ac: 'AC5', mutationId: 'overlap-evidence-generated-before-final-tree', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: 'overlap.generatedAfterFinalTree !== true' },
  { ac: 'AC5', mutationId: 'overlap-candidate-binding-mismatch', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: 'overlap.candidateCommitSha !== expected.finalCommitSha\n      && gitTreeOid(overlap.candidateCommitSha) !== expected.finalTreeOid' },
  { ac: 'AC5', mutationId: 'receipt-generated-before-prerequisite-suites', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: 'if (!preReceiptVerification.prerequisiteSuitesPassedBeforeReceipt)' },
  { ac: 'AC5', mutationId: 'independent-pr2a-recompute-disagrees', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: 'const conformance = buildConformanceReport(ref);' },
  { ac: 'AC5', mutationId: '928-admission-skips-current-recompute', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: 'external-928-body-contract-mismatch' },
  { ac: 'AC5', mutationId: '928-admission-accepts-unsafe-current-invariants', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: 'invariantBasedRefusal: true;' },
  { ac: 'AC5', mutationId: '928-admission-requires-historical-inventory-equality', path: 'scripts/pr2a/closure-receipt.ts', kind: 'forbidden', token: 'const mutationRequiresHistoricalInventoryEquality = true;' },
  { ac: 'AC5', mutationId: '928-admission-rejects-compatible-unrelated-evolution', path: 'scripts/pr2a/closure-receipt.ts', kind: 'forbidden', token: 'const mutationRejectsUnrelatedBaseEvolution = true;' },

  { ac: 'AC6', mutationId: 'powershell-policy-or-supervisor-logic-added', path: 'scripts/lib/Review-StartClaimLifecycle.ps1', kind: 'forbidden', token: "function Invoke-MutatedPowerShellPolicy { New-Item '.locks/mutation' -ItemType Directory }" },
  { ac: 'AC6', mutationId: 'powershell-compatibility-clone-added', path: 'scripts/lib/Review-StartClaimLifecycle.ps1', kind: 'forbidden', token: "function Acquire-ReviewStartClaimClone { param($PrNumber,$HeadSha) return @{ state='active'; prNumber=$PrNumber; headSha=$HeadSha } }" },
  { ac: 'AC6', mutationId: 'typescript-to-powershell-claim-dispatch-added', path: 'scripts/lib/review-start-claim-store.ts', kind: 'forbidden', token: "const mutationTsToPs = ['pwsh','Review-StartClaim.ps1'];" },
  { ac: 'AC6', mutationId: 'tracked-d928-oracle-added', path: 'scripts/review-start-claim.test.ts', kind: 'forbidden', token: "const mutationLegacyOracle = 'scripts/lib/Review-StartClaim.ps1';" },
  { ac: 'AC6', mutationId: 'new-scheduler-or-reaper-surface-added', path: 'scripts/lib/review-start-claim-cli.ts', kind: 'forbidden', token: 'setInterval(() => reaperSweep({}), 5000);' },
  { ac: 'AC6', mutationId: 'test-lane-classification-invalid', path: 'package.json', kind: 'required', token: '--maxWorkers=1' },

  { ac: 'AC7', mutationId: 'shared-protocol-interleaving-class-fails', path: 'scripts/lib/review-start-claim-cli.ts', kind: 'required', token: 'return withMutex(lock, execute) as UnknownRecord;' },
  { ac: 'AC7', mutationId: 'representative-end-to-end-class-fails', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: "  'acquisition'," },
  { ac: 'AC7', mutationId: 'process-ordering-substitutes-for-persisted-exclusion', path: 'scripts/lib/review-start-claim-cli.ts', kind: 'required', token: 'mkdirSync(lockDir, { recursive: false, mode: 0o700 });' },
  { ac: 'AC7', mutationId: 'reaper-or-release-mutates-replacement-generation', path: 'scripts/lib/review-start-claim-cli.ts', kind: 'required', token: "if (!sameGeneration(read.record, input.expected)) return { ok: false, reason: 'lost_ownership' };" },
  { ac: 'AC7', mutationId: 'declared-reap-trigger-unreachable', path: 'scripts/lib/review-start-claim-cli.ts', kind: 'required', token: 'export function reaperSweep' },
  { ac: 'AC7', mutationId: 'partial-tree-state-silently-supported', path: 'scripts/lib/review-start-claim-cli.ts', kind: 'required', token: "if (existing.reason !== 'missing') {" },
  { ac: 'AC7', mutationId: 'ci-isolation-or-reentry-broken', path: 'scripts/lib/review-start-claim-store.ts', kind: 'required', token: "if (process.env.OPK_VITEST_HARNESS !== '1') return;" },
  { ac: 'AC7', mutationId: 'rollback-cross-version-gate-not-existing-or-not-shared', path: 'scripts/pr2a/rollback-drain.ts', kind: 'required', token: 'entryBlocked: true,' },
  { ac: 'AC7', mutationId: 'rollback-quiescence-inventory-incomplete', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: 'if (!rollback.quiescenceInventoryComplete)' },
  { ac: 'AC7', mutationId: 'rollback-entry-resumes-before-zero-survivors', path: 'scripts/pr2a/rollback-drain.ts', kind: 'required', token: "if (survivors.length > 0) throw new Error(`rollback_drain_survivors:${survivors.join(',')}`);" },
  { ac: 'AC7', mutationId: 'rollback-detached-drain-artifact-invalid', path: 'scripts/pr2a/rollback-drain.ts', kind: 'required', token: "if (artifact.digest !== expected) throw new Error('rollback_artifact_digest_invalid');" },
  { ac: 'AC7', mutationId: 'rollback-rehearsal-in-evidence-checkout', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: 'if (!rollback.isolatedCheckout)' },
  { ac: 'AC7', mutationId: 'rollback-imports-928-activation-machinery', path: 'scripts/pr2a/rollback-drain.ts', kind: 'forbidden', token: "const mutationImports928ActivationMachinery = 'scripts/pr2-cutover/cordon-controller.ts';" },
  { ac: 'AC7', mutationId: 'unsupported-platform-or-filesystem-operation-succeeds', path: 'scripts/lib/review-start-claim-cli.ts', kind: 'required', token: "if (/^\\/mnt\\/[a-z](?:\\/|$)/i.test(canonical)) throw new Error('unsupported_windows_mounted_filesystem');" },

  { ac: 'AC8', mutationId: 'mandatory-command-or-lane-fails', path: 'package.json', kind: 'required', token: 'scripts/pr2a/final-conformance.test.ts' },
  { ac: 'AC8', mutationId: 'mandatory-test-suppressed-or-reduced', path: 'package.json', kind: 'required', token: '--maxWorkers=1' },
  { ac: 'AC8', mutationId: 'final-evidence-tree-or-platform-stale', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: 'function validateVerificationEnvironment(' },
  { ac: 'AC8', mutationId: 'required-suite-omitted-from-mandatory-path', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: "  'vitest-heavy'," },
  { ac: 'AC8', mutationId: 'receipt-dependent-suite-evidenced-pre-receipt', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: 'if (!preReceiptVerification.prerequisiteSuitesPassedBeforeReceipt)' },
  { ac: 'AC8', mutationId: 'overlap-evidence-candidate-tree-mismatch', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: 'overlap.candidateTreeOid !== expected.finalTreeOid' },
  { ac: 'AC8', mutationId: 'receipt-and-final-verification-tree-differ', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: 'verification.finalTreeOid !== finalTreeOid || verification.checkoutTreeOid !== finalTreeOid' },
  { ac: 'AC8', mutationId: 'final-checks-on-dirty-worktree', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: 'if (!verification.cleanBefore || !verification.cleanAfter' },
  { ac: 'AC8', mutationId: 'evidence-tree-differs-from-executed-bytes', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: 'if (sha256(bytes) !== claimedDigest)' },
  { ac: 'AC8', mutationId: 'implementation-change-reruns-tail-only', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: 'npm run typecheck:foundation && npm run lint:foundation && npm run test:contract-mutations && npm run test:issue-948' },
  { ac: 'AC8', mutationId: 'planning-change-preserves-stale-ac1', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: "planningManifestSha256: sha256(readAt(ref, 'scripts/pr2a/planning-manifest.json'))" },
  { ac: 'AC8', mutationId: 'same-tree-sha-change-rejected-as-tree-mismatch', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: 'return observedCommitSha === expectedCommitSha || gitTreeOid(observedCommitSha) === expectedTreeOid;' },
  { ac: 'AC8', mutationId: 'external-928-sync-evidence-missing', path: 'scripts/pr2a/closure-receipt.ts', kind: 'required', token: "if (external928.result !== 'pass'" },
]);

function git(args: string[], allowExitOne = false): string {
  const result = runProcessSync({ command: 'git', args, cwd: repoRoot, inheritParentEnv: true });
  if (!result.ok && !(allowExitOne && result.exitCode === 1)) {
    throw new Error(result.stderr || result.error || `git_${args.join('_')}_failed`);
  }
  return result.stdout;
}

function refExists(ref: string): boolean {
  return runProcessSync({
    command: 'git',
    args: ['cat-file', '-e', `${ref}^{commit}`],
    cwd: repoRoot,
    inheritParentEnv: true,
  }).ok;
}

function readAt(ref: string, file: string): string {
  return git(['show', `${ref}:${file}`]);
}

function existsAt(ref: string, file: string): boolean {
  return runProcessSync({
    command: 'git',
    args: ['cat-file', '-e', `${ref}:${file}`],
    cwd: repoRoot,
    inheritParentEnv: true,
  }).ok;
}

function listPaths(ref: string): string[] {
  return git(['ls-tree', '-r', '--name-only', ref]).split(/\r?\n/u).filter(Boolean).map(normalizeRepoPath);
}

function treeEntry(ref: string, file: string): string {
  return git(['ls-tree', ref, '--', file]).trim();
}

function diffRows(base: string, ref: string): DiffRow[] {
  return git(['diff', '--name-status', '--no-renames', base, ref]).split(/\r?\n/u).filter(Boolean).map((line) => {
    const [status = '', ...parts] = line.split('\t');
    const file = normalizeRepoPath(parts.join('\t'));
    const operation = status === 'A' ? 'add' : status === 'D' ? 'delete' : 'modify';
    return { status, path: file, operation };
  });
}

function semanticRows(planningBarrierCommit: string, binding: RefBinding): DiffRow[] {
  return diffRows(planningBarrierCommit, binding.candidateCommitSha).filter((row) => {
    return treeEntry(binding.baseCommitSha, row.path) !== treeEntry(binding.candidateCommitSha, row.path);
  });
}

function resolveRefBinding(ref: string): RefBinding {
  const requestedCommit = git(['rev-parse', `${ref}^{commit}`]).trim();
  const parentRow = git(['rev-list', '--parents', '-n', '1', requestedCommit]).trim().split(/\s+/u);
  let candidateCommitSha = requestedCommit;
  let baseCommitSha = '';

  if (parentRow.length >= 3) {
    baseCommitSha = parentRow[1] ?? '';
    candidateCommitSha = parentRow[2] ?? requestedCommit;
  } else {
    const baseName = String(process.env.GITHUB_BASE_REF ?? '').trim() || 'main';
    const baseRef = [`origin/${baseName}`, 'origin/main'].find(refExists);
    if (!baseRef) throw new Error('pr2a_candidate_base_unavailable');
    baseCommitSha = git(['merge-base', candidateCommitSha, baseRef]).trim();
  }

  if (!/^[0-9a-f]{40}$/u.test(baseCommitSha) || !/^[0-9a-f]{40}$/u.test(candidateCommitSha)) {
    throw new Error('pr2a_candidate_binding_invalid');
  }
  return {
    baseCommitSha,
    candidateCommitSha,
    candidateTreeOid: git(['rev-parse', `${candidateCommitSha}^{tree}`]).trim(),
  };
}

function allowedRoot(file: string): boolean {
  return file === 'package.json' || file === 'tsconfig.json' || file === 'vitest.config.ts'
    || file.startsWith('scripts/') || file.startsWith('tests/') || file.startsWith('.github/');
}

function denylisted(file: string): boolean {
  return (DENYLIST as readonly string[]).some((entry) => entry.endsWith('/') ? file.startsWith(entry) : file === entry);
}

function governanceReference(file: string): boolean {
  return (D928 as readonly string[]).includes(file)
    || file.startsWith('scripts/pr2a/')
    || file.startsWith('scripts/estate-cut/')
    || file === 'scripts/pr2-foundation/contracts.ts'
    || file === 'scripts/pr2-foundation/mutation-catalog.ts'
    || file === 'scripts/pr2-foundation/mutation-behavior-probes.ts'
    || file === 'scripts/pr2-foundation/mutation-semantic-gates.ts'
    || file === 'scripts/lib/orchestrator-side-process-observer.ts'
    || file === 'docs/launch-argv-registry.mjs'
    || file === 'docs/orchestrator-message-registry.mjs'
    || file === 'docs/review-start-preflight-shield.mjs';
}

function testOrHarness(file: string): boolean {
  return /(?:^|\/)(?:fixtures?|tests?)(?:\/|$)/iu.test(file)
    || /(?:\.test\.|\.spec\.|Tests\.ps1$|\.shared\.|test-helpers?\.|test-setup\.)/iu.test(file);
}

export function scanForbiddenExecutableReferences(files: Array<{ path: string; content: string }>): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  const basenames = D928.map((file) => path.posix.basename(file));
  for (const row of files) {
    if (!executableExtensions.has(path.posix.extname(row.path).toLowerCase())) continue;
    const matched = basenames.filter((name) => row.content.includes(name));
    if (matched.length === 0) continue;
    if (testOrHarness(row.path) && !row.path.startsWith('scripts/pr2a/')) {
      findings.push({ code: 'd928_test_or_harness_reference', path: row.path, detail: matched.join(',') });
      continue;
    }
    if (!governanceReference(row.path)) {
      findings.push({ code: 'd928_external_executable_reference', path: row.path, detail: matched.join(',') });
    }
  }
  return findings;
}

export function validateBridgeSource(source: string): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  const forbidden = [
    'Set-Content', 'Add-Content', 'Remove-Item', 'Move-Item', 'Copy-Item', 'New-Item',
    '[System.IO.File]', 'Review-StartClaim.ps1', 'review-start-claim-reaper.ps1',
  ];
  for (const token of forbidden) {
    if (source.includes(token)) {
      findings.push({ code: 'bridge_policy_or_storage_logic', path: 'scripts/lib/Review-StartClaimLifecycle.ps1', detail: token });
    }
  }
  if (!/ReviewStartClaimTsCli\s*=\s*Join-Path\s+\$PSScriptRoot\s+'review-start-claim-store\.ts'/u.test(source)
    || !source.includes('Invoke-ReviewStartClaimTsOperation')) {
    findings.push({ code: 'bridge_not_bound_to_typescript_authority', path: 'scripts/lib/Review-StartClaimLifecycle.ps1' });
  }
  if (source.includes("Join-Path $PSScriptRoot 'review-start-claim-cli.ts'")) {
    findings.push({ code: 'bridge_reaches_internal_claim_implementation', path: 'scripts/lib/Review-StartClaimLifecycle.ps1' });
  }
  if ((source.match(/function\s+Invoke-ReviewStartClaimTsOperation/gu) ?? []).length !== 1) {
    findings.push({ code: 'bridge_transport_gateway_not_unique', path: 'scripts/lib/Review-StartClaimLifecycle.ps1' });
  }
  if (!source.includes('PollOnce = $true') || !source.includes('if ($ResolveReviewRuns) { $runs = @(& $ResolveReviewRuns) }')) {
    findings.push({ code: 'bridge_visibility_poll_not_live', path: 'scripts/lib/Review-StartClaimLifecycle.ps1' });
  }
  return findings;
}

export function validateClaimStoreSource(source: string): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  const required = [
    'syncBuiltinESMExports',
    'function safeRmSync',
    'originalRenameSync(lockDir, quarantine)',
    'sameSnapshot(observed, moved)',
    'processIdentityAlive(moved.owner)',
    'fs.rmSync = safeRmSync',
    'syncBuiltinESMExports()',
    "await import('./review-start-claim-cli.ts')",
    "reason: 'visibility_pending'",
    'PollOnce',
  ];
  for (const token of required) {
    if (!source.includes(token)) {
      findings.push({ code: 'claim_store_protocol_guard_missing', path: 'scripts/lib/review-start-claim-store.ts', detail: token });
    }
  }
  if (source.includes('.takeover')) findings.push({ code: 'claim_store_second_lock_path', path: 'scripts/lib/review-start-claim-store.ts' });
  if (/rmSync\(lockDir,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/u.test(source)
    && !source.includes('originalRmSync(quarantine')) {
    findings.push({ code: 'claim_store_unfenced_stale_delete', path: 'scripts/lib/review-start-claim-store.ts' });
  }
  return findings;
}

export function validateClaimImplementationReachability(files: Array<{ path: string; content: string }>): ConformanceFinding[] {
  const allowed = new Set([
    'scripts/lib/review-start-claim-store.ts',
    'scripts/pr2a/closed-world-scanner.ts',
    'scripts/pr2a/final-conformance.ts',
    'scripts/pr2a/final-conformance.test.ts',
    'scripts/pr2a/closure-receipt.ts',
    'scripts/pr2a/mutation-runner.ts',
    'scripts/pr2a/planning.test.ts',
  ]);
  return files
    .filter((row) => row.content.includes('review-start-claim-cli.ts') && !allowed.has(row.path) && !testOrHarness(row.path))
    .map((row) => ({ code: 'claim_internal_implementation_externally_reachable', path: row.path }));
}

export function validateClosureReceiptSource(source: string): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  const required = [
    'function verifyArtifact',
    'function verifyCommandLogs',
    'function verifyReplay',
    'command-result-tree-binding-mismatch',
    'overlap-replay-not-bound-to-harness-and-inputs',
    'overlap.candidateCommitSha !== expected.finalCommitSha',
    'gitTreeOid(overlap.candidateCommitSha)',
    'external-928-body-contract-mismatch',
  ];
  for (const token of required) {
    if (!source.includes(token)) {
      findings.push({ code: 'closure_receipt_independent_verification_missing', path: 'scripts/pr2a/closure-receipt.ts', detail: token });
    }
  }
  if (/DIGEST\.test\([^)]*\)\s*&&?\s*[^;]*result\s*===\s*['"]pass/u.test(source)
    && !source.includes('verifyArtifact(evidenceRoot')) {
    findings.push({ code: 'closure_receipt_shape_only_verification', path: 'scripts/pr2a/closure-receipt.ts' });
  }
  return findings;
}

export function validateMandatoryPackageScripts(source: string): ConformanceFinding[] {
  let parsed: { scripts?: Record<string, string> };
  try {
    parsed = JSON.parse(source) as { scripts?: Record<string, string> };
  } catch {
    return [{ code: 'package_scripts_unreadable', path: 'package.json' }];
  }
  const findings: ConformanceFinding[] = [];
  const issue948 = parsed.scripts?.['test:issue-948'] ?? '';
  const mutations = parsed.scripts?.['test:contract-mutations'] ?? '';
  if (!issue948.includes('--maxWorkers=1') || !issue948.includes('scripts/pr2a/final-conformance.test.ts')) {
    findings.push({ code: 'issue948_mandatory_suite_weakened', path: 'package.json' });
  }
  if (!mutations.includes('scripts/pr2-foundation/contract-test-runner.ts')) {
    findings.push({ code: 'contract_mutation_suite_removed', path: 'package.json' });
  }
  return findings;
}

export function validateRunnerSource(source: string): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  if (!source.includes("from './lib/review-start-claim-store.ts'") || !source.includes('acquireReviewStartClaim(')) {
    findings.push({ code: 'runner_missing_direct_ts_claim_authority', path: 'scripts/pack-review-runner.ts' });
  }
  for (const forbidden of ['Review-StartClaim.ps1', 'Review-StartClaimLifecycle.ps1', 'review-start-claim-cli.ts']) {
    if (source.includes(forbidden)) {
      findings.push({ code: 'runner_claim_powershell_or_cli_edge', path: 'scripts/pack-review-runner.ts', detail: forbidden });
    }
  }
  const start = source.indexOf('async function acquireClaimLease');
  const end = start >= 0 ? source.indexOf('\nasync function ', start + 1) : -1;
  const block = start >= 0 ? source.slice(start, end > start ? end : source.length) : '';
  if (!block || /\bpwsh\b|spawn\s*\(|execFile\s*\(/iu.test(block)) {
    findings.push({ code: 'runner_claim_path_spawns_process', path: 'scripts/pack-review-runner.ts' });
  }
  return findings;
}

function validateDeclaredSafetyFaults(ref: string): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  const cache = new Map<string, string>();
  const source = (file: string): string => {
    const cached = cache.get(file);
    if (cached !== undefined) return cached;
    const value = readAt(ref, file);
    cache.set(file, value);
    return value;
  };
  for (const invariant of declaredSourceInvariants) {
    const content = source(invariant.path);
    const violated = invariant.kind === 'required' ? !content.includes(invariant.token) : content.includes(invariant.token);
    if (violated) {
      findings.push({
        code: `mutation-contract:${invariant.ac}:${invariant.mutationId}`,
        path: invariant.path,
        detail: `${invariant.kind}:${invariant.token}`,
      });
    }
  }
  return findings;
}

function validateOperationSet(manifest: PlanningManifest, rows: DiffRow[]): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  const expected = new Map(manifest.plannedOperations.map((row) => [row.path, row.operation]));
  const actual = new Map(rows.map((row) => [row.path, row.operation]));
  for (const [file, operation] of expected) {
    if (actual.get(file) !== operation) {
      findings.push({ code: 'planned_operation_missing_or_changed', path: file, detail: `expected=${operation};actual=${actual.get(file) ?? 'none'}` });
    }
  }
  for (const [file, operation] of actual) {
    if (!expected.has(file)) findings.push({ code: 'unreviewed_final_tree_operation', path: file, detail: operation });
  }
  return findings;
}

function validateDiffPolicy(rows: DiffRow[], ref: string): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  for (const row of rows) {
    if (!allowedRoot(row.path)) findings.push({ code: 'path_outside_allowed_roots', path: row.path });
    if (denylisted(row.path)) findings.push({ code: 'denylisted_path_changed', path: row.path });
    if (row.operation === 'add' && row.path.endsWith('.ps1')) findings.push({ code: 'new_powershell_logic_added', path: row.path });
    if (row.operation !== 'delete') {
      const mode = git(['ls-tree', ref, '--', row.path]).trim().split(/\s+/u)[0] ?? '';
      if (!['100644', '100755'].includes(mode)) findings.push({ code: 'non_regular_final_tree_mode', path: row.path, detail: mode });
    }
  }
  return findings;
}

function validateLiveManifests(ref: string): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  const basenames = D928.map((file) => path.posix.basename(file));
  for (const file of liveReferenceManifests) {
    const source = readAt(ref, file);
    for (const basename of basenames) {
      if (source.includes(basename)) findings.push({ code: 'actionable_manifest_retains_d928', path: file, detail: basename });
    }
  }
  return findings;
}

function acResult(findings: ConformanceFinding[], codes: string[]): 'pass' | 'fail' {
  return findings.some((row) => codes.some((code) => row.code.startsWith(code))) ? 'fail' : 'pass';
}

export function buildConformanceReport(ref = 'HEAD'): ConformanceReport {
  const binding = resolveRefBinding(ref);
  const commitSha = binding.candidateCommitSha;
  const finalTreeOid = binding.candidateTreeOid;
  const manifest = JSON.parse(readAt(commitSha, planningPath)) as PlanningManifest;
  const planningBarrierCommit = git(['log', '-1', '--format=%H', commitSha, '--', planningPath]).trim();
  const rows = semanticRows(planningBarrierCommit, binding);
  const findings: ConformanceFinding[] = [];

  if (manifest.issue !== 948 || manifest.lineage.foundationCommit !== FOUNDATION_COMMIT) findings.push({ code: 'planning_lineage_invalid' });
  if (git(['rev-parse', `${manifest.lineage.planningCommit}^{tree}`]).trim() !== manifest.lineage.planningBaseTreeOid) {
    findings.push({ code: 'planning_tree_binding_mismatch' });
  }
  findings.push(...validateOperationSet(manifest, rows));
  findings.push(...validateDiffPolicy(rows, commitSha));

  for (const target of D928) {
    if (!existsAt(commitSha, target)) {
      findings.push({ code: 'd928_target_missing_before_pr2_cutover', path: target });
      continue;
    }
    const digest = sha256(readAt(commitSha, target));
    if (digest !== manifest.d928Sha256[target]) findings.push({ code: 'd928_bytes_changed', path: target, detail: digest });
  }

  const executableRows = listPaths(commitSha)
    .filter((file) => executableExtensions.has(path.posix.extname(file).toLowerCase()))
    .map((file) => ({ path: file, content: readAt(commitSha, file) }));
  findings.push(...scanForbiddenExecutableReferences(executableRows));
  findings.push(...validateClaimImplementationReachability(executableRows));
  findings.push(...validateLiveManifests(commitSha));
  findings.push(...validateBridgeSource(readAt(commitSha, 'scripts/lib/Review-StartClaimLifecycle.ps1')));
  findings.push(...validateClaimStoreSource(readAt(commitSha, 'scripts/lib/review-start-claim-store.ts')));
  findings.push(...validateClosureReceiptSource(readAt(commitSha, 'scripts/pr2a/closure-receipt.ts')));
  findings.push(...validateMandatoryPackageScripts(readAt(commitSha, 'package.json')));
  findings.push(...validateRunnerSource(readAt(commitSha, 'scripts/pack-review-runner.ts')));
  findings.push(...validateDeclaredSafetyFaults(commitSha));

  if (existsAt(commitSha, 'scripts/check-side-process-launch-contract.ps1')) {
    findings.push({ code: 'retired_launch_contract_guard_present' });
  }
  const verify = readAt(commitSha, 'scripts/verify.ps1');
  if (verify.includes('check-side-process-launch-contract.ps1') || verify.includes('side-process launch contract')) {
    findings.push({ code: 'retired_launch_contract_verify_block_present', path: 'scripts/verify.ps1' });
  }
  const bridge = readAt(commitSha, 'scripts/lib/Review-StartClaimLifecycle.ps1');
  if (bridge.includes('function Acquire-ReviewStartClaim') && !bridge.includes("Invoke-ReviewStartClaimTsOperation 'Acquire-ReviewStartClaim'")) {
    findings.push({ code: 'bridge_claim_authority_not_delegated' });
  }

  const results = {
    AC1: acResult(findings, ['planning_', 'planned_', 'unreviewed_', 'mutation-contract:AC1:']),
    AC2: acResult(findings, ['runner_', 'claim_store_', 'mutation-contract:AC2:']),
    AC3: acResult(findings, ['bridge_', 'claim_internal_', 'actionable_manifest_', 'd928_external_', 'mutation-contract:AC3:']),
    AC4: acResult(findings, ['d928_test_', 'd928_bytes_', 'd928_target_', 'mutation-contract:AC4:']),
    AC5: acResult(findings, ['bridge_', 'runner_', 'claim_store_', 'claim_internal_', 'closure_receipt_', 'd928_external_', 'mutation-contract:AC5:']),
    AC6: acResult(findings, ['retired_launch_', 'actionable_manifest_', 'mutation-contract:AC6:']),
    AC7: acResult(findings, ['path_outside_', 'denylisted_', 'new_powershell_', 'non_regular_', 'planned_', 'unreviewed_', 'mutation-contract:AC7:']),
    AC8: acResult(findings, ['package_', 'issue948_', 'contract_mutation_', 'closure_receipt_', 'claim_store_', 'bridge_', 'runner_', 'claim_internal_', 'd928_', 'planning_', 'planned_', 'unreviewed_', 'path_outside_', 'denylisted_', 'new_powershell_', 'non_regular_', 'retired_launch_', 'actionable_manifest_', 'mutation-contract:AC8:']),
  };

  return {
    schemaVersion: 1,
    issue: 948,
    ref,
    baseCommitSha: binding.baseCommitSha,
    commitSha,
    finalTreeOid,
    planningCommit: manifest.lineage.planningCommit,
    planningBarrierCommit,
    planningBaseTreeOid: manifest.lineage.planningBaseTreeOid,
    changedPaths: rows.map((row) => row.path),
    findings,
    results,
    result: findings.length === 0 ? 'conformant' : 'nonconformant',
  };
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    if (!existsSync(path.join(repoRoot, planningPath))) throw new Error('planning_manifest_missing');
    const report = buildConformanceReport(arg('--ref') ?? 'HEAD');
    process.stdout.write(`${JSON.stringify(report, null, process.argv.includes('--json') ? 2 : 0)}\n`);
    if (report.result !== 'conformant') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
