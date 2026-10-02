#!/usr/bin/env node
import '../toolchain/native-entrypoint-preflight.ts';

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';
import { stableStringify } from '../lib/cutover/stable-stringify.ts';
import { D928 } from './contracts.ts';

export interface ConformanceFinding { code: string; path?: string; detail?: string; }
export interface ConformanceReport {
  schemaVersion: 2; issue: 948; ref: string; commitSha: string; finalTreeOid: string;
  findings: ConformanceFinding[];
  results: Record<'AC1'|'AC2'|'AC3'|'AC4'|'AC5'|'AC6'|'AC7'|'AC8','pass'|'fail'>;
  result: 'conformant'|'nonconformant';
}

const repoRoot = path.resolve(process.cwd());
const EXECUTABLE_EXTENSIONS = new Set(['.ps1','.psm1','.ts','.mts','.cts','.js','.mjs','.cjs','.sh','.yml','.yaml']);
const TEST_OR_HARNESS = /(?:^|\/)(?:fixtures?|tests?)(?:\/|$)|(?:\.test\.|\.spec\.|Tests\.ps1$|\.shared\.|test-helpers?\.|test-setup\.)/iu;
const EXECUTION_EDGE = /\b(?:import|require|spawn|spawnSync|exec|execFile|execFileSync)\b|\bpwsh\b|\s-File\b|^\s*[.&]\s+/iu;

function gitOk(args: string[]): boolean { return runProcessSync({ command:'git', args, cwd:repoRoot, inheritParentEnv:true }).ok; }
function gitText(args: string[]): string {
  const r=runProcessSync({command:'git',args,cwd:repoRoot,inheritParentEnv:true});
  if(!r.ok) throw new Error(r.stderr||r.error||`git_${args.join('_')}_failed`);
  return r.stdout.trim();
}
function existsAt(ref:string,file:string):boolean { return gitOk(['cat-file','-e',`${ref}:${file}`]); }
function readAt(ref:string,file:string):string {
  const r=runProcessSync({command:'git',args:['show',`${ref}:${file}`],cwd:repoRoot,inheritParentEnv:true});
  if(!r.ok) throw new Error(r.stderr||r.error||`git_show_failed:${file}`);
  return r.stdout;
}
function listAt(ref:string):string[] { const v=gitText(['ls-tree','-r','--name-only',ref]); return v?v.split(/\r?\n/u).filter(Boolean):[]; }
function testOrHarness(file:string):boolean { return TEST_OR_HARNESS.test(file); }

export function scanForbiddenExecutableReferences(files:Array<{path:string;content:string}>):ConformanceFinding[] {
  const out:ConformanceFinding[]=[]; const basenames=D928.map((file)=>path.posix.basename(file));
  for(const row of files){
    if(!EXECUTABLE_EXTENSIONS.has(path.posix.extname(row.path).toLowerCase())||testOrHarness(row.path)) continue;
    row.content.split(/\r?\n/u).forEach((line,index)=>{
      const matched=basenames.filter((name)=>line.includes(name));
      if(matched.length>0&&EXECUTION_EDGE.test(line)) out.push({code:'d928_external_executable_reference',path:row.path,detail:`line=${index+1};${matched.join(',')}`});
    });
  }
  return out;
}

const M = {
  tx: 'scripts/lib/cutover/activation-transaction.ts', cordon: 'scripts/lib/cutover/activation-cordon.ts',
  imports: 'scripts/lib/cutover/activation-import.ts', epoch: 'scripts/lib/cutover/activation-epoch-authority.ts',
  evidence: 'scripts/lib/cutover/activation-evidence.ts', recovery: 'scripts/lib/cutover/activation-recovery.ts',
  preflight: 'scripts/lib/cutover/activation-platform-preflight.ts', projection: 'scripts/lib/cutover/activation-registry-projection.ts',
  supervisor: 'scripts/lib/orchestrator-side-process-supervisor.ts', stable: 'scripts/lib/cutover/stable-stringify.ts',
  planning: 'scripts/cutover/issue-928.test.ts', targetRegistry: 'scripts/orchestrator-side-process-registry.cutover-target.json',
  lane: 'scripts/vitest-ci-lanes.config.json', vectors: 'scripts/fixtures/cutover/stable-stringify-vectors.json',
} as const;
const EXPECTED_FOLLOWUP_STEPS = [
  'committed-registry-reprojected',
  'typescript-supervisor-started',
  'scheduler-owned',
  'machine-local-completion-fsync-confirmed',
  'final-step-timestamp-recorded',
  'final-health-delivery-observed',
  'activation-complete',
] as const;

