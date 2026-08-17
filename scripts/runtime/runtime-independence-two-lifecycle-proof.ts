import assert from 'node:assert/strict';
import { runProcessSync } from '../kernel/subprocess.ts';
import type { OrcaRunOptions } from '../orca-runtime/native.ts';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrcaTaskRuntimeAdapter } from '../orca-runtime/task-adapter.ts';
import { selectRuntimeAdapterFactory } from './registry.ts';
import { executeRuntimeTaskLifecycle } from './task-lifecycle.ts';

const LOADERS = ['orca'] as const;
const IMPORTS = ['../orca-runtime/native.ts', '../orca-runtime/task-adapter.ts', './contracts.ts'] as const;

function composition(source: string): { loaders: string[]; imports: string[] } {
  const start = source.indexOf('const DEFAULT_LOADERS:');
  const end = source.indexOf('\n};', start);
  if (start < 0 || end < 0) throw new Error('runtime registry DEFAULT_LOADERS missing');
  const loaders = [...source.slice(start, end).matchAll(/^\s{2}(?:'([^']+)'|"([^"]+)"|([\w-]+)):\s*async\s*\(\)\s*=>/gm)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '').filter(Boolean).sort();
  const imports = [...new Set([
    ...[...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1]!),
    ...[...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]!),
  ])].sort();
  assert.deepEqual(loaders, [...LOADERS], 'sole production Orca loader');
  assert.deepEqual(imports, [...IMPORTS].sort(), 'exact Orca composition-root graph');
  return { loaders, imports };
}

function rejectLegacyMutation(source: string): void {
  const end = source.indexOf('\n};', source.indexOf('const DEFAULT_LOADERS:'));
  const mutated = `${source.slice(0, end)}\n  'ao-legacy': async () => import('./ao-legacy-adapter.ts'),${source.slice(end)}`;
  assert.throws(() => composition(mutated), /sole production Orca loader|exact Orca composition-root graph/);
}

function fixture(statePath: string, root: string): string {
  return `#!${process.execPath}\nimport fs from'node:fs';import path from'node:path';
const P=${JSON.stringify({ statePath, root })},a=process.argv.slice(2).filter(x=>x!=='--json'),op=a.slice(0,2).join(' '),get=n=>{const i=a.indexOf(n);return i<0?'':String(a[i+1]??'')},S=fs.existsSync(P.statePath)?JSON.parse(fs.readFileSync(P.statePath,'utf8')):{n:0,t:{},ops:[],captures:[]},bad=Object.keys(process.env).filter(k=>k.startsWith('AO_')||k.startsWith('AGENT_ORCHESTRATOR_')),paths=(process.env.PATH??'').split(path.delimiter).filter(Boolean);S.captures.push({op,bad,paths});const save=()=>fs.writeFileSync(P.statePath,JSON.stringify(S)),out=x=>{save();process.stdout.write(JSON.stringify(x)+'\\n')};if(bad.length||paths.length!==1||paths[0]!==P.root){out({ok:false,error:{code:'fixture_environment_not_hermetic'}});process.exit(0)}S.ops.push(op);
switch(op){case'worktree current':out({ok:true,result:{worktree:{path:P.root,head:'a'.repeat(40)}}});break;case'terminal create':{const h='term-'+(++S.n),g='generation-'+S.n,q={handle:h,incarnationId:g,title:get('--title'),worktreePath:P.root,status:'running',lines:['started:'+get('--command')],dispatches:0,closes:0,exists:true};S.t[h]=q;out({ok:true,result:{terminal:{handle:h,incarnationId:g,title:q.title}}});break}case'terminal list':out({ok:true,result:{terminals:Object.values(S.t).filter(x=>x.exists).map(({lines,dispatches,closes,exists,...x})=>x)}});break;case'terminal send':{const q=S.t[get('--terminal')],text=get('--text');if(!q||!q.exists)out({ok:false,error:{code:'terminal_not_found'}});else{q.dispatches++;q.lines.push(text);out({ok:true,result:{send:{accepted:true}}})}break}case'terminal read':{const h=get('--terminal'),q=S.t[h];if(!q||!q.exists)out({ok:false,error:{code:'terminal_not_found'}});else out({ok:true,result:{terminal:{handle:h,status:q.status,tail:q.lines,nextCursor:String(q.lines.length),latestCursor:String(q.lines.length)}}});break}case'terminal wait':{const h=get('--terminal'),q=S.t[h];out(q&&q.exists?{ok:true,result:{wait:{handle:h,condition:'tui-idle',satisfied:true,status:'running'}}}:{ok:false,error:{code:'terminal_not_found'}});break}case'terminal close':{const h=get('--terminal'),q=S.t[h];if(!q||!q.exists)out({ok:false,error:{code:'terminal_not_found'}});else{q.closes++;q.exists=false;q.status='exited';out({ok:true,result:{close:{handle:h,closed:true}}})}break}default:out({ok:false,error:{code:'unexpected_operation',message:op}})}\n`;
}

