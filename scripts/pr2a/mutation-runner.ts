#!/usr/bin/env node
import '../toolchain/native-entrypoint-preflight.ts';

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanForbiddenExecutableReferences,
  validateBridgeSource,
  validateClaimStoreSource,
  validateClosureReceiptSource,
  validateMandatoryPackageScripts,
  validateRunnerSource,
  type ConformanceFinding,
} from './final-conformance.ts';
import { validatePlanningManifest } from './planning-validator.ts';
import type { PlanningManifest } from './contracts.ts';
import {
  PR2A_MUTATION_CATALOG,
  PR2A_MUTATION_CONTROLS,
  type Pr2aAcceptanceId,
  type Pr2aMutationBinding,
} from './mutation-catalog.ts';

interface MutationEvidence {
  ac: Pr2aAcceptanceId;
  mutationId: string;
  mutationProfile: string;
  artifactPath: string;
  detector: string;
  executed: true;
  artifactHashBefore: string;
  artifactHashAfter: string;
  failingTestId: string;
  observedFindings: string[];
  negativeOutcome: 'failed';
  restoredHash: string;
  restoredOutcome: 'passed';
}

interface MutationPlan {
  profile: string;
  artifactPath: string;
  detector: string;
  mutate: (source: string, mutationId: string) => string;
  inspect: (source: string) => string[];
}

const repoRoot = path.resolve(process.cwd());

function digest(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
function source(file: string): string { return readFileSync(path.join(repoRoot, file), 'utf8'); }
function findingCodes(rows: ConformanceFinding[]): string[] { return rows.map((row) => row.code); }
function indexFor(value: string, size: number): number {
  return Number.parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16) % size;
}
function replaceRequired(sourceText: string, token: string, replacement: string, mutationId: string): string {
  if (!sourceText.includes(token)) throw new Error(`mutation_token_missing:${mutationId}:${token}`);
  return sourceText.replace(token, `${replacement} /* mutation:${mutationId} */`);
}

const storeTokens = [
  'sameSnapshot(observed, moved)',
  'processIdentityAlive(moved.owner)',
  'fs.rmSync = safeRmSync',
  'syncBuiltinESMExports()',
  "await import('./review-start-claim-cli.ts')",
  'PollOnce',
] as const;
const receiptTokens = [
  'function verifyArtifact',
  'function verifyCommandLogs',
  'function verifyReplay',
  'command-result-tree-binding-mismatch',
  'overlap-replay-not-bound-to-harness-and-inputs',
  'overlap.candidateCommitSha !== expected.finalCommitSha',
  'gitTreeOid(overlap.candidateCommitSha)',
  'external-928-body-contract-mismatch',
] as const;

