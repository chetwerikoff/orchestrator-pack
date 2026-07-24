#!/usr/bin/env node
import '../toolchain/native-entrypoint-preflight.ts';

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';
import {
  PR2A_MUTATION_CATALOG,
  type Pr2aAcceptanceId,
  type Pr2aMutationBinding,
} from './mutation-catalog.ts';

interface MutationEvidence {
  ac: Pr2aAcceptanceId;
  mutationId: string;
  artifactPath: string;
  detectorId: string;
  detectorCommand: string[];
  expectedFinding: string;
  observedFindings: string[];
  artifactHashBefore: string;
  artifactHashAfter: string;
  restoredHash: string;
  negativeExitCode: 1;
  restoredExitCode: 0;
  negativeOutcome: 'failed';
  restoredOutcome: 'passed';
}
interface MutationSpec {
  artifactPath: string;
  apply: (source: string) => string;
  faultPresent: (source: string) => boolean;
}
interface DetectorExecution {
  exitCode: number;
  findings: string[];
  command: string[];
}
type JsonRecord = Record<string, any>;
type PackageScripts = Record<string, string> & { 'test:issue-948': string };

const repoRoot = path.resolve(process.cwd());
const specs = new Map<string, MutationSpec>();
const digest = (value: string | Buffer): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const mutationKey = (ac: string, id: string): string => `${ac}:${id}`;
const source = (root: string, file: string): string => readFileSync(path.join(root, file), 'utf8');

function define(ac: Pr2aAcceptanceId, id: string, spec: MutationSpec): void {
  const key = mutationKey(ac, id);
  if (specs.has(key)) throw new Error(`duplicate_mutation_spec:${key}`);
  specs.set(key, spec);
}
function replaceRequired(text: string, token: string, replacement: string, id: string): string {
  if (!text.includes(token)) throw new Error(`mutation_token_missing:${id}:${token}`);
  return text.replace(token, replacement);
}
function defineReplace(ac: Pr2aAcceptanceId, id: string, artifactPath: string, token: string, replacement: string): void {
  const marker = `/* mutation:${id} */`;
  define(ac, id, {
    artifactPath,
    apply: (text) => replaceRequired(text, token, `${replacement} ${marker}`, id),
    faultPresent: (text) => text.includes(marker),
  });
}
function defineAppend(ac: Pr2aAcceptanceId, id: string, artifactPath: string, appended: string): void {
  const marker = `/* mutation:${id} */`;
  define(ac, id, {
    artifactPath,
    apply: (text) => `${text}${text.endsWith('\n') ? '' : '\n'}${appended} ${marker}\n`,
    faultPresent: (text) => text.includes(marker),
  });
}
function defineJson(
  ac: Pr2aAcceptanceId,
  id: string,
  artifactPath: string,
  mutate: (value: JsonRecord) => void,
  faultPresent: (value: JsonRecord) => boolean,
): void {
  define(ac, id, {
    artifactPath,
    apply: (text) => {
      const value = JSON.parse(text) as JsonRecord;
      mutate(value);
      return `${JSON.stringify(value)}\n`;
    },
    faultPresent: (text) => {
      try { return faultPresent(JSON.parse(text) as JsonRecord); }
      catch { return true; }
    },
  });
}
function row(value: JsonRecord, pathName: string): JsonRecord {
  const found = (value.denominator as JsonRecord[]).find((candidate) => candidate.path === pathName);
  if (!found) throw new Error(`planning_row_missing:${pathName}`);
  return found;
}
function lifecycle(value: JsonRecord, identity: string): JsonRecord {
  const found = (value.lifecycle as JsonRecord[]).find((candidate) => candidate.identity === identity);
  if (!found) throw new Error(`planning_lifecycle_missing:${identity}`);
  return found;
}
function packageScripts(text: string): PackageScripts {
  const scripts = (JSON.parse(text) as { scripts?: Record<string, string> }).scripts;
  if (!scripts?.['test:issue-948']) throw new Error('mandatory_issue_948_script_missing');
  return scripts as PackageScripts;
}
function packageMutation(
  mutate: (scripts: PackageScripts) => void,
  faultPresent: (scripts: PackageScripts) => boolean,
): MutationSpec {
  return {
    artifactPath: 'package.json',
    apply: (text) => {
      const value = JSON.parse(text) as { scripts?: Record<string, string> };
      const scripts = packageScripts(text);
      mutate(scripts);
      value.scripts = scripts;
      return `${JSON.stringify(value, null, 2)}\n`;
    },
    faultPresent: (text) => {
      try { return faultPresent(packageScripts(text)); }
      catch { return true; }
    },
  };
}

