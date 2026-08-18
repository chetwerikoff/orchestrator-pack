#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runProcess } from './kernel/subprocess.ts';
import {
  currentWorkerAssignment,
  listCurrentWorkerAssignments,
  resolveWorkerAssignmentStorePath,
  withCurrentWorkerAssignmentFence,
  type WorkerAssignment,
} from './lib/worker-assignment-store.ts';
import { withCrashRecoverableFileLock } from './pr2-foundation/journal-lock.ts';
import {
  buildWorkerReportRecordKey,
  readWorkerReportStoreFile,
  resolveWorkerReportStorePath,
  resolveWorkerReportTrustedBinding,
  upsertWorkerReportRecordInMemory,
  writeWorkerReportStoreFile,
} from '../docs/worker-report-store.mjs';

const STATES = new Set(['ready_for_review','fixing_ci','addressing_reviews','completed','blocked','pr_created','working','started']);
const BINDING_ARGS = new Set(['--repository','--issue-number','--task-id','--assignment-id','--assignment-generation','--pr-number','--head-sha']);
const AUTO_ARGS = new Set(['--state','--delivery-run-id','--project-id','--repo-root']);
export type ReportDisposition = 'recorded'|'continue_work'|'dry_run'|'command_error';
export interface ReportOutcome {
  readonly disposition: ReportDisposition; readonly accepted: boolean; readonly recordWritten: boolean;
  readonly requestedState: string; readonly reason: string; readonly dryRun?: boolean;
  readonly assignmentId?: string; readonly assignmentGeneration?: number; readonly reportKey?: string;
}
export interface ReportRequest {
  readonly state: string; readonly repository: string; readonly issueNumber: number; readonly taskId: string;
  readonly assignmentId: string; readonly assignmentGeneration: number; readonly prNumber: number;
  readonly headSha: string; readonly deliveryRunId: string; readonly projectId: string; readonly repoRoot: string;
  readonly dryRun: boolean;
}
interface ChildResult { readonly ok: boolean; readonly stdout: string; readonly stderr?: string }
export interface ReportDeps {
  readonly run?: (command: string, args: readonly string[], cwd: string, timeoutMs: number) => Promise<ChildResult>;
  readonly now?: () => number; readonly reportStorePath?: string;
}
type Predicate<T> = { readonly kind:'ok'; readonly value:T }|{ readonly kind:'continue_work'|'command_error'; readonly reason:string };

