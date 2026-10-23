import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runProcessSync } from '../kernel/subprocess.ts';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeAdapter, RuntimeWorker } from '../runtime/contracts.ts';
import { OrcaTaskRuntimeAdapter } from '../orca-runtime/task-adapter.ts';
import type { OrcaJsonResponse } from '../orca-runtime/native.ts';
import {
  attachWorkerAssignmentIssueNumber,
  currentWorkerAssignment,
  parseWorkerAssignmentStore,
  publishCurrentWorkerAssignment,
  readWorkerAssignmentStore,
  resolveWorkerAssignmentStorePath,
  retireCurrentWorkerAssignment,
  workerAssignmentKey,
} from '../lib/worker-assignment-store.ts';
import { evaluateReadiness } from './readiness-evaluator.ts';
import { withCrashRecoverableFileLock } from './journal-lock.ts';
import { readTerminalGoneDispatch, runSupervisedWorkerStart } from './supervised-worker-start.ts';

const roots: string[] = [];
const canonicalTerminal = 'term_operator_owned';
const canonicalWorktree = 'repo::exact-worktree';

function root(): string {
  const value = mkdtempSync(path.join(tmpdir(), 'opk-1416-start-'));
  roots.push(value);
  return value;
}
function envelope(result: Record<string, unknown>, ok = true): string {
  return JSON.stringify({ id:'orca-operation-1', ok, result });
}
function args(task = 'task_1'): string[] {
  return ['--task', task, '--terminal', 'terminal:operator-owned', '--worktree', 'path:/tmp/exact-worktree', '--agent', 'codex'];
}
function argsForTerminal(terminal: string, task = 'task_1'): string[] {
  return ['--task', task, '--terminal', terminal, '--worktree', 'path:/tmp/exact-worktree', '--agent', 'codex'];
}
function terminallyFailedExactLiveRetainedShow(handle = canonicalTerminal) {
  return {
    dispatch: { status: 'failed', last_heartbeat_at: null },
    worker: { agent_terminal_handle: handle },
    terminal: { handle },
    observation: { exactWorker: true, status: 'live' },
    terminalResource: {
      terminalHandle: handle,
      worktreeId: canonicalWorktree,
      originDispatchId: 'dispatch_old',
      ownerDispatchId: 'dispatch_old',
      releaseState: 'retained',
    },
  } as const;
}
function producerEffects(input: {
  terminal?: string;
  worktree?: string;
  terminalAction?: 'reused'|'reused_agent_terminal'|'created';
} = {}): Record<string, unknown>[] {
  const terminal = input.terminal ?? canonicalTerminal;
  const worktree = input.worktree ?? canonicalWorktree;
  return [
    { kind:'worktree', action:'reused', id:worktree },
    { kind:'setup', action:'not_applicable', state:'not_applicable' },
    { kind:'terminal', role:'agent', action:input.terminalAction ?? 'reused', id:terminal },
    { kind:'dispatch_input', role:'agent', id:terminal, state:'accepted' },
  ];
}
function inspectPlacement(input: {
  terminal?: string;
  terminalWorktree?: string;
  worktree?: string;
  terminalOk?: boolean;
  worktreeOk?: boolean;
} = {}) {
  return async (inspectArgs: readonly string[]) => {
    if (inspectArgs[0] === 'terminal' && inspectArgs[1] === 'show') {
      if (input.terminalOk === false) return { ok:false, stdout:'' };
      return {
        ok:true,
        stdout:envelope({ terminal:{
          handle:input.terminal ?? canonicalTerminal,
          worktreeId:input.terminalWorktree ?? canonicalWorktree,
          incarnationId:'pty-current',
        } }),
      };
    }
    if (inspectArgs[0] === 'worktree' && inspectArgs[1] === 'show') {
      if (input.worktreeOk === false) return { ok:false, stdout:'' };
      return {
        ok:true,
        stdout:envelope({ worktree:{
          id:input.worktree ?? canonicalWorktree,
          path:'/tmp/exact-worktree',
          head:'a'.repeat(40),
        } }),
      };
    }
    return { ok:false, stdout:'', stderr:'unexpected inspection' };
  };
}
const worker: RuntimeWorker = {
  identity:{ runtime:'orca', id:'terminal-1', generation:'pty-1' },
  workspacePath:'/tmp/exact-worktree', title:'worker', provenance:'internal',
};
function adapter(resolution: { kind:'gone' }|{ kind:'resolved'; worker:RuntimeWorker }, liveness:'busy'|'idle'|'unknown'|'gone'='idle'): RuntimeAdapter {
  return {
    id:'orca',
    readiness:()=>({ status:'ok', value:{ ready:true, workspacePath:worker.workspacePath } }),
    listWorkers:()=>({ status:'ok', value:resolution.kind==='resolved'?[resolution.worker]:[] }),
    findWorkerById:()=>({ status:'ok', value:resolution.kind==='resolved'?resolution.worker:null }),
    findWorker:()=>({ status:'ok', value:resolution.kind==='resolved'?resolution.worker:null }),
    resolveAssignmentWorker:()=>({ status:'ok', value:resolution }),
    spawnWorker:()=>({ status:'ok', value:worker }),
    dispatchInput:()=>({ status:'dispatched' }),
    readBoundedOutput:()=>({ status:'ok', value:{ worker:worker.identity, lines:[], observationToken:{ opaque:'t' }, changed:false, terminalState:'running' } }),
    liveness:()=>({ status:liveness, worker:worker.identity }),
    stopWorker:()=>({ status:'ok', value:{ stopped:true } }),
  };
}

afterEach(()=>{ for(const value of roots.splice(0)) rmSync(value,{recursive:true,force:true}); });

