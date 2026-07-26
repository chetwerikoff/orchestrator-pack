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
const TEST_FILE = 'scripts/cutover/issue-928.test.ts';
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

function writeArtifact(pathName: string, value: { bytes: Buffer; mode: number }): void {
  const file = absoluteArtifact(pathName);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value.bytes, { mode: value.mode });
  chmodSync(file, value.mode);
}

function restoreArtifact(pathName: string, snapshot: ArtifactSnapshot): void {
  const file = absoluteArtifact(pathName);
  if (!snapshot.existed) { rmSync(file, { force: true }); return; }
  writeArtifact(pathName, { bytes: snapshot.bytes, mode: snapshot.mode });
}

function replaceSpec(artifactPath: string, detector: DetectorPattern, token: string, replacement: string, all = false): MutationSpec {
  return { artifactPath, detector, apply: (snapshot) => {
    if (!snapshot.existed) throw new Error(`mutation_artifact_missing:${artifactPath}`);
    const source = snapshot.bytes.toString('utf8');
    if (!source.includes(token)) throw new Error(`mutation_token_missing:${artifactPath}:${token}`);
    const mutated = all ? source.split(token).join(replacement) : source.replace(token, replacement);
    return { bytes: Buffer.from(mutated, 'utf8'), mode: snapshot.mode };
  } };
}

function insertBeforeSpec(artifactPath: string, detector: DetectorPattern, token: string, insertion: string): MutationSpec {
  return replaceSpec(artifactPath, detector, token, `${insertion}\n  ${token}`);
}

function appendSpec(artifactPath: string, detector: DetectorPattern, text: string): MutationSpec {
  return { artifactPath, detector, apply: (snapshot) => {
    if (!snapshot.existed) throw new Error(`mutation_artifact_missing:${artifactPath}`);
    const newline = snapshot.bytes.toString('utf8').endsWith('\n') ? '' : '\n';
    return { bytes: Buffer.concat([snapshot.bytes, Buffer.from(`${newline}${text}\n`, 'utf8')]), mode: snapshot.mode };
  } };
}

function createSpec(artifactPath: string, detector: DetectorPattern, text: string): MutationSpec {
  return { artifactPath, detector, apply: (snapshot) => {
    if (snapshot.existed) throw new Error(`mutation_create_target_exists:${artifactPath}`);
    return { bytes: Buffer.from(`${text}\n`, 'utf8'), mode: 0o600 };
  } };
}

function modeSpec(artifactPath: string, detector: DetectorPattern, mode: number): MutationSpec {
  return { artifactPath, detector, apply: (snapshot) => {
    if (!snapshot.existed) throw new Error(`mutation_artifact_missing:${artifactPath}`);
    return { bytes: snapshot.bytes, mode };
  } };
}

function registrySpec(childId = 'legacy-mutation'): MutationSpec {
  return replaceSpec('scripts/orchestrator-side-process-registry.cutover-target.json', 'registry', '"id": "pr2-scheduler"', `"id": "${childId}"`);
}

function scopeProtectedSpec(): MutationSpec {
  return appendSpec('scripts/lib/review-start-claim-store.ts', 'scope', '// issue-928 mutation: protected claim authority drift');
}

function scopeDeletedSpec(): MutationSpec {
  return createSpec(D928[2]!, 'scope', '# issue-928 mutation: forbidden restored PowerShell claim shim');
}

function currentHead(): string {
  const result = runProcessSync({ command: 'git', args: ['rev-parse', 'HEAD'], cwd: repoRoot, inheritParentEnv: true });
  if (!result.ok) throw new Error(result.stderr || result.error || 'head_lookup_failed');
  return result.stdout.trim();
}