const CUTOVER_TERMINAL_ROWS = [
  'scripts/lib/Get-ReactionMessagesFromYaml.ps1',
  'scripts/reaction-config-messages.d.mts',
  'scripts/reaction-config-messages.mjs',
  'scripts/review-ready-report-state-seed.ps1',
  'scripts/review-trigger-reconcile.ps1',
  'scripts/review-trigger-reeval.ps1',
] as const;
const D928_REPLACEMENT_OWNERS = [
  'scripts/orchestrator-wake-supervisor.ts',
  'scripts/lib/orchestrator-side-process-supervisor.ts',
  'scripts/lib/review-start-claim-store.ts',
  'scripts/lib/review-start-claim-reaper.ts',
] as const;
function read(file: string): string { return readFileSync(path.resolve(repoRoot, file), 'utf8'); }
function exists(file: string): boolean { return existsSync(path.resolve(repoRoot, file)); }
function has(file: string, token: string): boolean { return exists(file) && read(file).includes(token); }
function count(file: string, token: string): number { return exists(file) ? read(file).split(token).length - 1 : 0; }
function clean(file: string): boolean { return gitOk(['diff','--quiet','HEAD','--',file]) && gitOk(['diff','--cached','--quiet','HEAD','--',file]); }
function body(file: string, marker: string): string { const source=read(file); const index=source.indexOf(marker); return index<0?'':source.slice(index); }
function ordered(source: string, tokens: readonly string[]): boolean { let previous=-1; for(const token of tokens){const index=source.indexOf(token); if(index<0||index<=previous)return false; previous=index;} return true; }
function all(file: string, tokens: readonly string[]): boolean { return tokens.every((token)=>has(file,token)); }
function registryOk(): boolean { try { const value=JSON.parse(read(M.targetRegistry)) as any; return value?.schemaVersion===2&&value.requiredChildIds?.length===1&&value.requiredChildIds[0]==='pr2-scheduler'&&value.children?.length===1&&value.children[0]?.id==='pr2-scheduler'&&value.children[0]?.runtime==='node'&&value.children[0]?.script==='pr2-foundation/scheduler.ts'&&value.children[0]?.sideEffecting===true; } catch { return false; } }
function vectorsOk(): boolean { try { const value=JSON.parse(read(M.vectors)) as any; return Array.isArray(value?.vectors)&&value.vectors.length>0&&value.vectors.every((row:any)=>stableStringify(row.input)===row.canonical); } catch { return false; } }
function laneOk(): boolean { try { const value=JSON.parse(read(M.lane)) as any; return value?.lightMaxWorkers===2&&value?.classification?.['scripts/cutover/issue-928.test.ts']==='light'&&Array.isArray(value?.heavyFileBatchIsolate)&&!value.heavyFileBatchIsolate.includes('scripts/cutover/issue-928.test.ts'); } catch { return false; } }
function followupStepsOk(): boolean {
  const source = read(M.evidence);
  const marker = 'export const REQUIRED_FOLLOWUP_STEPS = [';
  const start = source.indexOf(marker);
  const end = start < 0 ? -1 : source.indexOf('] as const;', start + marker.length);
  if (start < 0 || end < 0) return false;
  const steps = [...source.slice(start + marker.length, end).matchAll(/'([^']+)'/g)].map((match) => match[1]);
  return JSON.stringify(steps) === JSON.stringify(EXPECTED_FOLLOWUP_STEPS);
}
function inertProofOk(): boolean {
  return all(M.cordon, [
    'const typescriptSupervisorInert = proveTypeScriptSupervisorInert(input.legacyStateRoot);',
    "if (supervisorAlive || childAlive) throw new Error('typescript_supervisor_not_inert');",
    '    typescriptSupervisorInert,',
    "record.typescriptSupervisorInert?.result !== 'typescript-supervisor-inert'",
  ]);
}
function modeOk(): boolean { const file='scripts/orchestrator-wake-supervisor.ts'; if(!exists(file))return false; const row=gitText(['ls-files','-s','--',file]).split(/\s+/,1)[0]??''; return /^100(644|755)$/.test(row)&&(row==='100755')===((statSync(path.resolve(repoRoot,file)).mode&0o111)!==0); }
function guardOk(key:string, artifact:string):boolean {
  if(!key.startsWith('AC8:guard-')&&!key.includes('guard-record-missing'))return true;
  if(!artifact||!existsSync(path.resolve(artifact)))return false;
  try {
    const value=JSON.parse(readFileSync(path.resolve(artifact),'utf8')) as any;
    if(value?.schemaVersion!==1||value?.prHeadSha!==gitText(['rev-parse','HEAD'])||value?.platform!=='linux')return false;
    return ['verify','reusable'].every((name)=>{const row=value?.records?.[name]; return !!row&&typeof row.command==='string'&&row.command.includes('pwsh')&&String(row.pwshVersion??'').startsWith('7.')&&row.platform==='linux'&&row.exitCode===0&&/^sha256:[0-9a-f]{64}$/i.test(String(row.stdoutDigest??''))&&Number.isFinite(Date.parse(String(row.completedAt??'')));});
  } catch { return false; }
}

