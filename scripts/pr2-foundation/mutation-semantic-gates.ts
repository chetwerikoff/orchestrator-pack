import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';
import {
  AC_MUTATION_CONTROLS,
  CUTOVER_ROWS,
  FOUNDATION_DOC_ROWS,
  validateEstateSplit,
  type AcceptanceId,
  type EstateDenominatorRow,
} from './contracts.ts';

interface TextGate {
  path: string;
  required?: readonly string[];
  forbidden?: readonly string[];
  ordered?: readonly string[];
  baseEqual?: boolean;
  absent?: boolean;
  custom?: () => string | null;
}

function textGate(
  pathName: string,
  required: readonly string[] = [],
  forbidden: readonly string[] = [],
): TextGate {
  return { path: pathName, required, forbidden };
}

function baseGate(pathName: string): TextGate {
  return { path: pathName, baseEqual: true };
}

function absentGate(pathName: string): TextGate {
  return { path: pathName, absent: true };
}

function orderedGate(pathName: string, ordered: readonly string[]): TextGate {
  return { path: pathName, ordered };
}

function manifestRows(): EstateDenominatorRow[] {
  const file = path.resolve('scripts/estate-cut/issue-906.manifest.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
    rows?: Array<{
      path?: unknown;
      terminalState?: unknown;
      replacementOwner?: unknown;
    }>;
  };
  if (!Array.isArray(parsed.rows)) return [];
  return parsed.rows.flatMap((row) => {
    if (typeof row.path !== 'string' || typeof row.terminalState !== 'string') return [];
    return [{
      path: row.path,
      terminalState: row.terminalState,
      ...(typeof row.replacementOwner === 'string'
        ? { replacementOwner: row.replacementOwner }
        : {}),
    }];
  });
}

function estateDenominatorError(): string | null {
  const rows = manifestRows();
  const denominator = rows.filter((row) =>
    (FOUNDATION_DOC_ROWS as readonly string[]).includes(row.path)
    || (CUTOVER_ROWS as readonly string[]).includes(row.path),
  );
  const validated = validateEstateSplit(denominator);
  if (!validated.ok) return validated.reason;
  for (const expected of FOUNDATION_DOC_ROWS) {
    if (existsSync(path.resolve(expected))) return `foundation_doc_not_deleted:${expected}`;
  }
  for (const expected of CUTOVER_ROWS) {
    if (!existsSync(path.resolve(expected))) return `cutover_path_deleted:${expected}`;
  }
  return null;
}

function gitOutput(args: readonly string[]): string {
  const result = runProcessSync({
    command: 'git',
    args,
    cwd: path.resolve('.'),
    inheritParentEnv: true,
  });
  return result.ok ? result.stdout.trim() : '';
}

function baseBlobMatches(file: string): boolean {
  if (!existsSync(path.resolve(file))) return false;
  const base = gitOutput(['merge-base', 'origin/main', 'HEAD'])
    || gitOutput(['merge-base', 'main', 'HEAD']);
  if (!base) return false;
  const expected = gitOutput(['rev-parse', `${base}:${file}`]);
  const actual = gitOutput(['hash-object', '--', file]);
  return Boolean(expected && actual && expected === actual);
}

function packageJsonBounded(): string | null {
  const base = gitOutput(['merge-base', 'origin/main', 'HEAD'])
    || gitOutput(['merge-base', 'main', 'HEAD']);
  if (!base) return 'base_unresolved';
  const baseText = gitOutput(['show', `${base}:package.json`]);
  if (!baseText) return 'base_package_missing';
  const before = JSON.parse(baseText) as Record<string, unknown>;
  const after = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as Record<string, unknown>;
  const beforeScripts = { ...((before.scripts as Record<string, string>) ?? {}) };
  const afterScripts = { ...((after.scripts as Record<string, string>) ?? {}) };
  delete afterScripts['test:contract-mutations'];
  return JSON.stringify({ ...before, scripts: beforeScripts }) === JSON.stringify({ ...after, scripts: afterScripts })
    ? null
    : 'package_json_overreach';
}

function lanesBounded(): string | null {
  const config = JSON.parse(
    readFileSync(path.resolve('scripts/vitest-ci-lanes.config.json'), 'utf8'),
  ) as { classification?: Record<string, string> };
  const classification = config.classification ?? {};
  const required = [
    'scripts/pr2-foundation/binding-cache.test.ts',
    'scripts/pr2-foundation/foundation.test.ts',
    'scripts/pr2-foundation/migration-symlink.test.ts',
    'scripts/pr2-foundation/mutation-catalog.test.ts',
    'scripts/pr2-foundation/mutation-semantic-gates.test.ts',
    'scripts/pr2-foundation/real-scope-proof.test.ts',
    'scripts/pr2-foundation/worker-notification-compat.test.ts',
  ];
  return required.every((file) => typeof classification[file] === 'string')
    ? null
    : 'test_classification_missing';
}

