#!/usr/bin/env node
import '../toolchain/native-entrypoint-preflight.ts';

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';
import {
  DENYLIST,
  D928,
  FOUNDATION_COMMIT,
  normalizeRepoPath,
  type PlanningManifest,
} from './contracts.ts';

export interface ConformanceFinding {
  code: string;
  path?: string;
  detail?: string;
}

export interface ConformanceReport {
  schemaVersion: 1;
  issue: 948;
  ref: string;
  commitSha: string;
  finalTreeOid: string;
  planningCommit: string;
  planningBarrierCommit: string;
  planningBaseTreeOid: string;
  changedPaths: string[];
  findings: ConformanceFinding[];
  results: {
    AC1: 'pass' | 'fail';
    AC2: 'pass' | 'fail';
    AC3: 'pass' | 'fail';
    AC4: 'pass' | 'fail';
    AC5: 'pass' | 'fail';
    AC6: 'pass' | 'fail';
    AC7: 'pass' | 'fail';
    AC8: 'pass' | 'fail';
  };
  result: 'conformant' | 'nonconformant';
}

interface DiffRow {
  status: string;
  path: string;
  operation: 'add' | 'modify' | 'delete';
}

const repoRoot = path.resolve(process.cwd());
const planningPath = 'scripts/pr2a/planning-manifest.json';
const executableExtensions = new Set(['.ps1', '.psm1', '.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.sh', '.yml', '.yaml']);
const liveReferenceManifests = [
  'scripts/orchestrator-escalation-emitter-inventory.json',
  'scripts/orchestrator-message-audit-roots.manifest.json',
  'scripts/orchestrator-message-owner-mechanisms.manifest.json',
  'scripts/orchestrator-message-protected-runtime.manifest.json',
  'scripts/fixtures/mechanical-json-state/state-coverage-manifest.json',
  'scripts/vitest-live-store-inventory.json',
] as const;

function git(args: string[], allowExitOne = false): string {
  const result = runProcessSync({
    command: 'git',
    args,
    cwd: repoRoot,
    inheritParentEnv: true,
  });
  if (!result.ok && !(allowExitOne && result.exitCode === 1)) {
    throw new Error(result.stderr || result.error || `git_${args.join('_')}_failed`);
  }
  return result.stdout;
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function readAt(ref: string, file: string): string {
  return git(['show', `${ref}:${file}`]);
}

function existsAt(ref: string, file: string): boolean {
  const result = runProcessSync({
    command: 'git', args: ['cat-file', '-e', `${ref}:${file}`], cwd: repoRoot,
    inheritParentEnv: true,
  });
  return result.ok;
}

function listPaths(ref: string): string[] {
  return git(['ls-tree', '-r', '--name-only', ref]).split(/\r?\n/u).filter(Boolean).map(normalizeRepoPath);
}

function diffRows(base: string, ref: string): DiffRow[] {
  return git(['diff', '--name-status', '--no-renames', base, ref]).split(/\r?\n/u).filter(Boolean).map((line) => {
    const [status = '', ...parts] = line.split('\t');
    const file = normalizeRepoPath(parts.join('\t'));
    const operation = status === 'A' ? 'add' : status === 'D' ? 'delete' : 'modify';
    return { status, path: file, operation };
  });
}

function allowedRoot(file: string): boolean {
  return file === 'package.json' || file === 'tsconfig.json' || file === 'vitest.config.ts'
    || file.startsWith('scripts/') || file.startsWith('tests/') || file.startsWith('.github/');
}

function denylisted(file: string): boolean {
  return (DENYLIST as readonly string[]).some((entry) => entry.endsWith('/') ? file.startsWith(entry) : file === entry);
}

function governanceReference(file: string): boolean {
  return (D928 as readonly string[]).includes(file)
    || file.startsWith('scripts/pr2a/')
    || file.startsWith('scripts/estate-cut/')
    || file === 'scripts/pr2-foundation/contracts.ts'
    || file === 'scripts/pr2-foundation/mutation-catalog.ts'
    || file === 'scripts/pr2-foundation/mutation-behavior-probes.ts'
    || file === 'scripts/pr2-foundation/mutation-semantic-gates.ts'
    || file === 'scripts/lib/orchestrator-side-process-observer.ts'
    || file === 'docs/launch-argv-registry.mjs'
    || file === 'docs/orchestrator-message-registry.mjs'
    || file === 'docs/review-start-preflight-shield.mjs';
}

function testOrHarness(file: string): boolean {
  return /(?:^|\/)(?:fixtures?|tests?)(?:\/|$)/iu.test(file)
    || /(?:\.test\.|\.spec\.|Tests\.ps1$|\.shared\.|test-helpers?\.|test-setup\.)/iu.test(file);
}

export function scanForbiddenExecutableReferences(
  files: Array<{ path: string; content: string }>,
): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  const basenames = D928.map((file) => path.posix.basename(file));
  for (const row of files) {
    if (!executableExtensions.has(path.posix.extname(row.path).toLowerCase())) continue;
    const matched = basenames.filter((name) => row.content.includes(name));
    if (matched.length === 0) continue;
    if (testOrHarness(row.path) && !row.path.startsWith('scripts/pr2a/')) {
      findings.push({ code: 'd928_test_or_harness_reference', path: row.path, detail: matched.join(',') });
      continue;
    }
    if (!governanceReference(row.path)) {
      findings.push({ code: 'd928_external_executable_reference', path: row.path, detail: matched.join(',') });
    }
  }
  return findings;
}

