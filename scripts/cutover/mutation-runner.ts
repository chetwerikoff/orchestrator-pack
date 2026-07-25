#!/usr/bin/env -S node --experimental-strip-types
import '../toolchain/native-entrypoint-preflight.ts';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';

type Ac = 'AC1' | 'AC2' | 'AC3' | 'AC4' | 'AC5' | 'AC6' | 'AC7' | 'AC8';
interface Spec { path: string; token: string; replacement: string; testName: string; }
const SPECS: Record<Ac, Spec> = {
  AC1: { path: 'scripts/lib/cutover/stable-stringify.ts', token: 'Object.keys(record).sort()', replacement: 'Object.keys(record)', testName: 'AC1 validates Node22 platform and canonical stable-stringify vectors' },
  AC2: { path: 'scripts/lib/cutover/activation-registry-projection.ts', token: 'value.children.length !== 1', replacement: 'value.children.length < 1', testName: 'AC2 accepts exactly the scheduler-only target registry' },
  AC3: { path: 'scripts/lib/cutover/activation-import.ts', token: "if (unknown.length) throw new Error(`store_unknown_field:${storeId}:${unknown.sort().join(',')}`);", replacement: 'if (false && unknown.length) throw new Error(`store_unknown_field:${storeId}`);', testName: 'AC3 imports the three closed store shapes idempotently and rejects unknown fields' },
  AC4: { path: 'scripts/lib/cutover/activation-transaction.ts', token: "activation: { result: 'C1-C18-ts-transfer-pass' },", replacement: "activation: { result: 'BROKEN' as 'C1-C18-ts-transfer-pass' },", testName: 'AC4 rehearses cordon -> drain -> import -> projection -> CAS -> TypeScript ownership' },
  AC5: { path: 'scripts/lib/cutover/activation-epoch-authority.ts', token: "if (core.nonce !== nonce) throw new Error('epoch_nonce_mismatch');", replacement: "if (false) throw new Error('epoch_nonce_mismatch');", testName: 'AC5 central CAS is single-commit and nonce fenced' },
  AC6: { path: 'scripts/pr2-foundation/scheduler.ts', token: 'const core = new JsonEpochAuthority(options.epochAuthorityFile).require(options.epochId, options.nonce);', replacement: 'const core = new JsonEpochAuthority(options.epochAuthorityFile).get(options.epochId)!;', testName: 'AC6 scheduler refuses stale epoch/nonce before attempting work' },
  AC7: { path: 'scripts/orchestrator-wake-supervisor.ts', token: "import './toolchain/native-entrypoint-preflight.ts';", replacement: "import './toolchain/native-entrypoint-preflight.ts';\n// mutation pwsh dispatch marker", testName: 'AC7 merged revision has exactly four required PowerShell deletions and no pwsh dispatch in replacement production paths' },
  AC8: { path: 'scripts/orchestrator-side-process-registry.cutover-target.json', token: '"script": "pr2-foundation/scheduler.ts"', replacement: '"script": "review-trigger-reconcile.ps1"', testName: 'AC8 target registry remains staged and tracked live registry is not the scheduler-only projection' },
};

const digest = (value: string | Buffer): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function selected(): Ac[] {
  const index = process.argv.indexOf('--ac');
  if (index >= 0) {
    const ac = process.argv[index + 1] as Ac | undefined;
    if (!ac || !(ac in SPECS)) throw new Error('invalid_ac');
    return [ac];
  }
  if (process.argv.includes('--all')) return Object.keys(SPECS) as Ac[];
  throw new Error('expected_--ac_or_--all');
}

function runTest(root: string, testName: string): { ok: boolean; exitCode: number; output: string } {
  const previousHarness = process.env.OPK_VITEST_HARNESS;
  const previousNested = process.env.OPK_CONTRACT_MUTATIONS_ALREADY_RUN;
  process.env.OPK_VITEST_HARNESS = '1';
  process.env.OPK_CONTRACT_MUTATIONS_ALREADY_RUN = '1';
  try {
    const result = runProcessSync({
      command: process.execPath,
      args: [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', resolve(root, 'vitest.config.ts'), resolve(root, 'scripts/cutover/issue-928.test.ts'), '--testNamePattern', testName],
      cwd: root,
      inheritParentEnv: true,
    });
    return { ok: result.ok, exitCode: result.exitCode ?? (result.ok ? 0 : 1), output: `${result.stdout}\n${result.stderr}` };
  } finally {
    if (previousHarness === undefined) delete process.env.OPK_VITEST_HARNESS;
    else process.env.OPK_VITEST_HARNESS = previousHarness;
    if (previousNested === undefined) delete process.env.OPK_CONTRACT_MUTATIONS_ALREADY_RUN;
    else process.env.OPK_CONTRACT_MUTATIONS_ALREADY_RUN = previousNested;
  }
}

function main(): void {
  const repoRoot = resolve('.');
  const parent = mkdtempSync(join(tmpdir(), 'opk-928-mutations-'));
  const checkout = join(parent, 'checkout');
  let added = false;
  try {
    const add = runProcessSync({ command: 'git', args: ['worktree', 'add', '--detach', checkout, 'HEAD'], cwd: repoRoot, inheritParentEnv: true });
    if (!add.ok) throw new Error(add.stderr || add.error || 'mutation_worktree_add_failed');
    added = true;
    const installedModules = resolve(repoRoot, 'node_modules');
    if (!existsSync(installedModules)) throw new Error('mutation_node_modules_missing');
    symlinkSync(installedModules, join(checkout, 'node_modules'), 'dir');
    const evidence = [];
    for (const ac of selected()) {
      const spec = SPECS[ac];
      const file = join(checkout, spec.path);
      const before = readFileSync(file, 'utf8');
      if (!before.includes(spec.token)) throw new Error(`mutation_token_missing:${ac}:${spec.path}`);
      const baseline = runTest(checkout, spec.testName);
      if (!baseline.ok) throw new Error(`mutation_baseline_red:${ac}:${baseline.output}`);
      const mutated = before.replace(spec.token, spec.replacement);
      writeFileSync(file, mutated, 'utf8');
      const negative = runTest(checkout, spec.testName);
      if (negative.ok) throw new Error(`mutation_not_red:${ac}`);
      writeFileSync(file, before, 'utf8');
      const restored = runTest(checkout, spec.testName);
      if (!restored.ok) throw new Error(`mutation_restore_not_green:${ac}:${restored.output}`);
      evidence.push({
        ac,
        mutationId: `issue-928-${ac.toLowerCase()}`,
        artifactPath: spec.path,
        detectorId: spec.testName,
        artifactHashBefore: digest(before),
        artifactHashAfter: digest(mutated),
        restoredHash: digest(readFileSync(file)),
        negativeOutcome: 'red',
        restoredOutcome: 'green',
        negativeExitCode: negative.exitCode,
        restoredExitCode: restored.exitCode,
        executed: true,
      });
    }
    process.stdout.write(`${JSON.stringify({ issue: 928, mutationEvidence: evidence, mutationRunner: { result: 'externally-grounded', bindings: evidence.length } })}\n`);
  } finally {
    if (added) runProcessSync({ command: 'git', args: ['worktree', 'remove', '--force', checkout], cwd: repoRoot, inheritParentEnv: true });
    rmSync(parent, { recursive: true, force: true });
  }
}

try { main(); } catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
