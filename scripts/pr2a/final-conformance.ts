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
const ISSUE_928_TEST = 'scripts/cutover/issue-928.test.ts';
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
function existsAt(ref: string, file: string): boolean { return gitOk(['cat-file', '-e', `${ref}:${file}`]); }
function helperBlobPreserved(ref: string): boolean {
  return existsAt(ref, PRE_CUTOVER_HELPER)
    && gitText(['rev-parse', `${ref}:${PRE_CUTOVER_HELPER}`]) === PRE_CUTOVER_BLOB_SHA;
}
function completePr2CutoverSignature(ref: string): boolean {
  return D928.every((file) => !existsAt(ref, file))
    && CUTOVER_MARKERS.every((file) => existsAt(ref, file))
    && helperBlobPreserved(ref);
}
function keepFinding(row: ConformanceFinding, ref: string, completeCutover: boolean): boolean {
  if (completeCutover && row.code === 'd928_target_missing_before_pr2_cutover' && row.path && D928.includes(row.path as (typeof D928)[number])) return false;
  if (completeCutover && row.code === 'd928_test_or_harness_reference' && row.path === ISSUE_928_TEST) return false;
  if (helperBlobPreserved(ref) && row.code === 'claim_internal_implementation_externally_reachable' && row.path === PRE_CUTOVER_HELPER) return false;
  return true;
}
function recomputeResults(findings: ConformanceFinding[]): ConformanceReport['results'] {
  return Object.fromEntries(Object.entries(RESULT_PREFIXES).map(([ac, prefixes]) => [
    ac,
    findings.some((row) => prefixes.some((prefix) => row.code.startsWith(prefix))) ? 'fail' : 'pass',
  ])) as ConformanceReport['results'];
}
export function buildConformanceReport(ref = 'HEAD'): ConformanceReport {
  const base = buildPreCutoverConformanceReport(ref);
  const completeCutover = completePr2CutoverSignature(base.commitSha);
  const findings = base.findings.filter((row) => keepFinding(row, base.commitSha, completeCutover));
  return { ...base, findings, results: recomputeResults(findings), result: findings.length === 0 ? 'conformant' : 'nonconformant' };
}

const M = {
  tx: 'scripts/lib/cutover/activation-transaction.ts', cordon: 'scripts/lib/cutover/activation-cordon.ts',
  imports: 'scripts/lib/cutover/activation-import.ts', epoch: 'scripts/lib/cutover/activation-epoch-authority.ts',
  evidence: 'scripts/lib/cutover/activation-evidence.ts', recovery: 'scripts/lib/cutover/activation-recovery.ts',
  preflight: 'scripts/lib/cutover/activation-platform-preflight.ts', projection: 'scripts/lib/cutover/activation-registry-projection.ts',
  supervisor: 'scripts/lib/orchestrator-side-process-supervisor.ts', stable: 'scripts/lib/cutover/stable-stringify.ts',
  planning: 'scripts/cutover/issue-928.test.ts', estate: 'scripts/estate-cut/issue-906.manifest.json', targetRegistry: 'scripts/orchestrator-side-process-registry.cutover-target.json',
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
function estateRows(value: unknown, rows: Array<{ path: string; terminalState?: unknown; replacementOwner?: unknown }> = []): Array<{ path: string; terminalState?: unknown; replacementOwner?: unknown }> {
  if (Array.isArray(value)) {
    for (const entry of value) estateRows(entry, rows);
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.path === 'string' && 'terminalState' in record) {
      rows.push({ path: record.path, terminalState: record.terminalState, replacementOwner: record.replacementOwner });
    }
    for (const entry of Object.values(record)) estateRows(entry, rows);
  }
  return rows;
}
function estateSuccessorOk(): boolean {
  try {
    const value = JSON.parse(read(M.estate)) as { objectiveStateDomain?: unknown[] };
    if (!Array.isArray(value.objectiveStateDomain)
      || value.objectiveStateDomain.filter((state) => state === 'cutover-terminalized').length !== 1) return false;
    const rows = estateRows(value);
    for (const file of CUTOVER_TERMINAL_ROWS) {
      const matches = rows.filter((row) => row.path === file);
      if (matches.length !== 1
        || matches[0]!.terminalState !== 'cutover-terminalized'
        || matches[0]!.replacementOwner !== 'scripts/orchestrator-cutover-activate.ts') return false;
    }
    D928.forEach((file, index) => {
      const matches = rows.filter((row) => row.path === file);
      if (matches.length !== 1
        || matches[0]!.terminalState !== 'deleted-now'
        || matches[0]!.replacementOwner !== D928_REPLACEMENT_OWNERS[index]) throw new Error('d928_estate_successor_invalid');
    });
    return true;
  } catch {
    return false;
  }
}

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

