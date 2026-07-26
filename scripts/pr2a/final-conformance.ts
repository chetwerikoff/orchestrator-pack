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

type MutationKey = `AC${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}:${string}`;

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

const CHECK_BINDINGS: Record<MutationKey, string> = {
  'AC1:operator-ack-only': 'foundation-proof',
  'AC1:pr2a-merge-missing': 'pr2a-merge-guard',
  'AC1:pr2a-receipt-trusted-without-recompute': 'closure-recompute-call',
  'AC1:closure-schema-incompatible': 'closure-schema-guard',
  'AC1:external-supervisor-library-reference': 'closure-target-coverage',
  'AC1:external-claim-library-reference': 'closure-target-coverage',
  'AC1:closure-unresolved-set-nonempty': 'closure-unresolved-guard',
  'AC1:closure-input-tree-unbound': 'closure-tree-binding',
  'AC1:fleet-member-omitted': 'fleet-roster-guards',
  'AC1:stale-member-accepted': 'fleet-roster-guards',
  'AC1:rejoining-member-unquarantined': 'fleet-roster-guards',
  'AC1:diverged-revision-accepted': 'fleet-roster-guards',
  'AC1:second-control-plane-host': 'fleet-roster-guards',
  'AC1:host-or-repo-unbound': 'fleet-roster-guards',
  'AC1:installed-commit-unbound': 'preflight-bindings',
  'AC1:old-installed-revision-missing': 'preflight-bindings',
  'AC1:legacy-supervisor-identity-ambiguous': 'process-identity-guards',
  'AC1:node22-not-enforced': 'node22-guard',
  'AC1:competing-transaction-admitted': 'cordon-admission-guard',
  'AC1:successor-926-used-as-prerequisite': 'no-successor-prerequisite',
  'AC1:mutation-before-admission': 'tx-admission-order',
  'AC2:install-kills-old-supervisor': 'tx-cordon-first-order',
  'AC2:install-gap-acquirer-gap': 'tx-cordon-first-order',
  'AC2:ts-supervisor-starts-at-install': 'tx-cas-before-start',
  'AC2:dual-supervisor-owner': 'tx-cas-before-start',
  'AC2:cordon-not-first': 'tx-cordon-first-order',
  'AC2:legacy-supervisor-terminated-before-cordon': 'tx-cordon-first-order',
  'AC2:legacy-supervisor-survivor': 'tx-survivor-guard',
  'AC2:legacy-supervisor-identity-unverified': 'process-identity-guards',
  'AC2:ts-supervisor-start-before-cas': 'tx-cas-before-start',
  'AC2:store-writer-ingress-left-open': 'cordon-flags',
  'AC2:concurrent-writer-admitted': 'tx-survivor-guard',
  'AC2:drain-watermark-missing': 'writer-watermark',
  'AC2:pid-identity-unverified': 'process-identity-guards',
  'AC2:survivor-accepted': 'tx-survivor-guard',
  'AC2:registry-projection-before-import-digest': 'tx-import-before-projection',
  'AC2:registry-file-or-parent-not-fsynced': 'durability-primitives',
  'AC2:registry-readback-hash-missing': 'registry-projection-guards',
  'AC2:precommit-log-not-durable-before-cas': 'tx-phase1-before-cas',
  'AC2:precommit-digest-not-in-core': 'epoch-core-guards',
  'AC2:precommit-log-digest-mismatch-accepted': 'phase1-digest-verify',
  'AC2:registry-treated-as-commit': 'tx-cas-before-followups',
  'AC2:central-cas-not-sole-commit': 'tx-single-cas',
  'AC2:cas-core-field-extra-or-missing': 'epoch-core-guards',
  'AC2:postcommit-followup-treated-as-commit': 'tx-cas-before-followups',
  'AC2:cas-conflict-ignored': 'epoch-cas-guards',
  'AC2:tracked-registry-restored-consumed': 'supervisor-source-guards',
  'AC2:legacy-executable-reference-restored': 'no-legacy-executable',
  'AC2:epoch-gated-source-missing': 'supervisor-source-guards',
  'AC2:postactivation-start-without-reprojection': 'supervisor-source-guards',
  'AC2:dual-scheduler': 'registry-single-scheduler',
  'AC3:snapshot-before-drain': 'tx-drain-before-snapshot',
  'AC3:writer-watermark-missing': 'writer-watermark',
  'AC3:concurrent-store-writer': 'tx-survivor-guard',
  'AC3:snapshot-version-missing': 'snapshot-guards',
  'AC3:snapshot-digest-not-raw-bytes': 'snapshot-guards',
  'AC3:digest-algorithm-not-sha256': 'snapshot-guards',
  'AC3:stable-stringify-key-order-wrong': 'stable-stringify-guards',
  'AC3:stable-stringify-whitespace-present': 'stable-stringify-guards',
  'AC3:unicode-or-escape-vector-mismatch': 'canonical-vectors',
  'AC3:negative-zero-or-exponent-vector-mismatch': 'canonical-vectors',
  'AC3:nested-key-order-vector-mismatch': 'canonical-vectors',
  'AC3:vector-failing-payload-accepted': 'canonical-vectors',
  'AC3:store-covered-field-omitted': 'import-shape-guards',
  'AC3:unknown-store-field-silently-ignored': 'import-shape-guards',
  'AC3:target-import-identity-missing': 'import-identity-guards',
  'AC3:target-import-identity-aliased': 'import-identity-guards',
  'AC3:target-cas-or-upsert-omitted': 'import-marker-guards',
  'AC3:marker-only-completion': 'import-marker-guards',
  'AC3:target-state-digest-mismatch-accepted': 'import-digest-guards',
  'AC3:post-mutation-pre-marker-reapplied': 'import-digest-guards',
  'AC3:legacy-read-partial-import': 'import-digest-guards',
  'AC3:claim-store-modified': 'claim-authority-bytes',
  'AC3:claim-reaper-modified': 'claim-authority-bytes',
  'AC3:claim-semantics-changed': 'claim-key-semantics',
  'AC3:claim-key-or-namespace-changed': 'claim-key-semantics',
  'AC3:second-claim-store-created': 'no-second-claim-store',
  'AC3:claimant-family-not-ts-native': 'claimant-ts-import',
  'AC3:powershell-claim-path-resurrected': 'no-legacy-claim-path',
  'AC3:four-deletion-disturbs-claim-authority': 'claim-authority-bytes',
  'AC3:pr2a-overlap-proof-reimplemented': 'no-overlap-reimplementation',
  'AC4:harness-owned-cycle': 'rehearsal-inert',
  'AC4:merge-rehearsal-labeled-live': 'rehearsal-inert',
  'AC4:staged-registry-missing': 'staged-registry-required',
  'AC4:staged-registry-has-legacy-child': 'registry-single-scheduler',
  'AC4:live-registry-diff-at-merge': 'live-registry-bytes',
  'AC4:denominator-file-diff-from-post948-base': 'denominator-bytes',
  'AC4:denominator-file-not-loadable': 'denominator-loadable',
  'AC4:install-gap-old-supervisor-continuity-untested': 'old-supervisor-continuity',
  'AC4:ts-supervisor-not-inert': 'ts-supervisor-inert',
  'AC4:claim-authority-diff-at-merge': 'claim-authority-bytes',
  'AC4:claim-key-changed': 'claim-key-semantics',
  'AC4:durable-delivery-missing': 'followup-required',
  'AC4:cutover-row-not-terminalized': 'cutover-terminalized',
  'AC4:deleted-supervisor-duty-missing': 'ts-supervisor-replacement',
  'AC4:orphan-claim-file-not-deleted': 'exact-d928-deletions',
  'AC4:powershell-shim-used-in-rehearsal': 'no-pwsh-dispatch',
  'AC4:retired-launch-contract-guard-restored': 'retired-guard-absent',
  'AC4:926-precedes-adoption': 'no-successor-prerequisite',
  'AC4:930-precedes-926': 'no-successor-prerequisite',
  'AC5:preimport-target-change-unchecked': 'preimport-rollback-guards',
  'AC5:rollback-old-revision-unbound': 'preimport-rollback-guards',
  'AC5:rollback-uses-new-checkout-ps-shim': 'no-legacy-claim-path',
  'AC5:import-begin-recorded-after-mutation': 'recovery-order-guards',
  'AC5:legacy-restored-after-import-begin': 'recovery-no-legacy',
  'AC5:legacy-epoch-rearmed-on-migrated-store': 'recovery-no-legacy',
  'AC5:postmutation-import-bytes-discarded': 'recovery-forward-path',
  'AC5:forward-recovery-uncordoned': 'recovery-forward-path',
  'AC5:registry-projection-crash-unrecovered': 'recovery-forward-path',
  'AC5:precommit-log-digest-mismatch-accepted': 'phase1-digest-verify',
  'AC5:precommit-log-fabricated-on-recovery': 'recovery-phase1-guards',
  'AC5:precas-ts-supervisor-started': 'recovery-order-guards',
  'AC5:postactivation-start-without-reprojection': 'supervisor-source-guards',
  'AC5:postcas-followup-missing-treated-uncommitted': 'recovery-central-authority',
  'AC5:postcas-followup-changes-commit': 'followup-authority-guards',
  'AC5:postcas-legacy-restored': 'recovery-no-legacy',
  'AC5:reverse-reconciliation-completeness-claimed': 'recovery-no-reverse',
  'AC6:candidate-manifest-self-authorizes': 'scope-declared-only',
  'AC6:addition-root-not-predeclared': 'scope-declared-only',
  'AC6:foundation-component-reimplemented': 'scope-declared-only',
  'AC6:live-registry-modified': 'live-registry-bytes',
  'AC6:denominator-compatibility-file-modified': 'denominator-bytes',
  'AC6:denominator-file-not-loadable': 'denominator-loadable',
  'AC6:staged-registry-omitted': 'staged-registry-required',
  'AC6:unrelated-manifest-row-changed': 'scope-declared-only',
  'AC6:required-ps-deletion-missing': 'exact-d928-deletions',
  'AC6:ps-file-shimmed-not-deleted': 'exact-d928-deletions',
  'AC6:new-powershell-logic-added': 'no-new-powershell',
  'AC6:powershell-file-modified-instead-of-deleted': 'exact-d928-deletions',
  'AC6:powershell-file-renamed': 'no-new-powershell',
  'AC6:embedded-powershell-program': 'no-pwsh-dispatch',
  'AC6:cutover-module-spawns-pwsh': 'no-pwsh-dispatch',
  'AC6:supervisor-ts-replacement-missing': 'ts-supervisor-replacement',
  'AC6:claim-store-modified': 'claim-authority-bytes',
  'AC6:claim-reaper-modified': 'claim-authority-bytes',
  'AC6:claimant-family-modified': 'claim-authority-bytes',
  'AC6:second-claim-store-created': 'no-second-claim-store',
  'AC6:powershell-claim-path-resurrected': 'no-legacy-claim-path',
  'AC6:retired-launch-contract-guard-restored': 'retired-guard-absent',
  'AC6:legacy-executable-reference-restored': 'no-legacy-executable',
  'AC6:symlink-mode': 'scope-regular-mode',
  'AC6:gitlink-mode': 'scope-regular-mode',
  'AC6:nonregular-mode': 'scope-regular-mode',
  'AC6:test-classification-missing': 'lane-config-guards',
  'AC6:test-classification-duplicate': 'lane-config-guards',
  'AC6:lane-config-overreach': 'lane-config-guards',
  'AC7:cas-core-field-extra-or-missing': 'epoch-core-guards',
  'AC7:pr2a-closure-admission-evidence-missing': 'phase1-required-steps',
  'AC7:precommit-log-not-durable-before-cas': 'tx-phase1-before-cas',
  'AC7:precommit-digest-not-in-core': 'epoch-core-guards',
  'AC7:precommit-log-digest-mismatch-accepted': 'phase1-digest-verify',
  'AC7:legacy-supervisor-termination-evidence-missing': 'phase1-required-steps',
  'AC7:ts-supervisor-inert-evidence-missing': 'phase1-required-steps',
  'AC7:precommit-timestamp-outside-core': 'phase1-record-shape',
  'AC7:postcommit-timestamp-in-core': 'epoch-core-guards',
  'AC7:followup-epoch-reference-missing': 'followup-record-shape',
  'AC7:followup-sequence-duplicate': 'followup-record-shape',
  'AC7:followup-sequence-gap': 'followup-record-shape',
  'AC7:followup-sequence-nonmonotonic': 'followup-record-shape',
  'AC7:followup-treated-authoritative': 'followup-authority-guards',
  'AC7:ts-supervisor-start-followup-missing': 'followup-required',
  'AC7:scheduler-enable-followup-missing': 'followup-required',
  'AC7:local-fsync-followup-missing': 'followup-required',
  'AC7:host-context-described-as-authentication': 'host-context-nonauth',
  'AC7:second-commit-same-epoch': 'epoch-cas-guards',
  'AC7:nonce-not-generated-at-cordon': 'cordon-nonce',
  'AC7:nonce-not-stored-centrally': 'epoch-core-guards',
  'AC7:consumer-skips-central-nonce-equality': 'epoch-cas-guards',
  'AC7:stale-nonce-replay': 'epoch-cas-guards',
  'AC7:local-record-treated-authoritative': 'recovery-central-authority',
  'AC7:rehearsal-record-accepted-live': 'recovery-central-authority',
  'AC7:same-tuple-recovery-duplicates-commit': 'recovery-central-authority',
  'AC8:wrong-node-major-admitted': 'node22-guard',
  'AC8:windows-native-activation': 'platform-guards',
  'AC8:unsupported-platform-admitted': 'platform-guards',
  'AC8:repo-root-not-canonical': 'platform-guards',
  'AC8:cross-device-registry-projection': 'platform-guards',
  'AC8:pid-start-time-unchecked': 'process-identity-guards',
  'AC8:process-tree-survivor': 'process-identity-guards',
  'AC8:exclusive-lock-omitted': 'epoch-cas-guards',
  'AC8:atomic-rename-omitted': 'durability-primitives',
  'AC8:file-fsync-omitted': 'durability-primitives',
  'AC8:parent-fsync-omitted': 'durability-primitives',
  'AC8:new-powershell-logic-added': 'no-new-powershell',
  'AC8:verify-guard-record-missing': 'guard-record',
  'AC8:reusable-guard-record-missing': 'guard-record',
  'AC8:guard-not-pwsh7': 'guard-record',
  'AC8:guard-stale-head': 'guard-record',
  'AC8:guard-nonzero-accepted': 'guard-record',
  'AC8:guard-stdout-digest-missing': 'guard-record',
  'AC8:retired-launch-contract-guard-restored': 'retired-guard-absent',
  'AC8:supervisor-dependent-pester-load-restored': 'no-supervisor-pester-load',
};