defineJson('AC1','tooling-bootstrap-scope-violated','scripts/pr2a/planning-manifest.json',v=>{v.tooling.scannerPath='scripts/lib/review-start-claim-store.ts';},v=>v.tooling.scannerPath!=='scripts/pr2a/closed-world-scanner.ts');
defineJson('AC1','planning-base-tree-mismatch','scripts/pr2a/planning-manifest.json',v=>{v.lineage.planningBaseTreeOid='0'.repeat(40);},v=>v.lineage.planningBaseTreeOid==='0'.repeat(40));
defineJson('AC1','planning-input-changed-without-replan','scripts/pr2a/planning-manifest.json',v=>{v.tooling.scannerSha256='sha256:'+ '0'.repeat(64);},v=>v.tooling.scannerSha256==='sha256:'+ '0'.repeat(64));
defineJson('AC1','tracked-file-omitted-from-denominator','scripts/pr2a/planning-manifest.json',v=>{v.denominator=v.denominator.filter((r:JsonRecord)=>r.path!=='package.json');},v=>!v.denominator.some((r:JsonRecord)=>r.path==='package.json'));
defineJson('AC1','command-bearing-file-misclassified-non-executable','scripts/pr2a/planning-manifest.json',v=>{row(v,'package.json').denominatorClass='reviewed-non-executable';},v=>row(v,'package.json').denominatorClass==='reviewed-non-executable');
defineJson('AC1','executable-classification-incomplete','scripts/pr2a/planning-manifest.json',v=>{row(v,'package.json').executionClass='';},v=>!row(v,'package.json').executionClass);
defineJson('AC1','reachable-helper-chain-missing','scripts/pr2a/planning-manifest.json',v=>{row(v,'scripts/pr2a/closed-world-scanner.ts').rootChains=[];},v=>row(v,'scripts/pr2a/closed-world-scanner.ts').rootChains.length===0);
defineJson('AC1','target-independent-primitive-detection-bypassed','scripts/pr2a/planning-manifest.json',v=>{row(v,'package.json').evidence='';},v=>!row(v,'package.json').evidence);
defineJson('AC1','reachable-unresolved-primitive-suppressed','scripts/pr2a/planning-manifest.json',v=>{v.unknown=[{source:'package.json',reason:'unresolved primitive'}];},v=>v.unknown.length>0);
defineJson('AC1','class1-through-class4b-row-omitted','scripts/pr2a/planning-manifest.json',v=>{v.references=v.references.filter((r:JsonRecord)=>r.source!=='scripts/invoke-manual-review-run.ps1');},v=>!v.references.some((r:JsonRecord)=>r.source==='scripts/invoke-manual-review-run.ps1'));
defineJson('AC1','launch-guard-assertion-unclassified','scripts/pr2a/planning-manifest.json',v=>{v.references=v.references.filter((r:JsonRecord)=>r.source!=='scripts/check-side-process-launch-contract.ps1');},v=>!v.references.some((r:JsonRecord)=>r.source==='scripts/check-side-process-launch-contract.ps1'));
defineJson('AC1','lifecycle-function-alias-effect-or-helper-omitted','scripts/pr2a/planning-manifest.json',v=>{v.lifecycle=v.lifecycle.filter((r:JsonRecord)=>r.identity!=='Update-ReviewStartClaimRecordFields');},v=>!v.lifecycle.some((r:JsonRecord)=>r.identity==='Update-ReviewStartClaimRecordFields'));
defineJson('AC1','lifecycle-cli-branch-unclassified','scripts/pr2a/planning-manifest.json',v=>{v.lifecycle=v.lifecycle.filter((r:JsonRecord)=>r.identity!=='Invoke-ReviewStartClaimLifecycleCli');},v=>!v.lifecycle.some((r:JsonRecord)=>r.identity==='Invoke-ReviewStartClaimLifecycleCli'));
defineJson('AC1','retain-read-only-row-interprets-policy','scripts/pr2a/planning-manifest.json',v=>{const r=lifecycle(v,'Update-ReviewStartClaimRecordFields');r.disposition='retain-read-only';r.interprets=true;},v=>{const r=lifecycle(v,'Update-ReviewStartClaimRecordFields');return r.disposition==='retain-read-only'&&r.interprets===true;});
defineJson('AC1','legacy-operation-without-protocol-disposition','scripts/pr2a/planning-manifest.json',v=>{lifecycle(v,'Update-ReviewStartClaimRecordFields').legacyProtocolDisposition='';},v=>!lifecycle(v,'Update-ReviewStartClaimRecordFields').legacyProtocolDisposition);
defineJson('AC1','overlap-unsafe-operation-not-quiesced','scripts/pr2a/planning-manifest.json',v=>{lifecycle(v,'Update-ReviewStartClaimRecordFields').rolloutBoundary='';},v=>!lifecycle(v,'Update-ReviewStartClaimRecordFields').rolloutBoundary);
defineJson('AC1','unproven-operation-grouped-into-representative-class','scripts/pr2a/planning-manifest.json',v=>{const r=lifecycle(v,'Update-ReviewStartClaimRecordFields');r.legacyProtocolDisposition='protocol-equivalent';r.legacyProtocolEvidence='representative class only';},v=>lifecycle(v,'Update-ReviewStartClaimRecordFields').legacyProtocolEvidence==='representative class only');
defineJson('AC1','unsupported-retirement-selected','scripts/pr2a/planning-manifest.json',v=>{const r=lifecycle(v,'Update-ReviewStartClaimRecordFields');r.disposition='retire';r.callers=['scripts/review-trigger-reconcile.ps1'];},v=>{const r=lifecycle(v,'Update-ReviewStartClaimRecordFields');return r.disposition==='retire'&&r.callers.length>0;});
defineJson('AC1','implementation-operation-not-in-reviewed-plan','scripts/pr2a/planning-manifest.json',v=>{v.plannedOperations.push({path:'scripts/unreviewed-claim-operation.ts',operation:'add',reason:'mutation'});},v=>v.plannedOperations.some((r:JsonRecord)=>r.path==='scripts/unreviewed-claim-operation.ts'));
defineReplace('AC2','claim-namespace-or-key-changed','scripts/lib/review-start-claim-cli.ts',"return `pr-${positiveInteger(prNumber, 0)}-${normalizeHeadSha(headSha)}`;","return `review-pr-${positiveInteger(prNumber, 0)}-${normalizeHeadSha(headSha)}`;");
defineReplace('AC2','persisted-path-or-schema-changed','scripts/lib/review-start-claim-cli.ts',"export const REVIEW_START_CLAIM_SCHEMA_VERSION = 1;","export const REVIEW_START_CLAIM_SCHEMA_VERSION = 2;");
defineReplace('AC2','protocol-ordering-changed','scripts/lib/review-start-claim-cli.ts',"renameSync(temporary, path);\n  syncDirectory(dirname(path));","syncDirectory(dirname(path));\n  renameSync(temporary, path);");
defineReplace('AC2','record-reread-under-exclusion-omitted','scripts/lib/review-start-claim-cli.ts',"const read = readClaimRecord(required.path);\n    if (!read.ok || !read.record) return { ok: false, reason: 'ambiguous_claim', detail: read.reason };","const read = { ok: true, record: required.claim } as ReadRecordResult;");
defineReplace('AC2','generation-fence-weakened','scripts/lib/review-start-claim-cli.ts',"if (!sameGeneration(read.record, required.claim)) return { ok: false, reason: 'lost_ownership', holder: read.record.holder };","if (false) return { ok: false, reason: 'lost_ownership', holder: read.record.holder };");
defineReplace('AC2','lock-loss-or-reacquisition-uses-cached-authority','scripts/lib/review-start-claim-cli.ts',"if (!sameGeneration(read.record, input.expected)) return { ok: false, reason: 'lost_ownership' };","if (!input.expected) return { ok: false, reason: 'lost_ownership' };");
defineReplace('AC2','crash-point-breaks-single-authority','scripts/lib/review-start-claim-cli.ts',"const lock = claimLockDir(required.namespace, required.claim.prNumber, required.claim.headSha);","const lock = '';");
defineReplace('AC2','legacy-record-class-unreadable','scripts/lib/review-start-claim-cli.ts',"for (const required of ['schemaVersion', 'key', 'prNumber', 'headSha', 'holder', 'acquiredAtUtc', 'state'] as const)","for (const required of ['schemaVersion', 'key', 'prNumber', 'headSha', 'holder', 'acquiredAtUtc', 'state', 'projectNamespace'] as const)");
defineReplace('AC2','identity-ambiguity-reclaimed','scripts/lib/review-start-claim-cli.ts',"if (asString(owner.host) && asString(owner.host) !== hostname()) return true;","if (asString(owner.host) && asString(owner.host) !== hostname()) return false;");
defineReplace('AC2','policy-semantics-changed','scripts/lib/review-start-claim-cli.ts',"evaluateReclaimDecision,","evaluateSweep as evaluateReclaimDecision,");
defineReplace('AC2','declared-reap-trigger-broken','scripts/lib/review-start-claim-cli.ts',"const sweep = asRecord(evaluateSweep({","const sweep = asRecord({ actions: [], runStoreBatchReads: 0, mutation: true }); void ({");
defineAppend('AC2','new-reaper-scheduler-added','scripts/lib/review-start-claim-cli.ts',"setInterval(() => reaperSweep({}), 1000);");
defineReplace('AC2','unsupported-boundary-accepted','scripts/lib/review-start-claim-cli.ts',"if (platform() !== 'linux') throw new Error('unsupported_claim_platform');","if (false) throw new Error('unsupported_claim_platform');");
defineAppend('AC2','tracked-legacy-oracle-used','scripts/lib/review-start-claim-cli.ts',"const trackedLegacyOracle = 'scripts/lib/Review-StartClaim.ps1';");
defineAppend('AC2','protocol-matrix-duplicated-with-divergent-primitive','scripts/lib/review-start-claim-cli.ts',"const divergentProtocolLockRoot = '.takeover';");
defineReplace('AC3','claimant-family-still-reaches-powershell-claim','scripts/pack-review-runner.ts',"from './lib/review-start-claim-store.ts'","from './lib/Review-StartClaimLifecycle.ps1'");
defineAppend('AC3','supported-lifecycle-unit-still-interprets-in-powershell','scripts/lib/Review-StartClaimLifecycle.ps1',"function Get-MutatedClaimPolicy { param($Record) if ($Record.state -eq 'active') { return $true } return $false }");
defineAppend('AC3','supported-lifecycle-unit-still-mutates-in-powershell','scripts/lib/Review-StartClaimLifecycle.ps1',"Set-Content -LiteralPath 'mutation-claim.json' -Value '{}'");
defineReplace('AC3','internal-lifecycle-helper-bypasses-disposition','scripts/lib/Review-StartClaimLifecycle.ps1',"'review-start-claim-store.ts'","'review-start-claim-cli.ts'");
defineAppend('AC3','retain-read-only-unit-returns-policy-result','scripts/lib/Review-StartClaimLifecycle.ps1',"function Get-MutatedPolicyResult { return @{ launchable = $true } }");
defineReplace('AC3','cli-verb-bypasses-typescript-authority','scripts/lib/Review-StartClaimLifecycle.ps1',"function Get-ReviewStartClaimLifecycleConfig { return Invoke-ReviewStartClaimTsOperation 'Get-ReviewStartClaimLifecycleConfig' @{} }","function Get-ReviewStartClaimLifecycleConfig { return @{ staleMinutes = 1 } }");
defineAppend('AC3','powershell-bridge-contains-policy-or-locking','scripts/lib/Review-StartClaimLifecycle.ps1',"New-Item -ItemType Directory -Path '.locks/mutation' -Force | Out-Null");
defineAppend('AC3','typescript-dispatches-to-powershell','scripts/lib/review-start-claim-store.ts',"const mutationPwshDispatch = ['pwsh','-File','Review-StartClaim.ps1'];");
defineAppend('AC3','second-namespace-or-lock-tree-created','scripts/lib/review-start-claim-store.ts',"const mutationSecondNamespace = '.takeover';");
define('AC3','operation-semantic-primitive-usage-test-missing',packageMutation(s=>{s['test:issue-948']=s['test:issue-948'].replace('scripts/review-start-claim.test.ts','');},s=>!s['test:issue-948'].includes('scripts/review-start-claim.test.ts')));
define('AC3','operation-specific-durability-test-missing',packageMutation(s=>{s['test:issue-948']=s['test:issue-948'].replace('scripts/pr2a/final-conformance.test.ts','');},s=>!s['test:issue-948'].includes('scripts/pr2a/final-conformance.test.ts')));
defineReplace('AC3','representative-overlap-class-missing','scripts/pr2a/closure-receipt.ts',"  'generation-fence',","  // generation-fence mutation removed");
defineAppend('AC3','external-root-reaches-target-internal-claim-unit','scripts/pack-review-runner.ts',"const mutationTargetInternalEdge = 'scripts/lib/Review-StartClaim.ps1';");
defineAppend('AC4','retired-guard-or-verifier-edge-remains','scripts/verify.ps1',"& (Join-Path $PSScriptRoot 'check-side-process-launch-contract.ps1')");
defineReplace('AC4','surviving-launch-assertion-lost','scripts/lib/orchestrator-side-process-observer.ts','PassProjectId: child.passProjectId === true,','PassProjectId: false,');
defineAppend('AC4','supervisor-reverse-edge-remains','scripts/pack-review-runner.ts',"const mutationSupervisorEdge = 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1';");
defineAppend('AC4','claim-reverse-edge-remains','scripts/pack-review-runner.ts',"const mutationClaimEdge = 'scripts/lib/Review-StartClaim.ps1';");
defineAppend('AC4','powershell-policy-unit-remains-reachable','scripts/lib/Review-StartClaimLifecycle.ps1',"function Test-MutatedActiveClaim { param($Record) return $Record.state -eq 'active' }");
defineJson('AC4','fleet-hygiene-surface-removed','scripts/pr2a/planning-manifest.json',v=>{v.denominator=v.denominator.filter((r:JsonRecord)=>r.path!=='scripts/orchestrator-fleet-hygiene-sentinel.ps1');},v=>!v.denominator.some((r:JsonRecord)=>r.path==='scripts/orchestrator-fleet-hygiene-sentinel.ps1'));
defineAppend('AC4','tracked-d928-execution-surface-remains','scripts/review-start-claim.test.ts',"const mutationD928Execution = 'scripts/review-start-claim-reaper.ps1';");
defineJson('AC4','final-tracked-file-classification-invalid','scripts/pr2a/planning-manifest.json',v=>{row(v,'package.json').executionClass='';},v=>!row(v,'package.json').executionClass);
defineJson('AC4','command-bearing-primitive-hidden-by-non-executable-row','scripts/pr2a/planning-manifest.json',v=>{row(v,'package.json').denominatorClass='reviewed-non-executable';},v=>row(v,'package.json').denominatorClass==='reviewed-non-executable');
defineJson('AC4','final-unresolved-set-nonempty','scripts/pr2a/planning-manifest.json',v=>{v.dynamicUnsupported=[{source:'mutation'}];},v=>v.dynamicUnsupported.length>0);
defineJson('AC4','external-source-misreported-target-internal','scripts/pr2a/planning-manifest.json',v=>{const r=v.references.find((x:JsonRecord)=>!['scripts/lib/Review-StartClaim.ps1','scripts/orchestrator-wake-supervisor.ps1','scripts/review-start-claim-reaper.ps1','scripts/lib/Orchestrator-SideProcessSupervisor.ps1'].includes(x.source));r.disposition='target-internal';},v=>v.references.some((r:JsonRecord)=>r.disposition==='target-internal'&&!['scripts/lib/Review-StartClaim.ps1','scripts/orchestrator-wake-supervisor.ps1','scripts/review-start-claim-reaper.ps1','scripts/lib/Orchestrator-SideProcessSupervisor.ps1'].includes(r.source)));
defineJson('AC4','final-diff-does-not-equal-reviewed-operation-rows','scripts/pr2a/planning-manifest.json',v=>{v.plannedOperations.push({path:'scripts/mutation-extra.ts',operation:'add',reason:'mutation'});},v=>v.plannedOperations.some((r:JsonRecord)=>r.path==='scripts/mutation-extra.ts'));
defineReplace('AC5','receipt-final-tree-or-lineage-invalid','scripts/pr2a/closure-receipt.ts',"command-result-tree-binding-mismatch","command-result-binding-disabled");
defineJson('AC5','planning-receipt-tooling-identity-mismatch','scripts/pr2a/planning-manifest.json',v=>{v.tooling.grammarSha256='sha256:'+ 'f'.repeat(64);},v=>v.tooling.grammarSha256==='sha256:'+ 'f'.repeat(64));
defineReplace('AC5','receipt-self-asserts-unverifiable-tree','scripts/pr2a/closure-receipt.ts',"function verifyArtifact","function verifyArtifactDisabled");
defineReplace('AC5','receipt-final-invariant-incomplete','scripts/pr2a/closure-receipt.ts',"buildConformanceReport(ref)","{ result: 'conformant', findings: [] } as ReturnType<typeof buildConformanceReport>");
defineReplace('AC5','overlap-harness-or-job-bytes-unbound','scripts/pr2a/closure-receipt.ts',"verifyArtifact(evidenceRoot, overlap.harnessPath","void (overlap.harnessPath); verifyArtifact(evidenceRoot, 'unbound-harness'");
defineReplace('AC5','overlap-operation-matrix-missing','scripts/pr2a/closure-receipt.ts',"verifyOverlapStructuredArtifacts(overlap, evidenceRoot, findings);","void overlap.operationMatrixPath;");
defineReplace('AC5','overlap-replay-command-missing','scripts/pr2a/closure-receipt.ts',"verifyReplay(overlap, evidenceRoot, findings);","void overlap.replayCommand;");
defineReplace('AC5','candidate-build-not-derived-from-final-tree','scripts/pr2a/closure-receipt.ts',"sourceDigests = Object.fromEntries(sourcePaths.map((file) => [file, sha256(readAt(ref, file))]));","sourceDigests = Object.fromEntries(sourcePaths.map((file) => [file, 'sha256:' + '0'.repeat(64)]));");
defineReplace('AC5','candidate-build-attestation-invalid','scripts/pr2a/closure-receipt.ts',"return { ...provenanceWithoutDigest, digest: digestStructured(provenanceWithoutDigest) };","return { ...provenanceWithoutDigest, digest: 'sha256:' + '0'.repeat(64) };");
defineReplace('AC5','overlap-evidence-generated-before-final-tree','scripts/pr2a/closure-receipt.ts',"overlap.generatedAfterFinalTree !== true","false");
defineReplace('AC5','overlap-candidate-binding-mismatch','scripts/pr2a/closure-receipt.ts',"|| (overlap.candidateCommitSha !== expected.finalCommitSha\n      && gitTreeOid(overlap.candidateCommitSha) !== expected.finalTreeOid)","|| false");
defineReplace('AC5','receipt-generated-before-prerequisite-suites','scripts/pr2a/closure-receipt.ts',"if (!preReceiptVerification.prerequisiteSuitesPassedBeforeReceipt)","if (false)");
defineReplace('AC5','independent-pr2a-recompute-disagrees','scripts/pr2a/closure-receipt.ts',"const conformance = buildConformanceReport(ref);","const conformance = { result: 'conformant', findings: [], finalTreeOid: git(['rev-parse', `${ref}^{tree}`]).trim(), commitSha: git(['rev-parse', ref]).trim() } as any;");
defineReplace('AC5','928-admission-skips-current-recompute','scripts/pr2a/closure-receipt.ts',"external-928-body-contract-mismatch","external-928-body-shape-only");
defineReplace('AC5','928-admission-accepts-unsafe-current-invariants','scripts/pr2a/closure-receipt.ts',"invariantBasedRefusal: true;","invariantBasedRefusal: boolean;");
defineAppend('AC5','928-admission-requires-historical-inventory-equality','scripts/pr2a/closure-receipt.ts',"const mutationRequiresHistoricalInventoryEquality = true;");
defineAppend('AC5','928-admission-rejects-compatible-unrelated-evolution','scripts/pr2a/closure-receipt.ts',"const mutationRejectsUnrelatedBaseEvolution = true;");
defineJson('AC6','bootstrap-contains-semantic-migration','scripts/pr2a/planning-manifest.json',v=>{v.tooling.scannerPath='scripts/lib/review-start-claim-store.ts';},v=>v.tooling.scannerPath==='scripts/lib/review-start-claim-store.ts');
defineJson('AC6','d928-change-detected','scripts/pr2a/planning-manifest.json',v=>{v.d928Sha256['scripts/lib/Review-StartClaim.ps1']='sha256:'+ '0'.repeat(64);},v=>v.d928Sha256['scripts/lib/Review-StartClaim.ps1']==='sha256:'+ '0'.repeat(64));
defineJson('AC6','powershell-file-added','scripts/pr2a/planning-manifest.json',v=>{v.plannedOperations.push({path:'scripts/new-claim-shim.ps1',operation:'add',reason:'mutation'});},v=>v.plannedOperations.some((r:JsonRecord)=>r.path==='scripts/new-claim-shim.ps1'));
defineAppend('AC6','powershell-policy-or-supervisor-logic-added','scripts/lib/Review-StartClaimLifecycle.ps1',"function Invoke-MutatedPowerShellPolicy { New-Item '.locks/mutation' -ItemType Directory }");
defineAppend('AC6','powershell-compatibility-clone-added','scripts/lib/Review-StartClaimLifecycle.ps1',"function Acquire-ReviewStartClaimClone { param($PrNumber,$HeadSha) return @{ state='active'; prNumber=$PrNumber; headSha=$HeadSha } }");
defineAppend('AC6','typescript-to-powershell-claim-dispatch-added','scripts/lib/review-start-claim-store.ts',"const mutationTsToPs = ['pwsh','Review-StartClaim.ps1'];");
defineAppend('AC6','tracked-d928-oracle-added','scripts/review-start-claim.test.ts',"const mutationLegacyOracle = 'scripts/lib/Review-StartClaim.ps1';");
defineAppend('AC6','new-scheduler-or-reaper-surface-added','scripts/lib/review-start-claim-cli.ts',"setInterval(() => reaperSweep({}), 5000);");
defineJson('AC6','retirement-outside-closed-list','scripts/pr2a/planning-manifest.json',v=>{v.plannedOperations.push({path:'scripts/verify.ps1',operation:'delete',reason:'mutation'});},v=>v.plannedOperations.some((r:JsonRecord)=>r.path==='scripts/verify.ps1'&&r.operation==='delete'));
defineJson('AC6','path-or-operation-outside-reviewed-declaration','scripts/pr2a/planning-manifest.json',v=>{v.plannedOperations.push({path:'README.md',operation:'modify',reason:'mutation'});},v=>v.plannedOperations.some((r:JsonRecord)=>r.path==='README.md'));
defineJson('AC6','allowed-roots-or-denylist-violation','scripts/pr2a/planning-manifest.json',v=>{v.plannedOperations.push({path:'vendor/mutation.ts',operation:'add',reason:'mutation'});},v=>v.plannedOperations.some((r:JsonRecord)=>r.path==='vendor/mutation.ts'));
defineJson('AC6','rename-copy-symlink-gitlink-or-mode-evasion','scripts/pr2a/planning-manifest.json',v=>{row(v,'package.json').mode='120000';},v=>row(v,'package.json').mode==='120000');
define('AC6','test-lane-classification-invalid',packageMutation(s=>{s['test:issue-948']=s['test:issue-948'].replace('--maxWorkers=1','--maxWorkers=2');},s=>!s['test:issue-948'].includes('--maxWorkers=1')));
defineReplace('AC7','shared-protocol-interleaving-class-fails','scripts/lib/review-start-claim-cli.ts',"return withMutex(lock, execute) as UnknownRecord;","return execute();");
defineReplace('AC7','representative-end-to-end-class-fails','scripts/pr2a/closure-receipt.ts',"  'acquisition',","  // acquisition mutation removed");
defineReplace('AC7','process-ordering-substitutes-for-persisted-exclusion','scripts/lib/review-start-claim-cli.ts',"mkdirSync(lockDir, { recursive: false, mode: 0o700 });","Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);");
defineReplace('AC7','reaper-or-release-mutates-replacement-generation','scripts/lib/review-start-claim-cli.ts',"if (!sameGeneration(read.record, input.expected)) return { ok: false, reason: 'lost_ownership' };","if (false) return { ok: false, reason: 'lost_ownership' };");
defineReplace('AC7','declared-reap-trigger-unreachable','scripts/lib/review-start-claim-cli.ts',"export function reaperSweep","function reaperSweep");
defineReplace('AC7','partial-tree-state-silently-supported','scripts/lib/review-start-claim-cli.ts',"if (existing.reason !== 'missing') {","if (false) {");
defineReplace('AC7','ci-isolation-or-reentry-broken','scripts/lib/review-start-claim-store.ts',"if (process.env.OPK_VITEST_HARNESS !== '1') return;","if (false) return;");
defineReplace('AC7','rollback-cross-version-gate-not-existing-or-not-shared','scripts/pr2a/rollback-drain.ts',"entryBlocked: true,","entryBlocked: false,");
defineReplace('AC7','rollback-quiescence-inventory-incomplete','scripts/pr2a/closure-receipt.ts',"if (!rollback.quiescenceInventoryComplete)","if (false)");
defineReplace('AC7','rollback-entry-resumes-before-zero-survivors','scripts/pr2a/rollback-drain.ts',"if (survivors.length > 0) throw new Error(`rollback_drain_survivors:${survivors.join(',')}`);","void survivors;");
defineReplace('AC7','rollback-detached-drain-artifact-invalid','scripts/pr2a/rollback-drain.ts',"if (artifact.digest !== expected) throw new Error('rollback_artifact_digest_invalid');","void expected;");
defineReplace('AC7','rollback-rehearsal-in-evidence-checkout','scripts/pr2a/closure-receipt.ts',"if (!rollback.isolatedCheckout)","if (false)");
defineAppend('AC7','rollback-imports-928-activation-machinery','scripts/pr2a/rollback-drain.ts',"const mutationImports928ActivationMachinery = 'scripts/pr2-cutover/cordon-controller.ts';");
defineReplace('AC7','unsupported-platform-or-filesystem-operation-succeeds','scripts/lib/review-start-claim-cli.ts',"if (/^\\/mnt\\/[a-z](?:\\/|$)/i.test(canonical)) throw new Error('unsupported_windows_mounted_filesystem');","if (false) throw new Error('unsupported_windows_mounted_filesystem');");
define('AC8','mandatory-command-or-lane-fails',packageMutation(s=>{s['test:issue-948']=s['test:issue-948'].replace('scripts/pr2a/final-conformance.test.ts','scripts/pr2a/missing.test.ts');},s=>s['test:issue-948'].includes('scripts/pr2a/missing.test.ts')));
define('AC8','mandatory-test-suppressed-or-reduced',packageMutation(s=>{s['test:issue-948']=s['test:issue-948'].replace('--maxWorkers=1','--maxWorkers=4');},s=>!s['test:issue-948'].includes('--maxWorkers=1')));
defineReplace('AC8','final-evidence-tree-or-platform-stale','scripts/pr2a/closure-receipt.ts',"function validateVerificationEnvironment","function validateVerificationEnvironmentDisabled");
defineReplace('AC8','required-suite-omitted-from-mandatory-path','scripts/pr2a/closure-receipt.ts',"  'vitest-heavy',","  // vitest-heavy mutation omitted");
defineReplace('AC8','receipt-dependent-suite-evidenced-pre-receipt','scripts/pr2a/closure-receipt.ts',"if (!preReceiptVerification.prerequisiteSuitesPassedBeforeReceipt)","if (false)");
defineReplace('AC8','overlap-evidence-candidate-tree-mismatch','scripts/pr2a/closure-receipt.ts',"overlap.candidateTreeOid !== expected.finalTreeOid","false");
defineReplace('AC8','receipt-and-final-verification-tree-differ','scripts/pr2a/closure-receipt.ts',"verification.finalTreeOid !== finalTreeOid || verification.checkoutTreeOid !== finalTreeOid","false");
defineReplace('AC8','final-checks-on-dirty-worktree','scripts/pr2a/closure-receipt.ts',"if (!verification.cleanBefore || !verification.cleanAfter","if (false && (!verification.cleanBefore || !verification.cleanAfter");
defineReplace('AC8','evidence-tree-differs-from-executed-bytes','scripts/pr2a/closure-receipt.ts',"if (sha256(bytes) !== claimedDigest)","if (false)");
defineReplace('AC8','implementation-change-reruns-tail-only','scripts/pr2a/closure-receipt.ts',"npm run typecheck:foundation && npm run lint:foundation && npm run test:contract-mutations && npm run test:issue-948","npm run test:issue-948");
defineReplace('AC8','planning-change-preserves-stale-ac1','scripts/pr2a/closure-receipt.ts',"planningManifestSha256: sha256(readAt(ref, 'scripts/pr2a/planning-manifest.json'))","planningManifestSha256: 'sha256:' + '0'.repeat(64)");
defineReplace('AC8','same-tree-sha-change-rejected-as-tree-mismatch','scripts/pr2a/closure-receipt.ts',"return observedCommitSha === expectedCommitSha || gitTreeOid(observedCommitSha) === expectedTreeOid;","return observedCommitSha === expectedCommitSha;");
defineReplace('AC8','external-928-sync-evidence-missing','scripts/pr2a/closure-receipt.ts',"if (external928.result !== 'pass'","if (false && external928.result !== 'pass'");