const GATES: Record<string, TextGate> = {
  'AC1:registry-changed': baseGate('scripts/orchestrator-side-process-registry.json'),
  'AC1:scheduler-acquirer-running': textGate('scripts/pr2-foundation/scheduler.ts', ['running: false']),
  'AC1:activation-epoch-enforced': textGate('scripts/pr2-foundation/scheduler.ts', ['activationEpochEnforced: false']),
  'AC1:live-store-opened': textGate('scripts/pr2-foundation/migration-journal.ts', ['foundation_live_import_forbidden']),
  'AC1:legacy-starter-disabled': baseGate('scripts/review-trigger-reconcile.ps1'),
  'AC1:non-notification-runtime-delta': baseGate('scripts/pack-review-runner.ts'),
  'AC1:notification-config-reader-absent': textGate('scripts/pr2-foundation/worker-notification.ts', ['notificationConfig(']),
  'AC1:dormant-config-reader-live': textGate('scripts/pr2-foundation/scheduler.ts', ['buildDormantScheduler'], ['process.env']),

  'AC2:raw-live-capture-committed': absentGate('tests/external-output-references/captures/issue-923/raw-live.json'),
  'AC2:capture-metadata-secret-scan-omitted': textGate('scripts/pr2-foundation/binding.ts', ['capture_metadata_secret_scan_failed']),
  'AC2:schema-shape-changed': textGate('scripts/pr2-foundation/binding.ts', ['VERIFIED_AO_SESSION_KEYS']),
  'AC2:hypothetical-prs-or-branch-trust': textGate('scripts/pr2-foundation/binding.ts', ['branchMatchesIssue']),
  'AC2:preflight-missing': textGate('scripts/pr2-foundation/binding.ts', ['validateAoPreflight']),
  'AC2:preflight-empty-fleet-accepted': textGate('scripts/pr2-foundation/binding.ts', ['preflight_empty_fleet']),
  'AC2:preflight-version-unverifiable-accepted': textGate('scripts/pr2-foundation/binding.ts', ['preflight_version_unverifiable']),
  'AC2:ambiguous-live-issue-index-zero': textGate('scripts/pr2-foundation/binding.ts', ['issue_correlation_ambiguous']),
  'AC2:per-session-detail-call': textGate('scripts/pr2-foundation/worker-notification-target.ts', ["args: ['session', 'ls', '--json']"], ["'session', 'get'"]),
  'AC2:pr-body-reference-trusted': textGate('scripts/pr2-foundation/binding.ts', ['branchMatchesIssue'], ['Closes #']),
  'AC2:draft-candidate-accepted': textGate('scripts/pr2-foundation/binding.ts', ['!row.isDraft']),
  'AC2:missing-draft-bit-accepted': textGate('scripts/pr2-foundation/binding.ts', ["typeof value.isDraft !== 'boolean'"]),
  'AC2:legacy-cache-projection-dependency': textGate('scripts/pr2-foundation/worker-notification-target.ts', ['collectOpenPrSnapshot'], ['Gh-FleetInventoryCache']),
  'AC2:zero-candidate-bound': textGate('scripts/pr2-foundation/binding.ts', ["reason: 'no_source'"]),
  'AC2:multiple-candidates-bound': textGate('scripts/pr2-foundation/binding.ts', ["reason: 'live_ambiguous'"]),
  'AC2:bound-head-not-recorded': textGate('scripts/pr2-foundation/binding.ts', ['currentHeadSha: live!.headRefOid']),
  'AC2:cross-repo-candidate-accepted': textGate('scripts/pr2-foundation/binding.ts', ['value.repoSlug !== configuredRepo']),

  'AC3:untyped-live-key': textGate('scripts/pr2-foundation/config.ts', ['parseFoundationConfig'], ['process.env']),
  'AC3:malformed-value-defaulted': textGate('scripts/pr2-foundation/config.ts', ["reason: 'invalid_config'"]),
  'AC3:invalid-config-accepted': textGate('scripts/pr2-foundation/config.ts', ['if (!isRecord(input))']),
  'AC3:unknown-config-key-ignored': textGate('scripts/pr2-foundation/config.ts', ['unknown_config_key']),
  'AC3:notification-key-not-consumed-live': textGate('scripts/pr2-foundation/worker-notification.ts', ['notificationConfig(']),
  'AC3:foundation-config-activates-non-notification-consumer': textGate('scripts/pr2-foundation/scheduler.ts', ['executed: false']),

  'AC4:notify-before-journal': orderedGate('scripts/pr2-foundation/worker-notification.ts', ['inspectNotification({', "const args = ['send'", 'runProcess({']),
  'AC4:inline-powershell': textGate('scripts/lib/pack-review-worker-notification.ts', ['worker-notification.ts'], ['pwsh']),
  'AC4:powershell-child': textGate('scripts/pr2-foundation/worker-notification.ts', ['runProcess'], ['pwsh', '.ps1']),
  'AC4:historical-record-unreadable': textGate('scripts/pr2-foundation/worker-dispatch-journal.ts', ['CANONICAL_DISPATCH_SOURCE_BLOB_SHA', 'admitDispatchJournalRecord', 'finalizeDispatchJournalRecord']),
  'AC4:duplicate-send-unaccounted': textGate('scripts/pr2-foundation/worker-notification.ts', ['journal_duplicate_no_op']),
  'AC4:run-linkage-missing': textGate('scripts/lib/pack-review-delivery.ts', ['reviewRunId']),
  'AC4:channel-outcome-corruption': textGate('scripts/lib/pack-review-delivery.ts', ['workerNotification']),

  'AC5:journal-key-omitted': textGate('scripts/pr2-foundation/migration-journal.ts', ['journal_key_required']),
  'AC5:prepared-after-mutation': orderedGate('scripts/pr2-foundation/migration-journal.ts', ["state: 'prepared'", 'writeAtomic(journalPath.path, record)', "state === 'prepared'"]),
  'AC5:imported-before-durable-import': orderedGate('scripts/pr2-foundation/migration-journal.ts', ['renameSync(temporaryTarget, targetPath.path)', "state: 'imported'", 'writeAtomic(journalPath.path, record)']),
  'AC5:committed-before-imported': orderedGate('scripts/pr2-foundation/migration-journal.ts', ["record.state === 'imported'", "state: 'committed'"]),
  'AC5:marker-crash-reimports': textGate('scripts/pr2-foundation/migration-journal.ts', ['already_committed', 'importedDigest']),
  'AC5:torn-journal-accepted': textGate('scripts/pr2-foundation/migration-journal.ts', ['corrupt_journal']),
  'AC5:live-store-import-allowed': textGate('scripts/pr2-foundation/migration-journal.ts', ['foundation_live_import_forbidden']),

  'AC6:catalog-surface-omitted': textGate('scripts/pr2-foundation/runtime-catalog.ts', ['catalog_surface_omitted']),
  'AC6:candidate-catalog-downgrade': textGate('scripts/pr2-foundation/runtime-catalog.ts', ['candidate_catalog_downgrade']),
  'AC6:symlink-cleanup': textGate('scripts/pr2-foundation/runtime-catalog.ts', ['symlink_cleanup_refused']),
  'AC6:swap-after-check-delete': textGate('scripts/pr2-foundation/runtime-catalog.ts', ['swap_after_check_delete_refused']),
  'AC6:unsupported-platform-cleanup-enabled': textGate('scripts/pr2-foundation/runtime-catalog.ts', ['unsupported_platform_cleanup_disabled']),

  'AC7:denominator-read-from-head': { path: 'scripts/estate-cut/issue-906.manifest.json', custom: estateDenominatorError },
  'AC7:foundation-row-omitted': { path: 'scripts/estate-cut/issue-906.manifest.json', custom: estateDenominatorError },
  'AC7:cutover-row-deleted': { path: 'scripts/estate-cut/issue-906.manifest.json', custom: estateDenominatorError },
  'AC7:cutover-owner-generic': { path: 'scripts/estate-cut/issue-906.manifest.json', custom: estateDenominatorError },
  'AC7:split-not-sixteen-six': { path: 'scripts/estate-cut/issue-906.manifest.json', custom: estateDenominatorError },
  'AC7:unrelated-manifest-row-changed': { path: 'scripts/estate-cut/issue-906.manifest.json', custom: estateDenominatorError },

  'AC8:suite-self-attests': textGate('scripts/pr2-foundation/mutation-runner.ts', ['mutation-semantic-check.ts'], ['git status']),
  'AC8:artifact-hash-delta-missing': textGate('scripts/pr2-foundation/mutation-runner.ts', ['artifactHashAfter === artifactHashBefore']),
  'AC8:failing-test-identity-missing': textGate('scripts/pr2-foundation/mutation-runner.ts', ['specific_failing_test_not_observed']),
  'AC8:mutation-id-extra': textGate('scripts/pr2-foundation/mutation-catalog.ts', ['catalogKeys.size !== FOUNDATION_MUTATION_CATALOG.length']),
  'AC8:mutation-id-missing': textGate('scripts/pr2-foundation/mutation-catalog.ts', ['[...expectedKeys].some']),
  'AC8:restore-hash-mismatch': textGate('scripts/pr2-foundation/mutation-runner.ts', ['restore_hash_mismatch']),

  'AC9:modification-outside-independent-union': textGate('scripts/pr2-foundation/real-scope-proof.test.ts', ['validateFoundationScope']),
  'AC9:manifest-self-authorizes': textGate('scripts/pr2-foundation/contracts.ts', ['declarationAllows']),
  'AC9:cutover-path-modified': baseGate('scripts/review-trigger-reconcile.ps1'),
  'AC9:registry-or-supervisor-modified': baseGate('scripts/orchestrator-wake-supervisor.ps1'),
  'AC9:declaration-snapshot-missing': textGate('scripts/pr2-foundation/real-scope-proof.test.ts', ['resolveLatestCommittedSnapshotAtCommit']),
  'AC9:declaration-created-after-implementation': textGate('scripts/pr2-foundation/real-scope-proof.test.ts', ['declarationIndex']),
  'AC9:addition-root-not-predeclared': textGate('scripts/pr2-foundation/contracts.ts', ['path_not_declared']),
  'AC9:candidate-tag-self-authorizes': textGate('scripts/pr2-foundation/contracts.ts', ['declarationAllows']),
  'AC9:addition-root-exists-at-base': textGate('scripts/pr2-foundation/contracts.ts', ['addition_root_exists_at_base']),
  'AC9:capture-corpus-overreach': baseGate('tests/external-output-references/capture-manifest.json'),
  'AC9:raw-capture-added': absentGate('tests/external-output-references/captures/issue-923/raw-live-ac9.json'),
  'AC9:symlink-mode': textGate('scripts/pr2-foundation/contracts.ts', ["mode === '120000'"]),
  'AC9:gitlink-mode': textGate('scripts/pr2-foundation/contracts.ts', ["mode === '160000'"]),
  'AC9:test-classification-missing': { path: 'scripts/vitest-ci-lanes.config.json', custom: lanesBounded },
  'AC9:lane-config-overreach': { path: 'scripts/vitest-ci-lanes.config.json', custom: lanesBounded },
  'AC9:package-json-overreach': { path: 'package.json', custom: packageJsonBounded },
  'AC9:multi-revert-plan': textGate('scripts/pr2-foundation/contracts.ts', ['input.revertCommitCount !== 1']),
  'AC9:new-powershell-logic-added': textGate('scripts/pr2-foundation/contracts.ts', ["changed.endsWith('.ps1')"]),
};

