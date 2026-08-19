#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runProcess, type ProcessResult } from './kernel/subprocess.ts';
import {
  applyOpkVitestHarnessEnv,
  cleanupHarnessRoot,
  createHarnessRoot,
} from './lib/vitest-live-store-harness.mjs';
import {
  cleanupHeavyShardFleet,
  observeHeavyShardFleet,
} from './lib/testmode-fleet-lane.ts';

const RPC_FLAKE = /onTaskUpdate.*(?:RPC|timeout)|vitest-worker.*onTaskUpdate|STACK_TRACE_ERROR/isu;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const NODE = process.execPath;
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

interface LightShardPlan {
  readonly lightMaxWorkers: number;
  readonly lightShardCount: number;
  readonly light: readonly string[];
  readonly shard?: number;
  readonly totalRuntimeMs?: number;
  readonly lightShards?: readonly { shard: number }[];
}
interface HeavyShardPlan { readonly shard: number; readonly files: readonly string[]; readonly totalRuntimeMs: number }
interface WallclockPlan { readonly files: readonly string[] }
interface HeavyFileRunPlan { readonly mode: 'file' | 'tests'; readonly pool: string; readonly tests?: readonly string[]; readonly batchable?: boolean }
interface HeavyMember { readonly kind: 'file' | 'test'; readonly file: string; readonly pool: string; readonly label: string; readonly testPattern?: string }
interface HeavyInvocation { readonly label: string; readonly pool: string; readonly files: readonly string[]; readonly testPattern?: string; readonly members: readonly HeavyMember[] }

export interface AggregateInputs {
  readonly typecheckResult: string;
  readonly vitestLightResult: string;
  readonly vitestHeavyResult: string;
  readonly contractResult: string;
  readonly topologyResult: string;
  readonly headSha: string;
  readonly runId: string;
}

function envWithHarness(): { env: NodeJS.ProcessEnv; root: string } {
  const root = createHarnessRoot();
  const env: NodeJS.ProcessEnv = { ...process.env };
  applyOpkVitestHarnessEnv(root, env);
  env.OPK_VITEST_REENTRY_HARNESS_ROOT = root;
  env.OPK_TESTMODE_LEASE_ROOT = path.join(root, 'state', 'testmode-fleet-leases');
  env.OPK_TESTMODE_FLEET_WORKSPACE_ROOT = ROOT;
  env.CI = 'true';
  return { env, root };
}

function printResult(result: ProcessResult): void {
  if (result.stdout) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  if (result.stderr) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
}

async function child(command: string, args: readonly string[], env: Readonly<NodeJS.ProcessEnv>, timeoutMs?: number): Promise<ProcessResult> {
  const result = await runProcess({ command, args, cwd: ROOT, env, inheritParentEnv: false, allowEmptyStdout: true, ...(timeoutMs ? { timeoutMs } : {}) });
  printResult(result);
  return result;
}

async function jsonNode<T>(script: string, args: readonly string[], env: Readonly<NodeJS.ProcessEnv>): Promise<T> {
  const result = await runProcess({ command: NODE, args: [path.join(ROOT, script), ...args], cwd: ROOT, env, inheritParentEnv: false, allowEmptyStdout: false });
  if (!result.ok) {
    printResult(result);
    throw new Error(`${script} failed (${result.exitCode ?? result.outcome})`);
  }
  try { return JSON.parse(result.stdout) as T; }
  catch { throw new Error(`${script} returned malformed JSON`); }
}

async function nodeText(script: string, args: readonly string[], env: Readonly<NodeJS.ProcessEnv>): Promise<{ ok: boolean; text: string; result: ProcessResult }> {
  const result = await runProcess({ command: NODE, args: [path.join(ROOT, script), ...args], cwd: ROOT, env, inheritParentEnv: false, allowEmptyStdout: true });
  if (!result.ok) printResult(result);
  return { ok: result.ok, text: result.stdout.trim(), result };
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? '');
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function reportPath(name: string): string { return path.join(ROOT, name); }
function removeIfPresent(file: string): void { if (existsSync(file)) rmSync(file, { force: true }); }
function elapsedSeconds(started: number): number { return Math.round(((Date.now() - started) / 1000) * 100) / 100; }

async function runBudget(report: string, env: Readonly<NodeJS.ProcessEnv>): Promise<boolean> {
  const result = await child(NODE, [path.join(ROOT, 'scripts/enforce-vitest-runtime-budget.mjs'), report], env);
  return result.ok;
}

