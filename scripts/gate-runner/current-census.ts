import { failGate, passGate, type GateResult } from './contracts.ts';
import { evaluateCensus, type CensusSchemaOptions, type GateCensus } from './census.ts';
import type { SourceSnapshot } from './source-snapshot.ts';

function snapshotFile(snapshot: SourceSnapshot, path: string): string {
  return snapshot.files.get(path) ?? '';
}

function verifierSource(snapshot: SourceSnapshot): string {
  return snapshotFile(snapshot, 'scripts/verify.ts');
}

function nodePortSource(snapshot: SourceSnapshot): string {
  return snapshotFile(snapshot, 'scripts/gate-runner/node-verifier-ports.ts');
}

function directNodeVerifier(snapshot: SourceSnapshot): boolean {
  const verifier = verifierSource(snapshot);
  return verifier.includes('const ports = await runNodeVerificationPorts(repoRoot);')
    && verifier.includes('const gateReport = runGateRunner(repoRoot);');
}

function reusableBehaviorWired(snapshot: SourceSnapshot): boolean {
  const verifier = verifierSource(snapshot);
  return directNodeVerifier(snapshot)
    && verifier.includes('export function evaluateReusableTrackedPaths')
    && verifier.includes('export async function runReusableGuard')
    && verifier.includes("args: ['ls-files']")
    && verifier.includes('evaluateReusableTrackedPaths(tracked.paths)')
    && verifier.includes('const reusable = await runReusableGuard(repoRoot);')
    && verifier.includes("? await runReusableGuard(repoRoot, argv.includes('--allow-no-git'))");
}

function ciPolicyGuardWired(
  snapshot: SourceSnapshot,
  functionName: string,
  command: string,
  workflowPath: string,
): boolean {
  const source = snapshotFile(snapshot, 'scripts/ci-policy-guards.ts');
  const workflow = snapshotFile(snapshot, workflowPath);
  return source.includes(`function ${functionName}`)
    && source.includes(`command==='${command}'`)
    && workflow.includes(`ci-policy-guards.ts ${command}`);
}

function retainedCheckNodeOwnerWired(snapshot: SourceSnapshot, sourcePath: string): boolean {
  switch (sourcePath) {
    case 'scripts/check-ci-cheap-wins.ps1':
      return ciPolicyGuardWired(snapshot, 'runCiCheapWins', 'ci-cheap-wins', '.github/workflows/scope-guard.yml');
    case 'scripts/check-ci-pipeline-split.ps1':
      return ciPolicyGuardWired(snapshot, 'runPipelineSplit', 'pipeline-split', '.github/workflows/scope-guard.yml');
    case 'scripts/check-gh-inventory-static.ps1':
      return verifyMemberBehaviorWired(snapshot, 'check-gh-inventory-static');
    case 'scripts/check-operator-adoption-example.ps1': {
      const source = snapshotFile(snapshot, 'scripts/pr-scope-runner.ts');
      return source.includes('export function checkOperatorAdoption(')
        && source.includes('const adoption = checkOperatorAdoption(diff.diff.operatorAdoptionPaths, prBody);');
    }
    case 'scripts/check-read-delegation-audit-ci-gate.ps1':
      return ciPolicyGuardWired(snapshot, 'runReadDelegationCiGate', 'read-delegation-ci-gate', '.github/workflows/read-delegation-audit.yml');
    case 'scripts/check-read-delegation-policy-consistency.ps1':
      return ciPolicyGuardWired(snapshot, 'runReadDelegationPolicy', 'read-delegation-policy', '.github/workflows/read-delegation-audit.yml');
    case 'scripts/check-reusable.ps1':
      return reusableBehaviorWired(snapshot);
    case 'scripts/check-review-delivery-no-visibility-poll.ps1':
      return verifyMemberBehaviorWired(snapshot, 'check-review-delivery-no-visibility-poll');
    case 'scripts/check-verify-runtime.ps1':
      return ciPolicyGuardWired(snapshot, 'runVerifyRuntime', 'verify-runtime', '.github/workflows/scope-guard.yml');
    default:
      return false;
  }
}

function legacyRetainedCheckFailurePath(detail: string): string | undefined {
  return /^check-script:(scripts\/[^:]+\.ps1): retained legacy gate was dropped$/u.exec(detail)?.[1];
}

function verifyMemberBehaviorWired(snapshot: SourceSnapshot, member: string): boolean {
  if (!directNodeVerifier(snapshot)) return false;
  if (member === 'check-reusable') return reusableBehaviorWired(snapshot);
  const ports = nodePortSource(snapshot);
  if (member === 'check-gh-inventory-static') {
    return ports.includes('const inventoryFailure = await runGhInventoryStatic(repoRoot);')
      && ports.includes("args: [guard, path, '--mode', mode]")
      && ports.includes("args: [inventory, 'validate', repoRoot]");
  }
  if (member === 'check-review-delivery-no-visibility-poll') {
    return ports.includes('const deliveryFailure = reviewDeliveryFailure(repoRoot);')
      && ports.includes("'deliverPackReviewVerdict'")
      && ports.includes("'submit_visibility_timeout'");
  }
  return false;
}

function legacyVerifyFailureMember(detail: string): string | undefined {
  const match = /^verify-script:scripts\/([^:]+)\.ps1: retained verify invocation was dropped$/u.exec(detail);
  return match?.[1];
}

function isAdmittedNodeMigrationFailure(detail: string, snapshot: SourceSnapshot): boolean {
  const retainedCheck = legacyRetainedCheckFailurePath(detail);
  if (retainedCheck) return retainedCheckNodeOwnerWired(snapshot, retainedCheck);
  const verifyMember = legacyVerifyFailureMember(detail);
  if (verifyMember) return verifyMemberBehaviorWired(snapshot, verifyMember);
  if (
    detail === 'scripts/check-reusable.ps1 behavior surface drifted without a reviewed current-source hash'
    || detail === 'scripts/check-reusable.ps1 is missing while its behaviors remain legacy-enforced'
  ) {
    return reusableBehaviorWired(snapshot);
  }
  if (detail === 'verify.ps1 must contain exactly one gate-runner dispatch marker; found 0') {
    return directNodeVerifier(snapshot) && reusableBehaviorWired(snapshot);
  }
  return false;
}

export function evaluateCurrentCensus(
  census: GateCensus,
  snapshot: SourceSnapshot,
  registeredGateIds: ReadonlySet<string>,
  schemaOptions?: CensusSchemaOptions,
): GateResult {
  const historical = evaluateCensus(census, snapshot, registeredGateIds, schemaOptions);
  if (historical.status === 'PASS') return historical;
  const remaining = (historical.details ?? []).filter((detail) => !isAdmittedNodeMigrationFailure(detail, snapshot));
  if (remaining.length > 0) return failGate('gate-census', 'Gate population census reconciliation failed.', historical.evidence, remaining);
  return passGate('gate-census', 'Gate population census reconciled through the Node verification migration authority.', [], historical.evidence);
}