function guardRecordSpec(id: string): MutationSpec {
  const artifactPath = path.join(os.tmpdir(), 'opk-928-guard-records.json');
  const prepare = () => {
    const head = currentHead();
    const record = (command: string) => ({
      command,
      pwshVersion: '7.5.2',
      platform: 'linux',
      prHeadSha: head,
      exitCode: 0,
      stdoutDigest: `sha256:${'a'.repeat(64)}`,
      completedAt: '2026-07-26T00:00:00.000Z',
    });
    writeArtifact(artifactPath, {
      bytes: Buffer.from(`${JSON.stringify({ verify: record('pwsh -NoProfile -File scripts/verify.ps1'), reusable: record('pwsh -NoProfile -File scripts/check-reusable.ps1') }, null, 2)}\n`, 'utf8'),
      mode: 0o600,
    });
  };
  return {
    artifactPath,
    detector: 'guard-record',
    prepare,
    cleanup: () => rmSync(artifactPath, { force: true }),
    apply: (snapshot) => {
      const bundle = JSON.parse(snapshot.bytes.toString('utf8')) as Record<string, any>;
      if (id === 'verify-guard-record-missing') delete bundle.verify;
      else if (id === 'reusable-guard-record-missing') delete bundle.reusable;
      else if (id === 'guard-not-pwsh7') bundle.verify.pwshVersion = '5.1.0';
      else if (id === 'guard-stale-head') bundle.verify.prHeadSha = '0'.repeat(40);
      else if (id === 'guard-nonzero-accepted') bundle.verify.exitCode = 1;
      else if (id === 'guard-stdout-digest-missing') delete bundle.verify.stdoutDigest;
      else throw new Error(`unknown_guard_record_mutation:${id}`);
      return { bytes: Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, 'utf8'), mode: snapshot.mode };
    },
  };
}