function mutationPlan(binding: Pr2aMutationBinding): MutationPlan {
  switch (binding.ac) {
    case 'AC1':
      return {
        profile: 'planning-manifest-lineage',
        artifactPath: 'scripts/pr2a/planning-manifest.json',
        detector: 'validatePlanningManifest',
        mutate: (text, id) => replaceRequired(text, '"issue":948', '"issue":949', id),
        inspect: (text) => {
          try {
            const parsed = JSON.parse(text) as PlanningManifest;
            const result = validatePlanningManifest(parsed);
            return result.ok ? [] : ['planning_manifest_rejected'];
          } catch { return ['planning_manifest_unreadable']; }
        },
      };
    case 'AC2': {
      const token = storeTokens[indexFor(binding.mutationId, storeTokens.length)]!;
      return {
        profile: `claim-protocol:${token}`,
        artifactPath: 'scripts/lib/review-start-claim-store.ts',
        detector: 'validateClaimStoreSource',
        mutate: (text, id) => replaceRequired(text, token, `/* removed ${token} */`, id),
        inspect: (text) => findingCodes(validateClaimStoreSource(text)),
      };
    }
    case 'AC3': {
      const profile = indexFor(binding.mutationId, 3);
      if (profile === 0) return {
        profile: 'bridge-direct-internal-authority',
        artifactPath: 'scripts/lib/Review-StartClaimLifecycle.ps1',
        detector: 'validateBridgeSource',
        mutate: (text, id) => replaceRequired(text, "'review-start-claim-store.ts'", "'review-start-claim-cli.ts'", id),
        inspect: (text) => findingCodes(validateBridgeSource(text)),
      };
      if (profile === 1) return {
        profile: 'bridge-storage-policy',
        artifactPath: 'scripts/lib/Review-StartClaimLifecycle.ps1',
        detector: 'validateBridgeSource',
        mutate: (text, id) => `${text}\nSet-Content mutation-${id} '{}'\n`,
        inspect: (text) => findingCodes(validateBridgeSource(text)),
      };
      return {
        profile: 'runner-internal-cli-edge',
        artifactPath: 'scripts/pack-review-runner.ts',
        detector: 'validateRunnerSource',
        mutate: (text, id) => replaceRequired(text, "from './lib/review-start-claim-store.ts'", "from './lib/review-start-claim-cli.ts'", id),
        inspect: (text) => findingCodes(validateRunnerSource(text)),
      };
    }
    case 'AC4':
      return {
        profile: 'tracked-test-reaches-d928',
        artifactPath: 'scripts/pack-review-runner.ts',
        detector: 'scanForbiddenExecutableReferences',
        mutate: (text, id) => `${text}\nspawn('pwsh', ['-File', 'scripts/orchestrator-wake-supervisor.ps1']); // mutation:${id}\n`,
        inspect: (text) => findingCodes(scanForbiddenExecutableReferences([{ path: 'scripts/example.test.ts', content: text }])),
      };
    case 'AC5': {
      const token = receiptTokens[indexFor(binding.mutationId, receiptTokens.length)]!;
      return {
        profile: `receipt-verifier:${token}`,
        artifactPath: 'scripts/pr2a/closure-receipt.ts',
        detector: 'validateClosureReceiptSource',
        mutate: (text, id) => replaceRequired(text, token, `/* removed ${token} */`, id),
        inspect: (text) => findingCodes(validateClosureReceiptSource(text)),
      };
    }
    case 'AC6':
      return {
        profile: 'production-reverse-edge-to-d928',
        artifactPath: 'scripts/pack-review-runner.ts',
        detector: 'scanForbiddenExecutableReferences',
        mutate: (text, id) => `${text}\nconst mutation${id.replace(/[^a-z0-9]/giu, '_')} = 'scripts/lib/Review-StartClaim.ps1';\n`,
        inspect: (text) => findingCodes(scanForbiddenExecutableReferences([{ path: 'scripts/pack-review-runner.ts', content: text }])),
      };
    case 'AC7':
      return {
        profile: 'second-lock-tree',
        artifactPath: 'scripts/lib/review-start-claim-store.ts',
        detector: 'validateClaimStoreSource',
        mutate: (text, id) => `${text}\nconst secondLock${id.replace(/[^a-z0-9]/giu, '_')} = '.takeover';\n`,
        inspect: (text) => findingCodes(validateClaimStoreSource(text)),
      };
    case 'AC8': {
      const removeIssueSuite = indexFor(binding.mutationId, 2) === 0;
      return {
        profile: removeIssueSuite ? 'mandatory-issue948-suite-weakened' : 'contract-mutation-suite-removed',
        artifactPath: 'package.json',
        detector: 'validateMandatoryPackageScripts',
        mutate: (text, id) => removeIssueSuite
          ? replaceRequired(text, '--maxWorkers=1', '--maxWorkers=2', id)
          : replaceRequired(text, 'scripts/pr2-foundation/contract-test-runner.ts', 'scripts/pr2-foundation/contract-test-runner-removed.ts', id),
        inspect: (text) => findingCodes(validateMandatoryPackageScripts(text)),
      };
    }
  }
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

function runMutation(binding: Pr2aMutationBinding, root: string): MutationEvidence {
  const plan = mutationPlan(binding);
  const before = source(plan.artifactPath);
  const baselineFindings = plan.inspect(before);
  if (baselineFindings.length > 0) {
    throw new Error(`mutation_precondition_failed:${binding.failingTestId}:${baselineFindings.join(',')}`);
  }

  const file = path.join(root, `${binding.ac}-${binding.mutationId.replace(/[^a-z0-9_.-]/giu, '_')}${path.extname(plan.artifactPath) || '.txt'}`);
  writeFileSync(file, before, 'utf8');
  const artifactHashBefore = digest(before);
  const mutated = plan.mutate(before, binding.mutationId);
  if (mutated === before) throw new Error(`mutation_did_not_change_artifact:${binding.failingTestId}`);
  writeFileSync(file, mutated, 'utf8');
  const artifactHashAfter = digest(mutated);
  const observedFindings = plan.inspect(readFileSync(file, 'utf8'));
  if (observedFindings.length === 0) throw new Error(`specific_failing_test_not_observed:${binding.failingTestId}`);

  writeFileSync(file, before, 'utf8');
  const restoredHash = digest(readFileSync(file));
  if (restoredHash !== artifactHashBefore) throw new Error(`restore_hash_mismatch:${binding.failingTestId}`);
  const restoredFindings = plan.inspect(readFileSync(file, 'utf8'));
  if (restoredFindings.length > 0) throw new Error(`restored_verification_failed:${binding.failingTestId}:${restoredFindings.join(',')}`);

  return {
    ac: binding.ac,
    mutationId: binding.mutationId,
    mutationProfile: plan.profile,
    artifactPath: plan.artifactPath,
    detector: plan.detector,
    executed: true,
    artifactHashBefore,
    artifactHashAfter,
    failingTestId: binding.failingTestId,
    observedFindings,
    negativeOutcome: 'failed',
    restoredHash,
    restoredOutcome: 'passed',
  };
}

async function main(): Promise<void> {
  const bindings = selectedBindings(process.argv.slice(2));
  if (bindings.length === 0) throw new Error('no_mutation_bindings_selected');
  const root = mkdtempSync(path.join(tmpdir(), 'opk-pr2a-mutations-'));
  try {
    const evidence = bindings.map((binding) => runMutation(binding, root));
    process.stdout.write(`${JSON.stringify({
      issue: 948,
      mutationEvidence: evidence,
      mutationRunner: { result: 'concrete-source-red-green', bindings: evidence.length },
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
