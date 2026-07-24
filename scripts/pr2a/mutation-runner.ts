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
  expectedFindings: string[];
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
  expectedFindings: readonly string[];
  mutate: (source: string, mutationId: string) => string;
  inspect: (source: string) => string[];
}

const repoRoot = path.resolve(process.cwd());
const digest = (value: string | Buffer): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const source = (file: string): string => readFileSync(path.join(repoRoot, file), 'utf8');
const findingCodes = (rows: ConformanceFinding[]): string[] => rows.map((row) => row.code);
const includesAny = (value: string, terms: readonly string[]): boolean => terms.some((term) => value.includes(term));
function replaceRequired(text: string, token: string, replacement: string, id: string): string {
  if (!text.includes(token)) throw new Error(`mutation_token_missing:${id}:${token}`);
  const annotated = token.startsWith('"issue":') ? replacement : `${replacement} /* mutation:${id} */`;
  return text.replace(token, annotated);
}
function replaceAllRequired(text: string, token: string, replacement: string, id: string): string {
  if (!text.includes(token)) throw new Error(`mutation_token_missing:${id}:${token}`);
  return text.split(token).join(`${replacement} /* mutation:${id} */`);
}

const STORE_TOKENS = {
  ownerSnapshot: 'sameSnapshot(observed, moved)',
  liveOwner: 'processIdentityAlive(moved.owner)',
  canonicalHook: 'fs.rmSync = safeRmSync',
  durableSync: 'syncBuiltinESMExports()',
  authorityImport: "await import('./review-start-claim-cli.ts')",
  polling: 'PollOnce',
} as const;
const RECEIPT_TOKENS = {
  artifact: 'function verifyArtifact',
  command: 'function verifyCommandLogs',
  replay: 'function verifyReplay',
  commandTree: 'command-result-tree-binding-mismatch',
  replayBinding: 'overlap-replay-not-bound-to-harness-and-inputs',
  candidateCommit: 'overlap.candidateCommitSha !== expected.finalCommitSha',
  candidateTree: 'gitTreeOid(overlap.candidateCommitSha)',
  external928: 'external-928-body-contract-mismatch',
} as const;