async function runNpmTest(args: readonly string[], env: Readonly<NodeJS.ProcessEnv>): Promise<ProcessResult> {
  return child(NPM, ['test', '--', ...args], env);
}

export function aggregateFailures(input: AggregateInputs): readonly string[] {
  const failures: string[] = [];
  const check = (name: string, result: string): void => {
    if (!result) failures.push(`${name} result missing`);
    else if (result === 'success') return;
    else if (result === 'skipped') failures.push(`${name} unexpectedly skipped`);
    else if (result === 'cancelled') failures.push(`${name} cancelled`);
    else if (result === 'failure') failures.push(`${name} failed`);
    else failures.push(`${name} inconclusive (${result})`);
  };
  if (!input.headSha) failures.push('GITHUB_SHA missing (current-head binding)');
  if (!input.runId) failures.push('GITHUB_RUN_ID missing (current-run binding)');
  check('typecheck', input.typecheckResult);
  check('vitest-light', input.vitestLightResult);
  check('vitest-heavy-shards', input.vitestHeavyResult);
  check('vitest-contracts', input.contractResult);
  check('vitest-topology-plan', input.topologyResult);
  return failures;
}

export function aggregateFromEnv(env: Readonly<NodeJS.ProcessEnv> = process.env): AggregateInputs {
  return {
    typecheckResult: String(env.TYPECHECK_RESULT ?? ''),
    vitestLightResult: String(env.VITEST_LIGHT_RESULT ?? ''),
    vitestHeavyResult: String(env.VITEST_HEAVY_RESULT ?? ''),
    contractResult: String(env.VITEST_CONTRACT_RESULT ?? env.PESTER_RESULT ?? ''),
    topologyResult: String(env.VITEST_TOPOLOGY_PLAN_RESULT ?? ''),
    headSha: String(env.GITHUB_SHA ?? ''),
    runId: String(env.GITHUB_RUN_ID ?? ''),
  };
}

async function runAggregate(env: Readonly<NodeJS.ProcessEnv>): Promise<number> {
  const input = aggregateFromEnv(env);
  const failures = aggregateFailures(input);
  if (failures.length > 0) {
    process.stdout.write('[FAIL] full-regression aggregate:\n');
    for (const item of failures) process.stdout.write(` - ${item}\n`);
    return 1;
  }
  process.stdout.write(`[PASS] full-regression aggregate sha=${input.headSha} run=${input.runId}\n`);
  return 0;
}

async function runLightShard(plan: LightShardPlan, shard: number, total: number, env: NodeJS.ProcessEnv): Promise<number> {
  if (plan.light.length === 0) {
    process.stdout.write(`[PASS] Vitest light lane shard=${shard}/${total}: no classified light files\n`);
    return 0;
  }
  const report = reportPath(`.vitest-runtime-report-light-${shard}.json`);
  removeIfPresent(report);
  env.VITEST_CI_LIGHT_LANE = '1';
  env.VITEST_LIGHT_MAX_WORKERS = String(plan.lightMaxWorkers);
  env.VITEST_LIGHT_SHARD = String(shard);
  delete env.VITEST_CI_HEAVY_LANE;
  const started = Date.now();
  const result = await runNpmTest([...plan.light, '--reporter=default', '--reporter=json', `--outputFile=${report}`], env);
  const combined = `${result.stdout}\n${result.stderr}`;
  if (RPC_FLAKE.test(combined)) {
    process.stdout.write(`[FAIL] Vitest worker RPC flake signature detected in light lane shard=${shard}/${total}\n`);
    return 1;
  }
  if (!result.ok) return result.exitCode ?? 1;
  if (!existsSync(report)) {
    process.stdout.write(`[FAIL] Vitest runtime report missing for light lane shard=${shard}/${total}\n`);
    return 1;
  }
  if (!await runBudget(report, env)) {
    process.stdout.write(`[FAIL] Vitest runtime budget exceeded in light lane shard=${shard}/${total}\n`);
    return 1;
  }
  process.stdout.write(`vitest-lane-timing lane=light shard=${shard}/${total} files=${plan.light.length} workers=${plan.lightMaxWorkers} elapsed_sec=${elapsedSeconds(started)}\n`);
  return 0;
}

