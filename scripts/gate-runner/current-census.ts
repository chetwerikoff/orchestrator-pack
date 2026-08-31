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
  const verifyMember = legacyVerifyFailureMember(detail);
  if (verifyMember) return verifyMemberBehaviorWired(snapshot, verifyMember);
  if (detail === 'scripts/check-reusable.ps1 behavior surface drifted without a reviewed current-source hash') {
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