const bounded=(v:unknown,n:number):string=>{const s=String(v??'').trim();return s&&s.length<=n&&!/[\u0000-\u001f\u007f]/u.test(s)?s:''};
const sha=(v:unknown):string=>{const s=String(v??'').trim().toLowerCase();return /^[0-9a-f]{40}$/u.test(s)?s:''};
const safe=(v:unknown,f:string):string=>String(v??'').trim().replace(/[\r\n\t]+/gu,' ').slice(0,240)||f;
const outcome=(d:ReportDisposition,state:string,reason:string,accepted=false,written=false):ReportOutcome=>({disposition:d,accepted,recordWritten:written,requestedState:state,reason});
function matches(r:ReportRequest,a:WorkerAssignment|null):a is WorkerAssignment{return Boolean(a&&a.repository===r.repository&&a.issueNumber===r.issueNumber&&a.taskId===r.taskId&&a.assignmentId===r.assignmentId&&a.generation===r.assignmentGeneration)}
async function defaultRun(command:string,args:readonly string[],cwd:string,timeoutMs:number):Promise<ChildResult>{const p=await runProcess({command,args:[...args],cwd,inheritParentEnv:true,allowEmptyStdout:false,timeoutMs});return{ok:p.ok,stdout:p.stdout,stderr:p.stderr||p.error}}
async function jsonChild<T>(run:NonNullable<ReportDeps['run']>,r:ReportRequest,args:readonly string[],unavailable:string):Promise<Predicate<T>>{const c=await run('gh',args,r.repoRoot,15_000);if(!c.ok)return{kind:'continue_work',reason:unavailable};try{const p:unknown=JSON.parse(c.stdout);return p&&typeof p==='object'&&!Array.isArray(p)?{kind:'ok',value:p as T}:{kind:'command_error',reason:'github_child_json_malformed'}}catch{return{kind:'command_error',reason:'github_child_json_malformed'}}}
async function jsonChildAt<T>(run:NonNullable<ReportDeps['run']>,repoRoot:string,args:readonly string[],unavailable:string):Promise<Predicate<T>>{const c=await run('gh',args,repoRoot,15_000);if(!c.ok)return{kind:'continue_work',reason:unavailable};try{const p:unknown=JSON.parse(c.stdout);return p&&typeof p==='object'&&!Array.isArray(p)?{kind:'ok',value:p as T}:{kind:'command_error',reason:'github_child_json_malformed'}}catch{return{kind:'command_error',reason:'github_child_json_malformed'}}}
async function prHead(run:NonNullable<ReportDeps['run']>,r:ReportRequest):Promise<Predicate<true>>{const q=await jsonChild<{number?:unknown;state?:unknown;headRefOid?:unknown}>(run,r,['pr','view',String(r.prNumber),'--repo',r.repository,'--json','number,state,headRefOid'],'github_pr_binding_unavailable');if(q.kind!=='ok')return q;const h=sha(q.value.headRefOid);if(Number(q.value.number??0)!==r.prNumber)return{kind:'continue_work',reason:'pr_number_mismatch'};if(String(q.value.state??'').toUpperCase()!=='OPEN')return{kind:'continue_work',reason:'pr_not_open'};if(!h)return{kind:'command_error',reason:'github_pr_head_malformed'};return h===r.headSha?{kind:'ok',value:true}:{kind:'continue_work',reason:'pr_head_mismatch'}}
async function readyGate(run:NonNullable<ReportDeps['run']>,r:ReportRequest):Promise<Predicate<true>>{const issue=await jsonChild<{body?:unknown}>(run,r,['issue','view',String(r.issueNumber),'--repo',r.repository,'--json','body'],'github_issue_binding_unavailable');if(issue.kind!=='ok')return issue;const dir=mkdtempSync(join(tmpdir(),'opk-worker-report-'));const body=join(dir,'issue.md');try{writeFileSync(body,String(issue.value.body??''),'utf8');const c=await run(process.execPath,['--experimental-strip-types',resolve(r.repoRoot,'scripts/lib/Invoke-TypeScriptCli.ts'),'--script',resolve(r.repoRoot,'scripts/worker-smoke-run.ts'),'--','gate-check','--pr',String(r.prNumber),'--head-sha',r.headSha,'--issue-body-file',body,'--repo-root',r.repoRoot,'--cwd',r.repoRoot,'--issue',String(r.issueNumber),'--json'],r.repoRoot,120_000);if(!c.ok)return{kind:'continue_work',reason:`worker_smoke_gate_failed:${safe(c.stderr,'gate_command_failed')}`};let p:unknown;try{p=JSON.parse(c.stdout)}catch{return{kind:'command_error',reason:'worker_smoke_gate_json_malformed'}}if(!p||typeof p!=='object'||Array.isArray(p))return{kind:'command_error',reason:'worker_smoke_gate_json_malformed'};const g=p as{ok?:unknown;reason?:unknown};return g.ok===true?{kind:'ok',value:true}:{kind:'continue_work',reason:`worker_smoke_gate_not_ready:${safe(g.reason,'gate_rejected')}`}}finally{rmSync(dir,{recursive:true,force:true})}}
function binding(r:ReportRequest,a:WorkerAssignment){return resolveWorkerReportTrustedBinding({assignment:{assignmentId:a.assignmentId,generation:a.generation,taskId:a.taskId},openPrs:[{number:r.prNumber,state:'open',headRefOid:r.headSha}],worktreeHeadSha:r.headSha,prNumber:r.prNumber})}
async function append(r:ReportRequest,a:WorkerAssignment,deps:ReportDeps):Promise<ReportOutcome>{const path=deps.reportStorePath??resolveWorkerReportStorePath(process.env);try{return await withCrashRecoverableFileLock(join(dirname(path),'worker-report-store.lock'),10,()=>{const now=deps.now?.()??Date.now();const rec={reportState:r.state,accepted:true,assignment:{assignmentId:a.assignmentId,generation:a.generation,taskId:a.taskId},repoSlug:r.repository,prNumber:r.prNumber,headSha:r.headSha,reportedAtMs:now,lastObservedMs:now,...(r.deliveryRunId?{deliveryRunId:r.deliveryRunId}:{})};const b=binding(r,a);if(!b?.ok)return outcome('command_error',r.state,safe(b?.reason,'report_binding_internal_failure'));const applied=upsertWorkerReportRecordInMemory({store:readWorkerReportStoreFile(path),record:rec,nowMs:now,trustedBinding:b});if(!applied.ok||!applied.store||!applied.key)return outcome('command_error',r.state,safe(applied.reason,'report_store_apply_failed'));writeWorkerReportStoreFile(path,applied.store);const back=readWorkerReportStoreFile(path) as{sourceRecords?:Record<string,unknown>};const persisted=back.sourceRecords?.[applied.key];if(!persisted||buildWorkerReportRecordKey(persisted as Record<string,unknown>)!==applied.key)return outcome('command_error',r.state,'report_store_readback_failed');return{disposition:'recorded',accepted:true,recordWritten:true,requestedState:r.state,reason:'report_recorded',assignmentId:a.assignmentId,assignmentGeneration:a.generation,reportKey:applied.key}})}catch(e){return outcome('command_error',r.state,e instanceof Error&&e.message==='journal_busy'?'report_store_busy':'report_store_write_failed')}}

