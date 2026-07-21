import { createHash } from 'node:crypto';

export const FOUNDATION_DOC_ROWS = Object.freeze([
  'docs/ao-0-10-review-api.mjs',
  'docs/autonomous-review-retry.mjs',
  'docs/events-optional-consumer-signal-recovery.d.mts',
  'docs/events-optional-consumer-signal-recovery.mjs',
  'docs/orchestrator-wake-filter.mjs',
  'docs/review-bulk-send-diagnose.mjs',
  'docs/review-finding-delivery-confirm.mjs',
  'docs/review-head-ready.mjs',
  'docs/review-producer-contract.mjs',
  'docs/review-send-reconcile.mjs',
  'docs/review-trigger-reconcile.mjs',
  'docs/review-wake-trigger.mjs',
  'docs/reviewer-failure-evidence-markers.mjs',
  'docs/worker-iteration-cycle.mjs',
  'docs/worker-message-dispatch-observe.mjs',
  'docs/worker-report-store.mjs',
] as const);

export const CUTOVER_ROWS = Object.freeze([
  'scripts/lib/Get-ReactionMessagesFromYaml.ps1',
  'scripts/reaction-config-messages.d.mts',
  'scripts/reaction-config-messages.mjs',
  'scripts/review-ready-report-state-seed.ps1',
  'scripts/review-trigger-reconcile.ps1',
  'scripts/review-trigger-reeval.ps1',
] as const);

export const PROTECTED_RUNTIME_PATHS = Object.freeze([
  'scripts/orchestrator-side-process-registry.json',
  'scripts/orchestrator-wake-supervisor.ps1',
  'scripts/orchestrator-wake-supervisor.test.ts',
  'scripts/orchestrator-wake-supervisor-side-process-registry.test.ts',
  ...CUTOVER_ROWS,
] as const);

export const EXACT_EXISTING_SCOPE_PATHS = Object.freeze([
  'scripts/estate-cut/issue-906.manifest.json',
  'agent-orchestrator.yaml.example',
  'scripts/lib/pack-review-worker-notification.ts',
  'scripts/lib/pack-review-delivery.ts',
  'scripts/lib/pack-review-delivery.js',
  'scripts/pack-review-runner.ts',
  'scripts/pack-review-worker-notification.cases.ts',
  'tests/external-output-references/capture-manifest.json',
  'scripts/vitest-ci-lanes.config.json',
  'package.json',
  'docs/migration_notes.md',
  'docs/orchestrator-recovery-runbook.md',
] as const);

export const AC_MUTATION_CONTROLS = Object.freeze({
  AC1: [
    'registry-changed', 'scheduler-acquirer-running', 'activation-epoch-enforced',
    'live-store-opened', 'legacy-starter-disabled', 'non-notification-runtime-delta',
    'notification-config-reader-absent', 'dormant-config-reader-live',
  ],
  AC2: [
    'raw-live-capture-committed', 'capture-metadata-secret-scan-omitted', 'schema-shape-changed',
    'hypothetical-prs-or-branch-trust', 'preflight-missing', 'preflight-empty-fleet-accepted',
    'preflight-version-unverifiable-accepted', 'ambiguous-live-issue-index-zero',
    'per-session-detail-call', 'pr-body-reference-trusted', 'draft-candidate-accepted',
    'missing-draft-bit-accepted', 'legacy-cache-projection-dependency', 'zero-candidate-bound',
    'multiple-candidates-bound', 'bound-head-not-recorded', 'cross-repo-candidate-accepted',
  ],
  AC3: [
    'untyped-live-key', 'malformed-value-defaulted', 'invalid-config-accepted',
    'unknown-config-key-ignored', 'notification-key-not-consumed-live',
    'foundation-config-activates-non-notification-consumer',
  ],
  AC4: [
    'notify-before-journal', 'inline-powershell', 'powershell-child',
    'historical-record-unreadable', 'duplicate-send-unaccounted', 'run-linkage-missing',
    'channel-outcome-corruption',
  ],
  AC5: [
    'journal-key-omitted', 'prepared-after-mutation', 'imported-before-durable-import',
    'committed-before-imported', 'marker-crash-reimports', 'torn-journal-accepted',
    'live-store-import-allowed',
  ],
  AC6: [
    'catalog-surface-omitted', 'candidate-catalog-downgrade', 'symlink-cleanup',
    'swap-after-check-delete', 'unsupported-platform-cleanup-enabled',
  ],
  AC7: [
    'denominator-read-from-head', 'foundation-row-omitted', 'cutover-row-deleted',
    'cutover-owner-generic', 'split-not-sixteen-six', 'unrelated-manifest-row-changed',
  ],
  AC8: [
    'suite-self-attests', 'artifact-hash-delta-missing', 'failing-test-identity-missing',
    'mutation-id-extra', 'mutation-id-missing', 'restore-hash-mismatch',
  ],
  AC9: [
    'modification-outside-independent-union', 'manifest-self-authorizes', 'cutover-path-modified',
    'registry-or-supervisor-modified', 'declaration-snapshot-missing',
    'declaration-created-after-implementation', 'addition-root-not-predeclared',
    'candidate-tag-self-authorizes', 'addition-root-exists-at-base', 'capture-corpus-overreach',
    'raw-capture-added', 'symlink-mode', 'gitlink-mode', 'test-classification-missing',
    'lane-config-overreach', 'package-json-overreach', 'multi-revert-plan',
    'new-powershell-logic-added',
  ],
} as const);

