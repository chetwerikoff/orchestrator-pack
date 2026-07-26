#!/usr/bin/env node
import '../toolchain/native-entrypoint-preflight.ts';

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';
import { stableStringify } from '../lib/cutover/stable-stringify.ts';
import { D928 } from './contracts.ts';
import {
  buildConformanceReport as buildPreCutoverConformanceReport,
  type ConformanceFinding,
  type ConformanceReport,
} from './final-conformance-precutover.ts';

export * from './final-conformance-precutover.ts';

const repoRoot = path.resolve(process.cwd());
const PRE_CUTOVER_BLOB_SHA = '8840d070078f9fa61813a04ea66279d351013cfd';
const PRE_CUTOVER_HELPER = 'scripts/pr2a/final-conformance-precutover.ts';
const ISSUE_928_TEST = 'scripts/pr2a/planning.test.ts';
const ISSUE_928_MUTATION_RUNNER = 'scripts/cutover/mutation-runner.ts';
const CUTOVER_MARKERS = [
  'scripts/orchestrator-cutover-activate.ts',
  'scripts/orchestrator-side-process-registry.cutover-target.json',
  ISSUE_928_TEST,
] as const;

const RESULT_PREFIXES: Readonly<Record<keyof ConformanceReport['results'], readonly string[]>> = {
  AC1: ['planning_', 'planned_', 'unreviewed_', 'mutation-contract:AC1:'],
  AC2: ['runner_', 'claim_store_', 'mutation-contract:AC2:'],
  AC3: ['bridge_', 'claim_internal_', 'actionable_manifest_', 'd928_external_', 'mutation-contract:AC3:'],
  AC4: ['d928_test_', 'd928_bytes_', 'd928_target_', 'mutation-contract:AC4:'],
  AC5: ['bridge_', 'runner_', 'claim_store_', 'claim_internal_', 'closure_receipt_', 'd928_external_', 'mutation-contract:AC5:'],
  AC6: ['retired_launch_', 'actionable_manifest_', 'mutation-contract:AC6:'],
  AC7: ['path_outside_', 'denylisted_', 'new_powershell_', 'non_regular_', 'planned_', 'unreviewed_', 'mutation-contract:AC7:'],
  AC8: ['package_', 'issue948_', 'contract_mutation_', 'closure_receipt_', 'claim_store_', 'bridge_', 'runner_', 'claim_internal_', 'd928_', 'planning_', 'planned_', 'unreviewed_', 'path_outside_', 'denylisted_', 'new_powershell_', 'non_regular_', 'retired_launch_', 'actionable_manifest_', 'mutation-contract:AC8:'],
};

function gitOk(args: string[]): boolean {
  return runProcessSync({ command: 'git', args, cwd: repoRoot, inheritParentEnv: true }).ok;
}

function gitText(args: string[]): string {
  const result = runProcessSync({ command: 'git', args, cwd: repoRoot, inheritParentEnv: true });
  if (!result.ok) throw new Error(result.stderr || result.error || `git_${args.join('_')}_failed`);
  return result.stdout.trim();
}

function existsAt(ref: string, file: string): boolean {
  return gitOk(['cat-file', '-e', `${ref}:${file}`]);
}

function helperBlobPreserved(ref: string): boolean {
  if (!existsAt(ref, PRE_CUTOVER_HELPER)) return false;
  return gitText(['rev-parse', `${ref}:${PRE_CUTOVER_HELPER}`]) === PRE_CUTOVER_BLOB_SHA;
}

function completePr2CutoverSignature(ref: string): boolean {
  return D928.every((file) => !existsAt(ref, file))
    && CUTOVER_MARKERS.every((file) => existsAt(ref, file))
    && helperBlobPreserved(ref);
}

function keepFinding(row: ConformanceFinding, ref: string, completeCutover: boolean): boolean {
  if (completeCutover && row.code === 'd928_target_missing_before_pr2_cutover' && row.path && D928.includes(row.path as (typeof D928)[number])) {
    return false;
  }
  if (completeCutover && row.code === 'd928_test_or_harness_reference' && row.path === ISSUE_928_TEST) {
    return false;
  }
  if (completeCutover && row.code === 'd928_external_executable_reference' && row.path === ISSUE_928_MUTATION_RUNNER) {
    return false;
  }
  if (
    helperBlobPreserved(ref)
    && row.code === 'claim_internal_implementation_externally_reachable'
    && row.path === PRE_CUTOVER_HELPER
  ) {
    return false;
  }
  return true;
}

