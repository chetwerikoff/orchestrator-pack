import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';
import { stableStringify } from '../lib/cutover/stable-stringify.ts';
import { D928 } from '../pr2a/contracts.ts';

const repoRoot = path.resolve(process.cwd());
const P = {
  tx: 'scripts/lib/cutover/activation-transaction.ts',
  cordon: 'scripts/lib/cutover/activation-cordon.ts',
  importFile: 'scripts/lib/cutover/activation-import.ts',
  epoch: 'scripts/lib/cutover/activation-epoch-authority.ts',
  evidence: 'scripts/lib/cutover/activation-evidence.ts',
  recovery: 'scripts/lib/cutover/activation-recovery.ts',
  preflight: 'scripts/lib/cutover/activation-platform-preflight.ts',
  registryProjection: 'scripts/lib/cutover/activation-registry-projection.ts',
  supervisor: 'scripts/lib/orchestrator-side-process-supervisor.ts',
  stable: 'scripts/lib/cutover/stable-stringify.ts',
  vectors: 'scripts/fixtures/cutover/stable-stringify-vectors.json',
  targetRegistry: 'scripts/orchestrator-side-process-registry.cutover-target.json',
  liveRegistry: 'scripts/orchestrator-side-process-registry.json',
  claimStore: 'scripts/lib/review-start-claim-store.ts',
  claimCli: 'scripts/lib/review-start-claim-cli.ts',
  claimReaper: 'scripts/lib/review-start-claim-cli.ts',
  packRunner: 'scripts/pack-review-runner.ts',
  wakeSupervisor: 'scripts/orchestrator-wake-supervisor.ts',
  planningTest: 'scripts/pr2a/planning.test.ts',
  laneConfig: 'scripts/vitest-ci-lanes.config.json',
  denominatorJs: 'scripts/reaction-config-messages.mjs',
} as const;