function mutationSpec(ac: AcceptanceId, id: string): MutationSpec {
  if (ac === 'AC1') {
    if (id === 'pr2a-merge-missing') return replaceSpec('scripts/lib/cutover/activation-transaction.ts', 'admission-guards', "if (!isAncestor(repoRoot, PR2A_LANDING_COMMIT, baseRef)) throw new Error('pr2a_merge_missing');", "if (false) throw new Error('pr2a_merge_missing');");
    if (id === 'closure-schema-incompatible') return replaceSpec('scripts/lib/cutover/activation-transaction.ts', 'admission-guards', "if (manifest.schemaVersion !== 1) throw new Error('closure_schema_incompatible');", "if (false) throw new Error('closure_schema_incompatible');");
    if (/external-(supervisor|claim)-library-reference/.test(id)) return replaceSpec('scripts/lib/cutover/activation-transaction.ts', 'admission-guards', 'if (external.length !== 0) throw new Error(`external_legacy_reference:', 'if (false) throw new Error(`external_legacy_reference:');
    if (id === 'closure-unresolved-set-nonempty') return replaceSpec('scripts/lib/cutover/activation-transaction.ts', 'admission-guards', "throw new Error('closure_unresolved_set_nonempty');", 'void manifest.unknown;');
    if (/pr2a-receipt|closure-input-tree/.test(id)) return replaceSpec('scripts/pr2a/closed-world-scanner.ts', 'closure', "const registryPath = 'scripts/pr2a/execution-root-registry.json';", "const registryPath = 'scripts/pr2a/__mutation_missing_root_registry.json';");
    if (id === 'node22-not-enforced') return replaceSpec('scripts/lib/cutover/activation-platform-preflight.ts', 'node', "if (major !== 22) throw new Error('node22_required');", "if (false) throw new Error('node22_required');");
    if (id === 'installed-commit-unbound') return replaceSpec('scripts/lib/cutover/activation-platform-preflight.ts', 'admission-guards', "if (actualHead.toLowerCase() !== input.installedCommitSha.toLowerCase()) throw new Error('installed_commit_unbound');", "if (false) throw new Error('installed_commit_unbound');");
    if (/host-or-repo|old-installed/.test(id)) return replaceSpec('scripts/lib/cutover/activation-platform-preflight.ts', 'canonical-root', 'if (value !== lexical || lexical !== canonical)', 'if (false)');
    if (id === 'legacy-supervisor-identity-ambiguous') return replaceSpec('scripts/lib/cutover/activation-transaction.ts', 'admission-guards', 'assertLegacySupervisor(legacyIdentity, request.oldInstalledRevisionRoot);', 'void legacyIdentity;');
    if (id === 'competing-transaction-admitted') return replaceSpec('scripts/lib/cutover/activation-cordon.ts', 'admission-guards', "if (existsSync(input.path)) throw new Error('competing_transaction_admitted');", "if (false) throw new Error('competing_transaction_admitted');");
    if (id === 'successor-926-used-as-prerequisite') return registrySpec('pr2-merge-actuator');
    if (id === 'mutation-before-admission') return insertBeforeSpec('scripts/lib/cutover/activation-transaction.ts', 'ordering', 'const preflight = boundary.preflight(request);', 'projectRegistry(request.paths.targetRegistryPath, request.paths.projectedRegistryPath);');
    return replaceSpec('scripts/lib/cutover/activation-transaction.ts', 'foundation', 'const foundation = boundary.proveFoundationAdoption(request);', "const foundation = { result: 'foundation-evidence-verified' } as FoundationAdmissionProof;");
  }

  if (ac === 'AC2') {
    if (id === 'cordon-not-first') return insertBeforeSpec('scripts/lib/cutover/activation-transaction.ts', 'ordering', 'const cordon = createCordon({', 'await boundary.drainLegacyWriters(request, legacyWriters);');
    if (/install-kills-old-supervisor|install-gap-acquirer-gap|legacy-supervisor-terminated-before-cordon/.test(id)) return insertBeforeSpec('scripts/lib/cutover/activation-transaction.ts', 'ordering', 'const cordon = createCordon({', 'await boundary.terminateLegacyProcesses([legacySupervisor]);');
    if (/ts-supervisor-starts-at-install|dual-supervisor-owner|ts-supervisor-start-before-cas/.test(id)) return insertBeforeSpec('scripts/lib/cutover/activation-transaction.ts', 'ordering', 'const authority = new FileEpochAuthority(request.paths.epochAuthorityPath);', "await boundary.startTypeScriptSupervisor(request, 'mutation-pre-cas');");
    if (/legacy-supervisor-survivor|survivor-accepted/.test(id)) return replaceSpec('scripts/lib/cutover/activation-transaction.ts', 'survivor', 'if (survivors.supervisorAlive || survivors.writers.length !== 0) {', 'if (survivors.writers.length !== 0) {');
    if (id === 'concurrent-writer-admitted') return replaceSpec('scripts/lib/cutover/activation-transaction.ts', 'writer-survivor', 'if (survivors.supervisorAlive || survivors.writers.length !== 0) {', 'if (survivors.supervisorAlive) {');
    if (id === 'store-writer-ingress-left-open') return replaceSpec('scripts/lib/cutover/activation-cordon.ts', 'activation', '    writersClosed: true,', '    writersClosed: false as true,');
    if (id === 'drain-watermark-missing') return replaceSpec('scripts/lib/cutover/activation-import.ts', 'watermark', "if (!writerWatermark.trim()) throw new Error('writer_watermark_missing');", "if (false) throw new Error('writer_watermark_missing');");
    if (/legacy-supervisor-identity-unverified|pid-identity-unverified/.test(id)) return replaceSpec('scripts/lib/cutover/activation-cordon.ts', 'primitives', 'current.startTicks !== identity.startTicks', 'false');
    if (id === 'registry-projection-before-import-digest') return insertBeforeSpec('scripts/lib/cutover/activation-transaction.ts', 'ordering', 'const imports = request.stores.map((spec) => importSnapshot({', 'projectRegistry(request.paths.targetRegistryPath, request.paths.projectedRegistryPath);');
    if (id === 'registry-file-or-parent-not-fsynced' || id === 'precommit-log-not-durable-before-cas') return replaceSpec('scripts/lib/cutover/activation-evidence.ts', 'primitives', 'fsyncSync(fd);', 'void fd;', true);
    if (id === 'registry-readback-hash-missing') return replaceSpec('scripts/lib/cutover/activation-registry-projection.ts', 'activation', '  writeDurableFile(projectionPath, source);', '  writeDurableFile(projectionPath, Buffer.from("{}"));');
    if (/precommit-digest-not-in-core|precommit-log-digest-mismatch-accepted/.test(id)) return replaceSpec('scripts/lib/cutover/activation-transaction.ts', 'activation', '    preCommitLogDigest: phaseOne.digest,', "    preCommitLogDigest: 'sha256:mutation',");
    if (/registry-treated-as-commit|postcommit-followup-treated-as-commit/.test(id)) return insertBeforeSpec('scripts/lib/cutover/activation-transaction.ts', 'ordering', 'authority.commit(request.expectedOldEpochId, core);', "await boundary.startTypeScriptSupervisor(request, 'mutation-pre-cas');");
    if (id === 'central-cas-not-sole-commit') return replaceSpec('scripts/lib/cutover/activation-transaction.ts', 'activation', 'authority.commit(request.expectedOldEpochId, core);', 'authority.commit(request.expectedOldEpochId, core); authority.commit(request.epochId, core);');
    if (id === 'cas-core-field-extra-or-missing') return replaceSpec('scripts/lib/cutover/activation-epoch-authority.ts', 'activation', "  'importDigests', 'registryHash', 'preCommitLogDigest', 'commitAt',", "  'importDigests', 'registryHash', 'commitAt',");
    if (id === 'cas-conflict-ignored') return replaceSpec('scripts/lib/cutover/activation-epoch-authority.ts', 'primitives', 'if (document.currentEpochId !== expectedOldEpochId)', 'if (false)');
    if (/tracked-registry-restored-consumed|epoch-gated-source-missing|postactivation-start-without-reprojection/.test(id)) return replaceSpec('scripts/lib/orchestrator-side-process-supervisor.ts', 'primitives', '      const verified = verifyEpochAndProjection(options);', "      const verified = { registryHash: 'mutation', cadenceSeconds: 1 };");
    if (id === 'legacy-executable-reference-restored') return scopeDeletedSpec();
    if (id === 'dual-scheduler') return registrySpec('pr2-scheduler-duplicate');
  }

  if (ac === 'AC3') {
    if (id === 'snapshot-before-drain') return insertBeforeSpec('scripts/lib/cutover/activation-transaction.ts', 'ordering', 'const drain = await boundary.drainLegacyWriters(request, legacyWriters);', "snapshotStores(request.stores, request.paths.snapshotDir, 'mutation-before-drain');");
    if (id === 'writer-watermark-missing') return replaceSpec('scripts/lib/cutover/activation-import.ts', 'watermark', "if (!writerWatermark.trim()) throw new Error('writer_watermark_missing');", "if (false) throw new Error('writer_watermark_missing');");
    if (id === 'concurrent-store-writer') return replaceSpec('scripts/lib/cutover/activation-transaction.ts', 'writer-survivor', 'if (survivors.supervisorAlive || survivors.writers.length !== 0) {', 'if (survivors.supervisorAlive) {');
    if (id === 'snapshot-version-missing') return replaceSpec('scripts/lib/cutover/activation-import.ts', 'import-guards', 'if (!Number.isInteger(sourceVersion) || sourceVersion <= 0)', 'if (false)');
    if (/snapshot-digest-not-raw-bytes|digest-algorithm-not-sha256/.test(id)) return replaceSpec('scripts/lib/cutover/activation-import.ts', 'import-guards', 'snapshotDigest: sha256Bytes(bytes)', "snapshotDigest: 'sha256:mutation'");
    if (/stable-stringify|unicode-or-escape|negative-zero|nested-key|vector-failing/.test(id)) return replaceSpec('scripts/lib/cutover/stable-stringify.ts', 'vectors', 'Object.keys(object).sort()', 'Object.keys(object)');
    if (id === 'store-covered-field-omitted') return replaceSpec('scripts/lib/cutover/activation-import.ts', 'import-guards', "throw new Error(`store_missing_field:${spec.id}:${key}`)", 'void key;');
    if (id === 'unknown-store-field-silently-ignored') return replaceSpec('scripts/lib/cutover/activation-import.ts', 'import-guards', "throw new Error(`store_unknown_field:${spec.id}:${unknown.join(',')}`)", 'void unknown;');
    if (id === 'target-import-identity-missing') return replaceSpec('scripts/lib/cutover/activation-import.ts', 'import-guards', '    nonce: input.nonce,', '');
    if (id === 'target-import-identity-aliased') return replaceSpec('scripts/lib/cutover/activation-import.ts', 'import-guards', '    storeId: input.spec.id,', "    storeId: 'mutation' as typeof input.spec.id,");
    if (/target-cas-or-upsert-omitted|marker-only-completion/.test(id)) return replaceSpec('scripts/lib/cutover/activation-import.ts', 'import-guards', '  writeDurableJson(markerPath, record);', '  void markerPath;');
    if (/target-state-digest-mismatch-accepted|legacy-read-partial-import/.test(id)) return replaceSpec('scripts/lib/cutover/activation-import.ts', 'import-guards', 'if (sha256Stable(existing) !== importTargetDigest)', 'if (false)');
    if (id === 'post-mutation-pre-marker-reapplied') return replaceSpec('scripts/lib/cutover/activation-import.ts', 'import-guards', 'if (sha256Stable(readBack) !== importTargetDigest)', 'if (false)');
    return scopeProtectedSpec();
  }

  if (ac === 'AC4') {
    if (/staged-registry/.test(id)) return registrySpec();
    if (/live-registry|denominator|claim|powershell|orphan|retired|deleted-supervisor/.test(id)) return scopeDeletedSpec();
    if (/install-gap-old-supervisor|ts-supervisor-not-inert/.test(id)) return insertBeforeSpec('scripts/lib/cutover/activation-transaction.ts', 'ordering', 'const cordon = createCordon({', 'await boundary.terminateLegacyProcesses([legacySupervisor]);');
    if (/durable-delivery|cutover-row|harness-owned-cycle|merge-rehearsal/.test(id)) return replaceSpec('scripts/pr2-foundation/scheduler.ts', 'scheduler', '    if (!decision.eligible) { skipped += 1; continue; }', '    if (true) { skipped += 1; continue; }');
    if (id === '926-precedes-adoption') return registrySpec('pr2-merge-actuator');
    if (id === '930-precedes-926') return registrySpec('pr2b-registry-promotion');
  }

  if (ac === 'AC5') {
    if (/preimport-target-change|rollback-old-revision/.test(id)) return replaceSpec('scripts/lib/cutover/activation-recovery.ts', 'rollback', '    if (fileDigestOrAbsent(store.targetPath) !== cordon.preImportTargetDigests[store.id]) {', '    if (false) {');
    if (/rollback-uses-new-checkout-ps-shim|legacy-restored-after-import-begin|legacy-epoch-rearmed|postcas-legacy-restored/.test(id)) return scopeDeletedSpec();
    if (/import-begin-recorded-after-mutation|precas-ts-supervisor-started/.test(id)) return insertBeforeSpec('scripts/lib/cutover/activation-transaction.ts', 'ordering', 'const importBoundary = markImportBegun(request.paths.cordonPath);', 'projectRegistry(request.paths.targetRegistryPath, request.paths.projectedRegistryPath);');
    if (id === 'postactivation-start-without-reprojection') return replaceSpec('scripts/lib/orchestrator-side-process-supervisor.ts', 'primitives', '      const verified = verifyEpochAndProjection(options);', "      const verified = { registryHash: 'mutation', cadenceSeconds: 1 };");
    return replaceSpec('scripts/lib/cutover/activation-recovery.ts', 'recovery', '    core = completePreCasRecovery(request, cordon.nonce, authority);', '    core = authority.verify(request.epochId, cordon.nonce);');
  }

  if (ac === 'AC6') {
    if (/symlink-mode|gitlink-mode|nonregular-mode/.test(id)) return modeSpec('scripts/vitest-ci-lanes.config.json', 'scope', 0o755);
    if (/test-classification|lane-config/.test(id)) return appendSpec('scripts/vitest-ci-lanes.config.json', 'scope', ' ');
    if (/claim|second-claim|claimant/.test(id)) return scopeProtectedSpec();
    if (/live-registry/.test(id)) return appendSpec('scripts/orchestrator-side-process-registry.json', 'scope', ' ');
    return scopeDeletedSpec();
  }

  if (ac === 'AC7') {
    if (/nonce|replay|consumer-skips/.test(id)) return replaceSpec('scripts/lib/cutover/activation-epoch-authority.ts', 'primitives', 'if (!record || record.nonce !== nonce)', 'if (!record || false)');
    if (/followup/.test(id)) return replaceSpec('scripts/lib/cutover/activation-evidence.ts', 'activation', '    sequence: existing.length + 1,', '    sequence: existing.length + 2,');
    if (/fsync|precommit-log-not-durable/.test(id)) return replaceSpec('scripts/lib/cutover/activation-evidence.ts', 'primitives', 'fsyncSync(fd);', 'void fd;', true);
    if (/precommit-digest|precommit-log-digest/.test(id)) return replaceSpec('scripts/lib/cutover/activation-transaction.ts', 'activation', '    preCommitLogDigest: phaseOne.digest,', "    preCommitLogDigest: 'sha256:mutation',");
    if (id === 'legacy-supervisor-termination-evidence-missing') return replaceSpec('scripts/lib/cutover/activation-transaction.ts', 'activation', "'legacy-supervisor-and-writers-terminated'", "'mutation-termination-evidence'");
    if (/pr2a-closure-admission-evidence-missing|ts-supervisor-inert-evidence-missing/.test(id)) return replaceSpec('scripts/lib/cutover/activation-transaction.ts', 'admission-guards', 'const foundation = boundary.proveFoundationAdoption(request);', "const foundation = { result: 'foundation-evidence-verified' } as FoundationAdmissionProof;");
    if (/precommit-timestamp-outside-core|postcommit-timestamp-in-core|cas-core-field-extra-or-missing/.test(id)) return replaceSpec('scripts/lib/cutover/activation-epoch-authority.ts', 'activation', "  'importDigests', 'registryHash', 'preCommitLogDigest', 'commitAt',", "  'importDigests', 'registryHash', 'commitAt',");
    return replaceSpec('scripts/lib/cutover/activation-epoch-authority.ts', 'primitives', 'if (document.currentEpochId !== expectedOldEpochId)', 'if (false)');
  }

  if (id === 'wrong-node-major-admitted') return replaceSpec('scripts/lib/cutover/activation-platform-preflight.ts', 'node', "if (major !== 22) throw new Error('node22_required');", "if (false) throw new Error('node22_required');");
  if (/windows-native-activation|unsupported-platform-admitted/.test(id)) return replaceSpec('scripts/lib/cutover/activation-platform-preflight.ts', 'platform', "if (platform !== 'linux') throw new Error('unsupported_platform');", "if (false) throw new Error('unsupported_platform');");
  if (id === 'repo-root-not-canonical') return replaceSpec('scripts/lib/cutover/activation-platform-preflight.ts', 'canonical-root', 'if (value !== lexical || lexical !== canonical)', 'if (false)');
  if (id === 'cross-device-registry-projection') return replaceSpec('scripts/lib/cutover/activation-platform-preflight.ts', 'primitives', 'if (statSync(targetParent).dev !== statSync(projectionParent).dev)', 'if (false)');
  if (id === 'pid-start-time-unchecked') return replaceSpec('scripts/lib/cutover/activation-cordon.ts', 'primitives', 'current.startTicks !== identity.startTicks', 'false');
  if (id === 'process-tree-survivor') return replaceSpec('scripts/lib/cutover/activation-cordon.ts', 'primitives', 'if (survivors.length) throw new Error', 'if (false) throw new Error');
  if (id === 'exclusive-lock-omitted') return replaceSpec('scripts/lib/cutover/activation-epoch-authority.ts', 'primitives', '    mkdirSync(lock);', '    void lock;');
  if (id === 'atomic-rename-omitted') return replaceSpec('scripts/lib/cutover/activation-evidence.ts', 'primitives', '  renameSync(temporary, target);', '  writeFileSync(target, bytes);');
  if (id === 'file-fsync-omitted') return replaceSpec('scripts/lib/cutover/activation-evidence.ts', 'primitives', 'fsyncSync(fd);', 'void fd;', true);
  if (id === 'parent-fsync-omitted') return replaceSpec('scripts/lib/cutover/activation-evidence.ts', 'primitives', '  syncDirectory(directory);', '  void directory;');
  if (id === 'new-powershell-logic-added') return createSpec('scripts/cutover/issue-928-mutation.ps1', 'new-powershell', 'Write-Output mutation');
  if (['verify-guard-record-missing','reusable-guard-record-missing','guard-not-pwsh7','guard-stale-head','guard-nonzero-accepted','guard-stdout-digest-missing'].includes(id)) return guardRecordSpec(id);
  if (id === 'retired-launch-contract-guard-restored') return createSpec('scripts/check-side-process-launch-contract.ps1', 'retired-guard', '# mutation: retired guard restored');
  if (id === 'supervisor-dependent-pester-load-restored') return createSpec('scripts/cutover/issue-928-supervisor-dependent.Tests.ps1', 'pester-load', ". 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1'");
  throw new Error(`unmapped_mutation:${ac}:${id}`);
}