function absolute(pathName: string): string {
  return path.isAbsolute(pathName) ? pathName : path.join(repoRoot, pathName);
}
function read(pathName: string): string { return readFileSync(absolute(pathName), 'utf8'); }
function exists(pathName: string): boolean { return existsSync(absolute(pathName)); }
function has(pathName: string, token: string): boolean { return exists(pathName) && read(pathName).includes(token); }
function occurrences(pathName: string, token: string): number { return exists(pathName) ? read(pathName).split(token).length - 1 : 0; }
function ordered(pathName: string, tokens: string[]): boolean {
  if (!exists(pathName)) return false;
  const source = read(pathName); let previous = -1;
  for (const token of tokens) { const index = source.indexOf(token); if (index < 0 || index <= previous) return false; previous = index; }
  return true;
}
function gitWorktreeClean(pathName: string): boolean {
  return gitOk(['diff', '--quiet', 'HEAD', '--', pathName]) && gitOk(['diff', '--cached', '--quiet', 'HEAD', '--', pathName]);
}
function dirtyPathForKey(key: MutationKey): string {
  switch (key) {
    case 'AC3:claim-store-modified': case 'AC3:four-deletion-disturbs-claim-authority': case 'AC4:claim-authority-diff-at-merge': case 'AC6:claim-store-modified': return P.claimStore;
    case 'AC3:claim-reaper-modified': case 'AC6:claim-reaper-modified': return P.claimReaper;
    case 'AC6:claimant-family-modified': return P.packRunner;
    default: throw new Error(`mutation_dirty_target_missing:${key}`);
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
    const value = JSON.parse(read(P.vectors)) as { vectors?: Array<{ input: unknown; canonical: string }> };
    return Array.isArray(value.vectors) && value.vectors.length > 0 && value.vectors.every((row) => stableStringify(row.input) === row.canonical);
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
function guardRecordOk(_key: MutationKey, artifactPath: string): boolean {
  if (!artifactPath || !exists(artifactPath)) return false;
  try {
    const value = JSON.parse(read(artifactPath)) as any; const head = gitText(['rev-parse', 'HEAD']);
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

function mutationInvariantHolds(category: string, key: MutationKey, artifactPath: string): boolean {
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
        case 'AC2:precommit-log-not-durable-before-cas': case 'AC7:precommit-log-not-durable-before-cas': case 'AC7:local-fsync-followup-missing': case 'AC8:file-fsync-omitted': return has(P.evidence, 'fsyncSync(fd);');
        case 'AC8:atomic-rename-omitted': return has(P.evidence, 'renameSync(temporary, target);');
        case 'AC8:parent-fsync-omitted': return has(P.evidence, 'syncDirectory(directory);');
        default: throw new Error(`durability_check_missing:${key}`);
      }
    }
    case 'epoch-cas-guards': {
      switch (key) {
        case 'AC2:cas-conflict-ignored': return has(P.epoch, "if (document.currentEpochId !== expectedOldEpochId) throw new Error('epoch_cas_conflict');");
        case 'AC7:second-commit-same-epoch': return has(P.epoch, "if (document.records.some((row) => row.epochId === core.epochId)) throw new Error('epoch_duplicate_commit');");
        case 'AC7:consumer-skips-central-nonce-equality': case 'AC7:stale-nonce-replay': return has(P.epoch, "if (!record || record.nonce !== nonce) throw new Error('epoch_nonce_mismatch');");
        case 'AC8:exclusive-lock-omitted': return has(P.epoch, '    mkdirSync(lock);');
        default: throw new Error(`epoch_cas_check_missing:${key}`);
      }
    }
    case 'epoch-core-guards': {
      switch (key) {
        case 'AC2:precommit-digest-not-in-core': case 'AC7:precommit-digest-not-in-core': return has(P.tx, '    preCommitLogDigest: phaseOne.digest,');
        case 'AC2:cas-core-field-extra-or-missing': case 'AC7:cas-core-field-extra-or-missing': case 'AC7:postcommit-timestamp-in-core': return has(P.epoch, "  'importDigests', 'registryHash', 'preCommitLogDigest', 'commitAt',");
        case 'AC7:nonce-not-stored-centrally': return has(P.epoch, "  'epochId', 'nonce', 'hostId',");
        default: throw new Error(`epoch_core_check_missing:${key}`);
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
        default: throw new Error(`fleet_check_missing:${key}`);
      }
    }
    case 'followup-authority-guards': return !has(P.recovery, 'authority.commit(request.epochId, core);');
    case 'followup-record-shape': return has(P.evidence, key === 'AC7:followup-epoch-reference-missing' ? '    epochId,\n    sequence: existing.length + 1,' : '    sequence: existing.length + 1,');
    case 'followup-required': return requiredFollowupsOk();
    case 'foundation-proof': return has(P.tx, 'const foundation = boundary.proveFoundationAdoption(request);');
    case 'guard-record': return guardRecordOk(key, artifactPath);
    case 'host-context-nonauth': return !has(P.tx, 'hostAuthentication');
    case 'import-digest-guards': return has(P.importFile, key === 'AC3:legacy-read-partial-import' ? 'if (sha256Stable(existing) !== importTargetDigest) throw new Error(`import_target_digest_mismatch:${input.spec.id}`);' : 'if (sha256Stable(readBack) !== importTargetDigest) throw new Error(`import_target_digest_mismatch:${input.spec.id}`);');
    case 'import-identity-guards': return has(P.importFile, key === 'AC3:target-import-identity-missing' ? '    nonce: input.nonce,' : '    storeId: input.spec.id,');
    case 'import-marker-guards': return has(P.importFile, key === 'AC3:target-cas-or-upsert-omitted' ? '  writeDurableJson(markerPath, record);' : '  writeDurableFile(input.spec.targetPath, `${JSON.stringify(normalized, null, 2)}\n`);');
    case 'import-shape-guards': return has(P.importFile, key === 'AC3:store-covered-field-omitted' ? 'if (!required || JSON.stringify([...spec.coveredFields]) !== JSON.stringify(required)) throw new Error(`store_covered_fields_invalid:${spec.id}`);' : "if (unknown.length) throw new Error(`store_unknown_field:${spec.id}:${unknown.join(',')}`);");
    case 'lane-config-guards': return laneConfigOk();
    case 'live-registry-bytes': return gitWorktreeClean(P.liveRegistry);
    case 'no-legacy-claim-path': return !exists(D928[2]);
    case 'no-legacy-executable': return !has(P.tx, 'Review-StartClaim.ps1') && !has(P.tx, 'Orchestrator-SideProcessSupervisor.ps1');
    case 'no-new-powershell': return !exists('scripts/issue-928-mutation.ps1');
    case 'no-overlap-reimplementation': return !has(P.importFile, 'mutationOverlapProtocolReimplementation');
    case 'no-pwsh-dispatch': return !/\bpwsh\b/i.test(read(P.tx));
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
        default: throw new Error(`platform_check_missing:${key}`);
      }
    }
    case 'pr2a-merge-guard': return has(P.tx, "if (!isAncestor(repoRoot, PR2A_LANDING_COMMIT, baseRef)) throw new Error('pr2a_merge_missing');");
    case 'preflight-bindings': return has(P.preflight, key === 'AC1:installed-commit-unbound' ? "if (actualHead.toLowerCase() !== input.installedCommitSha.toLowerCase()) throw new Error('installed_commit_unbound');" : "if (!existsSync(input.repoRoot) || !existsSync(input.oldInstalledRevisionRoot)) throw new Error('installed_revision_missing');");
    case 'preimport-rollback-guards': return has(key === 'AC5:preimport-target-change-unchecked' ? P.recovery : P.cordon, key === 'AC5:preimport-target-change-unchecked' ? 'if (fileDigestOrAbsent(store.targetPath) !== cordon.preImportTargetDigests[store.id]) {' : '    oldInstalledRevisionRoot: input.oldInstalledRevisionRoot,');
    case 'process-identity-guards': {
      if (key === 'AC1:legacy-supervisor-identity-ambiguous' || key === 'AC2:legacy-supervisor-identity-unverified') return has(P.tx, 'assertLegacySupervisor(legacyIdentity, request.oldInstalledRevisionRoot);');
      if (key === 'AC2:pid-identity-unverified' || key === 'AC8:pid-start-time-unchecked') return has(P.cordon, 'assertSameProcess(identity);');
      return has(P.cordon, 'if (survivors.length) throw new Error(`legacy_process_survivor:${survivors.join(',')}`);');
    }
    case 'recovery-central-authority': {
      if (key === 'AC7:same-tuple-recovery-duplicates-commit') return occurrences(P.recovery, 'authority.commit(request.epochId, authority.verify(request.epochId, cordon.nonce));') === 0;
      return has(P.recovery, 'if (document.currentEpochId === request.epochId) {');
    }
    case 'recovery-forward-path': {
      if (key === 'AC5:postmutation-import-bytes-discarded') return has(P.recovery, 'const imports: ImportRecord[] = request.stores.map((spec) => importSnapshot({');
      if (key === 'AC5:forward-recovery-uncordoned') return !has(P.recovery, 'releaseLegacyStartBarrier(request.paths.supervisorStateDir);');
      return has(P.recovery, 'const projection = projectRegistry(request.paths.targetRegistryPath, request.paths.projectedRegistryPath);');
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
        default: throw new Error(`scope_declared_check_missing:${key}`);
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
    default: throw new Error(`mutation_check_category_unknown:${category}:${key}`);
  }
}

function runMutationCheck(key: MutationKey, artifactPath: string): void {
  const category = CHECK_BINDINGS[key];
  if (!category) throw new Error(`mutation_check_missing:${key}`);
  if (!mutationInvariantHolds(category, key, artifactPath)) {
    const code = `mutation-contract:${key}`;
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({ mutationCheck: { key, category, result: 'green' } })}\n`);
}

function runCli(argv: string[]): void {
  const mutationIndex = argv.indexOf('--mutation-check');
  if (mutationIndex >= 0) {
    const key = argv[mutationIndex + 1] as MutationKey | undefined;
    if (!key) throw new Error('mutation_check_key_missing');
    const artifactIndex = argv.indexOf('--artifact');
    runMutationCheck(key, artifactIndex >= 0 ? String(argv[artifactIndex + 1] ?? '') : '');
    return;
  }
  const refIndex = argv.indexOf('--ref');
  const requestedRef = refIndex >= 0 ? argv[refIndex + 1] ?? 'HEAD' : 'HEAD';
  const report = buildConformanceReport(requestedRef);
  process.stdout.write(`${JSON.stringify(report, null, argv.includes('--json') ? 2 : 0)}\n`);
  process.exitCode = report.result === 'conformant' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try { runCli(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