const ISSUE_928_ORACLE_GROUPS: Record<string, readonly string[]> = {
  'foundation-proof':['AC1:operator-ack-only'],
  'pr2a-merge-guard':['AC1:pr2a-merge-missing'],
  'closure-recompute-call':['AC1:pr2a-receipt-trusted-without-recompute'],
  'closure-schema-guard':['AC1:closure-schema-incompatible'],
  'closure-target-coverage':['AC1:external-supervisor-library-reference','AC1:external-claim-library-reference'],
  'closure-unresolved-guard':['AC1:closure-unresolved-set-nonempty'],
  'closure-tree-binding':['AC1:closure-input-tree-unbound'],
  'fleet-roster-guards':['AC1:fleet-member-omitted','AC1:stale-member-accepted','AC1:rejoining-member-unquarantined','AC1:diverged-revision-accepted','AC1:second-control-plane-host','AC1:host-or-repo-unbound'],
  'preflight-bindings':['AC1:installed-commit-unbound','AC1:old-installed-revision-missing'],
  'process-identity-guards':['AC1:legacy-supervisor-identity-ambiguous','AC2:legacy-supervisor-identity-unverified','AC2:pid-identity-unverified','AC8:pid-start-time-unchecked','AC8:process-tree-survivor'],
  'node22-guard':['AC1:node22-not-enforced','AC8:wrong-node-major-admitted'],
  'cordon-admission-guard':['AC1:competing-transaction-admitted'],
  'no-successor-prerequisite':['AC1:successor-926-used-as-prerequisite','AC4:926-precedes-adoption','AC4:930-precedes-926'],
  'tx-admission-order':['AC1:mutation-before-admission'],
  'tx-cordon-first-order':['AC2:install-kills-old-supervisor','AC2:install-gap-acquirer-gap','AC2:cordon-not-first','AC2:legacy-supervisor-terminated-before-cordon'],
  'tx-cas-before-start':['AC2:ts-supervisor-starts-at-install','AC2:dual-supervisor-owner','AC2:ts-supervisor-start-before-cas'],
  'tx-survivor-guard':['AC2:legacy-supervisor-survivor','AC2:concurrent-writer-admitted','AC2:survivor-accepted','AC3:concurrent-store-writer'],
  'cordon-flags':['AC2:store-writer-ingress-left-open'],
  'writer-watermark':['AC2:drain-watermark-missing','AC3:writer-watermark-missing'],
  'tx-import-before-projection':['AC2:registry-projection-before-import-digest'],
  'durability-primitives':['AC2:registry-file-or-parent-not-fsynced','AC8:atomic-rename-omitted','AC8:file-fsync-omitted','AC8:parent-fsync-omitted'],
  'registry-projection-guards':['AC2:registry-readback-hash-missing'],
  'tx-phase1-before-cas':['AC2:precommit-log-not-durable-before-cas','AC7:precommit-log-not-durable-before-cas'],
  'epoch-core-guards':['AC2:precommit-digest-not-in-core','AC2:cas-core-field-extra-or-missing','AC7:cas-core-field-extra-or-missing','AC7:precommit-digest-not-in-core','AC7:postcommit-timestamp-in-core','AC7:nonce-not-stored-centrally'],
  'phase1-digest-verify':['AC2:precommit-log-digest-mismatch-accepted','AC5:precommit-log-digest-mismatch-accepted','AC7:precommit-log-digest-mismatch-accepted'],
  'tx-cas-before-followups':['AC2:registry-treated-as-commit','AC2:postcommit-followup-treated-as-commit'],
  'tx-single-cas':['AC2:central-cas-not-sole-commit'],
  'epoch-cas-guards':['AC2:cas-conflict-ignored','AC7:second-commit-same-epoch','AC7:consumer-skips-central-nonce-equality','AC7:stale-nonce-replay','AC8:exclusive-lock-omitted'],
  'supervisor-source-guards':['AC2:tracked-registry-restored-consumed','AC2:epoch-gated-source-missing','AC2:postactivation-start-without-reprojection','AC5:postactivation-start-without-reprojection'],
  'no-legacy-executable':['AC2:legacy-executable-reference-restored','AC6:legacy-executable-reference-restored'],
  'registry-single-scheduler':['AC2:dual-scheduler','AC4:staged-registry-has-legacy-child'],
  'tx-drain-before-snapshot':['AC3:snapshot-before-drain'],
  'snapshot-guards':['AC3:snapshot-version-missing','AC3:snapshot-digest-not-raw-bytes','AC3:digest-algorithm-not-sha256'],
  'stable-stringify-guards':['AC3:stable-stringify-key-order-wrong','AC3:stable-stringify-whitespace-present'],
  'canonical-vectors':['AC3:unicode-or-escape-vector-mismatch','AC3:negative-zero-or-exponent-vector-mismatch','AC3:nested-key-order-vector-mismatch','AC3:vector-failing-payload-accepted'],
  'import-shape-guards':['AC3:store-covered-field-omitted','AC3:unknown-store-field-silently-ignored'],
  'import-identity-guards':['AC3:target-import-identity-missing','AC3:target-import-identity-aliased'],
  'import-marker-guards':['AC3:target-cas-or-upsert-omitted','AC3:marker-only-completion'],
  'import-digest-guards':['AC3:target-state-digest-mismatch-accepted','AC3:post-mutation-pre-marker-reapplied','AC3:legacy-read-partial-import'],
  'claim-authority-bytes':['AC3:claim-store-modified','AC3:claim-reaper-modified','AC3:four-deletion-disturbs-claim-authority','AC4:claim-authority-diff-at-merge','AC6:claim-store-modified','AC6:claim-reaper-modified','AC6:claimant-family-modified'],
  'claim-key-semantics':['AC3:claim-semantics-changed','AC3:claim-key-or-namespace-changed','AC4:claim-key-changed'],
  'no-second-claim-store':['AC3:second-claim-store-created','AC6:second-claim-store-created'],
  'claimant-ts-import':['AC3:claimant-family-not-ts-native'],
  'no-legacy-claim-path':['AC3:powershell-claim-path-resurrected','AC5:rollback-uses-new-checkout-ps-shim','AC6:powershell-claim-path-resurrected'],
  'no-overlap-reimplementation':['AC3:pr2a-overlap-proof-reimplemented'],
  'rehearsal-inert':['AC4:harness-owned-cycle','AC4:merge-rehearsal-labeled-live'],
  'staged-registry-required':['AC4:staged-registry-missing','AC6:staged-registry-omitted'],
  'live-registry-bytes':['AC4:live-registry-diff-at-merge','AC6:live-registry-modified'],
  'denominator-bytes':['AC4:denominator-file-diff-from-post948-base','AC6:denominator-compatibility-file-modified'],
  'denominator-loadable':['AC4:denominator-file-not-loadable','AC6:denominator-file-not-loadable'],
  'old-supervisor-continuity':['AC4:install-gap-old-supervisor-continuity-untested'],
  'ts-supervisor-inert':['AC4:ts-supervisor-not-inert'],
  'followup-required':['AC4:durable-delivery-missing','AC7:ts-supervisor-start-followup-missing','AC7:scheduler-enable-followup-missing','AC7:local-fsync-followup-missing'],
  'cutover-terminalized':['AC4:cutover-row-not-terminalized'],
  'ts-supervisor-replacement':['AC4:deleted-supervisor-duty-missing','AC6:supervisor-ts-replacement-missing'],
  'exact-d928-deletions':['AC4:orphan-claim-file-not-deleted','AC6:required-ps-deletion-missing','AC6:ps-file-shimmed-not-deleted','AC6:powershell-file-modified-instead-of-deleted'],
  'no-pwsh-dispatch':['AC4:powershell-shim-used-in-rehearsal','AC6:embedded-powershell-program','AC6:cutover-module-spawns-pwsh'],
  'retired-guard-absent':['AC4:retired-launch-contract-guard-restored','AC6:retired-launch-contract-guard-restored','AC8:retired-launch-contract-guard-restored'],
  'preimport-rollback-guards':['AC5:preimport-target-change-unchecked','AC5:rollback-old-revision-unbound'],
  'recovery-order-guards':['AC5:import-begin-recorded-after-mutation','AC5:precas-ts-supervisor-started'],
  'recovery-no-legacy':['AC5:legacy-restored-after-import-begin','AC5:legacy-epoch-rearmed-on-migrated-store','AC5:postcas-legacy-restored'],
  'recovery-forward-path':['AC5:postmutation-import-bytes-discarded','AC5:forward-recovery-uncordoned','AC5:registry-projection-crash-unrecovered'],
  'recovery-phase1-guards':['AC5:precommit-log-fabricated-on-recovery'],
  'recovery-central-authority':['AC5:postcas-followup-missing-treated-uncommitted','AC7:local-record-treated-authoritative','AC7:rehearsal-record-accepted-live','AC7:same-tuple-recovery-duplicates-commit'],
  'followup-authority-guards':['AC5:postcas-followup-changes-commit','AC7:followup-treated-authoritative'],
  'recovery-no-reverse':['AC5:reverse-reconciliation-completeness-claimed'],
  'scope-declared-only':['AC6:candidate-manifest-self-authorizes','AC6:addition-root-not-predeclared','AC6:foundation-component-reimplemented','AC6:unrelated-manifest-row-changed'],
  'no-new-powershell':['AC6:new-powershell-logic-added','AC6:powershell-file-renamed','AC8:new-powershell-logic-added'],
  'scope-regular-mode':['AC6:symlink-mode','AC6:gitlink-mode','AC6:nonregular-mode'],
  'lane-config-guards':['AC6:test-classification-missing','AC6:test-classification-duplicate','AC6:lane-config-overreach'],
  'phase1-required-steps':['AC7:pr2a-closure-admission-evidence-missing','AC7:legacy-supervisor-termination-evidence-missing','AC7:ts-supervisor-inert-evidence-missing'],
  'phase1-record-shape':['AC7:precommit-timestamp-outside-core'],
  'followup-record-shape':['AC7:followup-epoch-reference-missing','AC7:followup-sequence-duplicate','AC7:followup-sequence-gap','AC7:followup-sequence-nonmonotonic'],
  'host-context-nonauth':['AC7:host-context-described-as-authentication'],
  'cordon-nonce':['AC7:nonce-not-generated-at-cordon'],
  'platform-guards':['AC8:windows-native-activation','AC8:unsupported-platform-admitted','AC8:repo-root-not-canonical','AC8:cross-device-registry-projection'],
  'guard-record':['AC8:verify-guard-record-missing','AC8:reusable-guard-record-missing','AC8:guard-not-pwsh7','AC8:guard-stale-head','AC8:guard-nonzero-accepted','AC8:guard-stdout-digest-missing'],
  'no-supervisor-pester-load':['AC8:supervisor-dependent-pester-load-restored'],
};