describe('supervised worker start exact assignment admission',()=>{
  it('requires one exact pre-created terminal and worktree selector before invoking Orca',async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base}; let calls=0;
    const result=await runSupervisedWorkerStart({role:'worker',
      issueNumber:1416, repository:'chetwerikoff/orchestrator-pack', env,
      orcaArgs:['--task','task_1','--agent','codex'],
      execute:async()=>{calls+=1;return{ok:true,stdout:envelope({taskId:'task_1',dispatchId:'d',state:'ready'})}},
    });
    expect(result).toEqual({ok:false,reason:'supervised_start_exact_terminal_worktree_required'});
    expect(calls).toBe(0);
  });

  it('replaces a different-task local assignment on the safe exact-terminal route',async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base};
    const file=resolveWorkerAssignmentStorePath('orchestrator-pack',env);
    const old=await publishCurrentWorkerAssignment({file,repository:'chetwerikoff/orchestrator-pack',issueNumber:1416,
      taskId:'task_old',kind:'local',provider:'orca',bindingKey:'dispatch_old',role:'worker'});
    if(!old.ok)throw new Error(old.reason);
    const result=await runSupervisedWorkerStart({mode:'exact_terminal_worktree',role:'worker',issueNumber:1416,
      repository:'chetwerikoff/orchestrator-pack',env,adapter:adapter({kind:'gone'}),
      orcaArgs:args('task_new'),inspect:inspectPlacement(),
      execute:async()=>({ok:true,stdout:envelope({taskId:'task_new',dispatchId:'dispatch_new',state:'ready',
        worktree:{id:'repo-1::/tmp/new-worktree',path:'/tmp/new-worktree'},terminal:{handle:'term-provider',runtime:'orca',generation:'generation-1'},
        setup:{requested:'run',effective:'run',state:'running'},launch:{requested:{agent:'cursor',model:'model-medium'},effective:{agent:'cursor',model:'model-medium'}},
        effects:producerEffects()})}),
    });
    expect(result).toMatchObject({ok:true,reason:'ready_and_assignment_bound',assignment:{taskId:'task_new',bindingKey:'dispatch_new',generation:2}});
    expect(currentWorkerAssignment(file,1416)?.taskId).toBe('task_new');
  });

  it('publishes the delegated-integration marker only from the exact predecessor assignment', async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base};
    const file=resolveWorkerAssignmentStorePath('orchestrator-pack',env);
    const implementation=await publishCurrentWorkerAssignment({file,repository:'chetwerikoff/orchestrator-pack',issueNumber:1416,
      taskId:'task_1',kind:'local',provider:'orca',bindingKey:'dispatch_old',role:'worker'});
    if(!implementation.ok)throw new Error(implementation.reason);
    const delegatedIntegration={
      prNumber:926,
      expectedHeadSha:'a'.repeat(40),
      predecessorAssignmentId:implementation.assignment.assignmentId,
      predecessorGeneration:implementation.assignment.generation,
    };
    let calls=0;
    const result=await runSupervisedWorkerStart({mode:'exact_terminal_worktree',role:'worker',issueNumber:1416,
      repository:'chetwerikoff/orchestrator-pack',env,adapter:adapter({kind:'gone'}),delegatedIntegration,
      orcaArgs:args('task_1'),inspect:inspectPlacement(),
      execute:async()=>{calls+=1;return{ok:true,stdout:envelope({taskId:'task_1',dispatchId:'dispatch_integration',state:'ready',
        worktree:{id:'repo-1::/tmp/new-worktree',path:'/tmp/new-worktree'},terminal:{handle:'term-provider',runtime:'orca',generation:'generation-1'},
        setup:{requested:'run',effective:'run',state:'running'},launch:{requested:{agent:'cursor',model:'model-medium'},effective:{agent:'cursor',model:'model-medium'}},
        effects:producerEffects()})}},
    });
    expect(result).toMatchObject({ok:true,reason:'ready_and_assignment_bound',assignment:{
      taskId:'task_1',bindingKey:'dispatch_integration',generation:2,delegatedIntegration,
    }});
    expect(result.assignment?.assignmentId).not.toBe(implementation.assignment.assignmentId);
    expect(calls).toBe(1);
    expect(currentWorkerAssignment(file,1416)?.delegatedIntegration).toEqual(delegatedIntegration);
  });

  it('stops and reads back an exact live-idle implementation predecessor before delegated integration launch', async () => {
    const base=root(); const env={...process.env,OPK_BASE_DIR:base};
    const file=resolveWorkerAssignmentStorePath('orchestrator-pack',env);
    const implementation=await publishCurrentWorkerAssignment({file,repository:'chetwerikoff/orchestrator-pack',issueNumber:1416,
      taskId:'task_1',kind:'local',provider:'orca',bindingKey:'dispatch_old',role:'worker'});
    if(!implementation.ok)throw new Error(implementation.reason);
    const delegatedIntegration={
      prNumber:926,
      expectedHeadSha:'a'.repeat(40),
      predecessorAssignmentId:implementation.assignment.assignmentId,
      predecessorGeneration:implementation.assignment.generation,
    };
    const liveAdapter=adapter({kind:'resolved',worker},'idle');
    let predecessorPresent:RuntimeWorker|null=worker;
    const stopWorker=vi.fn((identity:RuntimeWorker['identity'])=>{
      expect(identity).toEqual(worker.identity);
      predecessorPresent=null;
      return {status:'ok' as const,value:{stopped:true as const}};
    });
    const liveAdapterWithReadback:RuntimeAdapter={
      ...liveAdapter,
      stopWorker,
      findWorker:()=>({status:'ok',value:predecessorPresent}),
    };
    let launches=0;
    const result=await runSupervisedWorkerStart({mode:'exact_terminal_worktree',role:'worker',issueNumber:1416,
      repository:'chetwerikoff/orchestrator-pack',env,adapter:liveAdapterWithReadback,delegatedIntegration,
      orcaArgs:args('task_1'),inspect:inspectPlacement(),
      execute:async()=>{
        launches+=1;
        expect(predecessorPresent).toBeNull();
        return {ok:true,stdout:envelope({taskId:'task_1',dispatchId:'dispatch_integration',state:'ready',
          worktree:{id:'repo-1::/tmp/new-worktree',path:'/tmp/new-worktree'},terminal:{handle:'term-provider',runtime:'orca',generation:'generation-1'},
          setup:{requested:'run',effective:'run',state:'running'},launch:{requested:{agent:'cursor',model:'model-medium'},effective:{agent:'cursor',model:'model-medium'}},
          effects:producerEffects()})};
      },
    });
    expect(result).toMatchObject({ok:true,reason:'ready_and_assignment_bound',assignment:{delegatedIntegration}});
    expect(stopWorker).toHaveBeenCalledTimes(1);
    expect(launches).toBe(1);
    expect(currentWorkerAssignment(file,1416)?.delegatedIntegration).toEqual(delegatedIntegration);
  });

  it('reuses an exact live current integration assignment with the same marker without Orca restart', async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base};
    const file=resolveWorkerAssignmentStorePath('orchestrator-pack',env);
    const implementation=await publishCurrentWorkerAssignment({file,repository:'chetwerikoff/orchestrator-pack',issueNumber:1416,
      taskId:'task_1',kind:'local',provider:'orca',bindingKey:'dispatch_old',role:'worker'});
    if(!implementation.ok)throw new Error(implementation.reason);
    const delegatedIntegration={
      prNumber:926,
      expectedHeadSha:'a'.repeat(40),
      predecessorAssignmentId:implementation.assignment.assignmentId,
      predecessorGeneration:implementation.assignment.generation,
    };
    const integration=await publishCurrentWorkerAssignment({file,repository:'chetwerikoff/orchestrator-pack',issueNumber:1416,
      taskId:'task_1',kind:'local',provider:'orca',bindingKey:'dispatch_integration',role:'worker',
      expectedCurrent:{assignmentId:implementation.assignment.assignmentId,generation:implementation.assignment.generation},
      delegatedIntegration});
    if(!integration.ok)throw new Error(integration.reason);
    let calls=0;
    const result=await runSupervisedWorkerStart({mode:'exact_terminal_worktree',role:'worker',issueNumber:1416,
      repository:'chetwerikoff/orchestrator-pack',env,adapter:adapter({kind:'resolved',worker},'idle'),delegatedIntegration,
      orcaArgs:args('task_1'),inspect:inspectPlacement(),
      execute:async()=>{calls+=1;return{ok:false,stdout:''}},
    });
    expect(result).toEqual({
      ok:true,
      reason:'delegated_integration_assignment_reused',
      assignment:integration.assignment,
    });
    expect(calls).toBe(0);
    expect(currentWorkerAssignment(file,1416)).toEqual(integration.assignment);
  });

  it('suppresses a second delegated launch while active and rechecks live main/readiness before its successor', async () => {
    const base = root();
    const env = { ...process.env, OPK_BASE_DIR: base };
    const file = resolveWorkerAssignmentStorePath('orchestrator-pack', env);
    const repository = 'chetwerikoff/orchestrator-pack';
    const issueNumber = 926;
    const prNumber = 2084;
    const currentPrHead = 'a'.repeat(40);
    const mainBefore = 'b'.repeat(40);
    const mainAfter = 'c'.repeat(40);
    let liveMainSha = mainBefore;
    let livePrHeadSha = currentPrHead;
    const readCurrentMain = vi.fn(() => liveMainSha);
    const readLivePr = vi.fn(() => ({ headSha: livePrHeadSha, baseRef: 'main' }));
    const revalidationEvents: string[] = [];
    const revalidate = (assignment: NonNullable<ReturnType<typeof currentWorkerAssignment>>) => {
      const observedMainSha = readCurrentMain();
      const pr = readLivePr();
      const target = {
        repository, issueNumber, taskId: assignment.taskId, assignmentId: assignment.assignmentId,
        assignmentGeneration: assignment.generation, prNumber, headSha: pr.headSha,
      };
      const readiness = evaluateReadiness({
        target,
        pr: { open: true, expectedTarget: pr.baseRef === 'main', prNumber, headSha: pr.headSha },
        workerReports: [{
          accepted: true, repoSlug: repository,
          assignment: { assignmentId: assignment.assignmentId, generation: assignment.generation, taskId: assignment.taskId },
          prNumber, headSha: pr.headSha, reportState: 'ready_for_review', reportedAtMs: 1,
        }],
        workerStatuses: [{
          assignmentId: assignment.assignmentId, assignmentGeneration: assignment.generation, taskId: assignment.taskId,
          issueNumber, repository, kind: 'local', localCapability: 'available', derivedStatus: 'ready_for_review',
          winningSource: 'pack-worker-report', stale: false, siblingReadinessOk: true,
        }],
        requiredCi: { headSha: pr.headSha, state: 'success' },
        review: { obligation: 'complete', unresolvedRequiredFinding: false, atCapOpenFindings: false, atCapContinuationRequired: false },
        smoke: { headSha: pr.headSha, state: 'pass' },
      });
      revalidationEvents.push(`revalidated:${observedMainSha}:${readiness.state}`);
      return { observedMainSha, readiness };
    };

    const firstImplementation = await publishCurrentWorkerAssignment({
      file, repository, issueNumber, taskId: 'task_926_first', kind: 'local', provider: 'orca',
      bindingKey: 'dispatch_926_first_implementation', role: 'worker',
    });
    if (!firstImplementation.ok) throw new Error(firstImplementation.reason);
    const firstAdmission = revalidate(firstImplementation.assignment);
    expect(firstAdmission.readiness.state).toBe('READY_TO_MERGE');
    const firstMarker = {
      prNumber, expectedHeadSha: currentPrHead,
      predecessorAssignmentId: firstImplementation.assignment.assignmentId,
      predecessorGeneration: firstImplementation.assignment.generation,
    };
    let launchCount = 0;
    const providerArgs = (taskId: string, _name: string) => args(taskId);
    const executeStart = (taskId: string, dispatchId: string, _name: string) => async () => {
      launchCount += 1;
      revalidationEvents.push(`started:${dispatchId}`);
      return { ok: true, stdout: envelope({
        taskId, dispatchId, state: 'ready', effects: producerEffects(),
      }) };
    };

    const firstStart = await runSupervisedWorkerStart({
      mode: 'exact_terminal_worktree', role: 'worker', issueNumber, repository, env,
      adapter: adapter({ kind: 'gone' }), delegatedIntegration: firstMarker,
      inspect: inspectPlacement(), orcaArgs: providerArgs('task_926_first', 'integration-first'),
      execute: executeStart('task_926_first', 'dispatch_926_integration_first', 'integration-first'),
    });
    expect(firstStart).toMatchObject({ ok: true, reason: 'ready_and_assignment_bound', assignment: { delegatedIntegration: firstMarker } });
    if (!firstStart.ok || !firstStart.assignment) throw new Error('first integration assignment was not published');
    expect(revalidationEvents.indexOf(`revalidated:${mainBefore}:READY_TO_MERGE`))
      .toBeLessThan(revalidationEvents.indexOf('started:dispatch_926_integration_first'));

    const activeAdapter = adapter({ kind: 'resolved', worker }, 'idle');
    let duplicateStarts = 0;
    const sameActiveAttempt = await runSupervisedWorkerStart({
      mode: 'exact_terminal_worktree', role: 'worker', issueNumber, repository, env,
      adapter: activeAdapter, delegatedIntegration: firstMarker,
      inspect: inspectPlacement(), orcaArgs: providerArgs('task_926_first', 'integration-first'),
      execute: async () => { duplicateStarts += 1; return { ok: false, stdout: '' }; },
    });
    expect(sameActiveAttempt).toMatchObject({ ok: true, reason: 'delegated_integration_assignment_reused' });
    expect(duplicateStarts).toBe(0);
    const competingMarker = { ...firstMarker, expectedHeadSha: 'd'.repeat(40) };
    const competingStart = await runSupervisedWorkerStart({
      mode: 'exact_terminal_worktree', role: 'worker', issueNumber, repository, env,
      adapter: activeAdapter, delegatedIntegration: competingMarker,
      inspect: inspectPlacement(), orcaArgs: providerArgs('task_926_first', 'integration-competing'),
      execute: async () => { duplicateStarts += 1; return { ok: false, stdout: '' }; },
    });
    expect(competingStart).toEqual({ ok: false, reason: 'delegated_integration_predecessor_mismatch' });
    expect(duplicateStarts).toBe(0);
    expect(launchCount).toBe(1);

    const retired = await retireCurrentWorkerAssignment({ file, expected: firstStart.assignment });
    expect(retired.ok).toBe(true);
    const nextImplementation = await publishCurrentWorkerAssignment({
      file, repository, issueNumber, taskId: 'task_926_next', kind: 'local', provider: 'orca',
      bindingKey: 'dispatch_926_next_implementation', role: 'worker',
    });
    if (!nextImplementation.ok) throw new Error(nextImplementation.reason);

    liveMainSha = mainAfter;
    const nextAdmission = revalidate(nextImplementation.assignment);
    expect(nextAdmission.observedMainSha).toBe(mainAfter);
    expect(nextAdmission.readiness.state).toBe('READY_TO_MERGE');
    const nextMarker = {
      prNumber, expectedHeadSha: currentPrHead,
      predecessorAssignmentId: nextImplementation.assignment.assignmentId,
      predecessorGeneration: nextImplementation.assignment.generation,
    };
    const nextStart = await runSupervisedWorkerStart({
      mode: 'exact_terminal_worktree', role: 'worker', issueNumber, repository, env,
      adapter: adapter({ kind: 'gone' }), delegatedIntegration: nextMarker,
      inspect: inspectPlacement(), orcaArgs: providerArgs('task_926_next', 'integration-next'),
      execute: executeStart('task_926_next', 'dispatch_926_integration_next', 'integration-next'),
    });
    expect(nextStart).toMatchObject({ ok: true, reason: 'ready_and_assignment_bound', assignment: { delegatedIntegration: nextMarker } });
    expect(readCurrentMain).toHaveBeenCalledTimes(2);
    expect(readLivePr).toHaveBeenCalledTimes(2);
    expect(launchCount).toBe(2);
    expect(revalidationEvents.indexOf(`revalidated:${mainAfter}:READY_TO_MERGE`))
      .toBeLessThan(revalidationEvents.indexOf('started:dispatch_926_integration_next'));
  });

  it('rejects delegated-integration predecessor drift before any Orca start effect', async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base};
    const file=resolveWorkerAssignmentStorePath('orchestrator-pack',env);
    const implementation=await publishCurrentWorkerAssignment({file,repository:'chetwerikoff/orchestrator-pack',issueNumber:1416,
      taskId:'task_1',kind:'local',provider:'orca',bindingKey:'dispatch_old',role:'worker'});
    if(!implementation.ok)throw new Error(implementation.reason);
    let calls=0;
    const result=await runSupervisedWorkerStart({role:'worker',issueNumber:1416,
      repository:'chetwerikoff/orchestrator-pack',env,
      delegatedIntegration:{
        prNumber:926,expectedHeadSha:'a'.repeat(40),predecessorAssignmentId:'wa-stale',predecessorGeneration:1,
      },
      orcaArgs:args(),
      inspect:async()=>{calls+=1;return{ok:true,stdout:''}},
      execute:async()=>{calls+=1;return{ok:true,stdout:''}},
    });
    expect(result).toEqual({ok:false,reason:'delegated_integration_predecessor_mismatch'});
    expect(calls).toBe(0);
    expect(currentWorkerAssignment(file,1416)).toEqual(implementation.assignment);
  });

  it('rejects exact-terminal reuse when an exited exact worker releaseState is unknown', async () => {
    const base = root();
    const env = { ...process.env, OPK_BASE_DIR: base };
    const file = resolveWorkerAssignmentStorePath('orchestrator-pack', env);
    const old = await publishCurrentWorkerAssignment({
      file,
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1416,
      taskId: 'task_old',
      kind: 'local',
      provider: 'orca',
      bindingKey: 'dispatch_old',
      role: 'worker',
    });
    if (!old.ok) throw new Error(old.reason);
    const runJson = vi.fn((): OrcaJsonResponse => ({
      ok: true,
      result: {
        worker: { agent_terminal_handle: canonicalTerminal },
        observation: { exactWorker: true, status: 'exited' },
        terminalResource: {
          terminalHandle: canonicalTerminal,
          worktreeId: canonicalWorktree,
          originDispatchId: 'dispatch_old',
          ownerDispatchId: 'dispatch_old',
          releaseState: 'unknown',
        },
      },
    }));
    let starts = 0;
    const result = await runSupervisedWorkerStart({
      role: 'worker',
      issueNumber: 1416,
      repository: 'chetwerikoff/orchestrator-pack',
      env,
      orcaArgs: args('task_new'),
      adapter: new OrcaTaskRuntimeAdapter({ runJson: runJson as never, env }),
      inspect: inspectPlacement(),
      execute: async () => {
        starts += 1;
        return { ok: true, stdout: envelope({ taskId: 'task_new', dispatchId: 'dispatch_new', state: 'ready', effects: producerEffects() }) };
      },
    });
    expect(result).toEqual({ ok: false, reason: 'target_unresolved', errorMessage: 'terminal_reuse_unauthorized' });
    expect(starts).toBe(0);
    expect(currentWorkerAssignment(file, 1416)).toEqual(old.assignment);
    expect(runJson.mock.calls.some((call) => call[0]?.slice(0, 2).join(' ') === 'terminal close')).toBe(false);
  });

  it('canonicalizes the requested producer placement and publishes only after a matching real-shape ready receipt',async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base};
    const result=await runSupervisedWorkerStart({role:'worker',
      issueNumber:1416, repository:'chetwerikoff/orchestrator-pack', env, orcaArgs:args(),
      inspect:inspectPlacement(),
      execute:async()=>({ok:true,stdout:envelope({
        runId:'run_1',taskId:'task_1',dispatchId:'dispatch_1',state:'ready',effects:producerEffects(),
      })}),
    });
    expect(result).toMatchObject({ok:true,reason:'ready_and_assignment_bound',assignment:{kind:'local',provider:'orca',bindingKey:'dispatch_1',generation:1}});
    const file=resolveWorkerAssignmentStorePath('orchestrator-pack',env);
    const stored=readFileSync(file,'utf8');
    expect(stored).not.toContain(canonicalTerminal);
    expect(stored).not.toContain(canonicalWorktree);
  });

  it('accepts producer reused_agent_terminal only when it names the exact requested terminal',async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base};
    const result=await runSupervisedWorkerStart({role:'worker',
      issueNumber:1416,repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),inspect:inspectPlacement(),
      execute:async()=>({ok:true,stdout:envelope({taskId:'task_1',dispatchId:'dispatch_1',state:'ready',effects:producerEffects({terminalAction:'reused_agent_terminal'})})}),
    });
    expect(result).toMatchObject({ok:true,assignment:{bindingKey:'dispatch_1'}});
  });

  it.each([
    ['supervised_start_terminal_mismatch', producerEffects({terminal:'foreign-terminal'})],
    ['supervised_start_worktree_mismatch', producerEffects({worktree:'repo::foreign-worktree'})],
    ['supervised_start_terminal_action_mismatch', producerEffects({terminalAction:'created'})],
  ] as const)('rejects producer placement mismatch %s before assignment publication',async(reason,effects)=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base};
    const result=await runSupervisedWorkerStart({role:'worker',
      issueNumber:1416,repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),inspect:inspectPlacement(),
      execute:async()=>({ok:true,stdout:envelope({taskId:'task_1',dispatchId:'dispatch_1',state:'ready',effects})}),
    });
    expect(result).toMatchObject({ok:false,reason});
    expect(currentWorkerAssignment(resolveWorkerAssignmentStorePath('orchestrator-pack',env),1416)).toBeNull();
  });

  it('fails closed before worker-start when terminal and worktree producer readbacks do not bind to each other',async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base}; let starts=0;
    const result=await runSupervisedWorkerStart({role:'worker',
      issueNumber:1416,repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),
      inspect:inspectPlacement({terminalWorktree:'repo::other'}),
      execute:async()=>{starts+=1;return{ok:true,stdout:envelope({taskId:'task_1',dispatchId:'d',state:'ready',effects:producerEffects()})}},
    });
    expect(result).toEqual({ok:false,reason:'supervised_start_terminal_worktree_mismatch'});
    expect(starts).toBe(0);
  });

  it('fails closed when the ready receipt omits producer terminal/worktree identity witnesses',async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base};
    const result=await runSupervisedWorkerStart({role:'worker',
      issueNumber:1416,repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),inspect:inspectPlacement(),
      execute:async()=>({ok:true,stdout:envelope({taskId:'task_1',dispatchId:'d',state:'ready',effects:[]})}),
    });
    expect(result).toMatchObject({ok:false,reason:'supervised_start_worktree_witness_unavailable'});
  });

  it.each(['busy','idle'] as const)('returns skipped_live and does not invoke start when current local target is %s',async(liveness)=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base}; const file=resolveWorkerAssignmentStorePath('orchestrator-pack',env);
    const old=await publishCurrentWorkerAssignment({file,repository:'chetwerikoff/orchestrator-pack',issueNumber:1416,taskId:'task_1',kind:'local',provider:'orca',bindingKey:'dispatch_old',role:'worker'});
    if(!old.ok)throw new Error(old.reason); let calls=0;
    const result=await runSupervisedWorkerStart({role:'worker',
      issueNumber:1416,repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),adapter:adapter({kind:'resolved',worker},liveness),
      inspect:inspectPlacement(),
      execute:async()=>{calls+=1;return{ok:true,stdout:envelope({taskId:'task_1',dispatchId:'dispatch_new',state:'ready',effects:producerEffects()})}},
    });
    expect(result).toEqual({ok:false,reason:'skipped_live'}); expect(calls).toBe(0); expect(currentWorkerAssignment(file,1416)).toEqual(old.assignment);
  });

  it('starts a new task on the same retained exact live terminal after a failed dispatch',async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base,OPK_DISPATCH_TERMINAL_MAIL_LEDGER:path.join(base,'terminal-mail-ledger.json')}; const file=resolveWorkerAssignmentStorePath('orchestrator-pack',env);
    const old=await publishCurrentWorkerAssignment({file,repository:'chetwerikoff/orchestrator-pack',issueNumber:1416,taskId:'task_old',kind:'local',provider:'orca',bindingKey:'dispatch_old',role:'worker'});
    if(!old.ok)throw new Error(old.reason);
    const order: string[]=[];
    const shown={
      ...terminallyFailedExactLiveRetainedShow(),
      dispatch:{id:'dispatch_old',status:'failed',last_heartbeat_at:null,run_id:'run_old'},
    };
    const runJson=vi.fn((cliArgs: readonly string[]): OrcaJsonResponse => {
      const operation=`${cliArgs[0] ?? ''} ${cliArgs[1] ?? ''}`;
      order.push(operation);
      if(operation==='orchestration worker-show') return {ok:true,result:shown};
      if(operation==='orchestration send'){
        expect(cliArgs).toEqual(expect.arrayContaining(['--run','run_old','--dispatch-id','dispatch_old']));
        return {ok:true,result:{message_id:'msg-terminal'}};
      }
      return {ok:false,error:{code:'unexpected_operation',message:operation}};
    });
    let calls=0;
    const result=await runSupervisedWorkerStart({role:'worker',
      issueNumber:1416,repository:'chetwerikoff/orchestrator-pack',env,
      orcaArgs:args('task_new'),
      adapter:new OrcaTaskRuntimeAdapter({
        runJson:runJson as never,
        env,
      }),
      inspect:inspectPlacement(),
      execute:async()=>{
        order.push('worker-start');
        calls+=1;
        return{ok:true,stdout:envelope({taskId:'task_new',dispatchId:'dispatch_new',state:'ready',effects:producerEffects()})};
      },
    });
    expect(result).toMatchObject({ok:true,reason:'ready_and_assignment_bound',assignment:{taskId:'task_new',bindingKey:'dispatch_new'}});
    expect(calls).toBe(1);
    expect(currentWorkerAssignment(file,1416)).toMatchObject({taskId:'task_new',bindingKey:'dispatch_new'});
    expect(order.indexOf('orchestration send')).toBeGreaterThan(order.indexOf('orchestration worker-show'));
    expect(order.indexOf('worker-start')).toBeGreaterThan(order.indexOf('orchestration send'));
    expect(runJson.mock.calls.some((call)=>call[0]?.slice(0,2).join(' ')==='terminal close')).toBe(false);
  });

  it('keeps the old assignment when terminal-mail send fails',async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base,OPK_DISPATCH_TERMINAL_MAIL_LEDGER:path.join(base,'failed-mail-ledger.json')}; const file=resolveWorkerAssignmentStorePath('orchestrator-pack',env);
    const old=await publishCurrentWorkerAssignment({file,repository:'chetwerikoff/orchestrator-pack',issueNumber:1416,taskId:'task_old',kind:'local',provider:'orca',bindingKey:'dispatch_old',role:'worker'});
    if(!old.ok)throw new Error(old.reason);
    const shown={
      dispatch:{id:'dispatch_old',status:'failed',last_heartbeat_at:null,run_id:'run_failed_mail'},
      worker:{agent_terminal_handle:canonicalTerminal},
      terminal:{handle:canonicalTerminal},
      observation:{exactWorker:true,status:'live'},
      terminalResource:{terminalHandle:canonicalTerminal,worktreeId:'wt-mail-failed',originDispatchId:'dispatch_old',ownerDispatchId:'dispatch_old',releaseState:'retained'},
    };
    const runJson=vi.fn((cliArgs: readonly string[]): OrcaJsonResponse => {
      const operation=`${cliArgs[0] ?? ''} ${cliArgs[1] ?? ''}`;
      if(operation==='orchestration worker-show') return {ok:true,result:shown};
      if(operation==='orchestration send') return {ok:false,error:{code:'send_failed',message:'terminal mail unavailable'}};
      return {ok:false,error:{code:'unexpected_operation',message:operation}};
    });
    let starts=0;
    const result=await runSupervisedWorkerStart({role:'worker',
      issueNumber:1416,repository:'chetwerikoff/orchestrator-pack',env,
      orcaArgs:args('task_blocked'),
      adapter:new OrcaTaskRuntimeAdapter({runJson:runJson as never,env}),
      inspect:inspectPlacement(),
      execute:async()=>{starts+=1;return{ok:true,stdout:envelope({taskId:'task_blocked',dispatchId:'dispatch_new',state:'ready',effects:producerEffects()})};},
    });
    expect(result).toEqual({ok:false,reason:'target_unresolved',errorMessage:'native cause unavailable'});
    expect(starts).toBe(0);
    expect(currentWorkerAssignment(file,1416)).toEqual(old.assignment);
    expect(runJson.mock.calls.some((call)=>call[0]?.slice(0,2).join(' ')==='orchestration send')).toBe(true);
    expect(runJson.mock.calls.some((call)=>call[0]?.slice(0,2).join(' ')==='terminal close')).toBe(false);
  });

  it('refuses a different terminal and does not start a second worker',async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base}; const file=resolveWorkerAssignmentStorePath('orchestrator-pack',env);
    const old=await publishCurrentWorkerAssignment({file,repository:'chetwerikoff/orchestrator-pack',issueNumber:1416,taskId:'task_old',kind:'local',provider:'orca',bindingKey:'dispatch_old',role:'worker'});
    if(!old.ok)throw new Error(old.reason);
    const runJson=vi.fn((): OrcaJsonResponse => ({ok:true,result:terminallyFailedExactLiveRetainedShow()}));
    let calls=0;
    const result=await runSupervisedWorkerStart({role:'worker',
      issueNumber:1416,repository:'chetwerikoff/orchestrator-pack',env,
      orcaArgs:argsForTerminal('terminal:foreign-owned','task_new'),
      adapter:new OrcaTaskRuntimeAdapter({runJson:runJson as never}),
      inspect:inspectPlacement({terminal:'foreign-terminal'}),
      execute:async()=>{calls+=1;return{ok:true,stdout:envelope({taskId:'task_new',dispatchId:'dispatch_new',state:'ready',effects:producerEffects({terminal:'foreign-terminal'})})}},
    });
    expect(result).toEqual({ok:false,reason:'target_unresolved',errorMessage:'native cause unavailable'});
    expect(calls).toBe(0);
    expect(currentWorkerAssignment(file,1416)).toEqual(old.assignment);
  });

  it('rejects a missing/failed/retained historical terminal on all three repeated start attempts', async () => {
    const base = root();
    const env = { ...process.env, OPK_BASE_DIR: base };
    const file = resolveWorkerAssignmentStorePath('orchestrator-pack', env);
    const old = await publishCurrentWorkerAssignment({
      file, repository: 'chetwerikoff/orchestrator-pack', issueNumber: 1416, taskId: 'task_1',
      kind: 'local', provider: 'orca', bindingKey: 'dispatch_old', role: 'worker',
    });
    if (!old.ok) throw new Error(old.reason);
    const shown = {
      dispatch: { status: 'failed', last_heartbeat_at: null },
      worker: { agent_terminal_handle: canonicalTerminal },
      terminal: null,
      observation: { exactWorker: false, status: 'missing' },
      terminalResource: {
        terminalHandle: canonicalTerminal, worktreeId: canonicalWorktree,
        originDispatchId: 'dispatch_old', ownerDispatchId: 'dispatch_old', releaseState: 'retained',
      },
    };
    const runJson = vi.fn((): OrcaJsonResponse => ({ ok: true, result: shown }));
    let starts = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await runSupervisedWorkerStart({
        role: 'worker', repository: 'chetwerikoff/orchestrator-pack', issueNumber: 1416,
        env, orcaArgs: args(), inspect: inspectPlacement(),
        adapter: new OrcaTaskRuntimeAdapter({ runJson: runJson as never, env }),
        execute: async () => {
          starts += 1;
          return { ok: true, stdout: envelope({ taskId: 'task_1', dispatchId: 'dispatch_new', state: 'ready' }) };
        },
      });
      expect(result).toEqual({ ok: false, reason: 'target_unresolved', errorMessage: 'terminal_reuse_unauthorized' });
      expect(currentWorkerAssignment(file, 1416)).toEqual(old.assignment);
    }
    expect(starts).toBe(0);
  });

  it('admits the native-proven missing/failed/retained predecessor on a different terminal only', async () => {
    const base = root();
    const env = { ...process.env, OPK_BASE_DIR: base };
    const file = resolveWorkerAssignmentStorePath('orchestrator-pack', env);
    const old = await publishCurrentWorkerAssignment({
      file, repository: 'chetwerikoff/orchestrator-pack', issueNumber: 1416, taskId: 'task_1',
      kind: 'local', provider: 'orca', bindingKey: 'dispatch_old', role: 'worker',
    });
    if (!old.ok) throw new Error(old.reason);
    const runJson = vi.fn((): OrcaJsonResponse => ({
      ok: true,
      result: {
        dispatch: { status: 'failed', last_heartbeat_at: null },
        worker: { agent_terminal_handle: canonicalTerminal },
        terminal: null,
        observation: { exactWorker: false, status: 'missing' },
        terminalResource: {
          terminalHandle: canonicalTerminal, worktreeId: canonicalWorktree,
          originDispatchId: 'dispatch_old', ownerDispatchId: 'dispatch_old', releaseState: 'retained',
        },
      },
    }));
    let starts = 0;
    const result = await runSupervisedWorkerStart({
      role: 'worker', issueNumber: 1416, repository: 'chetwerikoff/orchestrator-pack', env,
      orcaArgs: argsForTerminal('terminal:fresh', 'task_1'),
      adapter: new OrcaTaskRuntimeAdapter({ runJson: runJson as never, env }),
      inspect: inspectPlacement({ terminal: 'term-fresh' }),
      execute: async () => {
        starts += 1;
        return { ok: true, stdout: envelope({
          taskId: 'task_1', dispatchId: 'dispatch_new', state: 'ready', effects: producerEffects({ terminal: 'term-fresh' }),
        }) };
      },
    });
    expect(result).toMatchObject({
      ok: true, reason: 'ready_and_assignment_bound',
      assignment: { taskId: 'task_1', bindingKey: 'dispatch_new', generation: 2 },
    });
    expect(result.assignment?.assignmentId).not.toBe(old.assignment.assignmentId);
    expect(starts).toBe(1);
    expect(currentWorkerAssignment(file, 1416)?.bindingKey).toBe('dispatch_new');
  });

  it.each([
    { name: 'first native terminal read is unavailable', firstHandle: null, expectedReason: 'target_unresolved' },
    { name: 'native terminal identity changes before placement', firstHandle: 'term-fresh', expectedReason: 'supervised_start_terminal_witness_changed' },
  ])('blocks retained old-terminal reuse when $name', async ({ firstHandle, expectedReason }) => {
    const base = root();
    const env = { ...process.env, OPK_BASE_DIR: base };
    const file = resolveWorkerAssignmentStorePath('orchestrator-pack', env);
    const old = await publishCurrentWorkerAssignment({
      file, repository: 'chetwerikoff/orchestrator-pack', issueNumber: 1416,
      taskId: 'task_1', kind: 'local', provider: 'orca', bindingKey: 'dispatch_old', role: 'worker',
    });
    if (!old.ok) throw new Error(old.reason);
    const shown = {
      dispatch: { status: 'failed', last_heartbeat_at: null },
      worker: { agent_terminal_handle: canonicalTerminal },
      terminal: null,
      observation: { exactWorker: false, status: 'missing' },
      terminalResource: {
        terminalHandle: canonicalTerminal, worktreeId: canonicalWorktree,
        originDispatchId: 'dispatch_old', ownerDispatchId: 'dispatch_old', releaseState: 'retained',
      },
    };
    const runJson = vi.fn((): OrcaJsonResponse => ({ ok: true, result: shown }));
    const regularInspect = inspectPlacement();
    let terminalReads = 0;
    const inspect = async (inspectArgs: readonly string[]) => {
      if (inspectArgs[0] === 'terminal' && inspectArgs[1] === 'show') {
        terminalReads += 1;
        if (terminalReads === 1) {
          return firstHandle === null
            ? { ok: false, stdout: '' }
            : inspectPlacement({ terminal: firstHandle })(inspectArgs);
        }
      }
      return regularInspect(inspectArgs);
    };
    let starts = 0;
    const result = await runSupervisedWorkerStart({
      role: 'worker', issueNumber: 1416, repository: 'chetwerikoff/orchestrator-pack',
      env, orcaArgs: args(), inspect,
      adapter: new OrcaTaskRuntimeAdapter({ runJson: runJson as never, env }),
      execute: async () => {
        starts += 1;
        return { ok: true, stdout: envelope({
          taskId: 'task_1', dispatchId: 'dispatch_new', state: 'ready', effects: producerEffects(),
        }) };
      },
    });
    expect(result).toMatchObject({ ok: false, reason: expectedReason });
    if (firstHandle === null) {
      expect(result).toMatchObject({ errorMessage: 'terminal_reuse_unauthorized' });
    }
    expect(terminalReads).toBe(2);
    expect(starts).toBe(0);
    expect(currentWorkerAssignment(file, 1416)).toEqual(old.assignment);
  });

  it('uses absent-current admission after explicit retirement without recovering an old assignment identity', async () => {
    const base = root();
    const env = { ...process.env, OPK_BASE_DIR: base };
    const file = resolveWorkerAssignmentStorePath('orchestrator-pack', env);
    const old = await publishCurrentWorkerAssignment({
      file, repository: 'chetwerikoff/orchestrator-pack', issueNumber: 1416, taskId: 'task_1',
      kind: 'local', provider: 'orca', bindingKey: 'dispatch_old', role: 'worker',
    });
    if (!old.ok) throw new Error(old.reason);
    const retired = await retireCurrentWorkerAssignment({ file, expected: old.assignment });
    expect(retired.ok).toBe(true);
    let resolves = 0;
    const liveAdapter = { ...adapter({ kind: 'gone' }),
      resolveAssignmentWorker: () => {
        resolves += 1;
        throw new Error('absent current must not resolve an old Dispatch');
      },
    };
    const result = await runSupervisedWorkerStart({
      role: 'worker', issueNumber: 1416, repository: 'chetwerikoff/orchestrator-pack', env,
      orcaArgs: args(), adapter: liveAdapter, inspect: inspectPlacement(),
      execute: async () => ({
        ok: true, stdout: envelope({
          taskId: 'task_1', dispatchId: 'dispatch_new', state: 'ready', effects: producerEffects(),
        }),
      }),
    });
    expect(result).toMatchObject({
      ok: true, reason: 'ready_and_assignment_bound', assignment: { bindingKey: 'dispatch_new' },
    });
    expect(resolves).toBe(0);
    expect(result.assignment?.assignmentId).not.toBe(old.assignment.assignmentId);
  });

  it('separate operator successor advances generation only after affirmative current-local gone evidence',async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base}; const file=resolveWorkerAssignmentStorePath('orchestrator-pack',env);
    const old=await publishCurrentWorkerAssignment({file,repository:'chetwerikoff/orchestrator-pack',issueNumber:1416,taskId:'task_1',kind:'local',provider:'orca',bindingKey:'dispatch_old',role:'worker'});
    if(!old.ok)throw new Error(old.reason);
    const result=await runSupervisedWorkerStart({role:'worker',
      issueNumber:1416,repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),adapter:adapter({kind:'gone'}),inspect:inspectPlacement(),
      execute:async()=>({ok:true,stdout:envelope({taskId:'task_1',dispatchId:'dispatch_new',state:'ready',effects:producerEffects()})}),
    });
    expect(result).toMatchObject({ok:true,assignment:{generation:2,bindingKey:'dispatch_new'}});
    expect(result.assignment?.assignmentId).not.toBe(old.assignment.assignmentId);
  });

  it('exposes a non-authoritative operator-manual residual when reassignment wins after ready',async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base}; const file=resolveWorkerAssignmentStorePath('orchestrator-pack',env);
    const old=await publishCurrentWorkerAssignment({file,repository:'chetwerikoff/orchestrator-pack',issueNumber:1416,taskId:'task_1',kind:'local',provider:'orca',bindingKey:'dispatch_old',role:'worker'});
    if(!old.ok)throw new Error(old.reason); let winnerId='';
    const effects=producerEffects();
    const result=await runSupervisedWorkerStart({role:'worker',
      issueNumber:1416,repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),adapter:adapter({kind:'gone'}),inspect:inspectPlacement(),
      execute:async()=>{
        const winner=await publishCurrentWorkerAssignment({file,repository:'chetwerikoff/orchestrator-pack',issueNumber:1416,taskId:'task_1',kind:'remote',provider:'browser-gpt',bindingKey:'remote-winner',expectedCurrent:{assignmentId:old.assignment.assignmentId,generation:old.assignment.generation},role:'worker'});
        if(!winner.ok)throw new Error(winner.reason); winnerId=winner.assignment.assignmentId;
        return{ok:true,stdout:envelope({taskId:'task_1',dispatchId:'dispatch_residual',state:'ready',effects})};
      },
    });
    expect(result).toMatchObject({
      ok:false,reason:'assignment_stale',
      residual:{authority:'non_authoritative',disposition:'operator_manual',taskId:'task_1',dispatchId:'dispatch_residual',expectedCurrent:{kind:'exact',assignmentId:old.assignment.assignmentId,generation:1},publicationReason:'assignment_stale',residualResources:effects},
    });
    expect(currentWorkerAssignment(file,1416)?.assignmentId).toBe(winnerId);
  });

  it('exposes the same residual class for publication lock exhaustion after ready',async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base}; const file=resolveWorkerAssignmentStorePath('orchestrator-pack',env);
    let release!:()=>void; let held:Promise<unknown>|undefined;
    const effects=producerEffects();
    const run=runSupervisedWorkerStart({role:'worker',
      issueNumber:1416,repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),inspect:inspectPlacement(),
      execute:async()=>{
        held=withCrashRecoverableFileLock(`${file}.lock`,1,async()=>{await new Promise<void>((resolve)=>{release=resolve})});
        while(!release) await new Promise((resolve)=>setTimeout(resolve,1));
        return{ok:true,stdout:envelope({taskId:'task_1',dispatchId:'dispatch_busy',state:'ready',effects})};
      },
    });
    const result=await run;
    expect(result).toMatchObject({ok:false,reason:'assignment_store_busy',residual:{authority:'non_authoritative',disposition:'operator_manual',dispatchId:'dispatch_busy',expectedCurrent:{kind:'none'},publicationReason:'assignment_store_busy'}});
    expect(currentWorkerAssignment(file,1416)).toBeNull();
    release(); await held;
  });

  it('rejects malformed/failed/mismatched ready receipts without publication',async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base}; const inspect=inspectPlacement();
    const mismatch=await runSupervisedWorkerStart({role:'worker',issueNumber:1416,repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args('task_expected'),inspect,execute:async()=>({ok:true,stdout:envelope({taskId:'other',dispatchId:'d',state:'ready',effects:producerEffects()})})});
    expect(mismatch).toMatchObject({ok:false,reason:'supervised_start_task_mismatch'});
    const failed=await runSupervisedWorkerStart({role:'worker',issueNumber:1416,repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),inspect,execute:async()=>({ok:false,stdout:envelope({taskId:'task_1',dispatchId:'d',state:'outcome_unknown'},false)})});
    expect(failed).toMatchObject({ok:false,reason:'supervised_start_envelope_not_ok'});
    expect(currentWorkerAssignment(resolveWorkerAssignmentStorePath('orchestrator-pack',env),1416)).toBeNull();
  });

  it('preserves an exact Orca error code instead of laundering it into an invalid receipt', async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base};
    const result=await runSupervisedWorkerStart({role:'worker',
      repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),inspect:inspectPlacement(),
      execute:async()=>({
        ok:false,
        stdout:JSON.stringify({ok:false,error:{code:'agent_unconfigured',message:'agent is not configured'}}),
      }),
    });
    expect(result).toEqual({ok:false,reason:'supervised_start_envelope_error',errorCode:'agent_unconfigured',errorMessage:'agent is not configured'});
  });

  it('preserves exact Orca mutation recovery fields without promoting the failed start', async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base};
    const pending=await runSupervisedWorkerStart({role:'worker',
      repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),inspect:inspectPlacement(),
      execute:async()=>({
        ok:false,
        stdout:JSON.stringify({ok:false,error:{
          code:'operation_unknown',message:'accepted before restart',
          data:{requestId:'request-7',dispatchId:'dispatch-7',recoveryCommand:'orca orchestration worker-show --dispatch dispatch-7 --json',nextSteps:[' inspect logs ','retry once']},
        }}),
      }),
    });
    expect(pending).toEqual({
      ok:false,reason:'supervised_start_envelope_error',errorCode:'operation_unknown',errorMessage:'accepted before restart',
      nextSteps:['inspect logs','retry once'],
      recovery:{requestId:'request-7',dispatchId:'dispatch-7',recoveryCommand:'orca orchestration worker-show --dispatch dispatch-7 --json'},
    });
    const transportUnknown=await runSupervisedWorkerStart({role:'worker',
      repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),inspect:inspectPlacement(),
      execute:async()=>({
        ok:false,
        stdout:JSON.stringify({ok:false,error:{code:'runtime_timeout',message:'timeout',data:{orchestrationRequestId:'request-8'}}}),
      }),
    });
    expect(transportUnknown).toEqual({
      ok:false,reason:'supervised_start_envelope_error',errorCode:'runtime_timeout',errorMessage:'timeout',recovery:{requestId:'request-8'},
    });
    expect(currentWorkerAssignment(resolveWorkerAssignmentStorePath('orchestrator-pack',env),1416)).toBeNull();
  });

  it.each([
    ['numeric request id', {requestId:123,dispatchId:'dispatch-7',recoveryCommand:'orca orchestration worker-show --dispatch dispatch-7 --json'}],
    ['object request id', {orchestrationRequestId:{id:'request-8'},dispatchId:'dispatch-8'}],
    ['conflicting request ids', {orchestrationRequestId:'request-a',requestId:'request-b',dispatchId:'dispatch-9'}],
  ] as const)('does not promote malformed recovery authority: %s', async(_label,data)=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base};
    const result=await runSupervisedWorkerStart({role:'worker',
      repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),inspect:inspectPlacement(),
      execute:async()=>({
        ok:false,
        stdout:JSON.stringify({ok:false,error:{code:'operation_unknown',message:'unknown outcome',data}}),
      }),
    });
    expect(result).toEqual({ok:false,reason:'supervised_start_envelope_error',errorCode:'operation_unknown',errorMessage:'unknown outcome'});
  });

  it('bounds provider error message and next-step evidence', async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base};
    const result=await runSupervisedWorkerStart({role:'worker',
      repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),inspect:inspectPlacement(),
      execute:async()=>({ok:false,stdout:JSON.stringify({ok:false,error:{code:'provider_failed',
        message:'  provider message  ',data:{nextSteps:[' first ',7,'x'.repeat(513),...Array.from({length:9},(_,i)=>`keep-${i}`)]}}})}),
    });
    expect(result).toEqual({ok:false,reason:'supervised_start_envelope_error',errorCode:'provider_failed',
      errorMessage:'provider message',nextSteps:['first','keep-0','keep-1','keep-2','keep-3','keep-4','keep-5','keep-6']});
  });

  it('keeps malformed and code-less error envelopes on the generic invalid path', async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base};
    const malformed=await runSupervisedWorkerStart({role:'worker',
      repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),inspect:inspectPlacement(),
      execute:async()=>({ok:false,stdout:'{not-json'}),
    });
    expect(malformed).toEqual({ok:false,reason:'supervised_start_receipt_invalid'});
    const codeLess=await runSupervisedWorkerStart({role:'worker',
      repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),inspect:inspectPlacement(),
      execute:async()=>({ok:false,stdout:JSON.stringify({ok:false,error:{message:'missing code'}})}),
    });
    expect(codeLess).toEqual({ok:false,reason:'supervised_start_receipt_invalid'});
  });

  it('publishes a brief-only successful start under the sole taskId+dispatchId key and attaches Issue metadata without rekeying', async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base};
    const result=await runSupervisedWorkerStart({role:'worker',
      repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args('brief-task'),inspect:inspectPlacement(),
      execute:async()=>({ok:true,stdout:envelope({taskId:'brief-task',dispatchId:'dispatch-1441',state:'ready',effects:producerEffects()})}),
    });
    expect(result.ok).toBe(true);
    if(!result.ok||!result.assignment)throw new Error('expected assignment');
    expect(result.assignment.issueNumber).toBeUndefined();
    const file=resolveWorkerAssignmentStorePath('orchestrator-pack',env);
    const key=workerAssignmentKey('brief-task','dispatch-1441');
    const store=readWorkerAssignmentStore(file);
    expect(store).not.toBeNull();
    expect(Object.keys(store!.assignments)).toEqual([key]);
    const assignmentId=result.assignment.assignmentId;
    const generation=result.assignment.generation;
    const attached=await attachWorkerAssignmentIssueNumber({file,expected:result.assignment,issueNumber:1441});
    expect(attached.ok).toBe(true);
    if(!attached.ok)throw new Error(attached.reason);
    expect(attached.assignment).toMatchObject({issueNumber:1441,assignmentId,generation,taskId:'brief-task',bindingKey:'dispatch-1441'});
    expect(Object.keys(readWorkerAssignmentStore(file)!.assignments)).toEqual([key]);
  });

  it('migrates a recognized issue-N store then publishes the new assignment with an explicit role', async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base};
    const file=resolveWorkerAssignmentStorePath('orchestrator-pack',env);
    mkdirSync(path.dirname(file),{recursive:true});
    const oldAssignment={
      schema:'orchestrator-pack/worker-assignment/v1',projectId:'orchestrator-pack',repository:'chetwerikoff/orchestrator-pack',
      issueNumber:1441,taskId:'old-task',assignmentId:'wa-old',generation:1,kind:'local',provider:'orca',bindingKey:'dispatch-old',
      createdAtUtc:'2026-08-17T00:00:00.000Z',
    };
    const oldBytes=`${JSON.stringify({schema:'orchestrator-pack/worker-assignment-store/v1',revision:1,assignments:{'issue-1441':oldAssignment}},null,2)}\n`;
    writeFileSync(file,oldBytes);
    const parsed=parseWorkerAssignmentStore(oldBytes);
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!.assignments)).toEqual([workerAssignmentKey('old-task','dispatch-old')]);
    const result=await runSupervisedWorkerStart({role:'worker',
      repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args('brief-task'),inspect:inspectPlacement(),
      execute:async()=>({ok:true,stdout:envelope({taskId:'brief-task',dispatchId:'dispatch-1441',state:'ready',effects:producerEffects()})}),
    });
    expect(result.ok).toBe(true);
    if(!result.ok||!result.assignment)throw new Error('expected assignment');
    expect(result.assignment.role).toBe('worker');
    const live=readWorkerAssignmentStore(file);
    expect(Object.keys(live!.assignments).sort()).toEqual([
      workerAssignmentKey('brief-task','dispatch-1441'),
      workerAssignmentKey('old-task','dispatch-old'),
    ].sort());
    expect(live!.assignments[workerAssignmentKey('old-task','dispatch-old')]).toEqual(oldAssignment);
    expect(Object.prototype.hasOwnProperty.call(live!.assignments[workerAssignmentKey('old-task','dispatch-old')],'role')).toBe(false);
    expect(readFileSync(`${file}.pre-task-dispatch-migration`,'utf8')).toBe(oldBytes);
  });

  it('preserves the concrete migration cause when registration fails after a ready local receipt', async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base};
    const file=resolveWorkerAssignmentStorePath('orchestrator-pack',env);
    mkdirSync(path.dirname(file),{recursive:true});
    const oldAssignment={
      schema:'orchestrator-pack/worker-assignment/v1',projectId:'orchestrator-pack',repository:'chetwerikoff/orchestrator-pack',
      issueNumber:1441,taskId:'old-task',assignmentId:'wa-old',generation:1,kind:'local',provider:'orca',bindingKey:'dispatch-old',
      createdAtUtc:'2026-08-17T00:00:00.000Z',
    };
    const oldBytes=`${JSON.stringify({schema:'orchestrator-pack/worker-assignment-store/v1',revision:1,assignments:{'issue-1441':oldAssignment}},null,2)}\n`;
    writeFileSync(file,oldBytes);
    writeFileSync(`${file}.pre-task-dispatch-migration`,'conflicting-backup');
    const effects=producerEffects();
    const result=await runSupervisedWorkerStart({role:'worker',
      repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args('brief-task'),inspect:inspectPlacement(),
      execute:async()=>({ok:true,stdout:envelope({taskId:'brief-task',dispatchId:'dispatch-1441',state:'ready',effects})}),
    });
    expect(result).toMatchObject({
      ok:false,
      reason:'assignment_store_untrusted',
      cause:'migration_backup_conflict',
      receipt:{taskId:'brief-task',dispatchId:'dispatch-1441',state:'ready'},
      residualResources:effects,
    });
    expect(readFileSync(file,'utf8')).toBe(oldBytes);
  });

  it.each([undefined,'',' worker ','Worker','ORCHESTRATOR','admin'] as const)(
    'rejects role %j before inspect/start',
    async(role)=>{
      const base=root(); const env={...process.env,OPK_BASE_DIR:base}; let inspects=0; let starts=0;
      const result=await runSupervisedWorkerStart({
        ...(role===undefined?{}:{role}),
        repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),
        inspect:async()=>{inspects+=1;return{ok:true,stdout:''}},
        execute:async()=>{starts+=1;return{ok:true,stdout:''}},
      });
      expect(result).toEqual({ok:false,reason:'assignment_role_invalid'});
      expect(inspects).toBe(0);
      expect(starts).toBe(0);
    },
  );

  it.each([
    ['split model and effort', ['--model','model','--effort','medium']],
    ['mixed model and effort', ['--model','model-medium','--effort','medium']],
    ['incomplete model', ['--model']],
  ] as const)('rejects provider model composition before mutation: %s', async(_label,modelFlags)=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base}; let calls=0;
    const result=await runSupervisedWorkerStart({mode:'provider_new_top_level',role:'worker',repository:'chetwerikoff/orchestrator-pack',env,
      orcaArgs:['--task','task_1','--worktree','new-top-level','--repo','id:repo-1','--name','new-worktree','--agent','cursor',...modelFlags,'--setup','run'],
      execute:async()=>{ calls+=1; return {ok:true,stdout:''}; },
    });
    expect(result).toEqual({ok:false,reason:'supervised_start_provider_request_invalid'});
    expect(calls).toBe(0);
  });

  it('refuses direct provider_new_top_level CLI before any native worker/setup effect', () => {
    const base = root();
    const primary = path.join(base, 'primary');
    const config = path.join(base, 'xdg', 'orchestrator-pack', 'projects');
    const fakeBin = path.join(base, 'bin');
    const markerFile = path.join(base, 'orca-called');
    mkdirSync(primary, { recursive: true });
    mkdirSync(config, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    const init = runProcessSync({ command: 'git', args: ['init', '-q', primary], inheritParentEnv: true });
    expect(init.exitCode).toBe(0);
    const remote = runProcessSync({ command: 'git', args: ['-C', primary, 'remote', 'add', 'origin',
      'https://github.com/chetwerikoff/orchestrator-pack.git'], inheritParentEnv: true });
    expect(remote.exitCode).toBe(0);
    writeFileSync(path.join(config, 'orchestrator-pack.json'), JSON.stringify({
      projectId: 'orchestrator-pack', repository: 'chetwerikoff/orchestrator-pack',
      primaryRoot: primary, defaultBranch: 'main',
      orcaWorkspacePattern: '^opk-.*$', orchestratorTitlePattern: '^opk-manager-.*$',
      browserGpt: { projectUrl: 'https://chatgpt.com/g/g-test' },
    }));
    const fakeOrca = path.join(fakeBin, 'orca');
    writeFileSync(fakeOrca, '#!/bin/sh\nprintf effect >> "$OPK_ORCA_EFFECT_MARKER"\nexit 42\n');
    chmodSync(fakeOrca, 0o755);
    const env = {
      ...process.env, OPK_BASE_DIR: base, XDG_CONFIG_HOME: path.join(base, 'xdg'),
      OPK_PROJECT_ID: 'orchestrator-pack', OPK_ORCA_EFFECT_MARKER: markerFile,
      PATH: fakeBin + ':' + (process.env.PATH ?? ''),
    };
    const run = runProcessSync({ command: process.execPath, args: ['--experimental-strip-types',
      fileURLToPath(new URL('./supervised-worker-start.ts', import.meta.url)),
      '--project', 'orchestrator-pack', '--repository', 'chetwerikoff/orchestrator-pack',
      '--role', 'worker', '--mode', 'provider_new_top_level', '--',
      '--task', 'task_1', '--worktree', 'new-top-level', '--repo', 'id:repo-1',
      '--name', 'unsafe-hook-output', '--agent', 'cursor', '--model', 'model-medium',
      '--setup', 'run',
    ], env, timeoutMs: 15_000 });
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain('"reason":"supervised_start_provider_clean_witness_unavailable"');
    expect(existsSync(markerFile)).toBe(false);
    expect(currentWorkerAssignment(resolveWorkerAssignmentStorePath('orchestrator-pack', env), 1416)).toBeNull();
  });

  it('refuses direct atomic provider start before any setup or worker effect', async () => {
    const base = root(); const env = { ...process.env, OPK_BASE_DIR: base };
    let starts = 0; let inspects = 0;
    const result = await runSupervisedWorkerStart({
      mode: 'provider_new_top_level', role: 'worker', issueNumber: 1416,
      repository: 'chetwerikoff/orchestrator-pack', env,
      orcaArgs: ['--task', 'task_1', '--worktree', 'new-top-level',
        '--repo', 'id:repo-1', '--name', 'new-worktree',
        '--agent', 'cursor', '--model', 'model-medium', '--setup', 'run'],
      inspect: async () => { inspects += 1; return { ok: false, stdout: '' }; },
      execute: async () => { starts += 1; return { ok: true, stdout: envelope({
        taskId: 'task_1', dispatchId: 'dispatch_provider', state: 'ready',
        setup: { requested: 'run', state: 'running' },
        effects: [{ kind: 'dispatch_input', role: 'agent', state: 'accepted' }],
      }) }; },
    });
    expect(result).toEqual({ ok: false, reason: 'supervised_start_provider_clean_witness_unavailable' });
    expect(starts).toBe(0);
    expect(inspects).toBe(0);
    expect(currentWorkerAssignment(resolveWorkerAssignmentStorePath('orchestrator-pack', env), 1416)).toBeNull();
  });

  it.each([
    ['missing setup', { setup: undefined }],
    ['mismatched launch', { launch:{requested:{agent:'cursor',model:'other',effort:'medium'},effective:{agent:'cursor',model:'other',effort:'medium'}} }],
    ['missing accepted dispatch input', { effects:[
      {kind:'worktree',action:'created_top_level',id:'repo-1::/tmp/new-worktree'},
      {kind:'terminal',role:'agent',action:'reused_agent_terminal',id:'term-provider'},
    ] }],
  ] as const)('refuses atomic provider receipt %s before start', async(_label,override)=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base};
    let starts=0;
    const result=await runSupervisedWorkerStart({mode:'provider_new_top_level',role:'worker',repository:'chetwerikoff/orchestrator-pack',env,
      orcaArgs:['--task','task_1','--worktree','new-top-level','--repo','id:repo-1','--name','new-worktree','--agent','cursor','--model','model-medium','--setup','run'],
      execute:async()=>{starts+=1;return {ok:true,stdout:envelope({taskId:'task_1',dispatchId:'dispatch_provider',state:'ready',
        worktree:{id:'repo-1::/tmp/new-worktree',path:'/tmp/new-worktree'},terminal:{handle:'term-provider',runtime:'orca',generation:'generation-1'},
        setup:{requested:'run',effective:'run',state:'running'},launch:{requested:{agent:'cursor',model:'model-medium'},effective:{agent:'cursor',model:'model-medium'}},
        effects:[{kind:'worktree',action:'created_top_level',id:'repo-1::/tmp/new-worktree'},
          {kind:'terminal',role:'agent',action:'reused_agent_terminal',id:'term-provider'},
          {kind:'dispatch_input',role:'agent',id:'term-provider',state:'accepted'}],...override})};},
    });
    expect(result).toEqual({ok:false,reason:'supervised_start_provider_clean_witness_unavailable'});
    expect(starts).toBe(0);
    expect(currentWorkerAssignment(resolveWorkerAssignmentStorePath('orchestrator-pack',env),1416)).toBeNull();
  });

  it('accepts explicit orchestrator role on an otherwise valid start', async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base};
    const result=await runSupervisedWorkerStart({role:'orchestrator',
      repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),inspect:inspectPlacement(),
      execute:async()=>({ok:true,stdout:envelope({taskId:'task_1',dispatchId:'dispatch_1',state:'ready',effects:producerEffects()})}),
    });
    expect(result.ok).toBe(true);
    if(!result.ok||!result.assignment)throw new Error('expected assignment');
    expect(result.assignment.role).toBe('orchestrator');
  });
});

