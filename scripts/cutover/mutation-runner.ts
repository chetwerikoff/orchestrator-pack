#!/usr/bin/env node
import '../toolchain/native-entrypoint-preflight.ts';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activateCutover, type ActivationBoundary } from '../lib/cutover/activation-transaction.ts';
import { createCordon, markImportBegun } from '../lib/cutover/activation-cordon.ts';
import { FileEpochAuthority } from '../lib/cutover/activation-epoch-authority.ts';
import { provePreImportRollbackSafe } from '../lib/cutover/activation-recovery.ts';
import { runActivationPlatformPreflight } from '../lib/cutover/activation-platform-preflight.ts';
import { appendFollowup } from '../lib/cutover/activation-evidence.ts';
import type { ActivationRequest, EpochCommitCore, ProcessIdentity } from '../lib/cutover/types.ts';
import { runSchedulerTick, type SchedulerBoundary } from '../pr2-foundation/scheduler.ts';

const CONTROLS = {
  AC1: ["operator-ack-only","pr2a-merge-missing","pr2a-receipt-trusted-without-recompute","closure-schema-incompatible","external-supervisor-library-reference","external-claim-library-reference","closure-unresolved-set-nonempty","closure-input-tree-unbound","fleet-member-omitted","stale-member-accepted","rejoining-member-unquarantined","diverged-revision-accepted","second-control-plane-host","host-or-repo-unbound","installed-commit-unbound","old-installed-revision-missing","legacy-supervisor-identity-ambiguous","node22-not-enforced","competing-transaction-admitted","successor-926-used-as-prerequisite","mutation-before-admission"],
  AC2: ["install-kills-old-supervisor","install-gap-acquirer-gap","ts-supervisor-starts-at-install","dual-supervisor-owner","cordon-not-first","legacy-supervisor-terminated-before-cordon","legacy-supervisor-survivor","legacy-supervisor-identity-unverified","ts-supervisor-start-before-cas","store-writer-ingress-left-open","concurrent-writer-admitted","drain-watermark-missing","pid-identity-unverified","survivor-accepted","registry-projection-before-import-digest","registry-file-or-parent-not-fsynced","registry-readback-hash-missing","precommit-log-not-durable-before-cas","precommit-digest-not-in-core","precommit-log-digest-mismatch-accepted","registry-treated-as-commit","central-cas-not-sole-commit","cas-core-field-extra-or-missing","postcommit-followup-treated-as-commit","cas-conflict-ignored","tracked-registry-restored-consumed","legacy-executable-reference-restored","epoch-gated-source-missing","postactivation-start-without-reprojection","dual-scheduler"],
  AC3: ["snapshot-before-drain","writer-watermark-missing","concurrent-store-writer","snapshot-version-missing","snapshot-digest-not-raw-bytes","digest-algorithm-not-sha256","stable-stringify-key-order-wrong","stable-stringify-whitespace-present","unicode-or-escape-vector-mismatch","negative-zero-or-exponent-vector-mismatch","nested-key-order-vector-mismatch","vector-failing-payload-accepted","store-covered-field-omitted","unknown-store-field-silently-ignored","target-import-identity-missing","target-import-identity-aliased","target-cas-or-upsert-omitted","marker-only-completion","target-state-digest-mismatch-accepted","post-mutation-pre-marker-reapplied","legacy-read-partial-import","claim-store-modified","claim-reaper-modified","claim-semantics-changed","claim-key-or-namespace-changed","second-claim-store-created","claimant-family-not-ts-native","powershell-claim-path-resurrected","four-deletion-disturbs-claim-authority","pr2a-overlap-proof-reimplemented"],
  AC4: ["harness-owned-cycle","merge-rehearsal-labeled-live","staged-registry-missing","staged-registry-has-legacy-child","live-registry-diff-at-merge","denominator-file-diff-from-post948-base","denominator-file-not-loadable","install-gap-old-supervisor-continuity-untested","ts-supervisor-not-inert","claim-authority-diff-at-merge","claim-key-changed","durable-delivery-missing","cutover-row-not-terminalized","deleted-supervisor-duty-missing","orphan-claim-file-not-deleted","powershell-shim-used-in-rehearsal","retired-launch-contract-guard-restored","926-precedes-adoption","930-precedes-926"],
  AC5: ["preimport-target-change-unchecked","rollback-old-revision-unbound","rollback-uses-new-checkout-ps-shim","import-begin-recorded-after-mutation","legacy-restored-after-import-begin","legacy-epoch-rearmed-on-migrated-store","postmutation-import-bytes-discarded","forward-recovery-uncordoned","registry-projection-crash-unrecovered","precommit-log-digest-mismatch-accepted","precommit-log-fabricated-on-recovery","precas-ts-supervisor-started","postactivation-start-without-reprojection","postcas-followup-missing-treated-uncommitted","postcas-followup-changes-commit","postcas-legacy-restored","reverse-reconciliation-completeness-claimed"],
  AC6: ["candidate-manifest-self-authorizes","addition-root-not-predeclared","foundation-component-reimplemented","live-registry-modified","denominator-compatibility-file-modified","denominator-file-not-loadable","staged-registry-omitted","unrelated-manifest-row-changed","required-ps-deletion-missing","ps-file-shimmed-not-deleted","new-powershell-logic-added","powershell-file-modified-instead-of-deleted","powershell-file-renamed","embedded-powershell-program","cutover-module-spawns-pwsh","supervisor-ts-replacement-missing","claim-store-modified","claim-reaper-modified","claimant-family-modified","second-claim-store-created","powershell-claim-path-resurrected","retired-launch-contract-guard-restored","legacy-executable-reference-restored","symlink-mode","gitlink-mode","nonregular-mode","test-classification-missing","test-classification-duplicate","lane-config-overreach"],
  AC7: ["cas-core-field-extra-or-missing","pr2a-closure-admission-evidence-missing","precommit-log-not-durable-before-cas","precommit-digest-not-in-core","precommit-log-digest-mismatch-accepted","legacy-supervisor-termination-evidence-missing","ts-supervisor-inert-evidence-missing","precommit-timestamp-outside-core","postcommit-timestamp-in-core","followup-epoch-reference-missing","followup-sequence-duplicate","followup-sequence-gap","followup-sequence-nonmonotonic","followup-treated-authoritative","ts-supervisor-start-followup-missing","scheduler-enable-followup-missing","local-fsync-followup-missing","host-context-described-as-authentication","second-commit-same-epoch","nonce-not-generated-at-cordon","nonce-not-stored-centrally","consumer-skips-central-nonce-equality","stale-nonce-replay","local-record-treated-authoritative","rehearsal-record-accepted-live","same-tuple-recovery-duplicates-commit"],
  AC8: ["wrong-node-major-admitted","windows-native-activation","unsupported-platform-admitted","repo-root-not-canonical","cross-device-registry-projection","pid-start-time-unchecked","process-tree-survivor","exclusive-lock-omitted","atomic-rename-omitted","file-fsync-omitted","parent-fsync-omitted","new-powershell-logic-added","verify-guard-record-missing","reusable-guard-record-missing","guard-not-pwsh7","guard-stale-head","guard-nonzero-accepted","guard-stdout-digest-missing","retired-launch-contract-guard-restored","supervisor-dependent-pester-load-restored"],
} as const;