export function validateBridgeSource(source: string): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  const forbidden = [
    'Set-Content', 'Add-Content', 'Remove-Item', 'Move-Item', 'Copy-Item', 'New-Item',
    '[System.IO.File]', 'Review-StartClaim.ps1', 'review-start-claim-reaper.ps1',
  ];
  for (const token of forbidden) {
    if (source.includes(token)) findings.push({ code: 'bridge_policy_or_storage_logic', path: 'scripts/lib/Review-StartClaimLifecycle.ps1', detail: token });
  }
  if (!source.includes('review-start-claim-cli.ts') || !source.includes('Invoke-ReviewStartClaimTsOperation')) {
    findings.push({ code: 'bridge_not_bound_to_typed_cli', path: 'scripts/lib/Review-StartClaimLifecycle.ps1' });
  }
  if ((source.match(/function\s+Invoke-ReviewStartClaimTsOperation/gu) ?? []).length !== 1) {
    findings.push({ code: 'bridge_transport_gateway_not_unique', path: 'scripts/lib/Review-StartClaimLifecycle.ps1' });
  }
  return findings;
}

export function validateRunnerSource(source: string): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  if (!source.includes("from './lib/review-start-claim-store.ts'") || !source.includes('acquireReviewStartClaim(')) {
    findings.push({ code: 'runner_missing_direct_ts_claim_authority', path: 'scripts/pack-review-runner.ts' });
  }
  for (const forbidden of ['Review-StartClaim.ps1', 'Review-StartClaimLifecycle.ps1', 'review-start-claim-cli.ts']) {
    if (source.includes(forbidden)) findings.push({ code: 'runner_claim_powershell_or_cli_edge', path: 'scripts/pack-review-runner.ts', detail: forbidden });
  }
  const start = source.indexOf('async function acquireClaimLease');
  const end = start >= 0 ? source.indexOf('\nasync function ', start + 1) : -1;
  const block = start >= 0 ? source.slice(start, end > start ? end : source.length) : '';
  if (!block || /\bpwsh\b|spawn\s*\(|execFile\s*\(/iu.test(block)) {
    findings.push({ code: 'runner_claim_path_spawns_process', path: 'scripts/pack-review-runner.ts' });
  }
  return findings;
}

function validateOperationSet(manifest: PlanningManifest, rows: DiffRow[]): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  const expected = new Map(manifest.plannedOperations.map((row) => [row.path, row.operation]));
  const actual = new Map(rows.map((row) => [row.path, row.operation]));
  for (const [file, operation] of expected) {
    if (actual.get(file) !== operation) {
      findings.push({ code: 'planned_operation_missing_or_changed', path: file, detail: `expected=${operation};actual=${actual.get(file) ?? 'none'}` });
    }
  }
  for (const [file, operation] of actual) {
    if (!expected.has(file)) findings.push({ code: 'unreviewed_final_tree_operation', path: file, detail: operation });
  }
  return findings;
}

function validateDiffPolicy(rows: DiffRow[], ref: string): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  for (const row of rows) {
    if (!allowedRoot(row.path)) findings.push({ code: 'path_outside_allowed_roots', path: row.path });
    if (denylisted(row.path)) findings.push({ code: 'denylisted_path_changed', path: row.path });
    if (row.operation === 'add' && row.path.endsWith('.ps1')) findings.push({ code: 'new_powershell_logic_added', path: row.path });
    if (row.operation !== 'delete') {
      const mode = git(['ls-tree', ref, '--', row.path]).trim().split(/\s+/u)[0] ?? '';
      if (!['100644', '100755'].includes(mode)) findings.push({ code: 'non_regular_final_tree_mode', path: row.path, detail: mode });
    }
  }
  return findings;
}

function validateLiveManifests(ref: string): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  const basenames = D928.map((file) => path.posix.basename(file));
  for (const file of liveReferenceManifests) {
    const source = readAt(ref, file);
    for (const basename of basenames) {
      if (source.includes(basename)) findings.push({ code: 'actionable_manifest_retains_d928', path: file, detail: basename });
    }
  }
  return findings;
}

