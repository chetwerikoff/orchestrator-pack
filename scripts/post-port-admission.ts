#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';
import { resolve } from 'node:path';
import { isDirectExecution } from '#opk-toolchain/baseline-io';
import {
  producePortStageEvidence,
  verifyEvidenceIntegrity,
  writePortStageEvidence,
  type PortStageEvidence,
} from './port-stage-evidence/producer.ts';

export interface PostPortAdmissionResult {
  readonly status: 'PASS' | 'FAIL';
  readonly currentPrescriptive: readonly {
    readonly sourceKind: string;
    readonly sourcePath: string;
    readonly line: number;
    readonly matchedBytes: string;
    readonly resolvedScriptPath?: string;
  }[];
  readonly unclassifiedPowerShellSurfaces: PortStageEvidence['unclassifiedPowerShellSurfaces'];
  readonly unresolvedCurrentPrescriptiveScriptTargets: PortStageEvidence['unresolvedCurrentPrescriptiveScriptTargets'];
  readonly missingRetainedDispositions: readonly string[];
  readonly failures: readonly string[];
}

function argument(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function evaluatePostPortEvidence(evidence: PortStageEvidence): PostPortAdmissionResult {
  const currentPrescriptive = evidence.entries
    .filter((entry) => entry.currentPrescriptive)
    .map((entry) => ({
      sourceKind: entry.sourceKind,
      sourcePath: entry.occurrence.sourcePath,
      line: entry.occurrence.line,
      matchedBytes: entry.occurrence.matchedBytes,
      ...(entry.resolvedScriptPath ? { resolvedScriptPath: entry.resolvedScriptPath } : {}),
    }));
  const retained = new Set(evidence.retainedDispositions.map((row) => row.path));
  const missingRetainedDispositions = evidence.entries
    .filter((entry) => entry.sourceKind === 'tracked-ps1-file' && !entry.currentPrescriptive)
    .map((entry) => entry.occurrence.sourcePath)
    .filter((path) => !retained.has(path));

  const failures: string[] = [];
  if (evidence.artifactRole !== 'post-port') failures.push(`artifact_role=${evidence.artifactRole}`);
  if (!evidence.broaderStatusClosed) failures.push('broader_status_open');
  if (currentPrescriptive.length > 0) failures.push(`current_prescriptive=${currentPrescriptive.length}`);
  if (evidence.unresolvedCurrentPrescriptiveScriptTargets.length > 0) {
    failures.push(`unresolved_current_targets=${evidence.unresolvedCurrentPrescriptiveScriptTargets.length}`);
  }
  if (!evidence.dormantRetainedCoverageComplete) {
    failures.push(`dormant_retained_coverage_incomplete=${missingRetainedDispositions.length}`);
  }

  return {
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    currentPrescriptive,
    unclassifiedPowerShellSurfaces: evidence.unclassifiedPowerShellSurfaces,
    unresolvedCurrentPrescriptiveScriptTargets: evidence.unresolvedCurrentPrescriptiveScriptTargets,
    missingRetainedDispositions,
    failures,
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    const measuredHead = argument(argv, '--measured-head');
    if (!measuredHead || !/^[0-9a-f]{40}$/u.test(measuredHead)) throw new Error('--measured-head must be a full lowercase 40-hex SHA');
    const producerRevision = argument(argv, '--producer-revision') ?? measuredHead;
    if (!/^[0-9a-f]{40}$/u.test(producerRevision)) throw new Error('--producer-revision must be a full lowercase 40-hex SHA');
    const repoRoot = resolve(argument(argv, '--repo-root') ?? resolve(import.meta.dirname, '..'));
    const evidence = await producePortStageEvidence({ repoRoot, artifactRole: 'post-port', measuredHead, producerRevision });
    verifyEvidenceIntegrity(evidence);
    const admission = evaluatePostPortEvidence(evidence);
    if (admission.status !== 'PASS') {
      process.stderr.write(`[FAIL] post-port admission\n${JSON.stringify(admission, null, 2)}\n`);
      return 2;
    }
    const path = await writePortStageEvidence(repoRoot, evidence);
    process.stdout.write(`${JSON.stringify({ status: 'PASS', artifactRole: 'post-port', path, measuredHead, integrityDigest: evidence.integrityDigest })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`[FAIL] post-port admission: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`[FAIL] post-port admission: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