async function runLight(shard: number, env: NodeJS.ProcessEnv): Promise<number> {
  if (shard > 0) {
    const plan = await jsonNode<LightShardPlan>('scripts/invoke-vitest-ci-lane-plan.mjs', ['light', '--shard', String(shard)], env);
    return runLightShard(plan, Number(plan.shard ?? shard), Number(plan.lightShardCount ?? 1), env);
  }
  const plan = await jsonNode<LightShardPlan>('scripts/invoke-vitest-ci-lane-plan.mjs', ['light'], env);
  const shards = plan.lightShards ?? [];
  if (shards.length > 1) {
    for (const entry of shards) {
      const shardPlan = await jsonNode<LightShardPlan>('scripts/invoke-vitest-ci-lane-plan.mjs', ['light', '--shard', String(entry.shard)], env);
      const code = await runLightShard(shardPlan, entry.shard, Number(shardPlan.lightShardCount ?? shards.length), env);
      if (code !== 0) return code;
    }
    return 0;
  }
  return runLightShard(plan, 1, 1, env);
}

function buildHeavyInvocations(files: readonly string[], plans: ReadonlyMap<string, HeavyFileRunPlan>, batchSize: number): HeavyInvocation[] {
  const invocations: HeavyInvocation[] = [];
  let open: HeavyMember[] = [];
  let openPool = '';
  const flush = (): void => {
    if (open.length === 0) return;
    const files = [...new Set(open.map((member) => member.file))];
    invocations.push({
      label: open.length === 1 ? open[0]!.label : `batch(${open.length}): ${open.map((member) => member.label).join(', ')}`,
      pool: openPool,
      files,
      ...(open.length === 1 && open[0]!.testPattern ? { testPattern: open[0]!.testPattern } : {}),
      members: [...open],
    });
    open = []; openPool = '';
  };
  for (const file of files) {
    const plan = plans.get(file);
    if (!plan) throw new Error(`missing heavy run plan for ${file}`);
    if (plan.mode === 'tests') {
      flush();
      for (const title of plan.tests ?? []) {
        const member: HeavyMember = { kind: 'test', file, pool: plan.pool, label: `${file} > ${title}`, testPattern: title };
        invocations.push({ label: member.label, pool: plan.pool, files: [file], testPattern: title, members: [member] });
      }
      continue;
    }
    const member: HeavyMember = { kind: 'file', file, pool: plan.pool, label: file };
    if (plan.batchable === false) {
      flush(); invocations.push({ label: file, pool: plan.pool, files: [file], members: [member] }); continue;
    }
    if (open.length === 0) { openPool = plan.pool; open = [member]; }
    else if (openPool === plan.pool && open.length < batchSize) open.push(member);
    else { flush(); openPool = plan.pool; open = [member]; }
  }
  flush();
  return invocations;
}

async function jsonReportPredicate(command: 'has-failed-tests' | 'is-clean', report: string, env: Readonly<NodeJS.ProcessEnv>): Promise<boolean> {
  const result = await nodeText('scripts/lib/vitest-json-report.mjs', [command, report], env);
  if (!result.ok) throw new Error(`vitest_json_report_${command}_failed`);
  return result.text === '1';
}

async function validateHeavyReport(invocation: HeavyInvocation, report: string, env: Readonly<NodeJS.ProcessEnv>): Promise<boolean> {
  const planned = JSON.stringify({ members: invocation.members });
  const result = await child(NODE, [path.join(ROOT, 'scripts/lib/vitest-heavy-batching.mjs'), 'validate-report', '--report', report, '--repo-root', ROOT, '--planned-json', planned], env);
  return result.ok;
}

async function cleanupShard(shard: number, env: NodeJS.ProcessEnv): Promise<void> {
  const results = await cleanupHeavyShardFleet(shard, env);
  for (const result of results) {
    if (!result.ok) process.stderr.write(`[WARN] heavy shard cleanup lease failed reason=${result.reason ?? 'survivor'} survivors=${result.survivors.join(',')}\n`);
  }
}

