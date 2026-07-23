import '../toolchain/native-entrypoint-preflight.ts';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcess } from '../kernel/subprocess.ts';
import { runProcessSync } from '../kernel/subprocess.mjs';
import { D928, stableJson, type PlanningManifest } from './contracts.ts';

export function validatePlanningManifest(manifest: PlanningManifest): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  if (manifest.issue !== 948 || manifest.result !== 'reviewed-complete-reverse-closure-plan') reasons.push('binding_result_invalid');
  if (!/^[0-9a-f]{40}$/u.test(manifest.lineage.planningCommit)) reasons.push('planning_commit_invalid');
  if (!/^[0-9a-f]{40}$/u.test(manifest.lineage.planningBaseTreeOid)) reasons.push('planning_tree_invalid');
  if (manifest.unknown.length !== 0) reasons.push('unknown_nonempty');
  if (manifest.dynamicUnsupported.length !== 0) reasons.push('dynamic_unsupported_nonempty');
  const denominatorPaths = new Set(manifest.denominator.map((row) => row.path));
  if (denominatorPaths.size !== manifest.denominator.length) reasons.push('denominator_duplicate');
  for (const row of manifest.denominator) {
    if (!row.denominatorClass || !row.executionClass) reasons.push(`classification_missing:${row.path}`);
    if ((row.executionClass === 'root' || row.executionClass === 'reachable-helper') && row.rootChains.length === 0) reasons.push(`root_chain_missing:${row.path}`);
  }
  for (const row of manifest.references) {
    if (!denominatorPaths.has(row.source) || !denominatorPaths.has(row.target)) reasons.push(`reference_outside_denominator:${row.source}`);
    if (!row.disposition || !row.expectedFinalState) reasons.push(`reference_disposition_missing:${row.source}:${row.line}`);
  }
  for (const row of manifest.lifecycle) {
    if (!row.disposition || !row.legacyProtocolDisposition || !row.rolloutBoundary) reasons.push(`lifecycle_disposition_missing:${row.identity}`);
    if (row.disposition === 'retain-read-only' && (row.interprets || row.decides || row.mutates)) reasons.push(`retain_read_only_interprets:${row.identity}`);
  }
  for (const target of D928) if (!manifest.d928Sha256[target]) reasons.push(`d928_hash_missing:${target}`);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
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
    const add = runProcessSync({
      command: 'git',
      args: ['worktree', 'add', '--detach', checkout, manifest.lineage.planningCommit],
      cwd: process.cwd(),
      inheritParentEnv: true,
    });
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