function assertCatalogCoverage(): void {
  const catalogKeys = new Set(PR2A_MUTATION_CATALOG.map((binding) => mutationKey(binding.ac, binding.mutationId)));
  const missing = [...catalogKeys].filter((key) => !specs.has(key));
  const extra = [...specs.keys()].filter((key) => !catalogKeys.has(key));
  if (missing.length || extra.length) throw new Error(`mutation_catalog_coverage_invalid:missing=${missing.join(',')}:extra=${extra.join(',')}`);
}
function bindingFromArgs(argv: string[]): readonly Pr2aMutationBinding[] {
  const index = argv.indexOf('--ac');
  if (index >= 0) {
    const ac = String(argv[index + 1] ?? '') as Pr2aAcceptanceId;
    const selected = PR2A_MUTATION_CATALOG.filter((binding) => binding.ac === ac);
    if (selected.length === 0) throw new Error(`invalid_ac:${ac}`);
    return selected;
  }
  if (argv.includes('--all')) return PR2A_MUTATION_CATALOG;
  throw new Error('usage: mutation-runner.ts --ac AC1|...|AC8 or --all');
}
function execute(command: string[], cwd: string): ReturnType<typeof runProcessSync> {
  const result = runProcessSync({
    command: command[0]!,
    args: command.slice(1),
    cwd,
    inheritParentEnv: true,
  });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`detector_transport_failed:${command.join(' ')}:${result.stderr || result.error || result.exitCode}`);
  }
  return result;
}
function planningCommand(): string[] {
  return [process.execPath, '--experimental-strip-types', 'scripts/pr2a/planning-validator.ts', 'scripts/pr2a/planning-manifest.json'];
}
function conformanceCommand(ref: string): string[] {
  return [process.execPath, '--experimental-strip-types', 'scripts/pr2a/final-conformance.ts', '--ref', ref, '--json'];
}
function runPlanningDetector(root: string): DetectorExecution {
  const command = planningCommand();
  const result = execute(command, root);
  const findings = `${result.stderr}\n${result.stdout}`.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return { exitCode: result.exitCode ?? (result.ok ? 0 : 1), findings, command };
}
function git(root: string, args: string[]): string {
  const result = runProcessSync({ command: 'git', args, cwd: root, inheritParentEnv: true });
  if (!result.ok) throw new Error(result.stderr || result.error || `git_${args.join('_')}_failed`);
  return result.stdout.trim();
}
function syntheticPrMerge(root: string, candidateRef: string): string {
  const candidate = git(root, ['rev-parse', `${candidateRef}^{commit}`]);
  const baseName = String(process.env.GITHUB_BASE_REF ?? '').trim() || 'main';
  const baseRef = `origin/${baseName}`;
  const base = git(root, ['rev-parse', `${baseRef}^{commit}`]);
  const tree = git(root, ['rev-parse', `${candidate}^{tree}`]);
  return git(root, ['commit-tree', tree, '-p', base, '-p', candidate, '-m', 'mutation detector synthetic PR merge']);
}
function runConformanceDetector(root: string, candidateRef: string): DetectorExecution {
  const syntheticMerge = syntheticPrMerge(root, candidateRef);
  const command = conformanceCommand(syntheticMerge);
  const result = execute(command, root);
  let findings: string[] = [];
  if (result.stdout.trim()) {
    try {
      const report = JSON.parse(result.stdout) as { findings?: Array<{ code?: string }> };
      findings = Array.isArray(report.findings) ? report.findings.map((row) => String(row.code ?? '')).filter(Boolean) : [];
    } catch {
      if (result.ok) throw new Error(`conformance_detector_output_invalid:${result.stdout}`);
    }
  }
  return { exitCode: result.exitCode ?? (result.ok ? 0 : 1), findings, command };
}
function createMutationCommit(root: string, artifactPath: string, binding: Pr2aMutationBinding): string {
  git(root, ['add', '--', artifactPath]);
  const tree = git(root, ['write-tree']);
  const commit = git(root, ['commit-tree', tree, '-p', 'HEAD', '-m', `mutation ${binding.ac}:${binding.mutationId}`]);
  git(root, ['reset', '--quiet', 'HEAD', '--', artifactPath]);
  return commit;
}
function detectorForRestored(binding: Pr2aMutationBinding, root: string): DetectorExecution {
  return binding.failingTestId === 'pr2a:planning-validator'
    ? runPlanningDetector(root)
    : runConformanceDetector(root, 'HEAD');
}
function detectorForMutation(binding: Pr2aMutationBinding, root: string, artifactPath: string): DetectorExecution {
  if (binding.failingTestId === 'pr2a:planning-validator') return runPlanningDetector(root);
  const candidate = createMutationCommit(root, artifactPath, binding);
  return runConformanceDetector(root, candidate);
}
function runMutation(binding: Pr2aMutationBinding, root: string): MutationEvidence {
  const key = mutationKey(binding.ac, binding.mutationId);
  const spec = specs.get(key);
  if (!spec) throw new Error(`mutation_spec_missing:${key}`);
  const file = path.join(root, spec.artifactPath);
  const before = source(root, spec.artifactPath);
  if (spec.faultPresent(before)) throw new Error(`mutation_precondition_fault_present:${binding.mutationId}`);

  const mutated = spec.apply(before);
  if (mutated === before) throw new Error(`mutation_did_not_change_artifact:${binding.mutationId}`);
  if (!spec.faultPresent(mutated)) throw new Error(`mutation_fault_not_present:${binding.mutationId}`);
  writeFileSync(file, mutated, 'utf8');
  const negative = detectorForMutation(binding, root, spec.artifactPath);
  if (negative.exitCode !== 1) {
    throw new Error(`specific_detector_not_red:${binding.failingTestId}:exit=${negative.exitCode}:findings=${negative.findings.join(',')}`);
  }
  if (binding.failingTestId !== 'pr2a:planning-validator' && !negative.findings.includes(binding.failingTestId)) {
    throw new Error(`specific_failing_test_not_observed:${binding.failingTestId}:observed=${negative.findings.join(',')}`);
  }

  writeFileSync(file, before, 'utf8');
  const restoredHash = digest(readFileSync(file));
  const artifactHashBefore = digest(before);
  if (restoredHash !== artifactHashBefore) throw new Error(`restore_hash_mismatch:${binding.mutationId}`);
  const restored = detectorForRestored(binding, root);
  if (restored.exitCode !== 0) {
    throw new Error(`restored_verification_failed:${binding.failingTestId}:exit=${restored.exitCode}:findings=${restored.findings.join(',')}`);
  }

  return {
    ac: binding.ac,
    mutationId: binding.mutationId,
    artifactPath: spec.artifactPath,
    detectorId: binding.failingTestId,
    detectorCommand: negative.command,
    expectedFinding: binding.failingTestId,
    observedFindings: negative.findings,
    artifactHashBefore,
    artifactHashAfter: digest(mutated),
    restoredHash,
    negativeExitCode: 1,
    restoredExitCode: 0,
    negativeOutcome: 'failed',
    restoredOutcome: 'passed',
  };
}
async function main(): Promise<void> {
  assertCatalogCoverage();
  const bindings = bindingFromArgs(process.argv.slice(2));
  const parent = mkdtempSync(path.join(tmpdir(), 'opk-pr2a-mutations-'));
  const checkout = path.join(parent, 'checkout');
  let added = false;
  try {
    const add = runProcessSync({
      command: 'git',
      args: ['worktree', 'add', '--detach', checkout, 'HEAD'],
      cwd: repoRoot,
      inheritParentEnv: true,
    });
    if (!add.ok) throw new Error(add.stderr || add.error || 'mutation_worktree_add_failed');
    added = true;

    const planningBaseline = runPlanningDetector(checkout);
    if (planningBaseline.exitCode !== 0) {
      throw new Error(`planning_detector_baseline_red:${planningBaseline.findings.join(',')}`);
    }
    const conformanceBaseline = runConformanceDetector(checkout, 'HEAD');
    if (conformanceBaseline.exitCode !== 0) {
      throw new Error(`conformance_detector_baseline_red:${conformanceBaseline.findings.join(',')}`);
    }

    const evidence = bindings.map((binding) => runMutation(binding, checkout));
    process.stdout.write(`${JSON.stringify({
      issue: 948,
      mutationEvidence: evidence,
      mutationRunner: { result: 'one-row-one-fault-production-detector-red-green', bindings: evidence.length },
    })}\n`);
  } finally {
    if (added) {
      runProcessSync({
        command: 'git',
        args: ['worktree', 'remove', '--force', checkout],
        cwd: repoRoot,
        inheritParentEnv: true,
      });
    }
    rmSync(parent, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
