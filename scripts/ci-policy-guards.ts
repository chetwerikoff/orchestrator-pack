#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isDirectExecution } from '#opk-toolchain/baseline-io';
import { runProcessSync } from '#opk-kernel/subprocess';

type JobMap = ReadonlyMap<string, string>;

function repoRoot(argv: readonly string[]): string {
  const i = argv.indexOf('--repo-root');
  return resolve(i >= 0 ? (argv[i + 1] ?? '.') : resolve(import.meta.dirname, '..'));
}

function text(path: string): string {
  return readFileSync(path, 'utf8');
}

function workflowJobs(source: string): JobMap {
  const lines = source.split(/\r?\n/u);
  const out = new Map<string, string>();
  let inJobs = false;
  let current = '';
  let start = 0;
  const flush = (end: number) => {
    if (current) out.set(current, lines.slice(start, end).join('\n'));
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!inJobs) {
      if (/^jobs:\s*$/u.test(line)) inJobs = true;
      continue;
    }
    if (/^\S/u.test(line)) {
      flush(i);
      break;
    }
    const match = /^  ([A-Za-z0-9_-]+):\s*$/u.exec(line);
    if (match) {
      flush(i);
      current = match[1]!;
      start = i;
    }
    if (i === lines.length - 1) flush(lines.length);
  }
  return out;
}

function pushMain(source: string): boolean {
  return /^on:\s*.*?^\s*push:\s*$.*?^\s*branches:\s*$.*?^\s*-\s*main\s*$/msu.test(source)
    || /push:\s*[\r\n]+\s*branches:\s*\[[^\]]*\bmain\b/msu.test(source)
    || /push:\s*[\r\n]+\s*branches:\s*\r?\n\s*-\s*main\b/msu.test(source)
    || /push:\s*branches:\s*\[[^\]]*\bmain\b/msu.test(source);
}
function pullRequest(source: string): boolean {
  return /^on:\s*pull_request(?:_target)?\s*$/mu.test(source)
    || /^on:\s*\[[^\]]*\bpull_request(?:_target)?\b[^\]]*\]/mu.test(source)
    || /^\s*pull_request(?:_target)?:\s*/mu.test(source)
    || /^\s*-\s*pull_request(?:_target)?\s*$/mu.test(source);
}
function reusable(source: string): boolean {
  return /^on:\s*workflow_call\s*$/mu.test(source)
    || /^on:\s*\[[^\]]*\bworkflow_call\b[^\]]*\]/mu.test(source)
    || (/^on:\s*$/mu.test(source) && /^\s*workflow_call:\s*/mu.test(source));
}
function concurrencyBlock(source: string): string {
  const lines = source.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^concurrency:\s*$/u.test(line)) {
      const block: string[] = [];
      for (let j = i + 1; j < lines.length && !/^\S/u.test(lines[j]!); j += 1) block.push(lines[j]!);
      return block.join('\n');
    }
    const inline = /^concurrency:\s*(.+)$/u.exec(line);
    if (inline) return inline[1]!.trim();
  }
  return '';
}

