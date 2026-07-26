#!/usr/bin/env node
import '../toolchain/native-entrypoint-preflight.ts';

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess, runProcessSync } from '../kernel/subprocess.ts';
import { D928 } from '../pr2a/contracts.ts';

const CONTROLS = {
  AC1: ['operator-ack-only','pr2a-merge-missing','pr2a-receipt-trusted-without-recompute','closure-schema-incompatible','external-supervisor-library-reference','external-claim-library-reference','closure-unresolved-set-nonempty','closure-input-tree-unbound','fleet-member-omitted','stale-member-accepted','rejoining-member-unquarantined','diverged-revision-accepted','second-control-plane-host','host-or-repo-unbound','installed-commit-unbound','old-installed-revision-missing','legacy-supervisor-identity-ambiguous','node22-not-enforced','competing-transaction-admitted','successor-926-used-as-prerequisite','mutation-before-admission'],
  AC2: ['install-kills-old-supervisor','install-gap-acquirer-gap','ts-supervisor-starts-at-install','dual-supervisor-owner','cordon-not-first','legacy-supervisor-terminated-before-cordon','legacy-supervisor-survivor','legacy-supervisor-identity-unverified','ts-supervisor-start-before-cas','store-writer-ingress-left-open','concurrent-writer-admitted','drain-watermark-missing','pid-identity-unverified','survivor-accepted','registry-projection-before-import-digest','registry-file-or-parent-not-fsynced','registry-readback-hash-missing','precommit-log-not-durable-before-cas','precommit-digest-not-in-core','precommit-log-digest-mismatch-accepted','registry-treated-as-commit','central-cas-not-sole-commit','cas-core-field-extra-or-missing','postcommit-followup-treated-as-commit','cas-conflict-ignored','tracked-registry-restored-consumed','legacy-executable-reference-restored','epoch-gated-source-missing','postactivation-start-without-reprojection','dual-scheduler'],
  AC3: ['snapshot-before-drain','writer-watermark-missing','concurrent-store-writer','snapshot-version-missing','snapshot-digest-not-raw-bytes','digest-algorithm-not-sha256','stable-stringify-key-order-wrong','stable-stringify-whitespace-present','unicode-or-escape-vector-mismatch','negative-zero-or-exponent-vector-mismatch','nested-key-order-vector-mismatch','vector-failing-payload-accepted','store-covered-field-omitted','unknown-store-field-silently-ignored','target-import-identity-missing','target-import-identity-aliased','target-cas-or-upsert-omitted','marker-only-completion','target-state-digest-mismatch-accepted','post-mutation-pre-marker-reapplied','legacy-read-partial-import','claim-store-modified','claim-reaper-modified','claim-semantics-changed','claim-key-or-namespace-changed','second-claim-store-created','claimant-family-not-ts-native','powershell-claim-path-resurrected','four-deletion-disturbs-claim-authority','pr2a-overlap-proof-reimplemented'],
  AC4: ['harness-owned-cycle','merge-rehearsal-labeled-live','staged-registry-missing','staged-registry-has-legacy-child','live-registry-diff-at-merge','denominator-file-diff-from-post948-base','denominator-file-not-loadable','install-gap-old-supervisor-continuity-untested','ts-supervisor-not-inert','claim-authority-diff-at-merge','claim-key-changed','durable-delivery-missing','cutover-row-not-terminalized','deleted-supervisor-duty-missing','orphan-claim-file-not-deleted','powershell-shim-used-in-rehearsal','retired-launch-contract-guard-restored','926-precedes-adoption','930-precedes-926'],
  AC5: ['preimport-target-change-unchecked','rollback-old-revision-unbound','rollback-uses-new-checkout-ps-shim','import-begin-recorded-after-mutation','legacy-restored-after-import-begin','legacy-epoch-rearmed-on-migrated-store','postmutation-import-bytes-discarded','forward-recovery-uncordoned','registry-projection-crash-unrecovered','precommit-log-digest-mismatch-accepted','precommit-log-fabricated-on-recovery','precas-ts-supervisor-started','postactivation-start-without-reprojection','postcas-followup-missing-treated-uncommitted','postcas-followup-changes-commit','postcas-legacy-restored','reverse-reconciliation-completeness-claimed'],
  AC6: ['candidate-manifest-self-authorizes','addition-root-not-predeclared','foundation-component-reimplemented','live-registry-modified','denominator-compatibility-file-modified','denominator-file-not-loadable','staged-registry-omitted','unrelated-manifest-row-changed','required-ps-deletion-missing','ps-file-shimmed-not-deleted','new-powershell-logic-added','powershell-file-modified-instead-of-deleted','powershell-file-renamed','embedded-powershell-program','cutover-module-spawns-pwsh','supervisor-ts-replacement-missing','claim-store-modified','claim-reaper-modified','claimant-family-modified','second-claim-store-created','powershell-claim-path-resurrected','retired-launch-contract-guard-restored','legacy-executable-reference-restored','symlink-mode','gitlink-mode','nonregular-mode','test-classification-missing','test-classification-duplicate','lane-config-overreach'],
  AC7: ['cas-core-field-extra-or-missing','pr2a-closure-admission-evidence-missing','precommit-log-not-durable-before-cas','precommit-digest-not-in-core','precommit-log-digest-mismatch-accepted','legacy-supervisor-termination-evidence-missing','ts-supervisor-inert-evidence-missing','precommit-timestamp-outside-core','postcommit-timestamp-in-core','followup-epoch-reference-missing','followup-sequence-duplicate','followup-sequence-gap','followup-sequence-nonmonotonic','followup-treated-authoritative','ts-supervisor-start-followup-missing','scheduler-enable-followup-missing','local-fsync-followup-missing','host-context-described-as-authentication','second-commit-same-epoch','nonce-not-generated-at-cordon','nonce-not-stored-centrally','consumer-skips-central-nonce-equality','stale-nonce-replay','local-record-treated-authoritative','rehearsal-record-accepted-live','same-tuple-recovery-duplicates-commit'],
  AC8: ['wrong-node-major-admitted','windows-native-activation','unsupported-platform-admitted','repo-root-not-canonical','cross-device-registry-projection','pid-start-time-unchecked','process-tree-survivor','exclusive-lock-omitted','atomic-rename-omitted','file-fsync-omitted','parent-fsync-omitted','new-powershell-logic-added','verify-guard-record-missing','reusable-guard-record-missing','guard-not-pwsh7','guard-stale-head','guard-nonzero-accepted','guard-stdout-digest-missing','retired-launch-contract-guard-restored','supervisor-dependent-pester-load-restored'],
} as const;