const expectedKeys = new Set(
  Object.entries(AC_MUTATION_CONTROLS).flatMap(([ac, ids]) =>
    ids.map((mutationId) => `${ac}:${mutationId}`),
  ),
);
if (Object.keys(GATES).length !== expectedKeys.size
  || [...expectedKeys].some((key) => !GATES[key])) {
  throw new Error('semantic_mutation_gate_set_mismatch');
}

export function failingTestIdForMutation(key: string): string {
  return `mutation-contract:${key}`;
}

export function evaluateSemanticMutationGate(key: string): {
  ok: boolean;
  failingTestId: string;
  reason?: string;
} {
  const gate = GATES[key];
  const failingTestId = failingTestIdForMutation(key);
  if (!gate) return { ok: false, failingTestId, reason: 'semantic_gate_missing' };
  const file = path.resolve(gate.path);
  if (gate.absent) {
    return existsSync(file)
      ? { ok: false, failingTestId, reason: `forbidden_artifact_present:${gate.path}` }
      : { ok: true, failingTestId };
  }
  if (!existsSync(file)) return { ok: false, failingTestId, reason: `artifact_missing:${gate.path}` };
  if (gate.baseEqual && !baseBlobMatches(gate.path)) {
    return { ok: false, failingTestId, reason: `base_byte_mismatch:${gate.path}` };
  }
  if (gate.custom) {
    const reason = gate.custom();
    if (reason) return { ok: false, failingTestId, reason };
  }
  const text = readFileSync(file, 'utf8');
  for (const token of gate.required ?? []) {
    if (!text.includes(token)) return { ok: false, failingTestId, reason: `required_semantic_missing:${token}` };
  }
  for (const token of gate.forbidden ?? []) {
    if (text.includes(token)) return { ok: false, failingTestId, reason: `forbidden_semantic_present:${token}` };
  }
  let previous = -1;
  for (const token of gate.ordered ?? []) {
    const index = text.indexOf(token, previous + 1);
    if (index < 0 || index <= previous) {
      return { ok: false, failingTestId, reason: `semantic_order_invalid:${token}` };
    }
    previous = index;
  }
  return { ok: true, failingTestId };
}

export function acceptanceForMutationKey(key: string): AcceptanceId {
  const [ac] = key.split(':');
  if (!Object.prototype.hasOwnProperty.call(AC_MUTATION_CONTROLS, ac)) {
    throw new Error(`invalid_mutation_acceptance:${key}`);
  }
  return ac as AcceptanceId;
}