describe('Issue #2655 reboot terminal retirement at supervised start', () => {
  it.each(['failed', 'abandoned', 'cancelled', 'done', 'completed'] as const)(
    'starts from native %s and confirmed no-process with adapter resolve not-ok',
    async (state) => {
      const base = root();
      const env = { ...process.env, OPK_BASE_DIR: base };
      const file = resolveWorkerAssignmentStorePath('orchestrator-pack', env);
      const previous = await publishCurrentWorkerAssignment({
        file, repository: 'chetwerikoff/orchestrator-pack', issueNumber: 1416,
        taskId: 'task_6af384b00044', kind: 'local', provider: 'orca',
        bindingKey: 'ctx_3761867313e2', role: 'worker',
      });
      if (!previous.ok) throw new Error(previous.reason);
      const shown = {
        // Native worker-show is exact by --dispatch and need not repeat dispatch.id.
        dispatch: { status: state, last_heartbeat_at: null },
        worker: {
          agent_terminal_handle: ['done', 'completed'].includes(state) ? null : canonicalTerminal,
          worktree_id: canonicalWorktree,
          state: ['done', 'completed'].includes(state) ? 'succeeded' : 'abandoned',
          stage: ['done', 'completed'].includes(state) ? 'terminal' : 'terminal_missing',
        },
        terminal: null, observation: { exactWorker: false, status: 'missing' },
      };
      const adapter = new OrcaTaskRuntimeAdapter({
        runJson: vi.fn((): OrcaJsonResponse => ({ ok: true, result: shown })) as never,
        env,
      });
      const standardInspect = inspectPlacement({ terminal: 'term-fresh' });
      const inspect = async (argv: readonly string[]) => {
        if (argv[0] === 'orchestration' && argv[1] === 'dispatch-show') {
          expect(argv).toEqual(['orchestration', 'dispatch-show', '--task', 'task_6af384b00044', '--json']);
          return { ok: true, stdout: envelope({ dispatch: { id: 'ctx_3761867313e2', status: state } }) };
        }
        if (argv[0] === 'orchestration' && argv[1] === 'worker-show') {
          expect(argv).toEqual(['orchestration', 'worker-show', '--dispatch', 'ctx_3761867313e2', '--json']);
          return { ok: true, stdout: envelope(shown) };
        }
        return standardInspect(argv);
      };
      let starts = 0;
      const started = await runSupervisedWorkerStart({
        role: 'worker', repository: 'chetwerikoff/orchestrator-pack', issueNumber: 1416,
        env, adapter, inspect, orcaArgs: argsForTerminal('terminal:fresh', 'task_6af384b00044'),
        execute: async () => {
          starts += 1;
          return { ok: true, stdout: envelope({
            taskId: 'task_6af384b00044', dispatchId: 'dispatch-new', state: 'ready',
            effects: producerEffects({ terminal: 'term-fresh' }),
          }) };
        },
      });
      expect(started).toMatchObject({
        ok: true, reason: 'ready_and_assignment_bound',
        assignment: { taskId: 'task_6af384b00044', bindingKey: 'dispatch-new', generation: 2 },
      });
      expect(starts).toBe(1);
      expect(currentWorkerAssignment(file, 1416)?.assignmentId).not.toBe(previous.assignment.assignmentId);
    },
  );

  it.each([
    { name: 'live worker', status: 'live', exactWorker: true, workerState: 'ready', stage: 'input_accepted', state: 'dispatched' },
    { name: 'unknown worker', status: 'unknown', exactWorker: false, workerState: 'abandoned', stage: 'terminal_missing', state: 'failed' },
    { name: 'foreign Dispatch', status: 'missing', exactWorker: false, workerState: 'abandoned', stage: 'terminal_missing', state: 'failed', id: 'ctx_foreign' },
  ])('refuses $name without new Dispatch publication', async ({ status, exactWorker, workerState, stage, state, id }) => {
    const base = root(); const env = { ...process.env, OPK_BASE_DIR: base };
    const file = resolveWorkerAssignmentStorePath('orchestrator-pack', env);
    const previous = await publishCurrentWorkerAssignment({
      file, repository: 'chetwerikoff/orchestrator-pack', issueNumber: 1416,
      taskId: 'task_6af384b00044', kind: 'local', provider: 'orca',
      bindingKey: 'ctx_3761867313e2', role: 'worker',
    });
    if (!previous.ok) throw new Error(previous.reason);
    const shown = {
      dispatch: { id: id ?? 'ctx_3761867313e2', status: state, last_heartbeat_at: null },
      worker: { agent_terminal_handle: canonicalTerminal, state: workerState, stage },
      terminal: status === 'live' ? { handle: canonicalTerminal } : null,
      observation: { exactWorker, status },
    };
    const native = vi.fn((): OrcaJsonResponse => ({ ok: true, result: shown }));
    const inspect = async (argv: readonly string[]) => {
      if (argv[0] === 'orchestration' && argv[1] === 'dispatch-show')
        return { ok: true, stdout: envelope({ dispatch: { id: 'ctx_3761867313e2', status: state } }) };
      if (argv[0] === 'orchestration' && argv[1] === 'worker-show')
        return { ok: true, stdout: envelope(shown) };
      return inspectPlacement({ terminal: 'term-fresh' })(argv);
    };
    let starts = 0;
    const outcome = await runSupervisedWorkerStart({
      role: 'worker', repository: 'chetwerikoff/orchestrator-pack', issueNumber: 1416,
      env, adapter: new OrcaTaskRuntimeAdapter({ runJson: native as never, env }), inspect,
      orcaArgs: argsForTerminal('terminal:fresh', 'task_6af384b00044'),
      execute: async () => { starts += 1; return { ok: true, stdout: envelope({
        taskId: 'task_6af384b00044', dispatchId: 'dispatch-new', state: 'ready',
        effects: producerEffects({ terminal: 'term-fresh' }),
      }) }; },
    });
    expect(outcome.ok).toBe(false);
    expect(starts).toBe(0);
    expect(currentWorkerAssignment(file, 1416)).toEqual(previous.assignment);
  });
});