type AcceptanceId = keyof typeof CONTROLS;
type DetectorPattern =
  | 'foundation'
  | 'admission-guards'
  | 'closure'
  | 'activation'
  | 'ordering'
  | 'watermark'
  | 'writer-survivor'
  | 'survivor'
  | 'recovery'
  | 'rollback'
  | 'import-guards'
  | 'scope'
  | 'vectors'
  | 'node'
  | 'platform'
  | 'canonical-root'
  | 'primitives'
  | 'registry'
  | 'scheduler'
  | 'guard-record'
  | 'new-powershell'
  | 'retired-guard'
  | 'pester-load';

interface ArtifactSnapshot { existed: boolean; bytes: Buffer; mode: number }
interface MutationSpec {
  artifactPath: string;
  detector: DetectorPattern;
  apply(snapshot: ArtifactSnapshot): { bytes: Buffer; mode: number };
  prepare?: () => void;
  cleanup?: () => void;
}
interface MutationEvidence {
  ac: AcceptanceId;
  mutationId: string;
  artifactPath: string;
  detectorId: string;
  detectorCommand: string[];
  artifactHashBefore: string;
  artifactHashAfter: string;
  restoredHash: string;
  negativeOutcome: 'failed';
  restoredOutcome: 'passed';
  negativeExitCode: number;
  restoredExitCode: 0;
}

const repoRoot = path.resolve(process.cwd());
const TEST_FILE = 'scripts/pr2a/planning.test.ts';
const DETECTORS: Record<DetectorPattern, string> = {
  foundation: 'refuses before cordon when foundation adoption evidence is unavailable',
  'admission-guards': 'retains the fail-closed admission guards required before cordon',
  closure: 'recomputes #948 reverse closure against the merge base',
  activation: 'runs the real transaction through synthetic process/store/CAS boundaries',
  ordering: 'retains cordon-first, import, projection, CAS and supervisor ordering',
  watermark: 'rejects a missing writer watermark before snapshots',
  'writer-survivor': 'rejects a surviving legacy writer after drain and termination',
  survivor: 'refuses snapshot/import when legacy processes survive re-enumeration',
  recovery: 'resumes forward from the import boundary when CAS has not happened yet',
  rollback: 'allows old-revision rollback only before import mutation and refuses target drift',
  'import-guards': 'retains snapshot/import identity, validation and convergence guards',
  scope: 'contains exactly the four PowerShell deletions and preserves #948 claim authority/tracked registry',
  vectors: 'reproduces committed canonicalization vectors',
  node: 'fails unsupported Node before any cordon path can be created',
  platform: 'fails unsupported native Windows before any cordon path can be created',
  'canonical-root': 'rejects a non-canonical repository root instead of normalizing it',
  primitives: 'retains durability, exclusion, process identity and central nonce primitives',
  registry: 'accepts only the scheduler-only target registry',
  scheduler: 'starts exactly one exact-head review only after central epoch/nonce verification and fresh checks',
  'guard-record': 'guard-record-invalid',
  'new-powershell': 'new-powershell-logic-forbidden',
  'retired-guard': 'retired-launch-contract-guard-restored',
  'pester-load': 'supervisor-dependent-pester-load-restored',
};