function runCiCheapWins(root: string): string[] {
  const failures: string[] = [];
  const dir = join(root, '.github/workflows');
  const files = existsSync(dir) ? readdirSync(dir).filter((p) => /\.ya?ml$/iu.test(p)).sort() : [];
  if (files.length === 0) failures.push('no workflow files found under .github/workflows');
  for (const name of files) {
    const rel = '.github/workflows/' + name;
    if (rel === '.github/workflows/contract-evidence-legacy-list-guard.yml') continue;
    const source = text(join(dir, name));
    const hasPr = pullRequest(source);
    const hasMain = pushMain(source);
    const isReusable = reusable(source);
    if (hasPr || hasMain || isReusable) {
      const block = concurrencyBlock(source);
      if (!block) failures.push(rel + ' missing top-level concurrency block');
      else {
        if (hasMain) {
          if (/^\s*cancel-in-progress:\s*true\s*$/mu.test(block)) failures.push(rel + ' uses unconditional cancel-in-progress: true while also triggering push to main');
          if (!/cancel-in-progress:\s*\$\{\{/u.test(block)) failures.push(rel + ' must gate cancel-in-progress with a pull_request expression when push-to-main is enabled');
        }
        if (hasPr) {
          if (/github\.head_ref/u.test(block) && !/pull_request\.number/u.test(block)) failures.push(rel + ' concurrency group uses head_ref without pull_request.number (fork PR isolation)');
          if (!/pull_request\.number/u.test(block)) failures.push(rel + ' concurrency group must key on pull_request.number for PR-scoped cancellation');
        }
      }
    }
    for (const [jobName, job] of workflowJobs(source)) {
      if (!/npm ci/u.test(job) || /ci-cheap-wins:\s*npm-cache-unavailable/u.test(job)) continue;
      if (!/actions\/setup-node@v\d+/u.test(job) || !/cache:\s*npm/u.test(job)) failures.push(rel + " job '" + jobName + "' runs npm ci without actions/setup-node cache: npm (or documented npm-cache-unavailable carve-out)");
    }
  }
  const auditPath = join(root, '.github/workflows/read-delegation-audit.yml');
  if (!existsSync(auditPath)) failures.push('missing .github/workflows/read-delegation-audit.yml');
  else {
    const audit = text(auditPath);
    if (/(run:\s*npm test -- scripts\/read-delegation-audit\.test\.ts|vitest run.*read-delegation-audit\.test\.ts)/mu.test(audit)) failures.push('read-delegation-audit.yml must not run the fixture suite');
  }
  const scopePath = join(root, '.github/workflows/scope-guard.yml');
  if (!existsSync(scopePath)) failures.push('missing .github/workflows/scope-guard.yml');
  else {
    const scope = text(scopePath);
    const sharded = /test-vitest-light/u.test(scope) && /test-vitest-heavy/u.test(scope)
      && /vitest-ci-runner\.ts light/u.test(scope) && /vitest-ci-runner\.ts heavy/u.test(scope)
      && /vitest-ci-runner\.ts aggregate/u.test(scope);
    const contract = /^\s*test-vitest-contracts:\s*$/mu.test(scope) && /vitest-ci-runner\.ts contract/u.test(scope);
    if (!sharded) failures.push('scope-guard.yml must run the Node sharded Vitest pipeline');
    if (sharded && !contract) failures.push('sharded pipeline must keep the Node Vitest contract lane');
    for (const command of ['ci-cheap-wins', 'verify-runtime', 'pipeline-split']) {
      if (!scope.includes('ci-policy-guards.ts ' + command)) failures.push('scope-guard.yml must invoke Node CI policy guard: ' + command);
    }
  }
  return failures;
}

function runVerifyRuntime(root: string): string[] {
  const failures: string[] = [];
  const required = [
    'scripts/verify.ts','scripts/test-runtime-budget.config.json','scripts/enforce-vitest-runtime-budget.mjs',
    'scripts/vitest-ci-runner.ts','docs/verify-runtime-refactor.md','.github/workflows/scope-guard.yml',
  ];
  for (const rel of required) if (!existsSync(join(root, rel))) failures.push('missing required artifact: ' + rel);
  const verifyPath = join(root, 'scripts/verify.ts');
  if (existsSync(verifyPath)) {
    const source = text(verifyPath);
    if (!source.includes("argv.includes('--test-backed-smoke')")) failures.push('verify.ts must expose --test-backed-smoke');
    if (!source.includes('runReusableGuard')) failures.push('verify.ts must retain reusable repository guard');
    if (!source.includes('runGateRunner')) failures.push('verify.ts must retain the Node gate runner');
  }
  const scopePath = join(root, '.github/workflows/scope-guard.yml');
  if (existsSync(scopePath)) {
    const source = text(scopePath);
    const jobs = workflowJobs(source);
    const job = jobs.get('verify-pack') ?? '';
    if (!job) failures.push('scope-guard.yml missing verify-pack job');
    else {
      if (!/scripts\/verify\.ts/u.test(job)) failures.push('verify-pack must invoke scripts/verify.ts');
      if (!/ci-policy-guards\.ts verify-runtime/u.test(job)) failures.push('verify-pack must invoke Node verify-runtime policy guard');
    }
  }
  return failures;
}

function runPipelineSplit(root: string): string[] {
  const failures: string[] = [];
  const planner = join(root, 'scripts/emit-vitest-heavy-topology.mjs');
  const config = join(root, 'scripts/vitest-ci-lanes.config.json');
  const workflow = join(root, '.github/workflows/vitest-runtime-history-refresh.yml');
  for (const p of [planner, config, workflow]) if (!existsSync(p)) failures.push('missing surviving CI topology prerequisite: ' + p);
  if (failures.length > 0) return failures;
  const source = text(workflow);
  const fragments = [
    'plan-vitest-ci-topology:',
    'heavy_shard_count: ${{ steps.plan.outputs.heavy_shard_count }}',
    'heavy_shard_matrix: ${{ steps.plan.outputs.heavy_shard_matrix }}',
    'node scripts/emit-vitest-heavy-topology.mjs --gha-output --skip-oversized-guard',
    'name: Vitest heavy shard ${{ matrix.shard }}/${{ needs.plan-vitest-ci-topology.outputs.heavy_shard_count }}',
    'shard: ${{ fromJson(needs.plan-vitest-ci-topology.outputs.heavy_shard_matrix) }}',
    'OPK_VITEST_TOPOLOGY_PLAN_PATH: ${{ github.workspace }}/scripts/vitest-heavy-topology.plan.json',
    'needs: [plan-vitest-ci-topology, test-vitest-heavy]',
  ];
  for (const fragment of fragments) if (!source.includes(fragment)) failures.push("runtime-history refresh lost dynamic topology binding: missing '" + fragment + "'");
  const heavy = /^  test-vitest-heavy:\r?\n(?<body>.*?)(?=^  refresh-runtime-history:)/msu.exec(source)?.groups?.body ?? '';
  if (!/^      - name: Checkout\r?\n        uses: actions\/checkout@v4\r?\n        with:\r?\n          fetch-depth: 0(?:\r?\n|$)/msu.test(heavy)) failures.push('runtime-history heavy shards must use fetch-depth: 0');
  if (/shard:\s*\[\s*1\s*,\s*2\s*,\s*3\s*,\s*4\s*,\s*5\s*,\s*6\s*,\s*7\s*\]/u.test(source)) failures.push('runtime-history refresh must not restore a fixed 1..7 heavy shard matrix');
  const dir=mkdtempSync(join(tmpdir(),'opk-topology-'));
  const output=join(dir,'gha-output.txt');
  try {
    const result=runProcessSync({command:process.execPath,args:[planner,'--gha-output','--skip-oversized-guard'],cwd:root,inheritParentEnv:true,env:{GITHUB_OUTPUT:output}});
    if(!result.ok) failures.push('TypeScript topology planner failed: '+(result.stderr||result.error||result.outcome));
  } finally { rmSync(dir,{recursive:true,force:true}); }
  return failures;
}

function runReadDelegationPolicy(root: string): string[] {
  const failures: string[] = [];
  const manifestPath=join(root,'.cursor/rules/read-delegation-policy-manifest.json');
  if(!existsSync(manifestPath)) return ['missing committed Cursor read-delegation policy manifest'];
  const manifest=JSON.parse(text(manifestPath)) as {stalePatterns?:string[];policyBearingCursorRules?:string[]};
  const rules=manifest.policyBearingCursorRules??[];
  for(const rel of rules){
    const p=join(root,rel);
    if(!existsSync(p)){failures.push('manifested Cursor rule missing: '+rel);continue;}
    const source=text(p);
    for(const stale of manifest.stalePatterns??[]) if(source.includes(stale)) failures.push(rel+' contains stale read-delegation wording: '+stale);
  }
  const rulesDir=join(root,'.cursor/rules');
  const markers=['Coworker CLI delegation','coworker ask','delegate I/O, keep reasoning'];
  if(existsSync(rulesDir)) for(const name of readdirSync(rulesDir).filter(p=>p.endsWith('.mdc'))){
    const rel='.cursor/rules/'+name;
    if(rules.includes(rel)) continue;
    const source=text(join(rulesDir,name));
    const marker=markers.find(m=>source.includes(m));
    if(marker) failures.push('unmanifested policy-bearing Cursor rule: '+rel+' (marker: '+marker+')');
  }
  if(!text(join(root,'AGENTS.md')).includes('index-coverage carve-out')) failures.push('AGENTS.md missing index-coverage carve-out prose');
  return failures;
}

function runReadDelegationCiGate(root:string): string[] {
  const failures:string[]=[];
  const workflow=join(root,'.github/workflows/read-delegation-audit.yml');
  if(!existsSync(workflow)) return ['missing .github/workflows/read-delegation-audit.yml'];
  const source=text(workflow);
  if(!/^on:\s*$/mu.test(source)) failures.push('workflow missing on: trigger block');
  if(!source.includes('pull_request')) failures.push('workflow missing pull_request trigger');
  if(/continue-on-error:\s*true/u.test(source)) failures.push('audit job uses continue-on-error');
  if(/if:\s*false/u.test(source)) failures.push('audit job has unconditional skip (if: false)');
  const negative=join(root,'scripts/read-delegation-audit-negative-selftest.ts');
  writeFileSync(negative,'import { describe,it,expect } from "vitest";\ndescribe("negative self-test",()=>{it("must fail",()=>{expect(true).toBe(false);});});\n','utf8');
  try {
    const result=runProcessSync({command:'npx',args:['vitest','run',negative],cwd:root,inheritParentEnv:true});
    if(result.ok) failures.push('negative self-test unexpectedly passed — workflow cannot prove failure propagation');
  } finally { rmSync(negative,{force:true}); }
  return failures;
}

function printResult(name:string, failures:readonly string[]): number {
  if(failures.length===0){process.stdout.write('[PASS] '+name+'\n');return 0;}
  process.stderr.write('[FAIL] '+name+':\n'+failures.map(x=>' - '+x).join('\n')+'\n');
  return 1;
}

export function main(argv:readonly string[]):number{
  const command=argv[0]??'';
  const root=repoRoot(argv);
  if(command==='ci-cheap-wins') return printResult('CI cheap wins static guard',runCiCheapWins(root));
  if(command==='verify-runtime') return printResult('verify runtime refactor guard',runVerifyRuntime(root));
  if(command==='pipeline-split') return printResult('CI pipeline split guard',runPipelineSplit(root));
  if(command==='read-delegation-policy') return printResult('read-delegation policy consistency',runReadDelegationPolicy(root));
  if(command==='read-delegation-ci-gate') return printResult('read-delegation audit CI gate',runReadDelegationCiGate(root));
  process.stderr.write('usage: ci-policy-guards.ts <ci-cheap-wins|verify-runtime|pipeline-split|read-delegation-policy|read-delegation-ci-gate> [--repo-root PATH]\n');
  return 2;
}
if(isDirectExecution(import.meta.url,process.argv[1])) process.exitCode=main(process.argv.slice(2));
