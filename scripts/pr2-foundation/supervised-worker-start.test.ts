import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeAdapter, RuntimeWorker } from '../runtime/contracts.ts';
import {
  currentWorkerAssignment,
  publishCurrentWorkerAssignment,
  resolveWorkerAssignmentStorePath,
} from '../lib/worker-assignment-store.ts';
import { withCrashRecoverableFileLock } from './journal-lock.ts';
import { runSupervisedWorkerStart } from './supervised-worker-start.ts';

const roots: string[] = [];
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
    const result=await runSupervisedWorkerStart({
      issueNumber:1416, repository:'chetwerikoff/orchestrator-pack', env,
      orcaArgs:['--task','task_1','--agent','codex'],
      execute:async()=>{calls+=1;return{ok:true,stdout:envelope({taskId:'task_1',dispatchId:'d',state:'ready'})}},
    });
    expect(result).toEqual({ok:false,reason:'supervised_start_exact_terminal_worktree_required'});
    expect(calls).toBe(0);
  });

  it('publishes only Task/Dispatch logical identity after an initial ready receipt',async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base};
    const result=await runSupervisedWorkerStart({
      issueNumber:1416, repository:'chetwerikoff/orchestrator-pack', env, orcaArgs:args(),
      execute:async()=>({ok:true,stdout:envelope({runId:'run_1',taskId:'task_1',dispatchId:'dispatch_1',state:'ready',effects:[{kind:'terminal',id:'runtime-secret'}]})}),
    });
    expect(result).toMatchObject({ok:true,reason:'ready_and_assignment_bound',assignment:{kind:'local',provider:'orca',bindingKey:'dispatch_1',generation:1}});
    const file=resolveWorkerAssignmentStorePath('orchestrator-pack',env);
    expect(readFileSync(file,'utf8')).not.toContain('runtime-secret');
  });

  it.each(['busy','idle'] as const)('returns skipped_live and does not invoke start when current local target is %s',async(liveness)=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base}; const file=resolveWorkerAssignmentStorePath('orchestrator-pack',env);
    const old=await publishCurrentWorkerAssignment({file,repository:'chetwerikoff/orchestrator-pack',issueNumber:1416,taskId:'task_1',kind:'local',provider:'orca',bindingKey:'dispatch_old'});
    if(!old.ok)throw new Error(old.reason); let calls=0;
    const result=await runSupervisedWorkerStart({
      issueNumber:1416,repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),adapter:adapter({kind:'resolved',worker},liveness),
      execute:async()=>{calls+=1;return{ok:true,stdout:envelope({taskId:'task_1',dispatchId:'dispatch_new',state:'ready'})}},
    });
    expect(result).toEqual({ok:false,reason:'skipped_live'}); expect(calls).toBe(0); expect(currentWorkerAssignment(file,1416)).toEqual(old.assignment);
  });

  it('separate operator successor advances generation only after affirmative current-local gone evidence',async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base}; const file=resolveWorkerAssignmentStorePath('orchestrator-pack',env);
    const old=await publishCurrentWorkerAssignment({file,repository:'chetwerikoff/orchestrator-pack',issueNumber:1416,taskId:'task_1',kind:'local',provider:'orca',bindingKey:'dispatch_old'});
    if(!old.ok)throw new Error(old.reason);
    const result=await runSupervisedWorkerStart({
      issueNumber:1416,repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),adapter:adapter({kind:'gone'}),
      execute:async()=>({ok:true,stdout:envelope({taskId:'task_1',dispatchId:'dispatch_new',state:'ready'})}),
    });
    expect(result).toMatchObject({ok:true,assignment:{generation:2,bindingKey:'dispatch_new'}});
    expect(result.assignment?.assignmentId).not.toBe(old.assignment.assignmentId);
  });

  it('exposes a non-authoritative operator-manual residual when reassignment wins after ready',async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base}; const file=resolveWorkerAssignmentStorePath('orchestrator-pack',env);
    const old=await publishCurrentWorkerAssignment({file,repository:'chetwerikoff/orchestrator-pack',issueNumber:1416,taskId:'task_1',kind:'local',provider:'orca',bindingKey:'dispatch_old'});
    if(!old.ok)throw new Error(old.reason); let winnerId='';
    const effects=[{kind:'terminal',action:'ready',id:'receipt-resource'}];
    const result=await runSupervisedWorkerStart({
      issueNumber:1416,repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),adapter:adapter({kind:'gone'}),
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
    const run=runSupervisedWorkerStart({
      issueNumber:1416,repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),
      execute:async()=>{
        held=withCrashRecoverableFileLock(`${file}.lock`,1,async()=>{await new Promise<void>((resolve)=>{release=resolve})});
        while(!release) await new Promise((resolve)=>setTimeout(resolve,1));
        return{ok:true,stdout:envelope({taskId:'task_1',dispatchId:'dispatch_busy',state:'ready',effects:[{kind:'terminal',id:'residual'}]})};
      },
    });
    const result=await run;
    expect(result).toMatchObject({ok:false,reason:'assignment_store_busy',residual:{authority:'non_authoritative',disposition:'operator_manual',dispatchId:'dispatch_busy',expectedCurrent:{kind:'none'},publicationReason:'assignment_store_busy'}});
    expect(currentWorkerAssignment(file,1416)).toBeNull();
    release(); await held;
  });

  it('rejects malformed/failed/mismatched ready receipts without publication',async()=>{
    const base=root(); const env={...process.env,OPK_BASE_DIR:base};
    const mismatch=await runSupervisedWorkerStart({issueNumber:1416,repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args('task_expected'),execute:async()=>({ok:true,stdout:envelope({taskId:'other',dispatchId:'d',state:'ready'})})});
    expect(mismatch).toMatchObject({ok:false,reason:'supervised_start_task_mismatch'});
    const failed=await runSupervisedWorkerStart({issueNumber:1416,repository:'chetwerikoff/orchestrator-pack',env,orcaArgs:args(),execute:async()=>({ok:false,stdout:envelope({taskId:'task_1',dispatchId:'d',state:'outcome_unknown'},false)})});
    expect(failed).toMatchObject({ok:false,reason:'supervised_start_envelope_not_ok'});
    expect(currentWorkerAssignment(resolveWorkerAssignmentStorePath('orchestrator-pack',env),1416)).toBeNull();
  });
});