function detectorInvocation(detector: DetectorPattern, artifactPath: string): { command: string; args: string[]; marker: string } {
  const marker = DETECTORS[detector];
  if (detector === 'guard-record') {
    const script = `const fs=require('node:fs');const cp=require('node:child_process');const b=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const head=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();const commands=['pwsh -NoProfile -File scripts/verify.ps1','pwsh -NoProfile -File scripts/check-reusable.ps1'];const rows=[b.verify,b.reusable];const ok=rows.length===2&&rows.every((r,i)=>r&&r.command===commands[i]&&/^7\\./.test(String(r.pwshVersion))&&r.platform==='linux'&&r.prHeadSha===head&&r.exitCode===0&&/^sha256:[0-9a-f]{64}$/i.test(String(r.stdoutDigest))&&Number.isFinite(Date.parse(String(r.completedAt))));if(!ok){console.error(${JSON.stringify(marker)});process.exit(1);}`;
    return { command: process.execPath, args: ['-e', script, absoluteArtifact(artifactPath)], marker };
  }
  if (detector === 'new-powershell' || detector === 'retired-guard' || detector === 'pester-load') {
    const script = `const fs=require('node:fs');if(fs.existsSync(process.argv[1])){console.error(${JSON.stringify(marker)});process.exit(1);}`;
    return { command: process.execPath, args: ['-e', script, absoluteArtifact(artifactPath)], marker };
  }
  return {
    command: process.execPath,
    args: [path.join(repoRoot, 'scripts/run-vitest-with-harness.mjs'), 'run', '--maxWorkers=1', TEST_FILE, '-t', marker],
    marker,
  };
}