function acResult(findings: ConformanceFinding[], codes: string[]): 'pass' | 'fail' {
  return findings.some((row) => codes.some((code) => row.code.startsWith(code))) ? 'fail' : 'pass';
}

export function buildConformanceReport(ref = 'HEAD'): ConformanceReport {
  const commitSha = git(['rev-parse', `${ref}^{commit}`]).trim();
  const finalTreeOid = git(['rev-parse', `${ref}^{tree}`]).trim();
  const manifest = JSON.parse(readAt(ref, planningPath)) as PlanningManifest;
  const planningBarrierCommit = git(['log', '-1', '--format=%H', ref, '--', planningPath]).trim();
  const rows = diffRows(planningBarrierCommit, ref);
  const findings: ConformanceFinding[] = [];

  if (manifest.issue !== 948 || manifest.lineage.foundationCommit !== FOUNDATION_COMMIT) findings.push({ code: 'planning_lineage_invalid' });
  if (git(['rev-parse', `${manifest.lineage.planningCommit}^{tree}`]).trim() !== manifest.lineage.planningBaseTreeOid) {
    findings.push({ code: 'planning_tree_binding_mismatch' });
  }
  findings.push(...validateOperationSet(manifest, rows));
  findings.push(...validateDiffPolicy(rows, ref));

  for (const target of D928) {
    if (!existsAt(ref, target)) {
      findings.push({ code: 'd928_target_missing_before_pr2_cutover', path: target });
      continue;
    }
    const digest = sha256(readAt(ref, target));
    if (digest !== manifest.d928Sha256[target]) findings.push({ code: 'd928_bytes_changed', path: target, detail: digest });
  }

  const tracked = listPaths(ref);
  const executableRows = tracked
    .filter((file) => executableExtensions.has(path.posix.extname(file).toLowerCase()))
    .map((file) => ({ path: file, content: readAt(ref, file) }));
  findings.push(...scanForbiddenExecutableReferences(executableRows));
  findings.push(...validateLiveManifests(ref));
  findings.push(...validateBridgeSource(readAt(ref, 'scripts/lib/Review-StartClaimLifecycle.ps1')));
  findings.push(...validateRunnerSource(readAt(ref, 'scripts/pack-review-runner.ts')));

  if (existsAt(ref, 'scripts/check-side-process-launch-contract.ps1')) findings.push({ code: 'retired_launch_contract_guard_present' });
  const verify = readAt(ref, 'scripts/verify.ps1');
  if (verify.includes('check-side-process-launch-contract.ps1') || verify.includes('side-process launch contract')) {
    findings.push({ code: 'retired_launch_contract_verify_block_present', path: 'scripts/verify.ps1' });
  }
  const bridge = readAt(ref, 'scripts/lib/Review-StartClaimLifecycle.ps1');
  if (bridge.includes('function Acquire-ReviewStartClaim') && !bridge.includes("Invoke-ReviewStartClaimTsOperation 'Acquire-ReviewStartClaim'")) {
    findings.push({ code: 'bridge_claim_authority_not_delegated' });
  }

  const results = {
    AC1: acResult(findings, ['planning_', 'planned_', 'unreviewed_']),
    AC2: acResult(findings, ['runner_']),
    AC3: acResult(findings, ['bridge_', 'actionable_manifest_', 'd928_external_']),
    AC4: acResult(findings, ['d928_test_', 'd928_bytes_', 'd928_target_']),
    AC5: acResult(findings, ['bridge_', 'runner_', 'd928_external_']),
    AC6: acResult(findings, ['retired_launch_', 'actionable_manifest_']),
    AC7: acResult(findings, ['path_outside_', 'denylisted_', 'new_powershell_', 'non_regular_', 'planned_', 'unreviewed_']),
    AC8: findings.length === 0 ? 'pass' as const : 'fail' as const,
  };
  return {
    schemaVersion: 1,
    issue: 948,
    ref,
    commitSha,
    finalTreeOid,
    planningCommit: manifest.lineage.planningCommit,
    planningBarrierCommit,
    planningBaseTreeOid: manifest.lineage.planningBaseTreeOid,
    changedPaths: rows.map((row) => row.path),
    findings,
    results,
    result: findings.length === 0 ? 'conformant' : 'nonconformant',
  };
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    if (!existsSync(path.join(repoRoot, planningPath))) throw new Error('planning_manifest_missing');
    const report = buildConformanceReport(arg('--ref') ?? 'HEAD');
    process.stdout.write(`${JSON.stringify(report, null, process.argv.includes('--json') ? 2 : 0)}\n`);
    if (report.result !== 'conformant') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
