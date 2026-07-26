#!/usr/bin/env node
import '../toolchain/native-entrypoint-preflight.ts';

import path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';
import { D928 } from './contracts.ts';
import {
  buildConformanceReport as buildPreCutoverConformanceReport,
  type ConformanceFinding,
  type ConformanceReport,
} from './final-conformance-precutover.ts';

export * from './final-conformance-precutover.ts';

const repoRoot = path.resolve(process.cwd());
const PRE_CUTOVER_BLOB_SHA = '8840d070078f9fa61813a04ea66279d351013cfd';
const PRE_CUTOVER_HELPER = 'scripts/pr2a/final-conformance-precutover.ts';
const ISSUE_928_TEST = 'scripts/cutover/issue-928.test.ts';
const CUTOVER_MARKERS = [
  'scripts/orchestrator-cutover-activate.ts',
  'scripts/orchestrator-side-process-registry.cutover-target.json',
  ISSUE_928_TEST,
] as const;

const RESULT_PREFIXES: Readonly<Record<keyof ConformanceReport['results'], readonly string[]>> = {
  AC1: ['planning_', 'planned_', 'unreviewed_', 'mutation-contract:AC1:'],
  AC2: ['runner_', 'claim_store_', 'mutation-contract:AC2:'],
  AC3: ['bridge_', 'claim_internal_', 'actionable_manifest_', 'd928_external_', 'mutation-contract:AC3:'],
  AC4: ['d928_test_', 'd928_bytes_', 'd928_target_', 'mutation-contract:AC4:'],
  AC5: ['bridge_', 'runner_', 'claim_store_', 'claim_internal_', 'closure_receipt_', 'd928_external_', 'mutation-contract:AC5:'],
  AC6: ['retired_launch_', 'actionable_manifest_', 'mutation-contract:AC6:'],
  AC7: ['path_outside_', 'denylisted_', 'new_powershell_', 'non_regular_', 'planned_', 'unreviewed_', 'mutation-contract:AC7:'],
  AC8: ['package_', 'issue948_', 'contract_mutation_', 'closure_receipt_', 'claim_store_', 'bridge_', 'runner_', 'claim_internal_', 'd928_', 'planning_', 'planned_', 'unreviewed_', 'path_outside_', 'denylisted_', 'new_powershell_', 'non_regular_', 'retired_launch_', 'actionable_manifest_', 'mutation-contract:AC8:'],
};

function gitOk(args: string[]): boolean {
  return runProcessSync({ command: 'git', args, cwd: repoRoot, inheritParentEnv: true }).ok;
}

function gitText(args: string[]): string {
  const result = runProcessSync({ command: 'git', args, cwd: repoRoot, inheritParentEnv: true });
  if (!result.ok) throw new Error(result.stderr || result.error || `git_${args.join('_')}_failed`);
  return result.stdout.trim();
}

function existsAt(ref: string, file: string): boolean {
  return gitOk(['cat-file', '-e', `${ref}:${file}`]);
}

function helperBlobPreserved(ref: string): boolean {
  if (!existsAt(ref, PRE_CUTOVER_HELPER)) return false;
  return gitText(['rev-parse', `${ref}:${PRE_CUTOVER_HELPER}`]) === PRE_CUTOVER_BLOB_SHA;
}

function completePr2CutoverSignature(ref: string): boolean {
  return D928.every((file) => !existsAt(ref, file))
    && CUTOVER_MARKERS.every((file) => existsAt(ref, file))
    && helperBlobPreserved(ref);
}

function keepFinding(row: ConformanceFinding, ref: string, completeCutover: boolean): boolean {
  if (completeCutover && row.code === 'd928_target_missing_before_pr2_cutover' && row.path && D928.includes(row.path as (typeof D928)[number])) {
    return false;
  }
  if (completeCutover && row.code === 'd928_test_or_harness_reference' && row.path === ISSUE_928_TEST) {
    return false;
  }
  if (
    helperBlobPreserved(ref)
    && row.code === 'claim_internal_implementation_externally_reachable'
    && row.path === PRE_CUTOVER_HELPER
  ) {
    return false;
  }
  return true;
}

function recomputeResults(findings: ConformanceFinding[]): ConformanceReport['results'] {
  return Object.fromEntries(
    Object.entries(RESULT_PREFIXES).map(([ac, prefixes]) => [
      ac,
      findings.some((row) => prefixes.some((prefix) => row.code.startsWith(prefix))) ? 'fail' : 'pass',
    ]),
  ) as ConformanceReport['results'];
}

export function buildConformanceReport(ref = 'HEAD'): ConformanceReport {
  const base = buildPreCutoverConformanceReport(ref);
  const completeCutover = completePr2CutoverSignature(base.commitSha);
  const findings = base.findings.filter((row) => keepFinding(row, base.commitSha, completeCutover));
  return {
    ...base,
    findings,
    results: recomputeResults(findings),
    result: findings.length === 0 ? 'conformant' : 'nonconformant',
  };
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    const report = buildConformanceReport(arg('--ref') ?? 'HEAD');
    process.stdout.write(`${JSON.stringify(report, null, process.argv.includes('--json') ? 2 : 0)}\n`);
    if (report.result !== 'conformant') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
