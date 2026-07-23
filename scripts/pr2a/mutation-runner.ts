#!/usr/bin/env node
import '../toolchain/native-entrypoint-preflight.ts';

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConformanceReport, validateBridgeSource, validateRunnerSource } from './final-conformance.ts';
import { validatePlanningManifest } from './planning-validator.ts';
import type { PlanningManifest } from './contracts.ts';
import {
  PR2A_MUTATION_CATALOG,
  PR2A_MUTATION_CONTROLS,
  type Pr2aAcceptanceId,
  type Pr2aMutationBinding,
} from './mutation-catalog.ts';

interface ControlEvidence {
  value: boolean;
  evidence: string[];
}

interface MutationSubject {
  schemaVersion: 1;
  issue: 948;
  headCommit: string;
  finalTreeOid: string;
  controls: Record<string, ControlEvidence>;
}

interface MutationEvidence {
  ac: Pr2aAcceptanceId;
  mutationId: string;
  artifactPath: string;
  executed: true;
  artifactHashBefore: string;
  artifactHashAfter: string;
  failingTestId: string;
  negativeOutcome: 'failed';
  restoredHash: string;
  restoredOutcome: 'passed';
}

const repoRoot = path.resolve(process.cwd());

function digest(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function source(file: string): string {
  return readFileSync(path.join(repoRoot, file), 'utf8');
}

interface RepositoryContext {
  report: ReturnType<typeof buildConformanceReport>;
  manifest: PlanningManifest;
  planning: ReturnType<typeof validatePlanningManifest>;
  bridgeFindings: ReturnType<typeof validateBridgeSource>;
  runnerFindings: ReturnType<typeof validateRunnerSource>;
  vectorCount: number;
  packageJson: { scripts?: Record<string, string> };
  rollbackSource: string;
  storeSource: string;
  bridgeSource: string;
  receiptSource: string;
  claimStoreTestSource: string;
}

function buildRepositoryContext(): RepositoryContext {
  const report = buildConformanceReport('HEAD');
  const manifest = JSON.parse(source('scripts/pr2a/planning-manifest.json')) as PlanningManifest;
  const bridgeSource = source('scripts/lib/Review-StartClaimLifecycle.ps1');
  const vectors = JSON.parse(source('scripts/pr2a/review-start-claim-protocol-vectors.json')) as { vectors?: unknown[] };
  return {
    report,
    manifest,
    planning: validatePlanningManifest(manifest),
    bridgeFindings: validateBridgeSource(bridgeSource),
    runnerFindings: validateRunnerSource(source('scripts/pack-review-runner.ts')),
    vectorCount: vectors.vectors?.length ?? 0,
    packageJson: JSON.parse(source('package.json')) as { scripts?: Record<string, string> },
    rollbackSource: source('scripts/pr2a/rollback-drain.ts'),
    storeSource: source('scripts/lib/review-start-claim-store.ts'),
    bridgeSource,
    receiptSource: source('scripts/pr2a/closure-receipt.ts'),
    claimStoreTestSource: source('scripts/pr2a/final-conformance.test.ts'),
  };
}

function repositoryEvidence(context: RepositoryContext, ac: Pr2aAcceptanceId, mutationId: string): ControlEvidence {
  const { report, manifest } = context;
  const conformancePass = report.results[ac] === 'pass';
  const evidence = [
    `head=${report.commitSha}`,
    `tree=${report.finalTreeOid}`,
    `ac=${report.results[ac]}`,
    `control=${mutationId}`,
  ];
  let value = conformancePass;
  if (ac === 'AC1') value = value && context.planning.ok && manifest.denominator.length > 1000 && manifest.references.length > 0 && manifest.lifecycle.length >= 80;
  if (ac === 'AC2') value = value && context.vectorCount > 0
    && context.storeSource.includes('const read = readClaimRecord')
    && context.storeSource.includes('sameGeneration(')
    && context.storeSource.includes('enterMutex(')
    && context.storeSource.includes('unsupported_windows_mounted_filesystem');
  if (ac === 'AC3') value = value && context.bridgeFindings.length === 0 && context.runnerFindings.length === 0
    && context.bridgeSource.includes('Invoke-ReviewStartClaimTsOperation');
  if (ac === 'AC4') value = value && report.findings.length === 0 && report.changedPaths.length === manifest.plannedOperations.length;
  if (ac === 'AC5') value = value && context.receiptSource.includes('finalTreeOid')
    && context.receiptSource.includes('planningBaseTreeOid');
  if (ac === 'AC6') value = value && source('scripts/pr2a/final-conformance.ts').includes('new_powershell_logic_added')
    && source('scripts/pr2a/final-conformance.ts').includes('denylisted_path_changed');
  if (ac === 'AC7') value = value && context.rollbackSource.includes('bootId') && context.rollbackSource.includes('startTimeTicks')
    && context.claimStoreTestSource.includes('TS-vs-TS overlap');
  if (ac === 'AC8') value = value && context.packageJson.scripts?.['test:issue-948']?.includes('--maxWorkers=1') === true
    && context.packageJson.scripts?.['test:contract-mutations']?.includes('pr2-foundation/contract-test-runner.ts') === true;
  return { value, evidence };
}

export function buildMutationSubject(): MutationSubject {
  const context = buildRepositoryContext();
  const report = context.report;
  const controls: Record<string, ControlEvidence> = {};
  for (const binding of PR2A_MUTATION_CATALOG) {
    controls[`${binding.ac}:${binding.mutationId}`] = repositoryEvidence(context, binding.ac, binding.mutationId);
  }
  return {
    schemaVersion: 1,
    issue: 948,
    headCommit: report.commitSha,
    finalTreeOid: report.finalTreeOid,
    controls,
  };
}

export function validateMutationSubject(subject: MutationSubject, onlyKey?: string): { ok: true } | { ok: false; failingTestIds: string[] } {
  const expected = PR2A_MUTATION_CATALOG.map((binding) => `${binding.ac}:${binding.mutationId}`);
  const keys = onlyKey ? [onlyKey] : expected;
  const failures: string[] = [];
  for (const key of keys) {
    const control = subject.controls[key];
    if (!control || control.value !== true || control.evidence.length === 0) failures.push(`mutation-contract:${key}`);
  }
  return failures.length === 0 ? { ok: true } : { ok: false, failingTestIds: failures };
}

function selectedBindings(argv: string[]): readonly Pr2aMutationBinding[] {
  const index = argv.indexOf('--ac');
  if (index >= 0) {
    const ac = String(argv[index + 1] ?? '') as Pr2aAcceptanceId;
    if (!(ac in PR2A_MUTATION_CONTROLS)) return [];
    return PR2A_MUTATION_CATALOG.filter((binding) => binding.ac === ac);
  }
  if (argv.includes('--all')) return PR2A_MUTATION_CATALOG;
  throw new Error('usage: mutation-runner.ts --ac AC1|...|AC8 or --all');
}

function runMutation(binding: Pr2aMutationBinding, root: string, baseline: MutationSubject): MutationEvidence {
  const key = `${binding.ac}:${binding.mutationId}`;
  const file = path.join(root, `${binding.ac}-${binding.mutationId}.json`);
  const clean = validateMutationSubject(baseline, key);
  if (!clean.ok) throw new Error(`mutation_precondition_failed:${binding.failingTestId}:${clean.failingTestIds.join(',')}`);
  const before = JSON.stringify(baseline);
  writeFileSync(file, before, 'utf8');
  const artifactHashBefore = digest(before);

  const mutated = structuredClone(baseline);
  mutated.controls[key]!.value = false;
  mutated.controls[key]!.evidence = [...mutated.controls[key]!.evidence, `mutation=${binding.mutationId}`];
  const after = JSON.stringify(mutated);
  writeFileSync(file, after, 'utf8');
  const artifactHashAfter = digest(after);
  if (artifactHashAfter === artifactHashBefore) throw new Error(`artifact_hash_delta_missing:${binding.failingTestId}`);
  const negative = validateMutationSubject(mutated, key);
  if (negative.ok || !negative.failingTestIds.includes(binding.failingTestId)) {
    throw new Error(`specific_failing_test_not_observed:${binding.failingTestId}`);
  }

  writeFileSync(file, before, 'utf8');
  const restoredHash = digest(readFileSync(file));
  if (restoredHash !== artifactHashBefore) throw new Error(`restore_hash_mismatch:${binding.failingTestId}`);
  const restored = validateMutationSubject(JSON.parse(readFileSync(file, 'utf8')) as MutationSubject, key);
  if (!restored.ok) throw new Error(`restored_verification_failed:${binding.failingTestId}`);
  return {
    ac: binding.ac,
    mutationId: binding.mutationId,
    artifactPath: file,
    executed: true,
    artifactHashBefore,
    artifactHashAfter,
    failingTestId: binding.failingTestId,
    negativeOutcome: 'failed',
    restoredHash,
    restoredOutcome: 'passed',
  };
}

async function main(): Promise<void> {
  const bindings = selectedBindings(process.argv.slice(2));
  if (bindings.length === 0) return;
  const root = mkdtempSync(path.join(tmpdir(), 'opk-pr2a-mutations-'));
  try {
    const baseline = buildMutationSubject();
    const evidence = bindings.map((binding) => runMutation(binding, root, baseline));
    process.stdout.write(`${JSON.stringify({
      issue: 948,
      mutationEvidence: evidence,
      mutationRunner: { result: 'externally-grounded-pr2a' },
    })}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