function absolute(pathName: string): string { return path.isAbsolute(pathName) ? pathName : path.join(repoRoot, pathName); }
function read(pathName: string): string { return readFileSync(absolute(pathName), 'utf8'); }
function exists(pathName: string): boolean { return existsSync(absolute(pathName)); }
function has(pathName: string, token: string): boolean { return exists(pathName) && read(pathName).includes(token); }
function occurrences(pathName: string, token: string): number { return exists(pathName) ? read(pathName).split(token).length - 1 : 0; }
function ordered(pathName: string, tokens: readonly string[]): boolean {
  if (!exists(pathName)) return false;
  const source = read(pathName);
  let previous = -1;
  for (const token of tokens) {
    const index = source.indexOf(token);
    if (index < 0 || index <= previous) return false;
    previous = index;
  }
  return true;
}
function gitOk(args: string[]): boolean { return runProcessSync({ command: 'git', args, cwd: repoRoot, inheritParentEnv: true }).ok; }
function gitText(args: string[]): string {
  const result = runProcessSync({ command: 'git', args, cwd: repoRoot, inheritParentEnv: true });
  if (!result.ok) throw new Error(result.stderr || result.error || `git_${args.join('_')}_failed`);
  return result.stdout.trim();
}
function gitWorktreeClean(pathName: string): boolean {
  return gitOk(['diff', '--quiet', 'HEAD', '--', pathName]) && gitOk(['diff', '--cached', '--quiet', 'HEAD', '--', pathName]);
}
function dirtyPathForKey(key: string): string {
  switch (key) {
    case 'AC3:claim-store-modified': case 'AC3:four-deletion-disturbs-claim-authority': case 'AC4:claim-authority-diff-at-merge': case 'AC6:claim-store-modified': return P.claimStore;
    case 'AC3:claim-reaper-modified': case 'AC6:claim-reaper-modified': return P.claimReaper;
    case 'AC6:claimant-family-modified': return P.packRunner;
    default: throw new Error(`issue_928_oracle_dirty_target_missing:${key}`);
  }
}
function nodeSyntaxOk(pathName: string): boolean {
  return runProcessSync({ command: process.execPath, args: ['--check', absolute(pathName)], cwd: repoRoot, inheritParentEnv: true }).ok;
}
function targetRegistryOk(): boolean {
  if (!exists(P.targetRegistry)) return false;
  try {
    const value = JSON.parse(read(P.targetRegistry)) as any;
    return value?.schemaVersion === 2 && Array.isArray(value.requiredChildIds) && value.requiredChildIds.length === 1
      && value.requiredChildIds[0] === 'pr2-scheduler' && Array.isArray(value.children) && value.children.length === 1
      && value.children[0]?.id === 'pr2-scheduler' && value.children[0]?.runtime === 'node'
      && value.children[0]?.script === 'pr2-foundation/scheduler.ts' && value.children[0]?.sideEffecting === true;
  } catch { return false; }
}
function canonicalVectorsOk(): boolean {
  try {
    const value = JSON.parse(read(P.vectors)) as any;
    return Array.isArray(value?.vectors) && value.vectors.length > 0
      && value.vectors.every((row: any) => stableStringify(row.input) === row.canonical);
  } catch { return false; }
}
function requiredFollowupsOk(): boolean {
  return ordered(P.evidence, ["'committed-registry-reprojected'", "'typescript-supervisor-started'", "'scheduler-owned'", "'machine-local-completion-fsync-confirmed'", "'final-step-timestamp-recorded'", "'final-health-delivery-observed'", "'activation-complete'"]);
}
function laneConfigOk(): boolean {
  try {
    const value = JSON.parse(read(P.laneConfig)) as any;
    return value?.lightMaxWorkers === 2 && value?.classification?.['scripts/pr2a/planning.test.ts'] === 'light'
      && Array.isArray(value?.heavyFileBatchIsolate) && !value.heavyFileBatchIsolate.includes('scripts/pr2a/planning.test.ts');
  } catch { return false; }
}
function worktreeModeMatchesIndex(pathName: string): boolean {
  if (!exists(pathName)) return false;
  const row = gitText(['ls-files', '-s', '--', pathName]).split(/\s+/, 1)[0] ?? '';
  if (!/^100(644|755)$/.test(row)) return false;
  return (row === '100755') === ((statSync(absolute(pathName)).mode & 0o111) !== 0);
}
function guardRecordOk(artifactPath: string): boolean {
  if (!artifactPath || !exists(artifactPath)) return false;
  try {
    const value = JSON.parse(read(artifactPath)) as any;
    const head = gitText(['rev-parse', 'HEAD']);
    if (value?.schemaVersion !== 1 || value?.prHeadSha !== head || value?.platform !== 'linux') return false;
    for (const name of ['verify', 'reusable']) {
      const row = value?.records?.[name];
      if (!row || typeof row.command !== 'string' || !row.command.includes('pwsh')) return false;
      if (!String(row.pwshVersion ?? '').startsWith('7.') || row.platform !== 'linux' || row.exitCode !== 0) return false;
      if (!/^sha256:[0-9a-f]{64}$/i.test(String(row.stdoutDigest ?? '')) || !Number.isFinite(Date.parse(String(row.completedAt ?? '')))) return false;
    }
    return true;
  } catch { return false; }
}
function issue928OracleCategory(key: string): string {
  const hits = Object.entries(ISSUE_928_ORACLE_GROUPS).filter(([, keys]) => keys.includes(key));
  if (hits.length !== 1) throw new Error(`issue_928_oracle_binding_invalid:${key}:matches=${hits.length}`);
  return hits[0]![0];
}
function issue928PwshDispatchPresent(): boolean {
  const source = read(P.tx);
  return /\[\s*['"]pwsh['"]\s*,\s*['"]-File['"]/i.test(source) || /command\s*:\s*['"]pwsh['"]/i.test(source);
}
function issue928InvariantHolds(category: string, key: string, artifactPath: string): boolean {
  switch (category) {
    case 'canonical-vectors': return canonicalVectorsOk();
    case 'claim-authority-bytes': return gitWorktreeClean(dirtyPathForKey(key));
    case 'claim-key-semantics': return has(P.claimCli, '  return `pr-${positiveInteger(prNumber, 0)}-${normalizeHeadSha(headSha)}`;');
    case 'claimant-ts-import': return has(P.packRunner, "} from './lib/review-start-claim-store.ts';");
    case 'closure-recompute-call': return has(P.tx, 'const { baseRef, closure } = boundary.resolveBaseAndClosure(request);');
    case 'closure-schema-guard': return has(P.tx, "if (manifest.schemaVersion !== 1) throw new Error('closure_schema_incompatible');");
    case 'closure-target-coverage': return has(P.tx, 'const TARGET_LIBRARIES = new Set<string>(TARGET_LIBRARY_PATHS);');
    case 'closure-tree-binding': return has(P.tx, "if (!manifest.lineage?.planningBaseTreeOid) throw new Error('closure_input_tree_unbound');");
    case 'closure-unresolved-guard': return has(P.tx, 'if ((manifest.unknown ?? []).length !== 0 || (manifest.dynamicUnsupported ?? []).length !== 0) {');
    case 'cordon-admission-guard': return has(P.cordon, "if (existsSync(input.path)) throw new Error('competing_transaction_admitted');");
    case 'cordon-flags': return has(P.cordon, '    writersClosed: true,') && has(P.cordon, '    noRespawn: true,') && has(P.cordon, '    noTypeScriptStart: true,');
    case 'cordon-nonce': return has(P.cordon, "nonce: randomBytes(32).toString('hex'),");
    case 'cutover-terminalized': case 'exact-d928-deletions': return D928.every((file) => !exists(file));
    case 'denominator-bytes': return gitWorktreeClean(P.denominatorJs);
    case 'denominator-loadable': return nodeSyntaxOk(P.denominatorJs);
    case 'durability-primitives': {
      switch (key) {
        case 'AC2:registry-file-or-parent-not-fsynced': return has(P.registryProjection, 'writeDurableFile(projectionPath, source);');
        case 'AC8:atomic-rename-omitted': return has(P.evidence, 'renameSync(temporary, target);');
        case 'AC8:file-fsync-omitted': return has(P.evidence, 'fsyncSync(fd);');
        case 'AC8:parent-fsync-omitted': return has(P.evidence, 'syncDirectory(directory);');
        default: return false;
      }
    }
    case 'epoch-cas-guards': {
      switch (key) {
        case 'AC2:cas-conflict-ignored': return has(P.epoch, "if (document.currentEpochId !== expectedOldEpochId) throw new Error('epoch_cas_conflict');");
        case 'AC7:second-commit-same-epoch': return has(P.epoch, "if (document.records.some((row) => row.epochId === core.epochId)) throw new Error('epoch_duplicate_commit');");
        case 'AC7:consumer-skips-central-nonce-equality': case 'AC7:stale-nonce-replay': return has(P.epoch, "if (!record || record.nonce !== nonce) throw new Error('epoch_nonce_mismatch');");
        case 'AC8:exclusive-lock-omitted': return has(P.epoch, '    mkdirSync(lock);');
        default: return false;
      }
    }
    case 'epoch-core-guards': {
      switch (key) {
        case 'AC2:precommit-digest-not-in-core': case 'AC7:precommit-digest-not-in-core': return has(P.tx, '    preCommitLogDigest: phaseOne.digest,');
        case 'AC2:cas-core-field-extra-or-missing': case 'AC7:cas-core-field-extra-or-missing': case 'AC7:postcommit-timestamp-in-core': return has(P.epoch, "  'importDigests', 'registryHash', 'preCommitLogDigest', 'commitAt',");
        case 'AC7:nonce-not-stored-centrally': return has(P.epoch, "  'epochId', 'nonce', 'hostId',");
        default: return false;
      }
    }
    case 'fleet-roster-guards': {
      switch (key) {
        case 'AC1:fleet-member-omitted': return has(P.tx, 'if (member.quarantined !== true && !heartbeatHosts.has(member.hostId)) throw new Error(`foundation_member_omitted:${member.hostId}`);');
        case 'AC1:stale-member-accepted': return has(P.tx, 'if (!Number.isFinite(observedMs) || observedMs > nowMs + 30_000 || nowMs - observedMs > FOUNDATION_HEARTBEAT_MAX_AGE_MS) {');
        case 'AC1:rejoining-member-unquarantined': return has(P.tx, 'if (configured.quarantined !== true) throw new Error(`foundation_member_not_quarantined:${heartbeat.hostId}`);');
        case 'AC1:diverged-revision-accepted': return has(P.tx, 'if (heartbeat.active !== true || heartbeat.installedCommitSha !== oldInstalledCommitSha) {');
        case 'AC1:second-control-plane-host': return has(P.tx, "if (member.hostId !== request.hostId && member.quarantined !== true) throw new Error('second_control_plane_host');");
        case 'AC1:host-or-repo-unbound': return has(P.tx, "if (!request.hostId || request.hostId !== observedLocalHost) throw new Error('foundation_host_unbound');");
        default: return false;
      }
    }
    case 'followup-authority-guards': return !has(P.recovery, 'authority.commit(request.epochId, core);');
    case 'followup-record-shape': return has(P.evidence, key === 'AC7:followup-epoch-reference-missing' ? '    epochId,\n    sequence: existing.length + 1,' : '    sequence: existing.length + 1,');
    case 'followup-required': return requiredFollowupsOk();
    case 'foundation-proof': return has(P.tx, 'const foundation = boundary.proveFoundationAdoption(request);');
    case 'guard-record': return guardRecordOk(artifactPath);
    case 'host-context-nonauth': return !has(P.tx, 'hostAuthentication');
    case 'import-digest-guards': return has(P.importFile, key === 'AC3:legacy-read-partial-import' ? 'if (sha256Stable(existing) !== importTargetDigest) throw new Error(`import_target_digest_mismatch:${input.spec.id}`);' : 'if (sha256Stable(readBack) !== importTargetDigest) throw new Error(`import_target_digest_mismatch:${input.spec.id}`);');
    case 'import-identity-guards': return has(P.importFile, key === 'AC3:target-import-identity-missing' ? '    nonce: input.nonce,' : '    storeId: input.spec.id,');
    case 'import-marker-guards': return has(P.importFile, key === 'AC3:target-cas-or-upsert-omitted' ? '  writeDurableJson(markerPath, record);' : '  writeDurableFile(input.spec.targetPath, `${JSON.stringify(normalized, null, 2)}\\n`);');
    case 'import-shape-guards': return has(P.importFile, key === 'AC3:store-covered-field-omitted' ? 'if (!required || JSON.stringify([...spec.coveredFields]) !== JSON.stringify(required)) throw new Error(`store_covered_fields_invalid:${spec.id}`);' : "if (unknown.length) throw new Error(`store_unknown_field:${spec.id}:${unknown.join(',')}`);");
    case 'lane-config-guards': return laneConfigOk();
    case 'live-registry-bytes': return gitWorktreeClean(P.liveRegistry);
    case 'no-legacy-claim-path': return !exists(D928[2]);
    case 'no-legacy-executable': return !has(P.tx, 'Review-StartClaim.ps1') && !has(P.tx, 'Orchestrator-SideProcessSupervisor.ps1');
    case 'no-new-powershell': return !exists('scripts/issue-928-mutation.ps1');
    case 'no-overlap-reimplementation': return !has(P.importFile, 'mutationOverlapProtocolReimplementation');
    case 'no-pwsh-dispatch': return !issue928PwshDispatchPresent();
    case 'no-second-claim-store': return !exists('scripts/lib/cutover/review-start-claim-store.ts');
    case 'no-successor-prerequisite': return !has(P.tx, 'successor_926_prerequisite') && !has(P.tx, 'successor_930_prerequisite');
    case 'no-supervisor-pester-load': return !exists('scripts/Orchestrator-SideProcessSupervisor.Tests.ps1');
    case 'node22-guard': return has(P.preflight, "if (major !== 22) throw new Error('node22_required');");
    case 'old-supervisor-continuity': return ordered(P.tx, ['const cordon = createCordon({', 'boundary.terminateLegacyProcesses(']);
    case 'phase1-digest-verify': return has(key === 'AC5:precommit-log-digest-mismatch-accepted' ? P.recovery : P.tx, key === 'AC5:precommit-log-digest-mismatch-accepted' ? 'verifyPhaseOneDigest(request.paths.phaseOnePath, request.epochId, cordon.nonce, core.preCommitLogDigest);' : 'verifyPhaseOneDigest(request.paths.phaseOnePath, request.epochId, cordon.nonce, committed.preCommitLogDigest);');
    case 'phase1-record-shape': return has(P.evidence, 'completedAt: new Date().toISOString(),');
    case 'phase1-required-steps': {
      if (key === 'AC7:legacy-supervisor-termination-evidence-missing') return has(P.tx, "'legacy-supervisor-and-writers-terminated'");
      return has(P.tx, "appendPhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce, 'admission', { preflight, foundation, closure, baseRef });");
    }
    case 'platform-guards': {
      switch (key) {
        case 'AC8:windows-native-activation': case 'AC8:unsupported-platform-admitted': return has(P.preflight, "if (platform !== 'linux') throw new Error('unsupported_platform');");
        case 'AC8:repo-root-not-canonical': return has(P.preflight, 'if (value !== lexical || lexical !== canonical) throw new Error(`${label}_not_canonical`);');
        case 'AC8:cross-device-registry-projection': return has(P.preflight, "if (statSync(targetParent).dev !== statSync(projectionParent).dev) throw new Error('registry_cross_device_projection');");
        default: return false;
      }
    }
    case 'pr2a-merge-guard': return has(P.tx, "if (!isAncestor(repoRoot, PR2A_LANDING_COMMIT, baseRef)) throw new Error('pr2a_merge_missing');");
    case 'preflight-bindings': return has(P.preflight, key === 'AC1:installed-commit-unbound' ? "if (actualHead.toLowerCase() !== input.installedCommitSha.toLowerCase()) throw new Error('installed_commit_unbound');" : "if (!existsSync(input.repoRoot) || !existsSync(input.oldInstalledRevisionRoot)) throw new Error('installed_revision_missing');");
    case 'preimport-rollback-guards': return has(key === 'AC5:preimport-target-change-unchecked' ? P.recovery : P.cordon, key === 'AC5:preimport-target-change-unchecked' ? 'if (fileDigestOrAbsent(store.targetPath) !== cordon.preImportTargetDigests[store.id]) {' : '    oldInstalledRevisionRoot: input.oldInstalledRevisionRoot,');
    case 'process-identity-guards': {
      if (key === 'AC1:legacy-supervisor-identity-ambiguous') return has(P.tx, 'assertLegacySupervisor(legacyIdentity, request.oldInstalledRevisionRoot);');
      if (key === 'AC2:legacy-supervisor-identity-unverified') return has(P.tx, 'assertLegacySupervisor(identity, request.oldInstalledRevisionRoot);');
      if (key === 'AC2:pid-identity-unverified' || key === 'AC8:pid-start-time-unchecked') return has(P.cordon, 'assertSameProcess(identity);');
      return has(P.cordon, 'if (survivors.length) throw new Error(`legacy_process_survivor:${survivors.join(\',\')}`);');
    }
    case 'recovery-central-authority': {
      if (key === 'AC7:same-tuple-recovery-duplicates-commit') return occurrences(P.recovery, 'authority.commit(request.epochId, authority.verify(request.epochId, cordon.nonce));') === 0;
      return has(P.recovery, 'if (document.currentEpochId === request.epochId) {');
    }
    case 'recovery-forward-path': {
      if (key === 'AC5:postmutation-import-bytes-discarded') return has(P.recovery, 'const imports: ImportRecord[] = request.stores.map((spec) => importSnapshot({');
      if (key === 'AC5:forward-recovery-uncordoned') return !has(P.recovery, 'releaseLegacyStartBarrier(request.paths.supervisorStateDir);');
      return occurrences(P.recovery, 'const projection = projectRegistry(request.paths.targetRegistryPath, request.paths.projectedRegistryPath);') >= 2;
    }
    case 'recovery-no-legacy': return !has(P.recovery, 'releaseLegacyStartBarrier(request.paths.supervisorStateDir);');
    case 'recovery-no-reverse': return !has(P.recovery, 'reverseReconcileLegacyMutation');
    case 'recovery-order-guards': return key === 'AC5:import-begin-recorded-after-mutation' ? ordered(P.tx, ['const importBoundary = markImportBegun(request.paths.cordonPath);', 'const imports = request.stores.map((spec) => importSnapshot({']) : ordered(P.recovery, ['authority.commit(request.expectedOldEpochId, core);', 'boundary.ensureTypeScriptSupervisor(request, cordon.nonce)']);
    case 'recovery-phase1-guards': return has(P.recovery, 'assertForwardRecoveryPrefix(request.paths.phaseOnePath, request.epochId, nonce);');
    case 'registry-projection-guards': return has(P.registryProjection, "if (!readBack.equals(source)) throw new Error('registry_projection_readback_mismatch');");
    case 'registry-single-scheduler': case 'staged-registry-required': return targetRegistryOk();
    case 'rehearsal-inert': return has(P.planningTest, '  const boundary: ActivationBoundary = {') && !has(P.planningTest, 'productionActivationBoundary');
    case 'retired-guard-absent': return !exists('scripts/check-side-process-launch-contract.ps1');
    case 'scope-declared-only': {
      switch (key) {
        case 'AC6:candidate-manifest-self-authorizes': return !exists('scripts/cutover/candidate-self-authorized.ts');
        case 'AC6:addition-root-not-predeclared': return !exists('tools/issue-928-mutation.ts');
        case 'AC6:foundation-component-reimplemented': return !exists('scripts/lib/cutover/foundation-config.ts');
        case 'AC6:unrelated-manifest-row-changed': return gitWorktreeClean('scripts/pr2a/planning-manifest.json');
        default: return false;
      }
    }
    case 'scope-regular-mode': return worktreeModeMatchesIndex(P.wakeSupervisor);
    case 'snapshot-guards': return has(P.importFile, key === 'AC3:snapshot-version-missing' ? 'if (!Number.isInteger(sourceVersion) || sourceVersion <= 0) throw new Error(`snapshot_version_missing:${store.id}`);' : 'snapshotDigest: sha256Bytes(bytes)');
    case 'stable-stringify-guards': return has(P.stable, key === 'AC3:stable-stringify-key-order-wrong' ? 'Object.keys(object).sort()' : 'return canonical(value, new Set());');
    case 'supervisor-source-guards': {
      if (key === 'AC2:tracked-registry-restored-consumed') return has(P.supervisor, 'projectRegistry(options.targetRegistryPath, options.projectedRegistryPath)');
      if (key === 'AC2:epoch-gated-source-missing') return has(P.supervisor, 'new FileEpochAuthority(options.epochAuthorityPath).verify(options.epochId, options.nonce)');
      return has(P.supervisor, 'const projected = projectRegistry(options.targetRegistryPath, options.projectedRegistryPath);');
    }
    case 'ts-supervisor-inert': return gitWorktreeClean(P.liveRegistry);
    case 'ts-supervisor-replacement': return exists(P.wakeSupervisor) && exists(P.supervisor);
    case 'tx-admission-order': return ordered(P.tx, ['const preflight = boundary.preflight(request);', 'projectRegistry(request.paths.targetRegistryPath, request.paths.projectedRegistryPath)']);
    case 'tx-cas-before-followups': return ordered(P.tx, ['authority.commit(request.expectedOldEpochId, core);', "appendFollowup(request.paths.followupPath, request.epochId, 'committed-registry-reprojected'"]);
    case 'tx-cas-before-start': return ordered(P.tx, ['authority.commit(request.expectedOldEpochId, core);', 'boundary.startTypeScriptSupervisor(request, cordon.nonce)']);
    case 'tx-cordon-first-order': return ordered(P.tx, ['const cordon = createCordon({', 'boundary.drainLegacyWriters(request, legacyWriters)', 'boundary.terminateLegacyProcesses(']);
    case 'tx-drain-before-snapshot': return ordered(P.tx, ['const drain = await boundary.drainLegacyWriters(request, legacyWriters);', 'const snapshots = snapshotStores(request.stores, request.paths.snapshotDir, drain.writerWatermark);']);
    case 'tx-import-before-projection': return ordered(P.tx, ['const imports = request.stores.map((spec) => importSnapshot({', 'projectRegistry(request.paths.targetRegistryPath, request.paths.projectedRegistryPath)']);
    case 'tx-phase1-before-cas': return ordered(P.tx, ['const phaseOne = finalizePhaseOne(request.paths.phaseOnePath, request.epochId, cordon.nonce);', 'authority.commit(request.expectedOldEpochId, core);']);
    case 'tx-single-cas': return occurrences(P.tx, 'authority.commit(request.expectedOldEpochId, core);') === 1;
    case 'tx-survivor-guard': return has(P.tx, 'if (survivors.supervisorAlive || survivors.writers.length !== 0) {');
    case 'writer-watermark': return has(P.importFile, "if (!writerWatermark.trim()) throw new Error('writer_watermark_missing');");
    default: throw new Error(`issue_928_oracle_category_unknown:${category}:${key}`);
  }
}

const directIndex = process.argv.indexOf('--issue-928-mutation-check');
if (directIndex >= 0) {
  const key = String(process.argv[directIndex + 1] ?? '').trim();
  const artifactIndex = process.argv.indexOf('--artifact');
  const artifactPath = artifactIndex >= 0 ? String(process.argv[artifactIndex + 1] ?? '').trim() : '';
  if (!key) throw new Error('issue_928_oracle_key_missing');
  const category = issue928OracleCategory(key);
  if (!issue928InvariantHolds(category, key, artifactPath)) {
    process.stderr.write(`mutation-contract:${key}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify({ issue928MutationOracle: { key, category, result: 'green' } })}\n`);
  }
} else {
  const { describe, expect, it } = await import('vitest');
  const { AC_MUTATION_CONTROLS } = await import('./contracts.ts');
  const { MUTATION_BEHAVIOR_PROBE_KEYS } = await import('./mutation-behavior-probes.ts');
  const { buildBehavioralMutation, EXECUTABLE_BEHAVIOR_MUTATION_KEYS } = await import('./mutation-behavior-recipes.ts');
  const { FOUNDATION_MUTATION_CATALOG } = await import('./mutation-catalog.ts');

  const ISSUE_928_CUTOVER_MARKERS = Object.freeze([
    'scripts/cutover/mutation-runner.ts',
    'scripts/orchestrator-cutover-activate.ts',
    'scripts/pr2a/final-conformance-precutover.ts',
  ]);
  const TERMINALIZED_FOUNDATION_MUTATION_KEY = 'AC9:registry-or-supervisor-modified';
  const issue928CutoverPresent = (): boolean => ISSUE_928_CUTOVER_MARKERS.every((file) => existsSync(path.resolve(file)));
  const mutationKeys = (): string[] => Object.entries(AC_MUTATION_CONTROLS).flatMap(([ac, ids]) => ids.map((mutationId) => `${ac}:${mutationId}`));
  const importsMutationRecipes = /(?:from\s+|import\s*\(\s*)['"]\.\/mutation-behavior-recipes\.ts['"]/u;
  const importsSemanticGates = /(?:from\s+|import\s*\(\s*)['"]\.\/mutation-semantic-gates\.ts['"]/u;

  describe('[AC8] independent behavioral mutation probes', () => {
    it('binds every declared control to an explicit behavioral mutation without semantic-gate fallback', () => {
      const expected = mutationKeys().sort();
      expect([...EXECUTABLE_BEHAVIOR_MUTATION_KEYS]).toEqual(expected);
      const recipes = readFileSync(path.resolve('scripts/pr2-foundation/mutation-behavior-recipes.ts'), 'utf8');
      expect(recipes).not.toMatch(importsSemanticGates);
      expect(recipes).not.toContain('buildBoundedSemanticMutation');
      expect(recipes).not.toContain('GATES[');
      expect(recipes).toContain("from './mutation-catalog.ts'");
      expect(recipes).toContain('behavioral_mutation_recipe_set_mismatch');
    });

    it('builds a bounded non-empty mutation plan for every live declared control and terminalizes only the #928-owned legacy supervisor control', () => {
      const terminalized: string[] = [];
      const cutoverPresent = issue928CutoverPresent();
      for (const [ac, ids] of Object.entries(AC_MUTATION_CONTROLS)) {
        for (const mutationId of ids) {
          const key = `${ac}:${mutationId}`;
          const bindingPath = FOUNDATION_MUTATION_CATALOG.find((entry) => `${entry.ac}:${entry.mutationId}` === key)?.artifactPath;
          expect(bindingPath, key).toBeTruthy();
          const absolutePath = path.resolve(bindingPath!);
          const source = existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : null;
          if (source === null && cutoverPresent && key === TERMINALIZED_FOUNDATION_MUTATION_KEY) {
            terminalized.push(key);
            continue;
          }
          const plan = buildBehavioralMutation(key, source);
          expect(plan.artifactPath, key).toBe(bindingPath);
          expect(plan.affectedOccurrences, key).toBeGreaterThan(0);
          expect(plan.content, key).not.toBe(source);
        }
      }
      expect(terminalized).toEqual(cutoverPresent ? [TERMINALIZED_FOUNDATION_MUTATION_KEY] : []);
    });

    it('binds the full control set to a checker authority independent from mutation recipes', () => {
      const expected = mutationKeys().sort();
      expect([...MUTATION_BEHAVIOR_PROBE_KEYS]).toEqual(expected);
      const checker = readFileSync(path.resolve('scripts/pr2-foundation/mutation-semantic-check.ts'), 'utf8');
      const probes = readFileSync(path.resolve('scripts/pr2-foundation/mutation-behavior-probes.ts'), 'utf8');
      const fixtures = readFileSync(path.resolve('scripts/pr2-foundation/mutation-behavior-fixtures.ts'), 'utf8');
      const runner = readFileSync(path.resolve('scripts/pr2-foundation/mutation-runner.ts'), 'utf8');
      expect(checker).toContain("await import('./mutation-behavior-probes.ts')");
      expect(checker).not.toMatch(importsSemanticGates);
      expect(probes).not.toMatch(importsMutationRecipes);
      expect(fixtures).not.toMatch(importsMutationRecipes);
      expect(fixtures).not.toMatch(importsSemanticGates);
      expect(runner).toContain("from './mutation-behavior-recipes.ts'");
    });

    it('uses executable behavioral mutants for the reviewer examples', () => {
      expect(EXECUTABLE_BEHAVIOR_MUTATION_KEYS).toEqual(expect.arrayContaining([
        'AC1:scheduler-acquirer-running','AC1:activation-epoch-enforced','AC2:draft-candidate-accepted','AC2:missing-draft-bit-accepted','AC3:invalid-config-accepted','AC4:duplicate-send-unaccounted','AC9:modification-outside-independent-union','AC9:declaration-snapshot-missing','AC9:declaration-created-after-implementation',
      ]));
      const scheduler = readFileSync(path.resolve('scripts/pr2-foundation/scheduler.ts'), 'utf8');
      expect(buildBehavioralMutation('AC1:scheduler-acquirer-running', scheduler).content).toContain('running: true');
      const binding = readFileSync(path.resolve('scripts/pr2-foundation/binding.ts'), 'utf8');
      expect(buildBehavioralMutation('AC2:draft-candidate-accepted', binding).content).not.toContain('!row.isDraft &&');
      const config = readFileSync(path.resolve('scripts/pr2-foundation/config.ts'), 'utf8');
      expect(buildBehavioralMutation('AC3:invalid-config-accepted', config).content).toContain('return { ok: true, config: DEFAULT_FOUNDATION_CONFIG };');
      const notification = readFileSync(path.resolve('scripts/pr2-foundation/worker-notification.ts'), 'utf8');
      const duplicateMutant = buildBehavioralMutation('AC4:duplicate-send-unaccounted', notification);
      expect(duplicateMutant.affectedOccurrences).toBe(2);
      expect(duplicateMutant.content).not.toContain("if (inspected.duplicate) return { state: 'delivered', reason: 'journal_duplicate_no_op' };");
      const scopeProof = readFileSync(path.resolve('scripts/pr2-foundation/real-scope-proof.ts'), 'utf8');
      expect(buildBehavioralMutation('AC9:modification-outside-independent-union', scopeProof).content).toContain("'README.md'");
    });
  });
}