function recomputeResults(findings: ConformanceFinding[]): ConformanceReport['results'] {
  return Object.fromEntries(
    Object.entries(RESULT_PREFIXES).map(([ac, prefixes]) => [
      ac,
      findings.some((row) => prefixes.some((prefix) => row.code.startsWith(prefix))) ? 'fail' : 'pass',
    ]),
  ) as ConformanceReport['results'];
}

export function buildConformanceReport(ref = 'HEAD'): ConformanceReport {
  const base = buildPreCutoverConformanceReport(ref);
  const completeCutover = completePr2CutoverSignature(base.commitSha);
  const findings = base.findings.filter((row) => keepFinding(row, base.commitSha, completeCutover));
  return {
    ...base,
    findings,
    results: recomputeResults(findings),
    result: findings.length === 0 ? 'conformant' : 'nonconformant',
  };
}

const MUTATION_FILES = {
  tx: 'scripts/lib/cutover/activation-transaction.ts', cordon: 'scripts/lib/cutover/activation-cordon.ts',
  imports: 'scripts/lib/cutover/activation-import.ts', epoch: 'scripts/lib/cutover/activation-epoch-authority.ts',
  evidence: 'scripts/lib/cutover/activation-evidence.ts', recovery: 'scripts/lib/cutover/activation-recovery.ts',
  preflight: 'scripts/lib/cutover/activation-platform-preflight.ts', projection: 'scripts/lib/cutover/activation-registry-projection.ts',
  supervisor: 'scripts/lib/orchestrator-side-process-supervisor.ts', stable: 'scripts/lib/cutover/stable-stringify.ts',
  planning: 'scripts/pr2a/planning.test.ts', targetRegistry: 'scripts/orchestrator-side-process-registry.cutover-target.json',
  lane: 'scripts/vitest-ci-lanes.config.json', vectors: 'scripts/fixtures/cutover/stable-stringify-vectors.json',
} as const;
function mread(file: string): string { return readFileSync(path.resolve(repoRoot, file), 'utf8'); }
function mexists(file: string): boolean { return existsSync(path.resolve(repoRoot, file)); }
function mhas(file: string, token: string): boolean { return mexists(file) && mread(file).includes(token); }
function mcount(file: string, token: string): number { return mexists(file) ? mread(file).split(token).length - 1 : 0; }
function mclean(file: string): boolean { return gitOk(['diff','--quiet','HEAD','--',file]) && gitOk(['diff','--cached','--quiet','HEAD','--',file]); }
function mbody(file: string, marker: string): string { const text=mread(file); const i=text.indexOf(marker); return i<0?'':text.slice(i); }
function morder(text: string, tokens: readonly string[]): boolean { let p=-1; for(const token of tokens){const i=text.indexOf(token); if(i<0||i<=p)return false; p=i;} return true; }
function mall(file: string, tokens: readonly string[]): boolean { return tokens.every((token)=>mhas(file,token)); }
function registryOk(): boolean { try { const v=JSON.parse(mread(MUTATION_FILES.targetRegistry)) as any; return v?.schemaVersion===2&&v.requiredChildIds?.length===1&&v.requiredChildIds[0]==='pr2-scheduler'&&v.children?.length===1&&v.children[0]?.id==='pr2-scheduler'&&v.children[0]?.runtime==='node'&&v.children[0]?.script==='pr2-foundation/scheduler.ts'&&v.children[0]?.sideEffecting===true; } catch { return false; } }
function vectorsOk(): boolean { try { const v=JSON.parse(mread(MUTATION_FILES.vectors)) as any; return Array.isArray(v?.vectors)&&v.vectors.length>0&&v.vectors.every((row:any)=>stableStringify(row.input)===row.canonical); } catch { return false; } }
function laneOk(): boolean { try { const v=JSON.parse(mread(MUTATION_FILES.lane)) as any; return v?.lightMaxWorkers===2&&v?.classification?.['scripts/pr2a/planning.test.ts']==='light'&&Array.isArray(v?.heavyFileBatchIsolate)&&!v.heavyFileBatchIsolate.includes('scripts/pr2a/planning.test.ts'); } catch { return false; } }
function modeOk(): boolean { const f='scripts/orchestrator-wake-supervisor.ts'; if(!mexists(f))return false; const row=gitText(['ls-files','-s','--',f]).split(/\s+/,1)[0]??''; return /^100(644|755)$/.test(row)&&(row==='100755')===((statSync(path.resolve(repoRoot,f)).mode&0o111)!==0); }
function guardOk(key:string, artifact:string):boolean { if(!key.startsWith('AC8:guard-')&&!key.includes('guard-record-missing'))return true; if(!artifact||!existsSync(path.resolve(artifact)))return false; try { const v=JSON.parse(readFileSync(path.resolve(artifact),'utf8')) as any; if(v?.schemaVersion!==1||v?.prHeadSha!==gitText(['rev-parse','HEAD'])||v?.platform!=='linux')return false; return ['verify','reusable'].every((n)=>{const r=v?.records?.[n]; return !!r&&typeof r.command==='string'&&r.command.includes('pwsh')&&String(r.pwshVersion??'').startsWith('7.')&&r.platform==='linux'&&r.exitCode===0&&/^sha256:[0-9a-f]{64}$/i.test(String(r.stdoutDigest??''))&&Number.isFinite(Date.parse(String(r.completedAt??'')));}); } catch { return false; } }
function mutationFailures(key:string, artifact:string):string[]{
  const F=MUTATION_FILES, out:string[]=[]; const need=(ok:boolean,id:string)=>{if(!ok)out.push(id);};
  const required: Array<[string, readonly string[]]> = [
    [F.tx,[
      'const foundation = boundary.proveFoundationAdoption(request);',"if (!isAncestor(repoRoot, PR2A_LANDING_COMMIT, baseRef)) throw new Error('pr2a_merge_missing');",'const { baseRef, closure } = boundary.resolveBaseAndClosure(request);',"if (manifest.schemaVersion !== 1) throw new Error('closure_schema_incompatible');",'const TARGET_LIBRARIES = new Set<string>(TARGET_LIBRARY_PATHS);',"if (!manifest.lineage?.planningBaseTreeOid) throw new Error('closure_input_tree_unbound');",'if ((manifest.unknown ?? []).length !== 0 || (manifest.dynamicUnsupported ?? []).length !== 0) {','if (member.quarantined !== true && !heartbeatHosts.has(member.hostId)) throw new Error(`foundation_member_omitted:${member.hostId}`);','if (!Number.isFinite(observedMs) || observedMs > nowMs + 30_000 || nowMs - observedMs > FOUNDATION_HEARTBEAT_MAX_AGE_MS) {','if (configured.quarantined !== true) throw new Error(`foundation_member_not_quarantined:${heartbeat.hostId}`);','if (heartbeat.active !== true || heartbeat.installedCommitSha !== oldInstalledCommitSha) {',"if (member.hostId !== request.hostId && member.quarantined !== true) throw new Error('second_control_plane_host');","if (!request.hostId || request.hostId !== observedLocalHost) throw new Error('foundation_host_unbound');",'assertLegacySupervisor(legacyIdentity, request.oldInstalledRevisionRoot);','    preCommitLogDigest: phaseOne.digest,']],
    [F.preflight,["if (platform !== 'linux') throw new Error('unsupported_platform');","if (major !== 22) throw new Error('node22_required');","if (actualHead.toLowerCase() !== input.installedCommitSha.toLowerCase()) throw new Error('installed_commit_unbound');","if (!existsSync(input.repoRoot) || !existsSync(input.oldInstalledRevisionRoot)) throw new Error('installed_revision_missing');",'if (value !== lexical || lexical !== canonical) throw new Error(`${label}_not_canonical`);',"if (statSync(targetParent).dev !== statSync(projectionParent).dev) throw new Error('registry_cross_device_projection');"]],
    [F.cordon,["if (existsSync(input.path)) throw new Error('competing_transaction_admitted');",'    writersClosed: true,','    noRespawn: true,','    noTypeScriptStart: true,',"nonce: randomBytes(32).toString('hex'),",'assertSameProcess(identity);','if (survivors.length) throw new Error(`legacy_process_survivor:${survivors.join(\',\')}`);','    oldInstalledRevisionRoot: input.oldInstalledRevisionRoot,']],
    [F.imports,["if (!writerWatermark.trim()) throw new Error('writer_watermark_missing');",'snapshotDigest: sha256Bytes(bytes)','if (!Number.isInteger(sourceVersion) || sourceVersion <= 0)','if (!required || JSON.stringify([...spec.coveredFields]) !== JSON.stringify(required)) throw new Error(`store_covered_fields_invalid:${spec.id}`);',"if (unknown.length) throw new Error(`store_unknown_field:${spec.id}:${unknown.join(',')}`);",'    nonce: input.nonce,','    storeId: input.spec.id,','  writeDurableJson(markerPath, record);','  writeDurableFile(input.spec.targetPath, `${JSON.stringify(normalized, null, 2)}\\n`);','if (sha256Stable(existing) !== importTargetDigest) throw new Error(`import_target_digest_mismatch:${input.spec.id}`);','if (sha256Stable(readBack) !== importTargetDigest) throw new Error(`import_target_digest_mismatch:${input.spec.id}`);']],
    [F.evidence,['fsyncSync(fd);','renameSync(temporary, target);','syncDirectory(directory);','    epochId,\n    sequence: existing.length + 1,','completedAt: new Date().toISOString(),',"'committed-registry-reprojected'","'typescript-supervisor-started'","'scheduler-owned'","'machine-local-completion-fsync-confirmed'","'final-step-timestamp-recorded'","'final-health-delivery-observed'","'activation-complete'"]],
    [F.epoch,["if (document.currentEpochId !== expectedOldEpochId) throw new Error('epoch_cas_conflict');","if (document.records.some((row) => row.epochId === core.epochId)) throw new Error('epoch_duplicate_commit');","if (!record || record.nonce !== nonce) throw new Error('epoch_nonce_mismatch');",'    mkdirSync(lock);',"  'epochId', 'nonce', 'hostId',","  'importDigests', 'registryHash', 'preCommitLogDigest', 'commitAt',"]],
    [F.projection,['writeDurableFile(projectionPath, source);',"if (!readBack.equals(source)) throw new Error('registry_projection_readback_mismatch');"]],
    [F.supervisor,['projectRegistry(options.targetRegistryPath, options.projectedRegistryPath)','new FileEpochAuthority(options.epochAuthorityPath).verify(options.epochId, options.nonce)','const projected = projectRegistry(options.targetRegistryPath, options.projectedRegistryPath);']],
    [F.recovery,['if (fileDigestOrAbsent(store.targetPath) !== cordon.preImportTargetDigests[store.id]) {','assertForwardRecoveryPrefix(request.paths.phaseOnePath, request.epochId, nonce);','const imports: ImportRecord[] = request.stores.map((spec) => importSnapshot({','if (document.currentEpochId === request.epochId) {','verifyPhaseOneDigest(request.paths.phaseOnePath, request.epochId, cordon.nonce, core.preCommitLogDigest);']],
    [F.stable,['Object.keys(object).sort()','return canonical(value, new Set());']],
  ];
  for(const [file,tokens] of required) need(mall(file,tokens),`required:${file}`);
  const activate=mbody(F.tx,'export async function activateCutover'), precas=mbody(F.recovery,'function completePreCasRecovery'), recover=mbody(F.recovery,'export async function recoverCommittedCutover');
  need(morder(activate,['const preflight = boundary.preflight(request);','projectRegistry(request.paths.targetRegistryPath, request.paths.projectedRegistryPath)']),'order:admission');
  need(morder(activate,['const cordon = createCordon({','boundary.drainLegacyWriters(request, legacyWriters)','boundary.terminateLegacyProcesses(']),'order:cordon');
  need(morder(activate,['const drain = await boundary.drainLegacyWriters(request, legacyWriters);','const snapshots = snapshotStores(request.stores, request.paths.snapshotDir, drain.writerWatermark);']),'order:snapshot');
  need(morder(activate,['const importBoundary = markImportBegun(request.paths.cordonPath);','const imports = request.stores.map((spec) => importSnapshot({']),'order:import-boundary');
  need(morder(activate,['const imports = request.stores.map((spec) => importSnapshot({','projectRegistry(request.paths.targetRegistryPath, request.paths.projectedRegistryPath)']),'order:projection');
  need(morder(activate,['const phaseOne = finalizePhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce);','authority.commit(request.expectedOldEpochId, core);']),'order:phase1-cas');
  need(morder(activate,['authority.commit(request.expectedOldEpochId, core);',"appendFollowup(request.paths.followupPath, request.epochId, 'committed-registry-reprojected'"]),'order:followup');
  need(morder(activate,['authority.commit(request.expectedOldEpochId, core);','boundary.startTypeScriptSupervisor(request, cordon.nonce)']),'order:start');
  need((activate.split('authority.commit(request.expectedOldEpochId, core);').length-1)===1&&!activate.includes('authority.commit(request.epochId, core);'),'cas:sole');
  need(activate.includes('if (survivors.supervisorAlive || survivors.writers.length !== 0) {'),'survivor:guard');
  need(!/\bpwsh\b/i.test(activate)&&!activate.includes('Review-StartClaim.ps1')&&!activate.includes('Orchestrator-SideProcessSupervisor.ps1')&&!activate.includes('successor_926_prerequisite')&&!activate.includes('successor_930_prerequisite')&&!activate.includes('hostAuthentication'),'forbidden:activation');
  need(!mread(F.imports).includes('mutationOverlapProtocolReimplementation'),'forbidden:overlap');
  need(!mread(F.evidence).includes("completedAt: 'mutation',"),'evidence:timestamp');
  need(registryOk(),'registry:single-scheduler'); need(vectorsOk(),'vectors:canonical'); need(laneOk(),'lane:bounded'); need(modeOk(),'mode:regular');
  need(mcount(F.recovery,'const projection = projectRegistry(request.paths.targetRegistryPath, request.paths.projectedRegistryPath);')>=2,'recovery:projection');
  need(!mread(F.recovery).includes('releaseLegacyStartBarrier(request.paths.supervisorStateDir);')&&!mread(F.recovery).includes('reverseReconcileLegacyMutation')&&!mread(F.recovery).includes('authority.commit(request.epochId, core);')&&!mread(F.recovery).includes('authority.commit(request.epochId, authority.verify(request.epochId, cordon.nonce));'),'recovery:forward-only');
  need(precas.includes('authority.commit(request.expectedOldEpochId, core);')&&!precas.includes('boundary.ensureTypeScriptSupervisor('),'recovery:precas');
  need(morder(recover,['verifyPhaseOneDigest(request.paths.phaseOnePath, request.epochId, cordon.nonce, core.preCommitLogDigest);','boundary.ensureTypeScriptSupervisor(request, cordon.nonce)']),'recovery:postcas');
  need(mhas('scripts/lib/review-start-claim-cli.ts','  return `pr-${positiveInteger(prNumber, 0)}-${normalizeHeadSha(headSha)}`;')&&mhas('scripts/pack-review-runner.ts',"} from './lib/review-start-claim-store.ts';"),'claim:authority');
  for(const file of ['scripts/orchestrator-side-process-registry.json','scripts/lib/review-start-claim-store.ts','scripts/lib/review-start-claim-cli.ts','scripts/pack-review-runner.ts','scripts/reaction-config-messages.mjs','scripts/pr2a/planning-manifest.json']) need(mclean(file),`clean:${file}`);
  need(runProcessSync({command:process.execPath,args:['--check',path.resolve(repoRoot,'scripts/reaction-config-messages.mjs')],cwd:repoRoot,inheritParentEnv:true}).ok,'denominator:syntax');
  for(const file of D928) need(!mexists(file),`deleted:${file}`);
  for(const file of ['scripts/lib/cutover/review-start-claim-store.ts','scripts/issue-928-mutation.ps1','scripts/check-side-process-launch-contract.ps1','scripts/Orchestrator-SideProcessSupervisor.Tests.ps1','scripts/cutover/candidate-self-authorized.ts','tools/issue-928-mutation.ts','scripts/lib/cutover/foundation-config.ts']) need(!mexists(file),`absent:${file}`);
  need(mexists('scripts/orchestrator-wake-supervisor.ts')&&mexists(F.supervisor),'supervisor:replacement');
  need(mhas(F.planning,'  const boundary: ActivationBoundary = {')&&!mhas(F.planning,'productionActivationBoundary'),'rehearsal:inert');
  need(guardOk(key,artifact),'guard:artifact');
  return out;
}
function runMutationCheck(argv:string[]):void{ const i=argv.indexOf('--mutation-check'),key=i>=0?String(argv[i+1]??'').trim():''; if(!key)throw new Error('mutation_check_key_missing'); const a=argv.indexOf('--artifact'),artifact=a>=0?String(argv[a+1]??'').trim():''; const failures=mutationFailures(key,artifact); if(failures.length){process.stderr.write(`mutation-contract:${key}\n${failures.join('\n')}\n`);process.exitCode=1;return;} process.stdout.write(`mutation-contract:${key}: passed\n`); }

function runCli(argv: string[]): void {
  if (argv.includes('--mutation-check')) {
    runMutationCheck(argv);
    return;
  }
  const refIndex = argv.indexOf('--ref');
  const requestedRef = refIndex >= 0 ? argv[refIndex + 1] ?? 'HEAD' : 'HEAD';
  const report = buildConformanceReport(requestedRef);
  const indentation = argv.includes('--json') ? 2 : 0;
  process.stdout.write(`${JSON.stringify(report, null, indentation)}\n`);
  process.exitCode = report.result === 'conformant' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