describe('Issue #2696 exact native exited orphaned terminal proof', () => {
  const taskId = 'task_4081bd3bbb04';
  const dispatchId = 'ctx_a5f5a38c2f00';
  const retainedHandle = 'term_20305996-730e-480c-92cc-f2b400a98e04';

  function nativeWorkerShow(): Record<string, unknown> {
    return {
      dispatch: { id: dispatchId, taskId, status: 'failed' },
      worker: { agent_terminal_handle: retainedHandle, worktree_id: canonicalWorktree },
      terminal: { handle: retainedHandle, orphaned: true, connected: false, writable: false },
      observation: { status: 'exited', exactWorker: true },
      terminalResource: {
        kind: 'external_terminal', releaseState: 'retained', terminalHandle: retainedHandle,
        worktreeId: canonicalWorktree, originDispatchId: dispatchId, ownerDispatchId: dispatchId,
      },
    };
  }

  function nativeInspect(
    shown: Record<string, unknown>,
    selectedStatus = 'failed',
    selectedId = dispatchId,
  ) {
    const placement = inspectPlacement({ terminal: 'term-fresh' });
    return async (argv: readonly string[]) => {
      if (argv[0] === 'orchestration' && argv[1] === 'dispatch-show') {
        expect(argv).toEqual(['orchestration', 'dispatch-show', '--task', taskId, '--json']);
        return { ok: true, stdout: envelope({ dispatch: { id: selectedId, status: selectedStatus } }) };
      }
      if (argv[0] === 'orchestration' && argv[1] === 'worker-show') {
        expect(argv).toEqual(['orchestration', 'worker-show', '--dispatch', dispatchId, '--json']);
        return { ok: true, stdout: envelope(shown) };
      }
      return placement(argv);
    };
  }

  async function priorManager() {
    const base = root();
    const env = { ...process.env, OPK_BASE_DIR: base };
    const file = resolveWorkerAssignmentStorePath('orchestrator-pack', env);
    const published = await publishCurrentWorkerAssignment({
      file, repository: 'chetwerikoff/orchestrator-pack', issueNumber: 2696,
      taskId, kind: 'local', provider: 'orca', bindingKey: dispatchId, role: 'orchestrator',
    });
    if (!published.ok) throw new Error(published.reason);
    return { env, file, previous: published.assignment };
  }

  it('admits the native exited/exactWorker orphaned manager on the same Task', async () => {
    const { env, file, previous } = await priorManager();
    const inspect = nativeInspect(nativeWorkerShow());
    expect(await readTerminalGoneDispatch(previous, inspect)).toEqual({
      taskId, dispatchId, dispatchState: 'failed', priorTerminalId: retainedHandle,
      worktreeId: canonicalWorktree, workerAbsent: true,
    });

    // The adapter cannot resolve the old process; only the exact native proof permits replacement.
    const unavailableAdapter = new OrcaTaskRuntimeAdapter({
      runJson: vi.fn((): OrcaJsonResponse => ({
        ok: false, error: { code: 'native_unavailable', message: 'adapter cannot resolve old worker' },
      })) as never,
      env,
    });
    const execute = vi.fn(async () => ({
      ok: true, stdout: envelope({
        taskId, dispatchId: 'ctx_new_manager_2696', state: 'ready',
        effects: producerEffects({ terminal: 'term-fresh' }),
      }),
    }));
    const result = await runSupervisedWorkerStart({
      mode: 'exact_terminal_worktree', role: 'orchestrator', issueNumber: 2696,
      repository: 'chetwerikoff/orchestrator-pack', env, adapter: unavailableAdapter,
      orcaArgs: argsForTerminal('terminal:fresh', taskId), inspect, execute,
    });
    expect(result).toMatchObject({
      ok: true, reason: 'ready_and_assignment_bound',
      assignment: { taskId, bindingKey: 'ctx_new_manager_2696', generation: 2, role: 'orchestrator' },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(currentWorkerAssignment(file, 2696)?.assignmentId).not.toBe(previous.assignmentId);
  });

  const refusals: {
    name: string;
    change: (shown: Record<string, unknown>) => void;
    selectedStatus?: string;
    selectedId?: string;
  }[] = [
    { name: 'non-orphaned live terminal', change: (shown) => {
      (shown.terminal as Record<string, unknown>).orphaned = false;
    } },
    { name: 'orphaned flag absent', change: (shown) => {
      delete (shown.terminal as Record<string, unknown>).orphaned;
    } },
    { name: 'running observation', change: (shown) => {
      (shown.observation as Record<string, unknown>).status = 'running';
    } },
    { name: 'active observation', change: (shown) => {
      (shown.observation as Record<string, unknown>).status = 'active';
    } },
    { name: 'exited without exactWorker true', change: (shown) => {
      (shown.observation as Record<string, unknown>).exactWorker = false;
    } },
    { name: 'exited without terminal record', change: (shown) => {
      shown.terminal = null;
    } },
    { name: 'missing retained terminal handle', change: (shown) => {
      (shown.terminal as Record<string, unknown>).handle = '';
    } },
    { name: 'uncorroborated retained handle', change: (shown) => {
      (shown.worker as Record<string, unknown>).agent_terminal_handle = null;
      (shown.terminalResource as Record<string, unknown>).terminalHandle = null;
    } },
    { name: 'worker versus terminal handle mismatch', change: (shown) => {
      (shown.worker as Record<string, unknown>).agent_terminal_handle = 'term_foreign';
    } },
    { name: 'resource versus terminal handle mismatch', change: (shown) => {
      (shown.terminalResource as Record<string, unknown>).terminalHandle = 'term_foreign';
    } },
    { name: 'nonterminal selected Dispatch', selectedStatus: 'dispatched', change: (shown) => {
      (shown.dispatch as Record<string, unknown>).status = 'dispatched';
    } },
    { name: 'contradictory worker-show Dispatch id', change: (shown) => {
      (shown.dispatch as Record<string, unknown>).id = 'ctx_foreign';
    } },
    { name: 'abbreviated worker-show Dispatch id', change: (shown) => {
      (shown.dispatch as Record<string, unknown>).id = 'ctx_a5f5a38c2f0';
    } },
    { name: 'contradictory dispatch-show Dispatch id', selectedId: 'ctx_foreign', change: () => {} },
    { name: 'mismatched Dispatch status', change: (shown) => {
      (shown.dispatch as Record<string, unknown>).status = 'completed';
    } },
    { name: 'foreign origin Dispatch', change: (shown) => {
      (shown.terminalResource as Record<string, unknown>).originDispatchId = 'ctx_foreign';
    } },
    { name: 'foreign owner Dispatch', change: (shown) => {
      (shown.terminalResource as Record<string, unknown>).ownerDispatchId = 'ctx_foreign';
    } },
    { name: 'mismatched worktree identity', change: (shown) => {
      (shown.worker as Record<string, unknown>).worktree_id = 'repo::foreign-worktree';
    } },
  ];

  it.each(refusals)('refuses $name from the native exited/orphaned fixture', async ({
    change, selectedStatus, selectedId,
  }) => {
    const { previous } = await priorManager();
    const shown = nativeWorkerShow();
    change(shown);
    expect(await readTerminalGoneDispatch(previous, nativeInspect(
      shown, selectedStatus, selectedId,
    ))).toBeNull();
  });

  it('keeps the previous manager assignment when exited proof lacks orphaned state', async () => {
    const { env, file, previous } = await priorManager();
    const shown = nativeWorkerShow();
    (shown.terminal as Record<string, unknown>).orphaned = false;
    const unavailableAdapter = new OrcaTaskRuntimeAdapter({
      runJson: vi.fn((): OrcaJsonResponse => ({
        ok: false, error: { code: 'native_unavailable', message: 'adapter cannot resolve old worker' },
      })) as never,
      env,
    });
    const execute = vi.fn(async () => ({ ok: true, stdout: '' }));
    const result = await runSupervisedWorkerStart({
      role: 'orchestrator', issueNumber: 2696, repository: 'chetwerikoff/orchestrator-pack',
      env, adapter: unavailableAdapter, inspect: nativeInspect(shown),
      orcaArgs: argsForTerminal('terminal:fresh', taskId), execute,
    });
    expect(result.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(currentWorkerAssignment(file, 2696)).toEqual(previous);
  });
});