async function runHeavy(shard: number, env: NodeJS.ProcessEnv): Promise<number> {
  if (shard <= 0) throw new Error('heavy mode requires --shard <n>');
  env.VITEST_CI_HEAVY_LANE = '1'; env.VITEST_HEAVY_SHARD = String(shard); delete env.VITEST_CI_LIGHT_LANE;
  const plan = await jsonNode<HeavyShardPlan>('scripts/invoke-vitest-ci-lane-plan.mjs', ['heavy', '--shard', String(shard)], env);
  if (plan.files.length === 0) {
    process.stdout.write(`[PASS] Vitest heavy shard ${shard}: no files assigned\n`);
    return 0;
  }
  const finalReport = reportPath(`.vitest-runtime-report-heavy-${shard}.json`);
  removeIfPresent(finalReport);
  const plans = new Map<string, HeavyFileRunPlan>();
  for (const file of plan.files) plans.set(file, await jsonNode<HeavyFileRunPlan>('scripts/resolve-vitest-heavy-file-run-plan.mjs', [file], env));
  const batchSize = positive(env.VITEST_HEAVY_FILE_BATCH_SIZE, 4);
  const invocations = buildHeavyInvocations(plan.files, plans, batchSize);
  const baseline = [...plans.values()].reduce((sum, item) => sum + (item.mode === 'tests' ? (item.tests?.length ?? 0) : 1), 0);
  process.stdout.write(`vitest-heavy-batching shard=${shard} files=${plan.files.length} invocations=${invocations.length} baseline_invocations=${baseline} non_isolate_file_batch_size=${batchSize} isolate_test_batch_size=1\n`);
  const partialReports: string[] = [];
  let failure = 0;
  let sequence = 0;
  const started = Date.now();
  try {
    for (const invocation of invocations) {
      sequence += 1;
      const safe = invocation.label.replace(/[^\w.-]+/gu, '_');
      const report = reportPath(`.vitest-runtime-report-heavy-${shard}-${sequence}-${safe}.json`);
      let passed = false;
      const attempts = env.CI === 'true' ? 5 : 1;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        removeIfPresent(report);
        const args = [
          ...invocation.files,
          ...(invocation.pool === 'forks' ? [`--pool=${invocation.pool}`] : []),
          ...(invocation.testPattern ? ['-t', invocation.testPattern] : []),
          '--reporter=default', '--reporter=json', `--outputFile=${report}`,
        ];
        const result = await runNpmTest(args, env);
        const combined = `${result.stdout}\n${result.stderr}`;
        if (RPC_FLAKE.test(combined)) {
          const failedReport = existsSync(report) && await jsonReportPredicate('has-failed-tests', report, env);
          if (failedReport) {
            failure = result.exitCode ?? 1;
            process.stdout.write(`[FAIL] Vitest heavy shard ${shard} invocation ${invocation.label} reported genuine test failure alongside RPC-flake text; not retrying\n`);
            break;
          }
          const clean = existsSync(report) && await jsonReportPredicate('is-clean', report, env);
          if (clean) {
            process.stdout.write(`[WARN] Post-success vitest-worker onTaskUpdate shutdown flake suppressed for ${invocation.label}\n`);
            if (!await validateHeavyReport(invocation, report, env)) return 1;
            passed = true; break;
          }
          if (attempt < attempts) {
            process.stdout.write(`[WARN] Vitest worker RPC flake on heavy shard ${shard} invocation ${invocation.label} (attempt ${attempt}/${attempts}); retrying...\n`);
            await cleanupShard(shard, env);
            await new Promise((resolve) => setTimeout(resolve, 5_000));
            continue;
          }
          process.stdout.write(`[FAIL] Vitest worker onTaskUpdate RPC timeout detected on heavy shard ${shard} invocation ${invocation.label}\n`);
          failure = 1; break;
        }
        if (!result.ok) {
          failure = result.exitCode ?? 1;
          const failedReport = existsSync(report) && await jsonReportPredicate('has-failed-tests', report, env);
          if (failedReport) {
            process.stdout.write(`[FAIL] Vitest heavy shard ${shard} invocation ${invocation.label} reported a genuine test failure; not retrying\n`);
            break;
          }
          if (invocation.members.length > 1) {
            process.stdout.write(`[FAIL] Vitest heavy shard ${shard} invocation ${invocation.label} crashed without attributable test failure; batched crashes fail closed\n`);
            break;
          }
          if (attempt < attempts) {
            process.stdout.write(`[WARN] Vitest heavy shard ${shard} invocation ${invocation.label} failed (attempt ${attempt}/${attempts}, exit=${failure}); cleaning fleet and retrying...\n`);
            await cleanupShard(shard, env);
            await new Promise((resolve) => setTimeout(resolve, 5_000));
            continue;
          }
          break;
        }
        if (!existsSync(report)) {
          process.stdout.write(`[FAIL] Vitest runtime report missing for heavy shard ${shard} invocation ${invocation.label}\n`);
          return 1;
        }
        if (!await validateHeavyReport(invocation, report, env)) {
          process.stdout.write(`[FAIL] Vitest runtime report for heavy shard ${shard} invocation ${invocation.label} does not match planned batch members\n`);
          return 1;
        }
        passed = true; break;
      }
      if (!passed) { await cleanupShard(shard, env); continue; }
      partialReports.push(report);
    }

    if (failure === 0) {
      const merge = await child(NODE, [path.join(ROOT, 'scripts/lib/vitest-json-report.mjs'), 'merge', '--output', finalReport, ...partialReports], env);
      if (!merge.ok) failure = 1;
      else {
        writeFileSync(`${finalReport}.meta.json`, `${JSON.stringify({ commitSha: env.GITHUB_SHA ?? '', shard, success: true, runId: env.GITHUB_RUN_ID ?? '' })}\n`, 'utf8');
        if (!await runBudget(finalReport, env)) failure = 1;
        else process.stdout.write(`vitest-lane-timing lane=heavy shard=${shard} files=${plan.files.length} weight_ms=${plan.totalRuntimeMs} elapsed_sec=${elapsedSeconds(started)}\n`);
      }
    }
  } finally {
    for (const report of partialReports) removeIfPresent(report);
  }

  const hygiene = await observeHeavyShardFleet(shard, env);
  const dirty = hygiene.filter((item) => !item.ok);
  if (dirty.length > 0) {
    for (const item of dirty) process.stdout.write(`[FAIL] TestMode fleet hygiene lease=${item.leaseId} reason=${item.reason ?? 'surviving scoped pwsh'} survivors=${item.survivors.join(',')}\n`);
    await cleanupShard(shard, env);
    return 2;
  }
  return failure;
}