export async function evaluatePackWorkerReport(r:ReportRequest,deps:ReportDeps={}):Promise<ReportOutcome>{const run=deps.run??defaultRun;const file=resolveWorkerAssignmentStorePath(r.projectId,process.env);const initial=currentWorkerAssignment(file,r.issueNumber);if(!matches(r,initial))return outcome('continue_work',r.state,'assignment_stale');if(r.state==='addressing_reviews'&&!r.deliveryRunId)return outcome('continue_work',r.state,'delivery_run_unresolved');const fenced=await withCurrentWorkerAssignmentFence(file,initial,async()=>{const current=currentWorkerAssignment(file,r.issueNumber);if(!matches(r,current))return outcome('continue_work',r.state,'assignment_stale');const pr=await prHead(run,r);if(pr.kind!=='ok')return outcome(pr.kind,r.state,pr.reason);if(r.state==='ready_for_review'){const gate=await readyGate(run,r);if(gate.kind!=='ok')return outcome(gate.kind,r.state,gate.reason)}if(r.dryRun){const dry:ReportOutcome={disposition:'dry_run',accepted:true,recordWritten:false,requestedState:r.state,reason:'dry_run_admissible',dryRun:true,assignmentId:current.assignmentId,assignmentGeneration:current.generation};return dry}return append(r,current,deps)});if(!fenced.ok)return outcome(fenced.reason==='assignment_store_busy'||fenced.reason==='assignment_stale'?'continue_work':'command_error',r.state,fenced.reason);return fenced.value}

function arg(args:readonly string[],name:string):string{const i=args.indexOf(name);return i>=0?String(args[i+1]??'').trim():''}
function stateFromArgs(args:readonly string[]):string{let state=arg(args,'--state');if(!state&&args[0]&&!args[0].startsWith('-'))state=args[0];state=bounded(state,80).toLowerCase();if(!STATES.has(state))throw new Error('invalid_or_missing_state');return state}
function validateArgs(args:readonly string[],state:string,allowed:Set<string>):void{let positional=false;for(let i=0;i<args.length;i+=1){const a=args[i]!;if(allowed.has(a)){if(i+1>=args.length)throw new Error(`missing_value:${a}`);i+=1;continue}if(a==='--dry-run')continue;if(!a.startsWith('-')&&!positional&&a.toLowerCase()===state){positional=true;continue}throw new Error(`unknown_argument:${a}`)}}
function hasExplicitBindingArgs(args:readonly string[]):boolean{return args.some((value)=>BINDING_ARGS.has(value))}
export function parsePackWorkerReportArgs(argv:readonly string[],env:NodeJS.ProcessEnv=process.env):ReportRequest{const args=[...argv];const state=stateFromArgs(args);const repository=bounded(arg(args,'--repository')||env.GITHUB_REPOSITORY,240).toLowerCase();const issueNumber=Number(arg(args,'--issue-number'));const taskId=bounded(arg(args,'--task-id'),160);const assignmentId=bounded(arg(args,'--assignment-id'),160);const assignmentGeneration=Number(arg(args,'--assignment-generation'));const prNumber=Number(arg(args,'--pr-number'));const headSha=sha(arg(args,'--head-sha')||env.GITHUB_SHA);const deliveryRunId=bounded(arg(args,'--delivery-run-id')||env.OPK_DELIVERY_RUN_ID||env.OPK_REVIEW_RUN_ID||env.OPK_REVIEW_START_RUN_ID,160);const projectId=bounded(arg(args,'--project-id')||'orchestrator-pack',80);const repoRoot=resolve(arg(args,'--repo-root')||process.cwd());if(!repository||!Number.isInteger(issueNumber)||issueNumber<=0||!taskId||!assignmentId||!Number.isInteger(assignmentGeneration)||assignmentGeneration<=0||!Number.isInteger(prNumber)||prNumber<=0||!headSha||!projectId)throw new Error('report_binding_arguments_invalid');validateArgs(args,state,new Set([...AUTO_ARGS,...BINDING_ARGS]));return{state,repository,issueNumber,taskId,assignmentId,assignmentGeneration,prNumber,headSha,deliveryRunId,projectId,repoRoot,dryRun:args.includes('--dry-run')}}

