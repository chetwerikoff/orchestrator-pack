import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateClosureEvidenceBundle, validateFinalVerificationAgainstReceipt, type ClosureEvidenceBundle, type FinalVerificationEvidence } from './closure-receipt.ts';
import { stableJson } from './contracts.ts';
import {
  scanForbiddenExecutableReferences,
  validateBridgeSource,
  validateRunnerSource,
} from './final-conformance.ts';

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
