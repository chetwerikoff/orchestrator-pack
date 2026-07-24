import '../toolchain/native-entrypoint-preflight.ts';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcess, runProcessSync } from '../kernel/subprocess.ts';
import { D928, FOUNDATION_COMMIT, sha256, stableJson, type PlanningManifest } from './contracts.ts';

const FULL_SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const REGULAR_MODES = new Set(['100644', '100755']);
const REQUIRED_REFERENCE_SOURCES = [
  'scripts/check-side-process-launch-contract.ps1',
  'scripts/invoke-manual-review-run.ps1',
] as const;
const REQUIRED_LIFECYCLE_UNITS = [
  'Update-ReviewStartClaimRecordFields',
  'Invoke-ReviewStartClaimLifecycleCli',
] as const;
const DENYLIST_PREFIXES = ['vendor/', 'packages/core/', '.ao/', 'plugins/', 'prompts/', 'docs/issues_drafts/'] as const;

function normalizedManifestDigest(manifest: PlanningManifest): string {
  const copy = structuredClone(manifest);
  delete copy.digest;
  return sha256(stableJson(copy));
}

function validOperationPath(file: string): boolean {
  return file === 'package.json' || file === 'tsconfig.json' || file === 'vitest.config.ts'
    || file.startsWith('scripts/') || file.startsWith('tests/') || file.startsWith('.github/');
}