function ac1InvariantHolds(key: string): boolean {
  switch (key) {
    case 'AC1:operator-ack-only': return has(M.tx, 'const foundation = await boundary.proveFoundationAdoption(request);');
    case 'AC1:pr2a-merge-missing': return has(M.tx, "if (!isAncestor(repoRoot, PR2A_LANDING_COMMIT, baseRef)) throw new Error('pr2a_merge_missing');");
    case 'AC1:pr2a-receipt-trusted-without-recompute': return has(M.tx, 'const { baseRef, closure } = await boundary.resolveBaseAndClosure(request);');
    case 'AC1:closure-schema-incompatible': return has(M.tx, "if (manifest.schemaVersion !== 1) throw new Error('closure_schema_incompatible');");
    case 'AC1:external-supervisor-library-reference':
    case 'AC1:external-claim-library-reference': return has(M.tx, 'const TARGET_LIBRARIES = new Set<string>(TARGET_LIBRARY_PATHS);');
    case 'AC1:closure-unresolved-set-nonempty': return has(M.tx, 'if ((manifest.unknown ?? []).length !== 0 || (manifest.dynamicUnsupported ?? []).length !== 0) {');
    case 'AC1:closure-input-tree-unbound': return has(M.tx, "if (!manifest.lineage?.planningBaseTreeOid) throw new Error('closure_input_tree_unbound');");
    case 'AC1:fleet-member-omitted': return has(M.tx, 'if (member.quarantined !== true && !heartbeatHosts.has(member.hostId)) throw new Error(`foundation_member_omitted:${member.hostId}`);');
    case 'AC1:stale-member-accepted': return has(M.tx, 'if (!Number.isFinite(observedMs) || observedMs > nowMs + 30_000 || nowMs - observedMs > FOUNDATION_HEARTBEAT_MAX_AGE_MS) {');
    case 'AC1:rejoining-member-unquarantined': return has(M.tx, 'if (configured.quarantined !== true) throw new Error(`foundation_member_not_quarantined:${evidenceHeartbeat.hostId}`);');
    case 'AC1:diverged-revision-accepted': return has(M.tx, 'if (heartbeat.active !== true || heartbeat.installedCommitSha !== oldInstalledCommitSha) {');
    case 'AC1:second-control-plane-host': return has(M.tx, "if (member.hostId !== request.hostId && member.quarantined !== true) throw new Error('second_control_plane_host');");
    case 'AC1:host-or-repo-unbound': return has(M.tx, "if (!request.hostId || request.hostId !== observedLocalHost) throw new Error('foundation_host_unbound');");
    case 'AC1:installed-commit-unbound': return has(M.preflight, "if (actualHead.toLowerCase() !== input.installedCommitSha.toLowerCase()) throw new Error('installed_commit_unbound');");
    case 'AC1:old-installed-revision-missing': return has(M.preflight, "if (!existsSync(input.repoRoot) || !existsSync(input.oldInstalledRevisionRoot)) throw new Error('installed_revision_missing');");
    case 'AC1:legacy-supervisor-identity-ambiguous': return has(M.tx, 'assertLegacySupervisor(legacyIdentity, request.oldInstalledRevisionRoot);');
    case 'AC1:node22-not-enforced': return has(M.preflight, "if (major !== 22) throw new Error('node22_required');");
    case 'AC1:competing-transaction-admitted': return has(M.cordon, "if (existsSync(input.path)) throw new Error('competing_transaction_admitted');");
    case 'AC1:successor-926-used-as-prerequisite': return !has(M.tx, 'successor_926_prerequisite');
    case 'AC1:mutation-before-admission': return ordered(body(M.tx,'export async function activateCutover'), ['const preflight = boundary.preflight(request);','projectRegistry(request.paths.targetRegistryPath, request.paths.projectedRegistryPath)']);
    default: return false;
  }
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
    [M.preflight,["if (platform !== 'linux') throw new Error('unsupported_platform');","if (major !== 22) throw new Error('node22_required');","if (actualHead.toLowerCase() !== input.installedCommitSha.toLowerCase()) throw new Error('installed_commit_unbound');","if (!existsSync(input.repoRoot) || !existsSync(input.oldInstalledRevisionRoot)) throw new Error('installed_revision_missing');",'if (value !== lexical || lexical !== canonical) throw new Error(`${label}_not_canonical`);',"if (statSync(targetParent).dev !== statSync(projectionParent).dev) throw new Error('registry_cross_device_projection');"]],
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
  need(estateSuccessorOk(),'estate:cutover-terminalized');
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
  for(const file of ['scripts/orchestrator-side-process-registry.json','scripts/lib/review-start-claim-store.ts','scripts/lib/review-start-claim-cli.ts','scripts/pack-review-runner.ts','scripts/reaction-config-messages.mjs','scripts/pr2a/planning-manifest.json']) need(clean(file),`clean:${file}`);
  need(runProcessSync({command:process.execPath,args:['--check',path.resolve(repoRoot,'scripts/reaction-config-messages.mjs')],cwd:repoRoot,inheritParentEnv:true}).ok,'denominator:syntax');
  for(const file of D928) need(!exists(file),`deleted:${file}`);
  for(const file of ['scripts/lib/cutover/review-start-claim-store.ts','scripts/issue-928-mutation.ps1','scripts/check-side-process-launch-contract.ps1','scripts/Orchestrator-SideProcessSupervisor.Tests.ps1','scripts/cutover/candidate-self-authorized.ts','tools/issue-928-mutation.ts','scripts/lib/cutover/foundation-config.ts']) need(!exists(file),`absent:${file}`);
  need(exists('scripts/orchestrator-wake-supervisor.ts')&&exists(M.supervisor),'supervisor:replacement'); need(has(M.planning,'  const boundary: ActivationBoundary = {')&&!has(M.planning,'productionActivationBoundary'),'rehearsal:inert'); need(guardOk(key,artifact),'guard:artifact');
  return out;
}
function runMutationCheck(argv:string[]):void{
  const index=argv.indexOf('--mutation-check'); const key=index>=0?String(argv[index+1]??'').trim():''; if(!key)throw new Error('mutation_check_key_missing');
  const artifactIndex=argv.indexOf('--artifact'); const artifact=artifactIndex>=0?String(argv[artifactIndex+1]??'').trim():'';
  const red = key.startsWith('AC1:') ? !ac1InvariantHolds(key) : mutationFailures(key,artifact).length > 0;
  if(red){process.stderr.write(`mutation-contract:${key}\n`);process.exitCode=1;return;}
  process.stdout.write(`mutation-contract:${key}: passed\n`);
}
function runCli(argv: string[]): void {
  if (argv.includes('--mutation-check')) { runMutationCheck(argv); return; }
  const refIndex = argv.indexOf('--ref'); const requestedRef = refIndex >= 0 ? argv[refIndex + 1] ?? 'HEAD' : 'HEAD';
  const report = buildConformanceReport(requestedRef); process.stdout.write(`${JSON.stringify(report, null, argv.includes('--json') ? 2 : 0)}\n`); process.exitCode = report.result === 'conformant' ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try { runCli(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