function planningPlan(): MutationPlan {
  return {
    profile: 'planning-manifest-lineage', artifactPath: 'scripts/pr2a/planning-manifest.json',
    detector: 'validatePlanningManifest', expectedFindings: ['planning_manifest_rejected'],
    mutate: (text, id) => replaceRequired(text, '"issue":948', '"issue":949', id),
    inspect: (text) => {
      try {
        const result = validatePlanningManifest(JSON.parse(text) as PlanningManifest);
        return result.ok ? [] : ['planning_manifest_rejected'];
      } catch { return ['planning_manifest_unreadable']; }
    },
  };
}
function claimPlan(id: string): MutationPlan {
  let token: string = STORE_TOKENS.ownerSnapshot;
  let profile = 'claim-protocol:owner-snapshot-revalidation';
  if (includesAny(id, ['identity', 'legacy-record', 'unsupported-boundary'])) {
    token = STORE_TOKENS.liveOwner; profile = 'claim-protocol:live-owner-identity';
  } else if (includesAny(id, ['namespace', 'key', 'path', 'schema'])) {
    token = STORE_TOKENS.canonicalHook; profile = 'claim-protocol:canonical-lock-tree';
  } else if (includesAny(id, ['dispatch', 'oracle', 'authority', 'policy-semantics'])) {
    token = STORE_TOKENS.authorityImport; profile = 'claim-protocol:typescript-authority';
  } else if (includesAny(id, ['reap', 'scheduler', 'visibility', 'trigger'])) {
    token = STORE_TOKENS.polling; profile = 'claim-protocol:inline-reap-and-poll';
  } else if (includesAny(id, ['ordering', 'crash', 'durability', 'atomic'])) {
    token = STORE_TOKENS.durableSync; profile = 'claim-protocol:durable-ordering';
  }
  return {
    profile, artifactPath: 'scripts/lib/review-start-claim-store.ts', detector: 'validateClaimStoreSource',
    expectedFindings: ['claim_store_protocol_guard_missing'],
    mutate: (text, mutationId) => replaceRequired(text, token, '/* removed protocol guard */', mutationId),
    inspect: (text) => findingCodes(validateClaimStoreSource(text)),
  };
}
function authorityPlan(id: string): MutationPlan {
  if (includesAny(id, ['second-namespace', 'second-lock'])) {
    return {
      profile: 'second-lock-tree', artifactPath: 'scripts/lib/review-start-claim-store.ts',
      detector: 'validateClaimStoreSource', expectedFindings: ['claim_store_second_lock_path'],
      mutate: (text, mutationId) => `${text}\nconst secondLock${mutationId.replace(/[^a-z0-9]/giu, '_')} = '.takeover';\n`,
      inspect: (text) => findingCodes(validateClaimStoreSource(text)),
    };
  }
  if (includesAny(id, ['bridge', 'powershell', 'retain-read-only', 'lifecycle-unit', 'internal-lifecycle'])) {
    const storage = includesAny(id, ['mutates', 'policy', 'locking', 'returns-policy']);
    return {
      profile: storage ? 'bridge-storage-policy' : 'bridge-direct-internal-authority',
      artifactPath: 'scripts/lib/Review-StartClaimLifecycle.ps1', detector: 'validateBridgeSource',
      expectedFindings: [storage ? 'bridge_policy_or_storage_logic' : 'bridge_not_bound_to_typescript_authority'],
      mutate: storage
        ? (text, mutationId) => `${text}\nSet-Content mutation-${mutationId} '{}'
`
        : (text, mutationId) => replaceRequired(text, "'review-start-claim-store.ts'", "'review-start-claim-cli.ts'", mutationId),
      inspect: (text) => findingCodes(validateBridgeSource(text)),
    };
  }
  return {
    profile: 'runner-internal-cli-edge', artifactPath: 'scripts/pack-review-runner.ts', detector: 'validateRunnerSource',
    expectedFindings: ['runner_missing_direct_ts_claim_authority', 'runner_claim_powershell_or_cli_edge'],
    mutate: (text, mutationId) => replaceRequired(text, "from './lib/review-start-claim-store.ts'", "from './lib/review-start-claim-cli.ts'", mutationId),
    inspect: (text) => findingCodes(validateRunnerSource(text)),
  };
}
function forbiddenReferencePlan(testSurface: boolean): MutationPlan {
  const artifactPath = testSurface ? 'scripts/review-start-claim.test.ts' : 'scripts/pack-review-runner.ts';
  return {
    profile: testSurface ? 'tracked-test-reaches-d928' : 'production-reverse-edge-to-d928', artifactPath,
    detector: 'scanForbiddenExecutableReferences',
    expectedFindings: [testSurface ? 'd928_test_or_harness_reference' : 'd928_external_executable_reference'],
    mutate: (text, id) => `${text}\nconst mutation_${id.replace(/[^a-z0-9]/giu, '_')} = 'scripts/lib/Review-StartClaim.ps1';\n`,
    inspect: (text) => findingCodes(scanForbiddenExecutableReferences([{ path: artifactPath, content: text }])),
  };
}
function receiptPlan(id: string): MutationPlan {
  let token: string = RECEIPT_TOKENS.artifact;
  let profile = 'receipt:artifact-byte-binding';
  if (includesAny(id, ['command', 'suite', 'verification'])) {
    token = RECEIPT_TOKENS.command; profile = 'receipt:command-log-binding';
  } else if (includesAny(id, ['replay', 'harness', 'operation-matrix'])) {
    token = includesAny(id, ['binding', 'input']) ? RECEIPT_TOKENS.replayBinding : RECEIPT_TOKENS.replay;
    profile = 'receipt:replay-binding';
  } else if (includesAny(id, ['candidate-build', 'candidate-binding', 'generated-before'])) {
    token = id.includes('tree') ? RECEIPT_TOKENS.candidateTree : RECEIPT_TOKENS.candidateCommit;
    profile = 'receipt:candidate-provenance';
  } else if (includesAny(id, ['928', 'historical', 'current-invariant', 'unrelated-evolution'])) {
    token = RECEIPT_TOKENS.external928; profile = 'receipt:external-928-admission';
  } else if (includesAny(id, ['tree', 'lineage'])) {
    token = RECEIPT_TOKENS.commandTree; profile = 'receipt:tree-lineage-binding';
  }
  return {
    profile, artifactPath: 'scripts/pr2a/closure-receipt.ts', detector: 'validateClosureReceiptSource',
    expectedFindings: ['closure_receipt_independent_verification_missing'],
    mutate: (text, mutationId) => replaceAllRequired(text, token, '/* removed receipt verifier */', mutationId),
    inspect: (text) => findingCodes(validateClosureReceiptSource(text)),
  };
}
function suitePlan(id: string): MutationPlan {
  const issueSuite = includesAny(id, ['lane', 'mandatory-command', 'required-suite', 'suppressed', 'reduced']);
  return {
    profile: issueSuite ? 'mandatory-issue948-suite-weakened' : 'contract-mutation-suite-removed',
    artifactPath: 'package.json', detector: 'validateMandatoryPackageScripts',
    expectedFindings: [issueSuite ? 'issue948_mandatory_suite_weakened' : 'contract_mutation_suite_removed'],
    mutate: issueSuite
      ? (text, mutationId) => replaceRequired(text, '--maxWorkers=1', '--maxWorkers=2', mutationId)
      : (text, mutationId) => replaceRequired(text, 'scripts/pr2-foundation/contract-test-runner.ts', 'scripts/pr2-foundation/contract-test-runner-removed.ts', mutationId),
    inspect: (text) => findingCodes(validateMandatoryPackageScripts(text)),
  };
}
function mutationPlan(binding: Pr2aMutationBinding): MutationPlan {
  switch (binding.ac) {
    case 'AC1': return planningPlan();
    case 'AC2': return claimPlan(binding.mutationId);
    case 'AC3': return authorityPlan(binding.mutationId);
    case 'AC4': return forbiddenReferencePlan(true);
    case 'AC5': return receiptPlan(binding.mutationId);
    case 'AC6': return forbiddenReferencePlan(false);
    case 'AC7': return includesAny(binding.mutationId, ['unsupported-platform', 'persisted-exclusion'])
      ? claimPlan(binding.mutationId) : receiptPlan(binding.mutationId);
    case 'AC8': return suitePlan(binding.mutationId);
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
function assertCatalogCoverage(): void {
  const seen = new Set<string>();
  for (const binding of PR2A_MUTATION_CATALOG) {
    const key = `${binding.ac}:${binding.mutationId}`;
    if (seen.has(key)) throw new Error(`duplicate_mutation_binding:${key}`);
    seen.add(key);
    if (mutationPlan(binding).expectedFindings.length === 0) throw new Error(`mutation_expected_finding_missing:${key}`);
  }
}
function runMutation(binding: Pr2aMutationBinding, root: string): MutationEvidence {
  const plan = mutationPlan(binding);
  const before = source(plan.artifactPath);
  const baselineFindings = plan.inspect(before);
  if (baselineFindings.length > 0) throw new Error(`mutation_precondition_failed:${binding.failingTestId}:${baselineFindings.join(',')}`);
  const file = path.join(root, `${binding.ac}-${binding.mutationId.replace(/[^a-z0-9_.-]/giu, '_')}${path.extname(plan.artifactPath) || '.txt'}`);
  writeFileSync(file, before, 'utf8');
  const artifactHashBefore = digest(before);
  const mutated = plan.mutate(before, binding.mutationId);
  if (mutated === before) throw new Error(`mutation_did_not_change_artifact:${binding.failingTestId}`);
  writeFileSync(file, mutated, 'utf8');
  const artifactHashAfter = digest(mutated);
  const observedFindings = plan.inspect(readFileSync(file, 'utf8'));
  const missing = plan.expectedFindings.filter((code) => !observedFindings.includes(code));
  if (missing.length > 0) throw new Error(`specific_failing_test_not_observed:${binding.failingTestId}:expected=${missing.join(',')}:observed=${observedFindings.join(',')}`);
  writeFileSync(file, before, 'utf8');
  const restoredHash = digest(readFileSync(file));
  if (restoredHash !== artifactHashBefore) throw new Error(`restore_hash_mismatch:${binding.failingTestId}`);
  const restoredFindings = plan.inspect(readFileSync(file, 'utf8'));
  if (restoredFindings.length > 0) throw new Error(`restored_verification_failed:${binding.failingTestId}:${restoredFindings.join(',')}`);
  return {
    ac: binding.ac, mutationId: binding.mutationId, mutationProfile: plan.profile,
    artifactPath: plan.artifactPath, detector: plan.detector, expectedFindings: [...plan.expectedFindings],
    executed: true, artifactHashBefore, artifactHashAfter, failingTestId: binding.failingTestId,
    observedFindings, negativeOutcome: 'failed', restoredHash, restoredOutcome: 'passed',
  };
}
async function main(): Promise<void> {
  assertCatalogCoverage();
  const bindings = selectedBindings(process.argv.slice(2));
  if (bindings.length === 0) throw new Error('no_mutation_bindings_selected');
  const root = mkdtempSync(path.join(tmpdir(), 'opk-pr2a-mutations-'));
  try {
    const evidence = bindings.map((binding) => runMutation(binding, root));
    process.stdout.write(`${JSON.stringify({ issue: 948, mutationEvidence: evidence,
      mutationRunner: { result: 'semantic-detector-red-green', bindings: evidence.length } })}\n`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