export type AcceptanceId = keyof typeof AC_MUTATION_CONTROLS;

export interface DeclarationSnapshotShape {
  issue_number: number;
  created_at: string;
  baseline: { commit_sha: string };
  declared_paths: string[];
  declared_globs: string[];
}

export interface EstateDenominatorRow {
  path: string;
  terminalState: string;
  replacementOwner?: string;
}

export function validateEstateSplit(
  rows: EstateDenominatorRow[],
): { ok: true; result: 'foundation-16-cutover-6' } | { ok: false; reason: string } {
  const expected = new Set<string>([...FOUNDATION_DOC_ROWS, ...CUTOVER_ROWS]);
  const relevant = rows.filter((row) => expected.has(row.path));
  const byPath = new Map(relevant.map((row) => [row.path, row]));
  if (relevant.length !== expected.size || byPath.size !== expected.size) {
    return { ok: false, reason: 'denominator_not_exactly_twenty_two_rows' };
  }
  for (const path of FOUNDATION_DOC_ROWS) {
    const row = byPath.get(path);
    if (!row || row.terminalState !== 'deleted-now') {
      return { ok: false, reason: `foundation_row_not_terminal:${path}` };
    }
    if (row.replacementOwner) return { ok: false, reason: `foundation_row_owner_survived:${path}` };
  }
  for (const path of CUTOVER_ROWS) {
    const row = byPath.get(path);
    if (!row || row.terminalState !== 'owned-by-PR-2-cutover' || row.replacementOwner !== 'draft 315') {
      return { ok: false, reason: `cutover_row_invalid:${path}` };
    }
  }
  return { ok: true, result: 'foundation-16-cutover-6' };
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function globPrefix(glob: string): string {
  const index = glob.search(/[?*[]/);
  return normalize(index < 0 ? glob : glob.slice(0, index)).replace(/\/$/, '');
}

function declarationAllows(path: string, declaration: DeclarationSnapshotShape): boolean {
  const normalized = normalize(path);
  if (declaration.declared_paths.map(normalize).includes(normalized)) return true;
  return declaration.declared_globs.some((glob) => {
    const prefix = globPrefix(glob);
    return Boolean(prefix) && (normalized === prefix || normalized.startsWith(`${prefix}/`));
  });
}

export function validateFoundationScope(input: {
  issueNumber: number;
  baseCommitSha: string;
  declaration: DeclarationSnapshotShape | null;
  changedPaths: string[];
  addedPaths: string[];
  basePaths: string[];
  derivedRewritePaths?: string[];
  modes: Record<string, string>;
  laneClassification: Record<string, string>;
  packageJsonChangedKeys?: string[];
  revertCommitCount: number;
}): { ok: true; result: 'foundation-bounded-regular-single-revert' } | { ok: false; reason: string } {
  const declaration = input.declaration;
  if (!declaration || declaration.issue_number !== input.issueNumber) {
    return { ok: false, reason: 'declaration_snapshot_missing' };
  }
  if (declaration.baseline.commit_sha !== input.baseCommitSha) {
    return { ok: false, reason: 'declaration_baseline_mismatch' };
  }
  if (Date.parse(declaration.created_at) > Date.now()) return { ok: false, reason: 'declaration_timestamp_invalid' };

  const base = new Set(input.basePaths.map(normalize));
  const added = new Set(input.addedPaths.map(normalize));
  const derived = new Set((input.derivedRewritePaths ?? []).map(normalize));
  const exactExisting = new Set<string>([...EXACT_EXISTING_SCOPE_PATHS, ...FOUNDATION_DOC_ROWS].map(normalize));

  for (const changed of input.changedPaths.map(normalize)) {
    if ((PROTECTED_RUNTIME_PATHS as readonly string[]).includes(changed)) {
      return { ok: false, reason: `protected_runtime_path_changed:${changed}` };
    }
    if (added.has(changed)) {
      if (!declarationAllows(changed, declaration)) {
        return { ok: false, reason: `addition_not_declared:${changed}` };
      }
    } else if (!exactExisting.has(changed) && !derived.has(changed)) {
      return { ok: false, reason: `modification_outside_independent_union:${changed}` };
    }
    if (changed.endsWith('.ps1') && added.has(changed)) {
      return { ok: false, reason: `new_powershell_logic_added:${changed}` };
    }
    const mode = input.modes[changed] ?? '100644';
    if (mode === '120000') return { ok: false, reason: `symlink_mode:${changed}` };
    if (mode === '160000') return { ok: false, reason: `gitlink_mode:${changed}` };
    if (!['100644', '100755'].includes(mode)) return { ok: false, reason: `non_regular_mode:${changed}` };
  }

  for (const addedPath of added) {
    if (base.has(addedPath)) return { ok: false, reason: `addition_root_exists_at_base:${addedPath}` };
  }
  const newTests = [...added].filter((path) => /^scripts\/.*\.test\.ts$/.test(path));
  for (const test of newTests) {
    if (!input.laneClassification[test]) return { ok: false, reason: `test_classification_missing:${test}` };
  }
  if ((input.packageJsonChangedKeys ?? []).some((key) => key !== 'scripts.test:contract-mutations')) {
    return { ok: false, reason: 'package_json_overreach' };
  }
  if (input.revertCommitCount !== 1) return { ok: false, reason: 'multi_revert_plan' };
  return { ok: true, result: 'foundation-bounded-regular-single-revert' };
}

export function mutationControlDigest(): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(AC_MUTATION_CONTROLS)).digest('hex')}`;
}

export function validateMutationEvidence(input: Array<{
  ac: AcceptanceId;
  mutationId: string;
  executed: boolean;
  artifactHashBefore: string;
  artifactHashAfter: string;
  failingTestId: string;
  negativeOutcome: string;
  restoredHash: string;
  restoredOutcome: string;
}>): { ok: true; result: 'externally-grounded' } | { ok: false; reason: string } {
  const expected = new Set(
    Object.entries(AC_MUTATION_CONTROLS).flatMap(([ac, ids]) => ids.map((id) => `${ac}:${id}`)),
  );
  const actual = new Set(input.map((row) => `${row.ac}:${row.mutationId}`));
  if (actual.size !== input.length) return { ok: false, reason: 'mutation_id_duplicate' };
  if (expected.size !== actual.size || [...expected].some((id) => !actual.has(id))) {
    return { ok: false, reason: 'mutation_id_set_mismatch' };
  }
  for (const row of input) {
    if (!row.executed) return { ok: false, reason: `mutation_not_executed:${row.mutationId}` };
    if (!row.artifactHashBefore || row.artifactHashBefore === row.artifactHashAfter) {
      return { ok: false, reason: `artifact_hash_delta_missing:${row.mutationId}` };
    }
    if (!row.failingTestId.trim() || row.negativeOutcome !== 'failed') {
      return { ok: false, reason: `failing_test_identity_missing:${row.mutationId}` };
    }
    if (row.restoredHash !== row.artifactHashBefore || row.restoredOutcome !== 'passed') {
      return { ok: false, reason: `restore_hash_mismatch:${row.mutationId}` };
    }
  }
  return { ok: true, result: 'externally-grounded' };
}
