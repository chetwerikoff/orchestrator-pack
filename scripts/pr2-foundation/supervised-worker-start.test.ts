import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeAdapter, RuntimeWorker } from '../runtime/contracts.ts';
import {
  attachWorkerAssignmentIssueNumber,
  currentWorkerAssignment,
  parseWorkerAssignmentStore,
  publishCurrentWorkerAssignment,
  readWorkerAssignmentStore,
  resolveWorkerAssignmentStorePath,
  workerAssignmentKey,
} from '../lib/worker-assignment-store.ts';
import { withCrashRecoverableFileLock } from './journal-lock.ts';
import { runSupervisedWorkerStart } from './supervised-worker-start.ts';

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
    const old=await publishCurrentWorkerAssignment({file,repository:'chetwerikoff/orchestrator-pack',issueNumber:1416,taskId:'task_1',kind:'local',provider:'orca',bindingKey:'dispatch_old'});
    if(!old.ok)throw new Error(old.reason); let calls=0;
    const result=await runSupervisedWorkerStart({role:'worker',
      issueNumber:1416,repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),adapter:adapter({kind:'resolved',worker},liveness),
      execute:async()=>{calls+=1;return{ok:true,stdout:envelope({taskId:'task_1',dispatchId:'dispatch_new',state:'ready',effects:producerEffects()})}},
    });
    expect(result).toEqual({ok:false,reason:'skipped_live'}); expect(calls).toBe(0); expect(currentWorkerAssignment(file,1416)).toEqual(old.assignment);
  });

  it('separate operator successor advances generation only after affirmative current-local gone evidence',async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base}; const file=resolveWorkerAssignmentStorePath('orchestrator-pack',env);
    const old=await publishCurrentWorkerAssignment({file,repository:'chetwerikoff/orchestrator-pack',issueNumber:1416,taskId:'task_1',kind:'local',provider:'orca',bindingKey:'dispatch_old'});
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
    const old=await publishCurrentWorkerAssignment({file,repository:'chetwerikoff/orchestrator-pack',issueNumber:1416,taskId:'task_1',kind:'local',provider:'orca',bindingKey:'dispatch_old'});
    if(!old.ok)throw new Error(old.reason); let winnerId='';
    const effects=producerEffects();
    const result=await runSupervisedWorkerStart({role:'worker',
      issueNumber:1416,repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),adapter:adapter({kind:'gone'}),inspect:inspectPlacement(),
      execute:async()=>{
        const winner=await publishCurrentWorkerAssignment({file,repository:'chetwerikoff/orchestrator-pack',issueNumber:1416,taskId:'task_1',kind:'remote',provider:'browser-gpt',bindingKey:'remote-winner',expectedCurrent:{assignmentId:old.assignment.assignmentId,generation:old.assignment.generation}});
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
    expect(result).toEqual({ok:false,reason:'supervised_start_envelope_error',errorCode:'agent_unconfigured'});
  });

  it('preserves exact Orca mutation recovery fields without promoting the failed start', async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base};
    const pending=await runSupervisedWorkerStart({role:'worker',
      repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),inspect:inspectPlacement(),
      execute:async()=>({
        ok:false,
        stdout:JSON.stringify({ok:false,error:{
          code:'operation_unknown',message:'accepted before restart',
          data:{requestId:'request-7',dispatchId:'dispatch-7',recoveryCommand:'orca orchestration worker-show --dispatch dispatch-7 --json'},
        }}),
      }),
    });
    expect(pending).toEqual({
      ok:false,reason:'supervised_start_envelope_error',errorCode:'operation_unknown',
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
      ok:false,reason:'supervised_start_envelope_error',errorCode:'runtime_timeout',recovery:{requestId:'request-8'},
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
    expect(result).toEqual({ok:false,reason:'supervised_start_envelope_error',errorCode:'operation_unknown'});
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