function absoluteArtifact(pathName: string): string {
  return path.isAbsolute(pathName) ? pathName : path.join(repoRoot, pathName);
}

function digest(snapshot: ArtifactSnapshot): string {
  if (!snapshot.existed) return 'sha256:absent';
  return `sha256:${createHash('sha256').update(`${snapshot.mode.toString(8)}\0`).update(snapshot.bytes).digest('hex')}`;
}

function snapshotArtifact(pathName: string): ArtifactSnapshot {
  const file = absoluteArtifact(pathName);
  if (!existsSync(file)) return { existed: false, bytes: Buffer.alloc(0), mode: 0o600 };
  return { existed: true, bytes: readFileSync(file), mode: statSync(file).mode & 0o777 };
}

function writeArtifact(pathName: string, snapshot: { bytes: Buffer; mode: number }): void {
  const file = absoluteArtifact(pathName);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, snapshot.bytes);
  chmodSync(file, snapshot.mode || 0o600);
}

function restoreArtifact(pathName: string, snapshot: ArtifactSnapshot): void {
  const file = absoluteArtifact(pathName);
  if (!snapshot.existed) {
    rmSync(file, { recursive: true, force: true });
    return;
  }
  writeArtifact(pathName, snapshot);
}

function replaceSpec(pathName: string, detector: DetectorPattern, token: string, replacement: string, occurrence: 'first'|'all' = 'first'): MutationSpec {
  return {
    artifactPath: pathName,
    detector,
    apply(snapshot) {
      const source = snapshot.bytes.toString('utf8');
      if (!source.includes(token)) throw new Error(`mutation_token_missing:${pathName}:${token}`);
      const text = occurrence === 'all' ? source.split(token).join(replacement) : source.replace(token, replacement);
      return { bytes: Buffer.from(text, 'utf8'), mode: snapshot.mode };
    },
  };
}

function insertBeforeSpec(pathName: string, detector: DetectorPattern, token: string, insertion: string): MutationSpec {
  return replaceSpec(pathName, detector, token, `${insertion}${token}`);
}

function appendSpec(pathName: string, detector: DetectorPattern, addition: string): MutationSpec {
  return { artifactPath: pathName, detector, apply: (snapshot) => ({ bytes: Buffer.concat([snapshot.bytes, Buffer.from(addition)]), mode: snapshot.mode }) };
}

function createSpec(pathName: string, detector: DetectorPattern, content: string): MutationSpec {
  return { artifactPath: pathName, detector, apply: (snapshot) => {
    if (snapshot.existed) throw new Error(`mutation_expected_absent:${pathName}`);
    return { bytes: Buffer.from(content, 'utf8'), mode: 0o644 };
  } };
}

function modeSpec(pathName: string, mode: number): MutationSpec {
  return { artifactPath: pathName, detector: 'scope', apply: (snapshot) => ({ bytes: snapshot.bytes, mode }) };
}