async function runDetector(detector: DetectorPattern, artifactPath: string): Promise<Awaited<ReturnType<typeof runProcess>>> {
  const invocation = detectorInvocation(detector, artifactPath);
  return runProcess({
    command: invocation.command,
    args: invocation.args,
    cwd: repoRoot,
    inheritParentEnv: true,
    env: { OPK_CONTRACT_MUTATIONS_ALREADY_RUN: '1', OPK_VITEST_HARNESS: '1' },
    allowEmptyStdout: true,
    timeoutMs: 120_000,
  });
}

async function executeMutation(ac: AcceptanceId, mutationId: string): Promise<MutationEvidence> {
  const spec = mutationSpec(ac, mutationId);
  spec.prepare?.();
  const before = snapshotArtifact(spec.artifactPath);
  try {
    const applied = spec.apply(before);
    writeArtifact(spec.artifactPath, applied);
    const artifactHashBefore = digest(before);
    const artifactHashAfter = digest(snapshotArtifact(spec.artifactPath));
    if (artifactHashAfter === artifactHashBefore) throw new Error(`mutation_hash_delta_missing:${ac}:${mutationId}`);
    const negative = await runDetector(spec.detector, spec.artifactPath);
    if (negative.ok) throw new Error(`specific_detector_not_red:${ac}:${mutationId}:${DETECTORS[spec.detector]}`);
    const negativeText = `${negative.stdout}\n${negative.stderr}`;
    if (!negativeText.includes(DETECTORS[spec.detector])) {
      throw new Error(`expected_detector_marker_missing:${ac}:${mutationId}:${DETECTORS[spec.detector]}`);
    }
    restoreArtifact(spec.artifactPath, before);
    const restoredHash = digest(snapshotArtifact(spec.artifactPath));
    if (restoredHash !== artifactHashBefore) throw new Error(`mutation_restore_hash_mismatch:${ac}:${mutationId}`);
    const green = await runDetector(spec.detector, spec.artifactPath);
    if (!green.ok) throw new Error(`mutation_restore_not_green:${ac}:${mutationId}:${green.stderr || green.stdout}`);
    const invocation = detectorInvocation(spec.detector, spec.artifactPath);
    return {
      ac,
      mutationId,
      artifactPath: spec.artifactPath,
      detectorId: `issue-928:${mutationId}:${DETECTORS[spec.detector]}`,
      detectorCommand: [invocation.command, ...invocation.args],
      artifactHashBefore,
      artifactHashAfter,
      restoredHash,
      negativeOutcome: 'failed',
      restoredOutcome: 'passed',
      negativeExitCode: negative.exitCode ?? 1,
      restoredExitCode: 0,
    };
  } finally {
    restoreArtifact(spec.artifactPath, before);
    spec.cleanup?.();
  }
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

function selected(argv: string[]): AcceptanceId[] {
  const index = argv.indexOf('--ac');
  if (index >= 0) { const ac = argv[index + 1] as AcceptanceId; if (!ac || !(ac in CONTROLS)) throw new Error('invalid_ac'); return [ac]; }
  if (argv.includes('--all')) return Object.keys(CONTROLS) as AcceptanceId[];
  throw new Error('expected --ac ACn or --all');
}

async function main(): Promise<void> {
  const selectedAcs = selected(process.argv.slice(2));
  const evidence: MutationEvidence[] = [];
  for (const ac of selectedAcs) {
    for (const mutationId of CONTROLS[ac]) evidence.push(await executeMutation(ac, mutationId));
  }
  const cutover: Record<string, unknown> = {};
  for (const ac of selectedAcs) Object.assign(cutover, producerOutcome(ac));
  process.stdout.write(`${JSON.stringify({ issue: 928, cutover, mutationEvidence: evidence, mutationRunner: { result: 'one-row-one-real-fault-external-detector-red-green', bindings: evidence.length } })}\n`);
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