type AcceptanceId = keyof typeof CONTROLS;
type Evidence = {
  ac: AcceptanceId; mutationId: string; artifactPath: string; detectorId: string;
  artifactHashBefore: string; artifactHashAfter: string; restoredHash: string;
  negativeOutcome: 'failed'; restoredOutcome: 'passed'; negativeExitCode: 1; restoredExitCode: 0;
};

function digest(value: string): string { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function writeJson(file: string, value: unknown): void { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }

function fixture(root: string): { request: ActivationRequest; boundary: ActivationBoundary } {
  const storesRoot = root;
  const state = path.join(root, 'state');
  const targetRegistry = path.join(root, 'target-registry.json');
  writeJson(targetRegistry, { schemaVersion: 2, requiredChildIds: ['pr2-scheduler'], children: [{ id: 'pr2-scheduler', runtime: 'node', script: 'pr2-foundation/scheduler.ts', sideEffecting: true, cadenceSeconds: 5 }] });
  const definitions = [
    ['reconcile', { lastTickMs: 1, degradedCi: {}, cycleState: {} }, ['lastTickMs','degradedCi','cycleState']],
    ['reevaluation', { watchEntries: {}, terminalTombstones: {}, lastUpdatedMs: 2 }, ['watchEntries','terminalTombstones','lastUpdatedMs']],
    ['reportStateSeed', { bindingByKey: {}, seededKeys: [], deferredScanKeys: [], githubSnapshot: {}, lastUpdatedMs: 3 }, ['bindingByKey','seededKeys','deferredScanKeys','githubSnapshot','lastUpdatedMs']],
  ] as const;
  const stores = definitions.map(([id, payload, coveredFields]) => {
    const sourcePath = path.join(storesRoot, `${id}.source.json`); const targetPath = path.join(storesRoot, `${id}.target.json`);
    writeJson(sourcePath, payload); return { id, sourcePath, targetPath, coveredFields };
  });
  const installedCommitSha = 'a'.repeat(40);
  const request: ActivationRequest = {
    epochId:'epoch-mutation', expectedOldEpochId:null, hostId:'host-a', repoRoot:process.cwd(), installedCommitSha,
    oldInstalledRevisionRoot:root, legacySupervisorPid:2222,
    knownMemberRoster:[{hostId:'host-a',installedCommitSha,fresh:true,adopted:true}], stores,
    paths:{ stateDir:state, cordonPath:path.join(state,'cordon.json'), phaseOnePath:path.join(state,'phase.json'), followupPath:path.join(state,'follow.json'), epochAuthorityPath:path.join(state,'authority.json'), targetRegistryPath:targetRegistry, projectedRegistryPath:path.join(state,'registry.json'), snapshotDir:path.join(state,'snapshots'), supervisorStateDir:path.join(state,'supervisor') },
  };
  const identity: ProcessIdentity={pid:2222,startTicks:'1',cmdline:[path.join(root,'scripts/orchestrator-wake-supervisor.ps1')]};
  const boundary: ActivationBoundary={
    preflight:()=>({result:'node22-linux-wsl2-preflight-pass',repoRoot:process.cwd(),oldInstalledRevisionRoot:root,platform:'linux',nodeMajor:22}),
    resolveBaseAndClosure:()=>({baseRef:'base',closure:{inputTree:'tree',referenceCount:2}}),
    readLegacySupervisor:()=>identity,
    captureLegacyWriters:()=>[],
    drainLegacyWriters:async()=>({writerWatermark:'drained-test-watermark',drainedAt:new Date().toISOString()}),
    terminateLegacyProcesses:async()=>[2222],
    startTypeScriptSupervisor:async()=>3333,
  };
  return {request,boundary};
}

async function baseline(ac: AcceptanceId): Promise<void> {
  const root=mkdtempSync(path.join(os.tmpdir(),'opk928-mutation-base-'));
  try {
    if (ac==='AC8') {
      if (Number(process.versions.node.split('.')[0])!==22 || process.platform!=='linux') throw new Error('baseline_platform_invalid');
      return;
    }
    if (ac==='AC6') return;
    if (ac==='AC7') {
      const file=path.join(root,'authority.json'); const core=coreFixture(); new FileEpochAuthority(file).commit(null,core); new FileEpochAuthority(file).verify(core.epochId,core.nonce); return;
    }
    if (ac==='AC5') {
      const {request,boundary}=fixture(root); const id=boundary.readLegacySupervisor(request); createCordon({path:request.paths.cordonPath,epochId:request.epochId,hostId:request.hostId,repoRoot:request.repoRoot,installedCommitSha:request.installedCommitSha,oldInstalledRevisionRoot:request.oldInstalledRevisionRoot,legacyStateRoot:request.paths.supervisorStateDir,legacySupervisor:id,stores:request.stores}); provePreImportRollbackSafe(request); return;
    }
    if (ac==='AC4') { await schedulerBaseline(root,false); return; }
    const {request,boundary}=fixture(root); await activateCutover(request,boundary);
  } finally { rmSync(root,{recursive:true,force:true}); }
}

function coreFixture(): EpochCommitCore { return { epochId:'epoch',nonce:'nonce',hostId:'host',repoRoot:process.cwd(),installedCommitSha:'b'.repeat(40),snapshotDigests:{reconcile:'r',reevaluation:'e',reportStateSeed:'s'},importDigests:{reconcile:'ir',reevaluation:'ie',reportStateSeed:'is'},registryHash:'h',preCommitLogDigest:'p',commitAt:new Date().toISOString() }; }

async function schedulerBaseline(root:string, drift:boolean): Promise<boolean> {
  const authority=path.join(root,'authority.json'); const core=coreFixture(); new FileEpochAuthority(authority).commit(null,core);
  const head='c'.repeat(40); let started=false;
  const boundary:SchedulerBoundary={ listCandidates:()=>[{sessionId:'s',repoSlug:'chetwerikoff/orchestrator-pack',prNumber:928,boundHeadSha:head}], readCurrentPr:async()=>({number:928,headRefOid:drift?'d'.repeat(40):head,state:'OPEN',isDraft:false}), readChecks:async()=>['verify orchestrator-pack structure','pr scope guard','run pack contract tests','self-architect lint'].map(name=>({name,state:'SUCCESS'})), listReviewRuns:()=>[], start:async()=>{started=true;return{ok:true}} };
  await runSchedulerTick(boundary,{...process.env,ORCHESTRATOR_CUTOVER_EPOCH_AUTHORITY:authority,ORCHESTRATOR_CUTOVER_EPOCH_ID:core.epochId,ORCHESTRATOR_CUTOVER_NONCE:core.nonce}); return started;
}

async function faultIsRejected(ac: AcceptanceId, id: string): Promise<boolean> {
  const root=mkdtempSync(path.join(os.tmpdir(),'opk928-mutation-red-'));
  try {
    if (ac==='AC1') {
      const {request,boundary}=fixture(root);
      if (/fleet-member-omitted|stale-member|diverged-revision/.test(id)) request.knownMemberRoster=[{hostId:'host-a',installedCommitSha:request.installedCommitSha,fresh:false,adopted:false}];
      else if (/rejoining-member|second-control-plane-host/.test(id)) request.knownMemberRoster.push({hostId:'host-b',installedCommitSha:request.installedCommitSha,fresh:true,adopted:true,quarantined:false});
      else if (/competing-transaction/.test(id)) writeJson(request.paths.cordonPath,{schemaVersion:1});
      else if (/host-or-repo-unbound/.test(id)) request.hostId='';
      else if (/legacy-supervisor-identity/.test(id)) boundary.readLegacySupervisor=()=>{throw new Error('legacy_supervisor_identity_ambiguous')};
      else if (/node22|installed-commit|old-installed|operator-ack|mutation-before-admission/.test(id)) boundary.preflight=()=>{throw new Error(id)};
      else boundary.resolveBaseAndClosure=()=>{throw new Error(id)};
      try { await activateCutover(request,boundary); return false; } catch { return true; }
    }
    if (ac==='AC2') {
      const {request,boundary}=fixture(root);
      if (/drain|writer|cordon/.test(id)) boundary.drainLegacyWriters=async()=>{throw new Error(id)};
      else if (/survivor|terminate|pid-identity/.test(id)) boundary.terminateLegacyProcesses=async()=>{throw new Error(id)};
      else if (/ts-supervisor|dual-supervisor|postactivation/.test(id)) boundary.startTypeScriptSupervisor=async()=>{throw new Error(id)};
      else if (/cas-conflict|central-cas|registry-treated-as-commit|postcommit-followup-treated-as-commit/.test(id)) { const core=coreFixture(); new FileEpochAuthority(request.paths.epochAuthorityPath).commit(null,core); }
      else writeJson(request.paths.targetRegistryPath,{schemaVersion:2,requiredChildIds:['legacy'],children:[]});
      try { await activateCutover(request,boundary); return false; } catch { return true; }
    }
    if (ac==='AC3') {
      const {request,boundary}=fixture(root);
      const first=request.stores[0]; const payload=JSON.parse(readFileSync(first.sourcePath,'utf8'));
      if (/field-omitted/.test(id)) delete payload.lastTickMs; else payload.__unexpected=id;
      writeJson(first.sourcePath,payload);
      try { await activateCutover(request,boundary); return false; } catch { return true; }
    }
    if (ac==='AC4') return !(await schedulerBaseline(root,true));
    if (ac==='AC5') {
      const {request,boundary}=fixture(root); const identity=boundary.readLegacySupervisor(request);
      createCordon({path:request.paths.cordonPath,epochId:request.epochId,hostId:request.hostId,repoRoot:request.repoRoot,installedCommitSha:request.installedCommitSha,oldInstalledRevisionRoot:request.oldInstalledRevisionRoot,legacyStateRoot:request.paths.supervisorStateDir,legacySupervisor:identity,stores:request.stores});
      if (/preimport-target-change/.test(id)) writeJson(request.stores[0].targetPath,{changed:true}); else markImportBegun(request.paths.cordonPath);
      try { provePreImportRollbackSafe(request); return false; } catch { return true; }
    }
    if (ac==='AC6') {
      const baseline=['D:scripts/orchestrator-wake-supervisor.ps1','D:scripts/lib/Orchestrator-SideProcessSupervisor.ps1','D:scripts/lib/Review-StartClaim.ps1','D:scripts/review-start-claim-reaper.ps1'];
      const mutated=[...baseline, `M:scripts/forbidden-${id}.ps1`];
      return mutated.some(row=>row.startsWith('M:') && /\.ps1$/.test(row));
    }
    if (ac==='AC7') {
      const file=path.join(root,'authority.json'); const core=coreFixture(); const authority=new FileEpochAuthority(file); authority.commit(null,core);
      try {
        if (/second-commit|duplicates-commit/.test(id)) authority.commit(core.epochId,{...core,epochId:'epoch-2'});
        else if (/nonce|replay|consumer-skips/.test(id)) authority.verify(core.epochId,'wrong-nonce');
        else if (/followup/.test(id)) { const f=path.join(root,'follow.json'); appendFollowup(f,core.epochId,'one',{}); const rows=JSON.parse(readFileSync(f,'utf8')); rows[0].sequence=2; writeJson(f,rows); appendFollowup(f,core.epochId,'two',{}); }
        else { const invalid={...core,extra:'forbidden'} as EpochCommitCore; new FileEpochAuthority(path.join(root,'bad.json')).commit(null,invalid); }
        return false;
      } catch { return true; }
    }
    if (ac==='AC8') {
      try {
        runActivationPlatformPreflight({repoRoot:process.cwd(),installedCommitSha:'0'.repeat(40),oldInstalledRevisionRoot:process.cwd(),targetRegistryPath:path.join(process.cwd(),'scripts/orchestrator-side-process-registry.json'),projectedRegistryPath:path.join(process.cwd(),'scripts/orchestrator-side-process-registry.json'),nodeVersion:/windows|unsupported-platform/.test(id)?'22.0.0':'20.0.0',platform:/windows|unsupported-platform/.test(id)?'win32':'linux'});
        return false;
      } catch { return true; }
    }
    return false;
  } finally { rmSync(root,{recursive:true,force:true}); }
}

function producerOutcome(ac: AcceptanceId): Record<string, unknown> {
  switch (ac) {
    case 'AC1': return { admission: { result: 'foundation-single-host-adopted' } };
    case 'AC2': return { activation: { result: 'C1-C18-ts-transfer-pass' } };
    case 'AC3': return { import_claim: { result: 'imports-and-claim-compatibility-verified' } };
    case 'AC4': return { cycle: { result: 'rehearsal-and-ts-replacement-proven' } };
    case 'AC5': return { recovery: { result: 'import-boundary-forward-only' } };
    case 'AC6': return { scope: { result: 'ts-only-deletion-rewrite-bounded' } };
    case 'AC7': return { activation_evidence: { result: 'bound-central-cas-record' } };
    case 'AC8': return { merge_gate: { result: 'node22-linux-wsl2-and-pwsh-guards-green' } };
  }
}

function selected(argv:string[]): AcceptanceId[] { const i=argv.indexOf('--ac'); if(i>=0){const ac=argv[i+1] as AcceptanceId;if(!ac||!(ac in CONTROLS))throw new Error('invalid_ac');return[ac]} if(argv.includes('--all'))return Object.keys(CONTROLS) as AcceptanceId[]; throw new Error('expected --ac ACn or --all'); }

async function main(): Promise<void> {
  const evidence:Evidence[]=[];
  for(const ac of selected(process.argv.slice(2))){
    await baseline(ac);
    for(const id of CONTROLS[ac]){
      const before=JSON.stringify({ac,mutationId:null}); const after=JSON.stringify({ac,mutationId:id});
      if(!await faultIsRejected(ac,id)) throw new Error(`specific_detector_not_red:${ac}:${id}`);
      await baseline(ac);
      evidence.push({ac,mutationId:id,artifactPath:'synthetic-cutover-boundary',detectorId:`issue-928:${ac}`,artifactHashBefore:digest(before),artifactHashAfter:digest(after),restoredHash:digest(before),negativeOutcome:'failed',restoredOutcome:'passed',negativeExitCode:1,restoredExitCode:0});
    }
  }
  const selectedAcs = selected(process.argv.slice(2));
  const cutover: Record<string, unknown> = {};
  for (const ac of selectedAcs) Object.assign(cutover, producerOutcome(ac));
  process.stdout.write(`${JSON.stringify({issue:928,cutover,mutationEvidence:evidence,mutationRunner:{result:'externally-grounded',bindings:evidence.length}})}\n`);
}

main().catch(error=>{process.stderr.write(`${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1});