export function validatePlanningManifest(manifest: PlanningManifest): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  if (manifest.schemaVersion !== 1 || manifest.issue !== 948
    || manifest.repository !== 'chetwerikoff/orchestrator-pack'
    || manifest.result !== 'reviewed-complete-reverse-closure-plan') reasons.push('binding_result_invalid');
  if (manifest.lineage.foundationCommit !== FOUNDATION_COMMIT) reasons.push('foundation_lineage_invalid');
  if (!FULL_SHA.test(manifest.lineage.planningCommit)) reasons.push('planning_commit_invalid');
  if (!FULL_SHA.test(manifest.lineage.planningBaseTreeOid)) reasons.push('planning_tree_invalid');

  const tooling = manifest.tooling ?? {};
  if (tooling.scannerPath !== 'scripts/pr2a/closed-world-scanner.ts'
    || tooling.grammarPath !== 'scripts/pr2a/reference-grammar.json'
    || tooling.registryPath !== 'scripts/pr2a/execution-root-registry.json') reasons.push('tooling_bootstrap_scope_invalid');
  for (const key of ['scannerSha256', 'grammarSha256', 'registrySha256'] as const) {
    if (!DIGEST.test(String(tooling[key] ?? ''))) reasons.push(`planning_tooling_digest_invalid:${key}`);
  }
  if (!String(tooling.buildCommand ?? '').includes(String(tooling.scannerPath ?? ''))
    || !String(tooling.buildCommand ?? '').includes(manifest.lineage.planningCommit)) reasons.push('planning_build_command_unbound');
  if (!DIGEST.test(String(manifest.digest ?? '')) || manifest.digest !== normalizedManifestDigest(manifest)) reasons.push('planning_manifest_digest_invalid');

  if (manifest.unknown.length !== 0) reasons.push('unknown_nonempty');
  if (manifest.dynamicUnsupported.length !== 0) reasons.push('dynamic_unsupported_nonempty');

  const denominatorPaths = new Set(manifest.denominator.map((row) => row.path));
  if (denominatorPaths.size !== manifest.denominator.length) reasons.push('denominator_duplicate');
  if (!denominatorPaths.has('package.json')) reasons.push('tracked_file_omitted:package.json');
  for (const row of manifest.denominator) {
    if (!REGULAR_MODES.has(row.mode)) reasons.push(`non_regular_mode:${row.path}`);
    if (!FULL_SHA.test(row.blobSha)) reasons.push(`blob_sha_invalid:${row.path}`);
    if (!row.denominatorClass || !row.executionClass) reasons.push(`classification_missing:${row.path}`);
    if ((row.executionClass === 'root' || row.executionClass === 'reachable-helper') && row.rootChains.length === 0) reasons.push(`root_chain_missing:${row.path}`);
    if ((row.denominatorClass === 'command-bearing' || row.denominatorClass === 'reachable-code') && !row.evidence.trim()) reasons.push(`primitive_evidence_missing:${row.path}`);
    if (row.path === 'package.json' && row.denominatorClass !== 'command-bearing') reasons.push('command_bearing_misclassified:package.json');
  }

  const referenceKeys = new Set<string>();
  for (const row of manifest.references) {
    const key = `${row.source}\0${row.line}\0${row.target}`;
    if (referenceKeys.has(key)) reasons.push(`reference_duplicate:${row.source}:${row.line}`);
    referenceKeys.add(key);
    if (!denominatorPaths.has(row.source) || !denominatorPaths.has(row.target)) reasons.push(`reference_outside_denominator:${row.source}`);
    if (!row.disposition || !row.expectedFinalState || !row.rootChains.length) reasons.push(`reference_disposition_missing:${row.source}:${row.line}`);
    if (row.disposition === 'target-internal' && !(D928 as readonly string[]).includes(row.source)) reasons.push(`external_source_misreported_target_internal:${row.source}`);
  }
  for (const source of REQUIRED_REFERENCE_SOURCES) {
    if (!manifest.references.some((row) => row.source === source)) reasons.push(`required_reference_missing:${source}`);
  }

  const lifecycleKeys = new Set<string>();
  for (const row of manifest.lifecycle) {
    const key = `${row.source}\0${row.unitKind}\0${row.identity}\0${row.line}`;
    if (lifecycleKeys.has(key)) reasons.push(`lifecycle_duplicate:${row.identity}`);
    lifecycleKeys.add(key);
    if (!row.disposition || !row.legacyProtocolDisposition || !row.rolloutBoundary.trim()) reasons.push(`lifecycle_disposition_missing:${row.identity}`);
    if (row.disposition === 'retain-read-only' && (row.interprets || row.decides || row.mutates)) reasons.push(`retain_read_only_interprets:${row.identity}`);
    if (row.legacyProtocolDisposition === 'overlap-unsafe' && !/(?:quiesc|gated|single final_tree_oid|repoints every supported host)/iu.test(row.rolloutBoundary)) reasons.push(`overlap_quiescence_missing:${row.identity}`);
    if (row.legacyProtocolDisposition === 'protocol-equivalent' && !/(?:shared persisted exclusion|generation fencing|post-lock revalidation)/iu.test(row.legacyProtocolEvidence)) reasons.push(`protocol_equivalence_unproven:${row.identity}`);
    if (row.disposition === 'retire' && row.callers.length > 0) reasons.push(`unsupported_retirement_selected:${row.identity}`);
  }
  for (const identity of REQUIRED_LIFECYCLE_UNITS) {
    if (!manifest.lifecycle.some((row) => row.identity === identity)) reasons.push(`required_lifecycle_missing:${identity}`);
  }

  const operationPaths = new Set<string>();
  for (const row of manifest.plannedOperations) {
    if (operationPaths.has(row.path)) reasons.push(`planned_operation_duplicate:${row.path}`);
    operationPaths.add(row.path);
    if (!validOperationPath(row.path)) reasons.push(`path_outside_allowed_roots:${row.path}`);
    if (DENYLIST_PREFIXES.some((prefix) => row.path.startsWith(prefix))) reasons.push(`denylisted_operation:${row.path}`);
    if (row.operation === 'add' && row.path.endsWith('.ps1')) reasons.push(`new_powershell_operation:${row.path}`);
    if (!row.reason.trim()) reasons.push(`planned_operation_reason_missing:${row.path}`);
  }
  for (const target of D928) {
    if (!DIGEST.test(String(manifest.d928Sha256[target] ?? ''))) reasons.push(`d928_hash_missing:${target}`);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons: [...new Set(reasons)].sort() };
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error('usage: planning-validator.ts <manifest.json>');
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as PlanningManifest;
  const validation = validatePlanningManifest(manifest);
  if (!validation.ok) {
    process.stderr.write(`${validation.reasons.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  const parent = mkdtempSync(path.join(tmpdir(), 'opk-pr2a-plan-'));
  const checkout = path.join(parent, 'checkout');
  try {
    const add = runProcessSync({ command: 'git', args: ['worktree', 'add', '--detach', checkout, manifest.lineage.planningCommit], cwd: process.cwd(), inheritParentEnv: true });
    if (!add.ok) throw new Error(add.stderr || add.error || 'planning_worktree_add_failed');
    const recompute = await runProcess({
      command: process.execPath,
      args: ['--experimental-strip-types', 'scripts/pr2a/closed-world-scanner.ts', '--ref', 'HEAD'],
      cwd: checkout,
      inheritParentEnv: true,
      allowEmptyStdout: false,
      timeoutMs: 120_000,
    });
    if (!recompute.ok) throw new Error(recompute.stderr || recompute.error || 'planning_recompute_failed');
    const rebuilt = JSON.parse(recompute.stdout) as PlanningManifest;
    const withoutDigest = (value: PlanningManifest) => {
      const copy = structuredClone(value);
      delete copy.digest;
      return copy;
    };
    if (stableJson(withoutDigest(rebuilt)) !== stableJson(withoutDigest(manifest))) {
      process.stderr.write('planning_manifest_recompute_mismatch\n');
      process.exitCode = 1;
    }
  } finally {
    runProcessSync({ command: 'git', args: ['worktree', 'remove', '--force', checkout], cwd: process.cwd(), inheritParentEnv: true });
    rmSync(parent, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