function childEnv(root: string): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AO_') && !key.startsWith('AGENT_ORCHESTRATOR_')).concat([
    ['PATH', root], ['OPK_VITEST_HARNESS', ''], ['OPK_VITEST_SKIP_CHILD_ENV_MERGE', '1'],
  ]));
}

function lifecycle(adapter: OrcaTaskRuntimeAdapter, root: string, title: string, prompt: string) {
  return executeRuntimeTaskLifecycle({
    adapter,
    title,
    command: 'cursor-agent',
    prompt,
    observationWindowMs: 1_000,
    options: { cwd: root, timeoutMs: 5_000 },
    acquireClaim: () => ({ ok: true }),
  });
}

function requireUnknownDispatch(result: ReturnType<typeof lifecycle>, label: string) {
  if (!('stage' in result) || result.stage !== 'dispatch') {
    throw new Error(`${label}:expected_dispatch_boundary:${JSON.stringify(result)}`);
  }
  assert.equal(result.result.status, 'dispatch_unknown');
  assert.equal(result.result.reason, 'submit_witness_unavailable');
  return result;
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(process.cwd(), '.issue-1250-orca-hermetic-'));
  const executable = join(root, 'orca.mjs');
  const statePath = join(root, 'state.json');
  try {
    const registrySource = readFileSync(fileURLToPath(new URL('./registry.ts', import.meta.url)), 'utf8');
    const witness = composition(registrySource);
    rejectLegacyMutation(registrySource);
    writeFileSync(executable, fixture(statePath, root), 'utf8');
    chmodSync(executable, 0o755);
    const env = childEnv(root);
    type OrcaRunner = NonNullable<OrcaRunOptions['runner']>;
    const runner = ((command: string, args: readonly string[] = [], options: { cwd?: string; timeout?: number } = {}) => {
      const result = runProcessSync({
        command,
        args,
        cwd: options.cwd,
        env,
        inheritParentEnv: false,
        timeoutMs: options.timeout,
      });
      return {
        pid: 0,
        output: [null, result.stdout, result.stderr],
        stdout: result.stdout,
        stderr: result.stderr,
        status: result.exitCode,
        signal: result.signal,
        ...(result.outcome === 'spawn-failure'
          ? { error: new Error(result.error ?? 'fixture process launch failed') }
          : {}),
      };
    }) as unknown as OrcaRunner;
    const productionFactory = await selectRuntimeAdapterFactory({ adapter: 'orca', env: {} });
    const selected = productionFactory({
      cwd: root, timeoutMs: 5_000, transport: { executable, env, runner },
    });
    assert.ok(selected instanceof OrcaTaskRuntimeAdapter);
    const first = requireUnknownDispatch(
      lifecycle(selected, root, 'issue-1250-lifecycle-a', 'implement task A'),
      'issue-1250-lifecycle-a',
    );
    const second = requireUnknownDispatch(
      lifecycle(selected, root, 'issue-1250-lifecycle-b', 'implement task B'),
      'issue-1250-lifecycle-b',
    );
    assert.notDeepEqual(first.worker.identity, second.worker.identity);
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { t: Record<string, { dispatches: number; closes: number; exists: boolean }>; ops: string[]; captures: Array<{ bad: string[]; paths: string[] }> };
    const terminals = Object.values(state.t);
    assert.equal(terminals.length, 2);
    assert.ok(terminals.every((value) => value.dispatches === 1 && value.closes === 0 && value.exists));
    assert.equal(state.ops.filter((value) => value === 'terminal create').length, 2);
    assert.equal(state.ops.filter((value) => value === 'terminal send').length, 2);
    assert.equal(state.ops.filter((value) => value === 'terminal close').length, 0);
    assert.equal(state.ops.filter((value) => value === 'terminal read').length, 0);
    assert.equal(state.ops.filter((value) => value === 'terminal wait').length, 0);
    assert.ok(state.captures.every((value) => value.bad.length === 0 && value.paths.length === 1 && value.paths[0] === root));
    process.stdout.write(`${JSON.stringify({ status: 'pass', selectedAdapter: selected.constructor.name, witness, operations: state.ops })}\n`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

await main();
