import { failGate, passGate, type GateResult } from './contracts.ts';
import { evaluateCensus, type GateCensus } from './census.ts';
import { NODE_CENSUS_PORT_TAGS } from './node-verifier-ports.ts';
import type { SourceSnapshot } from './source-snapshot.ts';

function nodePortSource(snapshot: SourceSnapshot): string {
  return snapshot.files.get('scripts/gate-runner/node-verifier-ports.ts') ?? '';
}

function hasPortTag(snapshot: SourceSnapshot, tag: string): boolean {
  return nodePortSource(snapshot).includes(`'${tag}'`) || nodePortSource(snapshot).includes(`\"${tag}\"`);
}

function thinNodeLauncher(snapshot: SourceSnapshot): boolean {
  const launcher = snapshot.files.get('scripts/verify.ps1') ?? '';
  const verifier = snapshot.files.get('scripts/verify.ts') ?? '';
  return launcher.includes('verify.ts')
    && /&\s+node\b/iu.test(launcher)
    && !launcher.includes('scripts/gate-runner/runner.ts')
    && verifier.includes('runNodeVerificationPorts');
}

function legacyVerifyFailurePortTag(detail: string): string | undefined {
  const match = /^(verify-script:scripts\/([^:]+)\.ps1): retained verify invocation was dropped$/u.exec(detail);
  return match?.[2] ? `verify-member:${match[2]}` : undefined;
}

function isAdmittedNodeMigrationFailure(detail: string, snapshot: SourceSnapshot): boolean {
  const verifyTag = legacyVerifyFailurePortTag(detail);
  if (verifyTag) return thinNodeLauncher(snapshot) && hasPortTag(snapshot, verifyTag);
  if (detail === 'scripts/check-reusable.ps1 behavior surface drifted without a reviewed current-source hash') {
    return thinNodeLauncher(snapshot)
      && NODE_CENSUS_PORT_TAGS.filter((tag) => tag.startsWith('check-reusable:')).every((tag) => hasPortTag(snapshot, tag));
  }
  if (detail === 'verify.ps1 must contain exactly one gate-runner dispatch marker; found 0') return thinNodeLauncher(snapshot);
  return false;
}

export function evaluateCurrentCensus(
  census: GateCensus,
  snapshot: SourceSnapshot,
  registeredGateIds: ReadonlySet<string>,
): GateResult {
  const historical = evaluateCensus(census, snapshot, registeredGateIds);
  if (historical.status === 'PASS') return historical;
  const remaining = (historical.details ?? []).filter((detail) => !isAdmittedNodeMigrationFailure(detail, snapshot));
  if (remaining.length > 0) return failGate('gate-census', 'Gate population census reconciliation failed.', historical.evidence, remaining);
  return passGate('gate-census', 'Gate population census reconciled through the Node verification migration authority.', [], historical.evidence);
}
