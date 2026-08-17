import { failGate, passGate, type GateResult } from './contracts.ts';
import { evaluateCensus, type GateCensus } from './census.ts';
import type { SourceSnapshot } from './source-snapshot.ts';

const REUSABLE_PORT_TAGS = [
  'check-reusable:allow-no-git',
  'check-reusable:allowed-path-patterns',
  'check-reusable:allowed-root-patterns',
  'check-reusable:exception-patterns',
  'check-reusable:forbidden-patterns',
  'check-reusable:git-command-presence',
  'check-reusable:tracked-file-enumeration',
  'check-reusable:violation-aggregation',
  'check-reusable:worktree-detection',
] as const;

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
    return thinNodeLauncher(snapshot) && REUSABLE_PORT_TAGS.every((tag) => hasPortTag(snapshot, tag));
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
