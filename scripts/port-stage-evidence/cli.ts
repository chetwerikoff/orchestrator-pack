#!/usr/bin/env -S node --experimental-strip-types
import '../toolchain/native-entrypoint-preflight.ts';
import { resolve } from 'node:path';
import { isDirectExecution } from '#opk-toolchain/baseline-io';
import { ARTIFACT_ROLES, producePortStageEvidence, serializePortStageEvidence, verifyEvidenceIntegrity, writePortStageEvidence, type ArtifactRole } from './producer.ts';

function argument(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function role(value: string | undefined): ArtifactRole {
  if (!value || !ARTIFACT_ROLES.includes(value as ArtifactRole)) throw new Error(`--role must be one of ${ARTIFACT_ROLES.join(', ')}`);
  return value as ArtifactRole;
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    const repoRoot = resolve(argument(argv, '--repo-root') ?? resolve(import.meta.dirname, '../..'));
    const artifactRole = role(argument(argv, '--role'));
    const measuredHead = argument(argv, '--measured-head');
    if (!measuredHead) throw new Error('--measured-head is required and must be a full 40-hex SHA');
    const evidence = await producePortStageEvidence({ repoRoot, artifactRole, measuredHead, producerRevision: argument(argv, '--producer-revision') });
    verifyEvidenceIntegrity(evidence);
    if (argv.includes('--stdout')) process.stdout.write(serializePortStageEvidence(evidence));
    else {
      const path = await writePortStageEvidence(repoRoot, evidence);
      process.stdout.write(`${JSON.stringify({ status: 'PASS', artifactRole, path, measuredHead: evidence.measuredHead, integrityDigest: evidence.integrityDigest })}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`[FAIL] port-stage-evidence: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`[FAIL] port-stage-evidence: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