function mutationFailures(key:string, artifact:string):string[]{
  const out:string[]=[]; const need=(ok:boolean,id:string)=>{if(!ok)out.push(id);};
  const required: Array<[string, readonly string[]]> = [
    [M.tx,[
      "if (!isAncestor(repoRoot, PR2A_LANDING_COMMIT, baseRef)) throw new Error('pr2a_merge_missing');",
      'const { baseRef, closure } = await boundary.resolveBaseAndClosure(request);',
      "if (manifest.schemaVersion !== 1) throw new Error('closure_schema_incompatible');",
      'const TARGET_LIBRARIES = new Set<string>(TARGET_LIBRARY_PATHS);',
      "if (!manifest.lineage?.planningBaseTreeOid) throw new Error('closure_input_tree_unbound');",
      'if ((manifest.unknown ?? []).length !== 0 || (manifest.dynamicUnsupported ?? []).length !== 0) {',
      'if (member.quarantined !== true && !heartbeatHosts.has(member.hostId)) throw new Error(`foundation_member_omitted:${member.hostId}`);',
      'if (!Number.isFinite(observedMs) || observedMs > nowMs + 30_000 || nowMs - observedMs > FOUNDATION_HEARTBEAT_MAX_AGE_MS) {',
      'if (heartbeat.active !== true || heartbeat.installedCommitSha !== oldInstalledCommitSha) {',
      "if (member.hostId !== request.hostId && member.quarantined !== true) throw new Error('second_control_plane_host');",
      "if (!request.hostId || request.hostId !== observedLocalHost) throw new Error('foundation_host_unbound');",
      'assertLegacySupervisor(legacyIdentity, request.oldInstalledRevisionRoot);',
      "appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'admission', { preflight, foundation, closure, baseRef });",
      "appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'legacy-supervisor-and-writers-terminated', {",
      '    preCommitLogDigest: phaseOne.digest,',
      'verifyPhaseOneDigest(request.paths.phaseOnePath, request.epochId, cordon.nonce, committed.preCommitLogDigest);',
    ]],
    [M.preflight,["if (platform !== 'linux') throw new Error('unsupported_platform');","if (major !== SUPPORTED_NODE_MAJOR) throw new Error('node_major_required');","if (actualHead.toLowerCase() !== input.installedCommitSha.toLowerCase()) throw new Error('installed_commit_unbound');","if (!existsSync(input.repoRoot) || !existsSync(input.oldInstalledRevisionRoot)) throw new Error('installed_revision_missing');",'if (value !== lexical || lexical !== canonical) throw new Error(`${label}_not_canonical`);',"if (statSync(targetParent).dev !== statSync(projectionParent).dev) throw new Error('registry_cross_device_projection');"]],
    [M.cordon,["if (existsSync(input.path)) throw new Error('competing_transaction_admitted');",'    writersClosed: true,','    noRespawn: true,','    noTypeScriptStart: true,',"nonce: randomBytes(32).toString('hex'),",'assertSameProcess(identity);','if (survivors.length) throw new Error(`legacy_process_survivor:${survivors.join(\',\')}`);','    oldInstalledRevisionRoot: input.oldInstalledRevisionRoot,']],
    [M.imports,["if (!writerWatermark.trim()) throw new Error('writer_watermark_missing');",'snapshotDigest: sha256Bytes(bytes)','if (!Number.isInteger(sourceVersion) || sourceVersion <= 0)','if (!required || JSON.stringify([...spec.coveredFields]) !== JSON.stringify(required)) throw new Error(`store_covered_fields_invalid:${spec.id}`);',"if (unknown.length) throw new Error(`store_unknown_field:${spec.id}:${unknown.join(',')}`);",'    nonce: input.nonce,','    storeId: input.spec.id,','  writeDurableJson(markerPath, record);','  writeDurableFile(input.spec.targetPath, `${JSON.stringify(normalized, null, 2)}\\n`);','if (sha256Stable(existing) !== importTargetDigest) throw new Error(`import_target_digest_mismatch:${input.spec.id}`);','if (sha256Stable(readBack) !== importTargetDigest) throw new Error(`import_target_digest_mismatch:${input.spec.id}`);']],
    [M.evidence,['fsyncSync(fd);','renameSync(temporary, target);','syncDirectory(directory);','    epochId,\n    sequence: existing.length + 1,','completedAt: new Date().toISOString(),']],
    [M.epoch,["if (document.currentEpochId !== expectedOldEpochId) throw new Error('epoch_cas_conflict');","if (document.records.some((row) => row.epochId === core.epochId)) throw new Error('epoch_duplicate_commit');","if (!record || record.nonce !== nonce) throw new Error('epoch_nonce_mismatch');",'    mkdirSync(lock);',"  'epochId', 'nonce', 'hostId',","  'importDigests', 'registryHash', 'preCommitLogDigest', 'commitAt',"]],
    [M.projection,['writeDurableFile(projectionPath, source);',"if (!readBack.equals(source)) throw new Error('registry_projection_readback_mismatch');"]],
    [M.supervisor,['projectRegistry(options.targetRegistryPath, options.projectedRegistryPath)','new FileEpochAuthority(options.epochAuthorityPath).verify(options.epochId, options.nonce)','const projected = projectRegistry(options.targetRegistryPath, options.projectedRegistryPath);']],
    [M.recovery,['if (fileDigestOrAbsent(store.targetPath) !== cordon.preImportTargetDigests[store.id]) {','assertForwardRecoveryPrefix(request.paths.phaseOnePath, request.epochId, nonce);','const imports: ImportRecord[] = request.stores.map((spec) => importSnapshot({','if (document.currentEpochId === request.epochId) {','verifyPhaseOneDigest(request.paths.phaseOnePath, request.epochId, cordon.nonce, core.preCommitLogDigest);']],
    [M.stable,['Object.keys(object).sort()','return canonical(value, new Set());']],
  ];
  for(const [file,tokens] of required) need(all(file,tokens),`required:${file}`);
  need(followupStepsOk(),'evidence:required-followups');
  need(inertProofOk(),'cordon:typescript-supervisor-inert');
  need(has(M.tx,'assertLegacySupervisor(legacyIdentity, request.oldInstalledRevisionRoot);')&&has(M.tx,'assertLegacySupervisor(identity, request.oldInstalledRevisionRoot);'),'identity:legacy-supervisor-boundaries');
  const activate=body(M.tx,'export async function activateCutover'); const recover=body(M.recovery,'export async function recoverCommittedCutover');
  need(ordered(activate,['const preflight = boundary.preflight(request);','projectRegistry(request.paths.targetRegistryPath, request.paths.projectedRegistryPath)']),'order:admission');
  need(ordered(activate,['const cordon = createCordon({','boundary.drainLegacyWriters(request, legacyWriters)','boundary.terminateLegacyProcesses(']),'order:cordon');
  need(ordered(activate,['const drain = await boundary.drainLegacyWriters(request, legacyWriters);','snapshotStores(request.stores, request.paths.snapshotDir,']),'order:snapshot');
  need(ordered(activate,['const importBoundary = markImportBegun(request.paths.cordonPath);','const imports = request.stores.map((spec) => importSnapshot({']),'order:import-boundary');
  need(ordered(activate,['const imports = request.stores.map((spec) => importSnapshot({','projectRegistry(request.paths.targetRegistryPath, request.paths.projectedRegistryPath)']),'order:projection');
  need(ordered(activate,['const phaseOne = finalizePhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce);','authority.commit(request.expectedOldEpochId, core);']),'order:phase1-cas');
  need(ordered(activate,['authority.commit(request.expectedOldEpochId, core);',"appendFollowup(request.paths.followupPath, request.epochId, 'committed-registry-reprojected'"]),'order:followup');
  need(ordered(activate,['authority.commit(request.expectedOldEpochId, core);','boundary.startTypeScriptSupervisor(request, cordon.nonce)']),'order:start');
  need((activate.split('authority.commit(request.expectedOldEpochId, core);').length-1)===1&&!activate.includes('authority.commit(request.epochId, core);'),'cas:sole');
  need(activate.includes('if (survivors.supervisorAlive || survivors.writers.length !== 0) {'),'survivor:guard');
  const pwshDispatch=/\[\s*['"]pwsh['"]\s*,\s*['"]-File['"]/i.test(activate)||/command\s*:\s*['"]pwsh['"]/i.test(activate);
  need(!pwshDispatch&&!activate.includes('Review-StartClaim.ps1')&&!activate.includes('Orchestrator-SideProcessSupervisor.ps1')&&!activate.includes('successor_926_prerequisite')&&!activate.includes('successor_930_prerequisite')&&!activate.includes('hostAuthentication'),'forbidden:activation');
  need(!read(M.imports).includes('mutationOverlapProtocolReimplementation'),'forbidden:overlap'); need(!read(M.evidence).includes("completedAt: 'mutation',"),'evidence:timestamp');
  need(registryOk(),'registry:single-scheduler'); need(vectorsOk(),'vectors:canonical'); need(laneOk(),'lane:bounded'); need(modeOk(),'mode:regular');
  need(count(M.recovery,'const projection = projectRegistry(request.paths.targetRegistryPath, request.paths.projectedRegistryPath);')>=2,'recovery:projection');
  need(!read(M.recovery).includes('releaseLegacyStartBarrier(request.paths.supervisorStateDir);')&&!read(M.recovery).includes('reverseReconcileLegacyMutation')&&!read(M.recovery).includes('authority.commit(request.epochId, core);')&&!read(M.recovery).includes('authority.commit(request.epochId, authority.verify(request.epochId, cordon.nonce));'),'recovery:forward-only');
  const recoveryText=read(M.recovery); need(recoveryText.indexOf('authority.commit(request.expectedOldEpochId, core);')>=0&&recoveryText.indexOf('boundary.ensureTypeScriptSupervisor(')>recoveryText.indexOf('authority.commit(request.expectedOldEpochId, core);'),'recovery:precas');
  need(ordered(recover,['verifyPhaseOneDigest(request.paths.phaseOnePath, request.epochId, cordon.nonce, core.preCommitLogDigest);','boundary.ensureTypeScriptSupervisor(request, cordon.nonce)']),'recovery:postcas');
  need(has('scripts/lib/review-start-claim-cli.ts','  return `pr-${positiveInteger(prNumber, 0)}-${normalizeHeadSha(headSha)}`;')&&has('scripts/pack-review-runner.ts',"} from './lib/review-start-claim-store.ts';"),'claim:authority');
  for(const file of ['scripts/orchestrator-side-process-registry.json','scripts/lib/review-start-claim-store.ts','scripts/lib/review-start-claim-cli.ts','scripts/pack-review-runner.ts','scripts/reaction-config-messages.mjs']) need(clean(file),`clean:${file}`);
  need(runProcessSync({command:process.execPath,args:['--check',path.resolve(repoRoot,'scripts/reaction-config-messages.mjs')],cwd:repoRoot,inheritParentEnv:true}).ok,'denominator:syntax');
  for(const file of D928) need(!exists(file),`deleted:${file}`);
  for(const file of ['scripts/lib/cutover/review-start-claim-store.ts','scripts/issue-928-mutation.ps1','scripts/check-side-process-launch-contract.ps1','scripts/Orchestrator-SideProcessSupervisor.Tests.ps1','scripts/cutover/candidate-self-authorized.ts','tools/issue-928-mutation.ts','scripts/lib/cutover/foundation-config.ts']) need(!exists(file),`absent:${file}`);
  need(exists('scripts/orchestrator-wake-supervisor.ts')&&exists(M.supervisor),'supervisor:replacement'); need(has(M.planning,'  const boundary: ActivationBoundary = {')&&!has(M.planning,'productionActivationBoundary'),'rehearsal:inert'); need(guardOk(key,artifact),'guard:artifact');
  return out;
}

export function buildConformanceReport(ref='HEAD'):ConformanceReport {
  const commitSha=gitText(['rev-parse',`${ref}^{commit}`]), headSha=gitText(['rev-parse','HEAD']);
  const finalTreeOid=gitText(['rev-parse',`${commitSha}^{tree}`]); const findings:ConformanceFinding[]=[];
  if(commitSha!==headSha) findings.push({code:'non_head_ref_unsupported',detail:`requested=${commitSha};head=${headSha}`});
  for(const failure of mutationFailures('AC8:current-conformance','')) findings.push({code:`current_invariant:${failure}`});
  for(const file of D928) if(existsAt(commitSha,file)) findings.push({code:'d928_retired_surface_present',path:file});
  const executable=listAt(commitSha).filter((file)=>file.startsWith('scripts/')&&EXECUTABLE_EXTENSIONS.has(path.posix.extname(file).toLowerCase())).map((file)=>({path:file,content:readAt(commitSha,file)}));
  findings.push(...scanForbiddenExecutableReferences(executable));
  const state:'pass'|'fail'=findings.length===0?'pass':'fail';
  const results={AC1:state,AC2:state,AC3:state,AC4:state,AC5:state,AC6:state,AC7:state,AC8:state};
  return {schemaVersion:2,issue:948,ref,commitSha,finalTreeOid,findings,results,result:findings.length===0?'conformant':'nonconformant'};
}
function runCli(argv:string[]):void {
  const i=argv.indexOf('--ref'), requested=i>=0?argv[i+1]??'HEAD':'HEAD'; const report=buildConformanceReport(requested);
  process.stdout.write(`${JSON.stringify(report,null,argv.includes('--json')?2:0)}\n`); process.exitCode=report.result==='conformant'?0:1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)){
  try{runCli(process.argv.slice(2));}catch(error){process.stderr.write(`${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;}
}