async function runWallclock(env: NodeJS.ProcessEnv): Promise<number> {
  delete env.VITEST_CI_LIGHT_LANE; delete env.VITEST_CI_HEAVY_LANE;
  const plan = await jsonNode<WallclockPlan>('scripts/invoke-vitest-ci-lane-plan.mjs', ['wallclock'], env);
  if (plan.files.length === 0) {
    process.stdout.write('[FAIL] Vitest wall-clock stage: no postMergeWallclock files configured\n');
    return 1;
  }
  const started = Date.now();
  for (const file of plan.files) {
    const filePlan = await jsonNode<HeavyFileRunPlan>('scripts/resolve-vitest-heavy-file-run-plan.mjs', [file], env);
    const invocations = filePlan.mode === 'tests' ? (filePlan.tests ?? []).map((title) => ({ label: `${file} > ${title}`, title })) : [{ label: file, title: '' }];
    for (const invocation of invocations) {
      const result = await runNpmTest([...(invocation.title ? ['-t', invocation.title] : []), file, '--pool', filePlan.pool], env);
      if (RPC_FLAKE.test(`${result.stdout}\n${result.stderr}`)) {
        process.stdout.write(`[FAIL] Vitest worker RPC flake signature detected in wall-clock file ${invocation.label}\n`);
        return 1;
      }
      if (!result.ok) return result.exitCode ?? 1;
    }
  }
  process.stdout.write(`vitest-lane-timing lane=wallclock files=${plan.files.length} elapsed_sec=${elapsedSeconds(started)}\n`);
  return 0;
}

function parseShard(argv: readonly string[]): number {
  const index = argv.indexOf('--shard');
  return index >= 0 ? Number(argv[index + 1] ?? 0) : 0;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const command = argv[0] ?? '';
  if (command === 'aggregate') return runAggregate(process.env);
  const harness = envWithHarness();
  try {
    if (command === 'light') return runLight(parseShard(argv), harness.env);
    if (command === 'heavy') return runHeavy(parseShard(argv), harness.env);
    if (command === 'wallclock') return runWallclock(harness.env);
    throw new Error('usage: vitest-ci-runner.ts <light [--shard N]|heavy --shard N|wallclock|aggregate>');
  } finally {
    try { cleanupHarnessRoot(harness.root); }
    catch (error) { process.stderr.write(`vitest-ci-runner: harness cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`); }
  }
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`vitest-ci-runner: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