export async function resolvePackWorkerReportRequest(argv:readonly string[],env:NodeJS.ProcessEnv=process.env,deps:Pick<ReportDeps,'run'>={}):Promise<Predicate<ReportRequest>>{
  const args=[...argv];
  let state:string;
  try{state=stateFromArgs(args);validateArgs(args,state,AUTO_ARGS)}catch(e){return{kind:'command_error',reason:e instanceof Error?e.message:'invalid_cli_usage'}}
  const projectId=bounded(arg(args,'--project-id')||'orchestrator-pack',80);
  const repoRoot=resolve(arg(args,'--repo-root')||process.cwd());
  if(!projectId)return{kind:'command_error',reason:'report_binding_arguments_invalid'};
  const run=deps.run??defaultRun;
  const gitHead=await run('git',['rev-parse','HEAD'],repoRoot,10_000);
  if(!gitHead.ok)return{kind:'continue_work',reason:'worktree_head_unavailable'};
  const headSha=sha(gitHead.stdout);
  if(!headSha)return{kind:'command_error',reason:'worktree_head_malformed'};
  const repo=await jsonChildAt<{nameWithOwner?:unknown}>(run,repoRoot,['repo','view','--json','nameWithOwner'],'github_repository_binding_unavailable');
  if(repo.kind!=='ok')return repo;
  const repository=bounded(repo.value.nameWithOwner,240).toLowerCase();
  if(!repository)return{kind:'command_error',reason:'github_repository_binding_malformed'};
  const pr=await jsonChildAt<{number?:unknown;state?:unknown;headRefOid?:unknown;body?:unknown}>(run,repoRoot,['pr','view','--json','number,state,headRefOid,body'],'github_pr_binding_unavailable');
  if(pr.kind!=='ok')return pr;
  const prNumber=Number(pr.value.number??0);
  const prHeadSha=sha(pr.value.headRefOid);
  if(!Number.isInteger(prNumber)||prNumber<=0||!prHeadSha)return{kind:'command_error',reason:'github_pr_binding_malformed'};
  if(String(pr.value.state??'').toUpperCase()!=='OPEN')return{kind:'continue_work',reason:'pr_not_open'};
  if(prHeadSha!==headSha)return{kind:'continue_work',reason:'pr_head_mismatch'};
  const closingIssues=new Set<number>();
  for(const match of String(pr.value.body??'').matchAll(/^\s*(?:Closes|Fixes|Resolves)\s+#(\d+)\b/gimu)){
    const issue=Number(match[1]);
    if(Number.isInteger(issue)&&issue>0)closingIssues.add(issue);
  }
  if(closingIssues.size===0)return{kind:'continue_work',reason:'pr_issue_binding_missing'};
  const file=resolveWorkerAssignmentStorePath(projectId,env);
  const assignments=listCurrentWorkerAssignments(file);
  if(!assignments)return{kind:'continue_work',reason:'assignment_untrusted'};
  const matchesCurrent=assignments.filter((assignment)=>assignment.projectId===projectId&&assignment.repository===repository&&closingIssues.has(assignment.issueNumber));
  if(matchesCurrent.length===0)return{kind:'continue_work',reason:'assignment_missing'};
  if(matchesCurrent.length!==1)return{kind:'continue_work',reason:'assignment_binding_ambiguous'};
  const assignment=matchesCurrent[0]!;
  const deliveryRunId=bounded(arg(args,'--delivery-run-id')||env.OPK_DELIVERY_RUN_ID||env.OPK_REVIEW_RUN_ID||env.OPK_REVIEW_START_RUN_ID,160);
  return{kind:'ok',value:{state,repository,issueNumber:assignment.issueNumber,taskId:assignment.taskId,assignmentId:assignment.assignmentId,assignmentGeneration:assignment.generation,prNumber,headSha,deliveryRunId,projectId,repoRoot,dryRun:args.includes('--dry-run')}};
}

export async function main(argv:readonly string[]=process.argv.slice(2)):Promise<number>{let r:ReportRequest;if(hasExplicitBindingArgs(argv)){try{r=parsePackWorkerReportArgs(argv)}catch(e){process.stdout.write(`${JSON.stringify(outcome('command_error','',e instanceof Error?e.message:'invalid_cli_usage'))}\n`);return 2}}else{const resolved=await resolvePackWorkerReportRequest(argv);if(resolved.kind!=='ok'){let state='';try{state=stateFromArgs(argv)}catch{}const o=outcome(resolved.kind,state,resolved.reason);process.stdout.write(`${JSON.stringify(o)}\n`);return resolved.kind==='command_error'?2:0}r=resolved.value}let o:ReportOutcome;try{o=await evaluatePackWorkerReport(r)}catch(e){o=outcome('command_error',r.state,safe(e,'worker_report_internal_error'))}process.stdout.write(`${JSON.stringify(o)}\n`);return o.disposition==='command_error'?2:0}
if(process.argv[1]?.endsWith('pack-worker-report.ts'))main().then(c=>{process.exitCode=c}).catch(e=>{process.stdout.write(`${JSON.stringify(outcome('command_error','',safe(e,'worker_report_internal_error')))}\n`);process.exitCode=2});