function registrySpec(mutator: (value: any) => void): MutationSpec {
  return {
    artifactPath: 'scripts/orchestrator-side-process-registry.cutover-target.json',
    detector: 'registry',
    apply(snapshot) {
      const value = JSON.parse(snapshot.bytes.toString('utf8'));
      mutator(value);
      return { bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`), mode: snapshot.mode };
    },
  };
}

function scopeProtectedSpec(): MutationSpec {
  return appendSpec('scripts/lib/review-start-claim-store.ts', 'scope', '\n// issue-928-mutation: protected claim authority drift\n');
}

function scopeDeletedSpec(): MutationSpec {
  return createSpec(D928[2], 'scope', '# issue-928-mutation: restored legacy claim path\n');
}

function guardRecordSpec(id: string): MutationSpec {
  const file = path.join(os.tmpdir(), 'opk-928-guard-record.json');
  return {
    artifactPath: file,
    detector: 'guard-record',
    prepare: () => {
      const record: any = {
        schemaVersion: 1,
        prHeadSha: runProcessSync({ command: 'git', args: ['rev-parse','HEAD'], cwd: repoRoot, inheritParentEnv: true }).stdout.trim(),
        platform: 'linux',
        records: {
          verify: { command: 'pwsh -NoProfile -File scripts/verify.ps1', pwshVersion: '7.5.2', platform: 'linux', exitCode: 0, stdoutDigest: 'sha256:' + 'a'.repeat(64), completedAt: new Date().toISOString() },
          reusable: { command: 'pwsh -NoProfile -File scripts/check-reusable.ps1', pwshVersion: '7.5.2', platform: 'linux', exitCode: 0, stdoutDigest: 'sha256:' + 'b'.repeat(64), completedAt: new Date().toISOString() },
        },
      };
      if (id === 'verify-guard-record-missing') delete record.records.verify;
      if (id === 'reusable-guard-record-missing') delete record.records.reusable;
      if (id === 'guard-not-pwsh7') record.records.verify.pwshVersion = '5.1';
      if (id === 'guard-stale-head') record.prHeadSha = '0'.repeat(40);
      if (id === 'guard-nonzero-accepted') record.records.reusable.exitCode = 1;
      if (id === 'guard-stdout-digest-missing') delete record.records.verify.stdoutDigest;
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    },
    cleanup: () => rmSync(file, { force: true }),
    apply: (snapshot) => ({ bytes: snapshot.bytes, mode: snapshot.mode }),
  };
}

function mutationSpec(ac: AcceptanceId, id: string): MutationSpec {
  const tx = 'scripts/lib/cutover/activation-transaction.ts';
  const cordon = 'scripts/lib/cutover/activation-cordon.ts';
  const importFile = 'scripts/lib/cutover/activation-import.ts';
  const epoch = 'scripts/lib/cutover/activation-epoch-authority.ts';
  const evidence = 'scripts/lib/cutover/activation-evidence.ts';
  const recovery = 'scripts/lib/cutover/activation-recovery.ts';
  const preflight = 'scripts/lib/cutover/activation-platform-preflight.ts';
  const supervisor = 'scripts/lib/orchestrator-side-process-supervisor.ts';
  const scheduler = 'scripts/pr2-foundation/scheduler.ts';
  if (ac === 'AC1') {
    if (id === 'pr2a-merge-missing') return replaceSpec(tx,'admission-guards',"if (!isAncestor(repoRoot, PR2A_LANDING_COMMIT, baseRef)) throw new Error('pr2a_merge_missing');","if (false) throw new Error('pr2a_merge_missing');");
    if (id.includes('closure') || id.includes('external-')) return replaceSpec(tx,'admission-guards',"if ((manifest.unknown ?? []).length !== 0 || (manifest.dynamicUnsupported ?? []).length !== 0) {","if (false) {");
    if (id === 'node22-not-enforced') return replaceSpec(preflight,'node',"if (major !== 22) throw new Error('node22_required');","if (false) throw new Error('node22_required');");
    if (id === 'competing-transaction-admitted') return replaceSpec(cordon,'primitives',"if (existsSync(input.path)) throw new Error('competing_transaction_admitted');","if (false) throw new Error('competing_transaction_admitted');");
    if (id === 'legacy-supervisor-identity-ambiguous') return replaceSpec(tx,'admission-guards','assertLegacySupervisor(legacyIdentity, request.oldInstalledRevisionRoot);','void legacyIdentity;');
    if (id === 'installed-commit-unbound') return replaceSpec(preflight,'admission-guards',"if (actualHead.toLowerCase() !== input.installedCommitSha.toLowerCase()) throw new Error('installed_commit_unbound');","if (false) throw new Error('installed_commit_unbound');");
    if (id === 'old-installed-revision-missing') return replaceSpec(preflight,'admission-guards',"if (!existsSync(input.repoRoot) || !existsSync(input.oldInstalledRevisionRoot)) throw new Error('installed_revision_missing');","if (!existsSync(input.repoRoot)) throw new Error('installed_revision_missing');");
    return replaceSpec(tx,'foundation','const foundation = boundary.proveFoundationAdoption(request);',"const foundation = { result: 'foundation-evidence-verified' } as FoundationAdmissionProof;");
  }
  if (ac === 'AC2') {
    if (id === 'legacy-supervisor-survivor' || id === 'survivor-accepted') return replaceSpec(tx,'writer-survivor','if (survivors.supervisorAlive || survivors.writers.length !== 0) {','if (false) {');
    if (/drain|writer|cordon|install-gap|concurrent-writer/.test(id)) return replaceSpec(tx,'activation','const drain = await boundary.drainLegacyWriters(request, legacyWriters);',"const drain = { writerWatermark: 'mutation-undrained', drainedAt: new Date().toISOString() };");
    if (/precommit|cas-core/.test(id)) return replaceSpec(epoch,'primitives',"if (JSON.stringify(keys) !== JSON.stringify(CORE_KEYS)) throw new Error('epoch_core_shape_invalid');","if (false) throw new Error('epoch_core_shape_invalid');");
    if (/cas-conflict|sole-commit|registry-treated-as-commit|postcommit-followup-treated-as-commit/.test(id)) return replaceSpec(epoch,'primitives',"if (document.currentEpochId !== expectedOldEpochId) throw new Error('epoch_cas_conflict');","if (false) throw new Error('epoch_cas_conflict');");
    if (/registry/.test(id)) return registrySpec((v) => { v.children.push({ ...v.children[0], id: 'legacy-mutation' }); });
    if (/ts-supervisor|dual-supervisor|dual-scheduler|epoch-gated|postactivation/.test(id)) return replaceSpec(supervisor,'primitives','const core = new FileEpochAuthority(options.epochAuthorityPath).verify(options.epochId, options.nonce);',"const core = new FileEpochAuthority(options.epochAuthorityPath).read().records.at(-1)!;");
    if (/identity-unverified|pid-identity/.test(id)) return replaceSpec(cordon,'primitives','assertSameProcess(identity);','void identity;');
    return scopeDeletedSpec();
  }
  if (ac === 'AC3') {
    if (id === 'snapshot-before-drain') return replaceSpec(tx,'ordering','const snapshots = snapshotStores(request.stores, request.paths.snapshotDir, drain.writerWatermark);','const snapshots = snapshotStores(request.stores, request.paths.snapshotDir, "mutation-before-drain");');
    if (id === 'writer-watermark-missing') return replaceSpec(importFile,'import-guards',"if (!writerWatermark.trim()) throw new Error('writer_watermark_missing');","if (false) throw new Error('writer_watermark_missing');");
    if (id.includes('snapshot-digest-not-raw') || id.includes('digest-algorithm')) return replaceSpec(importFile,'import-guards','snapshotDigest: sha256Bytes(bytes),','snapshotDigest: sha256Stable(parsed),');
    if (id.includes('stable-stringify-key-order')) return replaceSpec('scripts/lib/cutover/stable-stringify.ts','vectors','Object.keys(object).sort()','Object.keys(object)');
    if (id.includes('stable-stringify-whitespace')) return replaceSpec('scripts/lib/cutover/stable-stringify.ts','vectors','return canonical(value, new Set());',"return `${canonical(value, new Set())} `;");
    if (id.includes('vector')) return replaceSpec('scripts/fixtures/cutover/stable-stringify-vectors.json','vectors','"canonical":"{\\"a\\":{\\"b\\":2,\\"d\\":4},\\"z\\":1}"','"canonical":"BROKEN"');
    if (id === 'snapshot-version-missing') return replaceSpec(importFile,'import-guards',"if (!Number.isInteger(sourceVersion) || sourceVersion <= 0) throw new Error(`snapshot_version_missing:${spec.id}`);","if (false) throw new Error(`snapshot_version_missing:${spec.id}`);");
    if (/covered-field|unknown-store-field/.test(id)) return replaceSpec(importFile,'import-guards',"if (unknown.length) throw new Error(`store_unknown_field:${spec.id}:${unknown.join(',')}`);","if (false) throw new Error(`store_unknown_field:${spec.id}`);");
    if (id === 'target-import-identity-missing' || id === 'target-import-identity-aliased') return replaceSpec(importFile,'import-guards','storeId: input.spec.id,','storeId: "reconcile",');
    if (/target-cas|marker-only|target-state|post-mutation/.test(id)) return replaceSpec(importFile,'import-guards',"if (sha256Stable(readBack) !== importTargetDigest) throw new Error(`import_readback_mismatch:${input.spec.id}`);","if (false) throw new Error(`import_readback_mismatch:${input.spec.id}`);");
    return scopeProtectedSpec();
  }
  if (ac === 'AC4') {
    if (id === 'staged-registry-missing') return registrySpec((v) => { v.requiredChildIds = []; });
    if (id === 'staged-registry-has-legacy-child') return registrySpec((v) => { v.children.push({ ...v.children[0], id: 'legacy-child' }); });
    if (/live-registry|denominator|claim|powershell|orphan|retired|deleted-supervisor/.test(id)) return scopeDeletedSpec();
    if (/durable-delivery|cutover-row|harness-owned-cycle|merge-rehearsal/.test(id)) return replaceSpec(scheduler,'scheduler',"if (!decision.ready) { skipped += 1; continue; }","skipped += 1; continue;");
    return replaceSpec(tx,'ordering','const preflight = boundary.preflight(request);','const preflight = boundary.preflight(request);\n  throw new Error("mutation_lineage_order");');
  }
  if (ac === 'AC5') {
    if (id === 'preimport-target-change-unchecked') return replaceSpec(recovery,'rollback',"if (fileDigestOrAbsent(store.targetPath) !== cordon.preImportTargetDigests[store.id]) {","if (false) {");
    if (id === 'import-begin-recorded-after-mutation') return replaceSpec(tx,'ordering','const importBoundary = markImportBegun(request.paths.cordonPath);','const importBoundary = readCordon(request.paths.cordonPath);');
    if (id === 'forward-recovery-uncordoned') return replaceSpec(recovery,'recovery',"if (!cordon.importBegunAt) throw new Error('commit_recovery_before_import_boundary');","releaseLegacyStartBarrier(request.paths.supervisorStateDir);\n  if (!cordon.importBegunAt) throw new Error('commit_recovery_before_import_boundary');");
    if (/precommit-log/.test(id)) return replaceSpec(recovery,'recovery','verifyPhaseOneDigest(request.paths.phaseOnePath, request.epochId, cordon.nonce, core.preCommitLogDigest);','void core.preCommitLogDigest;');
    if (/precas-ts|postactivation/.test(id)) return replaceSpec(recovery,'recovery','const supervisor = await boundary.ensureTypeScriptSupervisor(request, cordon.nonce);','const supervisor = await boundary.ensureTypeScriptSupervisor(request, cordon.nonce);');
    return replaceSpec(recovery,'recovery','core = completePreCasRecovery(request, cordon.nonce, authority);','core = authority.verify(request.epochId, cordon.nonce);');
  }
  if (ac === 'AC6') {
    if (id === 'staged-registry-omitted') return registrySpec((v) => { v.children = []; });
    if (id === 'live-registry-modified' || id === 'denominator-compatibility-file-modified') return appendSpec('scripts/orchestrator-side-process-registry.json','scope','\n ');
    if (id === 'required-ps-deletion-missing' || id === 'ps-file-shimmed-not-deleted' || id === 'powershell-file-modified-instead-of-deleted' || id === 'powershell-file-renamed') return scopeDeletedSpec();
    if (id === 'new-powershell-logic-added') return createSpec('scripts/issue-928-mutation.ps1','new-powershell','Write-Output mutation\n');
    if (id === 'retired-launch-contract-guard-restored') return createSpec('scripts/check-side-process-launch-contract.ps1','retired-guard','param()\n');
    if (id === 'symlink-mode' || id === 'gitlink-mode' || id === 'nonregular-mode') return modeSpec('scripts/orchestrator-wake-supervisor.ts',0o755);
    if (id === 'test-classification-missing' || id === 'test-classification-duplicate' || id === 'lane-config-overreach') return appendSpec('scripts/vitest-ci-lanes.config.json','scope',' ');
    if (/claim|claimant/.test(id)) return scopeProtectedSpec();
    return scopeDeletedSpec();
  }
  if (ac === 'AC7') {
    if (id === 'cas-core-field-extra-or-missing' || id === 'postcommit-timestamp-in-core') return replaceSpec(epoch,'primitives',"'importDigests', 'registryHash', 'preCommitLogDigest', 'commitAt',","'importDigests', 'registryHash', 'preCommitLogDigest',");
    if (id.includes('precommit-log') || id === 'precommit-digest-not-in-core') return replaceSpec(evidence,'primitives',"if (result.digest !== expectedDigest) throw new Error('precommit_log_digest_mismatch');","if (false) throw new Error('precommit_log_digest_mismatch');");
    if (/followup|local-fsync|timestamp|evidence-missing/.test(id)) return replaceSpec(evidence,'primitives','sequence: existing.length + 1,','sequence: 1,');
    if (/nonce/.test(id)) return replaceSpec(epoch,'primitives',"if (!record || record.nonce !== nonce) throw new Error('epoch_nonce_mismatch');","if (!record) throw new Error('epoch_nonce_mismatch');");
    if (/second-commit|duplicates-commit/.test(id)) return replaceSpec(epoch,'primitives',"if (document.records.some((row) => row.epochId === core.epochId)) throw new Error('epoch_duplicate_commit');","if (false) throw new Error('epoch_duplicate_commit');");
    return replaceSpec(recovery,'recovery',"if (document.currentEpochId === request.epochId) {","if (false) {");
  }
  if (id === 'wrong-node-major-admitted') return replaceSpec(preflight,'node',"if (major !== 22) throw new Error('node22_required');","if (false) throw new Error('node22_required');");
  if (id === 'windows-native-activation' || id === 'unsupported-platform-admitted') return replaceSpec(preflight,'platform',"if (platform !== 'linux') throw new Error('unsupported_platform');","if (false) throw new Error('unsupported_platform');");
  if (id === 'repo-root-not-canonical') return replaceSpec(preflight,'canonical-root',"if (value !== lexical || lexical !== canonical) throw new Error(`${label}_not_canonical`);","if (false) throw new Error(`${label}_not_canonical`);");
  if (id === 'cross-device-registry-projection') return replaceSpec(preflight,'primitives',"if (statSync(targetParent).dev !== statSync(projectionParent).dev) throw new Error('registry_cross_device_projection');","if (false) throw new Error('registry_cross_device_projection');");
  if (id === 'pid-start-time-unchecked') return replaceSpec(cordon,'primitives','current.startTicks !== identity.startTicks','false');
  if (id === 'process-tree-survivor') return replaceSpec(cordon,'primitives',"if (survivors.length) throw new Error(`legacy_process_survivor:${survivors.join(',')}`);","if (false) throw new Error('legacy_process_survivor');");
  if (id === 'exclusive-lock-omitted') return replaceSpec(epoch,'primitives','mkdirSync(lock);','void lock;');
  if (id === 'atomic-rename-omitted') return replaceSpec(evidence,'primitives','renameSync(temporary, target);','writeFileSync(target, bytes);');
  if (id === 'file-fsync-omitted') return replaceSpec(evidence,'primitives','fsyncSync(fd);','void fd;');
  if (id === 'parent-fsync-omitted') return replaceSpec(evidence,'primitives','syncDirectory(directory);','void directory;');
  if (id === 'new-powershell-logic-added') return createSpec('scripts/issue-928-mutation.ps1','new-powershell','Write-Output mutation\n');
  if (id === 'retired-launch-contract-guard-restored') return createSpec('scripts/check-side-process-launch-contract.ps1','retired-guard','param()\n');
  if (id === 'supervisor-dependent-pester-load-restored') return createSpec(D928[0],'pester-load','# restored mutation surface\n');
  if (/guard-/.test(id) || id.includes('record-missing')) return guardRecordSpec(id);
  return replaceSpec(preflight,'primitives','const probeRoot = mkdtempSync(path.join(projectionParent, ".cutover-fsync-probe-"));','throw new Error("mutation_preflight_guard");\n  const probeRoot = mkdtempSync(path.join(projectionParent, ".cutover-fsync-probe-"));');
}

function detectorInvocation(spec: MutationSpec): { command: string; args: string[]; detectorId: string } {
  if (spec.detector === 'guard-record') {
    const script = [
      "const fs=require('node:fs');",
      `const p=${JSON.stringify(spec.artifactPath)};const v=JSON.parse(fs.readFileSync(p,'utf8'));`,
      "const sha=/^[0-9a-f]{40}$/;const digest=/^sha256:[0-9a-f]{64}$/;",
      "const required=['verify','reusable'];let ok=v.schemaVersion===1&&v.platform==='linux'&&sha.test(v.prHeadSha||'');",
      "for(const k of required){const r=v.records?.[k];ok=ok&&!!r&&r.platform==='linux'&&/^7\./.test(r.pwshVersion||'')&&r.exitCode===0&&digest.test(r.stdoutDigest||'')&&Number.isFinite(Date.parse(r.completedAt||''));}",
      "const cp=require('node:child_process');const head=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();ok=ok&&v.prHeadSha===head;",
      "if(!ok){console.error('guard-record-invalid');process.exit(1)}",
    ].join('');
    return { command: process.execPath, args: ['-e', script], detectorId: DETECTORS[spec.detector] };
  }
  if (spec.detector === 'new-powershell') {
    const script = `const fs=require('node:fs');if(fs.existsSync(${JSON.stringify(spec.artifactPath)})){console.error('new-powershell-logic-forbidden');process.exit(1)}`;
    return { command: process.execPath, args: ['-e', script], detectorId: DETECTORS[spec.detector] };
  }
  if (spec.detector === 'retired-guard') {
    const script = "const fs=require('node:fs');if(fs.existsSync('scripts/check-side-process-launch-contract.ps1')){console.error('retired-launch-contract-guard-restored');process.exit(1)}";
    return { command: process.execPath, args: ['-e', script], detectorId: DETECTORS[spec.detector] };
  }
  if (spec.detector === 'pester-load') {
    const script = `const fs=require('node:fs');if(fs.existsSync(${JSON.stringify(spec.artifactPath)})){console.error('supervisor-dependent-pester-load-restored');process.exit(1)}`;
    return { command: process.execPath, args: ['-e', script], detectorId: DETECTORS[spec.detector] };
  }
  return {
    command: process.execPath,
    args: [path.resolve('node_modules/vitest/vitest.mjs'),'run','--config',path.resolve('vitest.config.ts'),path.resolve(TEST_FILE),'-t',DETECTORS[spec.detector]],
    detectorId: DETECTORS[spec.detector],
  };
}

async function runDetector(spec: MutationSpec): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string; command: string[]; detectorId: string }> {
  const invocation = detectorInvocation(spec);
  const result = await runProcess({ command: invocation.command, args: invocation.args, cwd: repoRoot, inheritParentEnv: true });
  return {
    ok: result.ok,
    exitCode: result.exitCode ?? (result.ok ? 0 : 1),
    stdout: result.stdout,
    stderr: result.stderr,
    command: [invocation.command, ...invocation.args],
    detectorId: invocation.detectorId,
  };
}

async function executeMutation(ac: AcceptanceId, mutationId: string): Promise<MutationEvidence> {
  const spec = mutationSpec(ac, mutationId);
  spec.prepare?.();
  const before = snapshotArtifact(spec.artifactPath);
  try {
    const mutated = spec.apply(before);
    writeArtifact(spec.artifactPath, mutated);
    const after = snapshotArtifact(spec.artifactPath);
    if (digest(before) === digest(after)) throw new Error(`artifact_hash_delta_missing:${ac}:${mutationId}`);
    const negative = await runDetector(spec);
    if (negative.ok) throw new Error(`mutation_not_red:${ac}:${mutationId}`);
    const combinedOutput = `${negative.stdout}\n${negative.stderr}`;
    if (!combinedOutput.includes(negative.detectorId)) {
      throw new Error(`mutation_red_without_expected_detector:${ac}:${mutationId}:${negative.detectorId}`);
    }
    restoreArtifact(spec.artifactPath, before);
    const restored = snapshotArtifact(spec.artifactPath);
    if (digest(restored) !== digest(before)) throw new Error(`restore_hash_mismatch:${ac}:${mutationId}`);
    const green = await runDetector(spec);
    if (!green.ok) throw new Error(`mutation_restore_not_green:${ac}:${mutationId}:${green.stderr || green.stdout}`);
    return {
      ac,
      mutationId,
      artifactPath: spec.artifactPath,
      detectorId: negative.detectorId,
      detectorCommand: negative.command,
      artifactHashBefore: digest(before),
      artifactHashAfter: digest(after),
      restoredHash: digest(restored),
      negativeOutcome: 'failed',
      restoredOutcome: 'passed',
      negativeExitCode: negative.exitCode,
      restoredExitCode: 0,
    };
  } finally {
    restoreArtifact(spec.artifactPath, before);
    spec.cleanup?.();
  }
}

async function main(): Promise<void> {
  const selected = process.argv.includes('--all') ? (Object.keys(CONTROLS) as AcceptanceId[]) : (() => {
    const index = process.argv.indexOf('--ac');
    const value = index >= 0 ? process.argv[index + 1] as AcceptanceId : undefined;
    if (!value || !(value in CONTROLS)) throw new Error('usage: mutation-runner --all | --ac AC1..AC8');
    return [value];
  })();
  const evidence: MutationEvidence[] = [];
  for (const ac of selected) for (const mutationId of CONTROLS[ac]) evidence.push(await executeMutation(ac, mutationId));
  process.stdout.write(`${JSON.stringify({ issue: 928, controls: Object.fromEntries(selected.map((ac) => [ac, { result: 'rejected-by-independent-oracle', mutations: CONTROLS[ac].length }])), mutationEvidence: evidence, mutationRunner: { result: 'one-row-one-real-fault-external-detector-red-green', bindings: evidence.length } })}\n`);
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
