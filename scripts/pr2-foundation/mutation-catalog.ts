import { AC_MUTATION_CONTROLS, type AcceptanceId } from './contracts.ts';

export type MutationStrategy = 'bounded-semantic' | 'create';

export interface MutationBinding {
  ac: AcceptanceId;
  mutationId: string;
  artifactPath: string;
  strategy: MutationStrategy;
  failingTestId: string;
}

function entries(
  ac: AcceptanceId,
  artifactByMutation: Record<string, string>,
  strategyByMutation: Partial<Record<string, MutationStrategy>> = {},
): MutationBinding[] {
  return AC_MUTATION_CONTROLS[ac].map((mutationId) => {
    const artifactPath = artifactByMutation[mutationId];
    if (!artifactPath) throw new Error(`mutation_binding_missing:${ac}:${mutationId}`);
    return {
      ac,
      mutationId,
      artifactPath,
      strategy: strategyByMutation[mutationId] ?? 'bounded-semantic',
      failingTestId: `mutation-contract:${ac}:${mutationId}`,
    };
  });
}

export const FOUNDATION_MUTATION_CATALOG: readonly MutationBinding[] = Object.freeze([
  ...entries('AC1', {
    'registry-changed': 'scripts/orchestrator-side-process-registry.json',
    'scheduler-acquirer-running': 'scripts/pr2-foundation/scheduler.ts',
    'activation-epoch-enforced': 'scripts/pr2-foundation/scheduler.ts',
    'live-store-opened': 'scripts/pr2-foundation/migration-journal.ts',
    'legacy-starter-disabled': 'scripts/review-trigger-reconcile.ps1',
    'non-notification-runtime-delta': 'scripts/pack-review-runner.ts',
    'notification-config-reader-absent': 'scripts/pr2-foundation/worker-notification.ts',
    'dormant-config-reader-live': 'scripts/pr2-foundation/scheduler.ts',
  }),
  ...entries('AC2', {
    'raw-live-capture-committed': 'tests/external-output-references/captures/issue-923/raw-live.json',
    'capture-metadata-secret-scan-omitted': 'scripts/pr2-foundation/binding.ts',
    'schema-shape-changed': 'scripts/pr2-foundation/binding.ts',
    'hypothetical-prs-or-branch-trust': 'scripts/pr2-foundation/binding.ts',
    'preflight-missing': 'scripts/pr2-foundation/binding.ts',
    'preflight-empty-fleet-accepted': 'scripts/pr2-foundation/binding.ts',
    'preflight-version-unverifiable-accepted': 'scripts/pr2-foundation/binding.ts',
    'ambiguous-live-issue-index-zero': 'scripts/pr2-foundation/binding.ts',
    'per-session-detail-call': 'scripts/pr2-foundation/worker-notification-target.ts',
    'pr-body-reference-trusted': 'scripts/pr2-foundation/binding.ts',
    'draft-candidate-accepted': 'scripts/pr2-foundation/binding.ts',
    'missing-draft-bit-accepted': 'scripts/pr2-foundation/binding.ts',
    'legacy-cache-projection-dependency': 'scripts/pr2-foundation/worker-notification-target.ts',
    'zero-candidate-bound': 'scripts/pr2-foundation/binding.ts',
    'multiple-candidates-bound': 'scripts/pr2-foundation/binding.ts',
    'bound-head-not-recorded': 'scripts/pr2-foundation/binding.ts',
    'cross-repo-candidate-accepted': 'scripts/pr2-foundation/binding.ts',
  }, {
    'raw-live-capture-committed': 'create',
  }),
  ...entries('AC3', {
    'untyped-live-key': 'scripts/pr2-foundation/config.ts',
    'malformed-value-defaulted': 'scripts/pr2-foundation/config.ts',
    'invalid-config-accepted': 'scripts/pr2-foundation/config.ts',
    'unknown-config-key-ignored': 'scripts/pr2-foundation/config.ts',
    'notification-key-not-consumed-live': 'scripts/pr2-foundation/worker-notification.ts',
    'foundation-config-activates-non-notification-consumer': 'scripts/pr2-foundation/scheduler.ts',
  }),
  ...entries('AC4', {
    'notify-before-journal': 'scripts/pr2-foundation/worker-notification.ts',
    'inline-powershell': 'scripts/lib/pack-review-worker-notification.ts',
    'powershell-child': 'scripts/pr2-foundation/worker-notification.ts',
    'historical-record-unreadable': 'scripts/pr2-foundation/worker-dispatch-journal.ts',
    'duplicate-send-unaccounted': 'scripts/pr2-foundation/worker-notification.ts',
    'run-linkage-missing': 'scripts/lib/pack-review-delivery.ts',
    'channel-outcome-corruption': 'scripts/lib/pack-review-delivery.ts',
  }),
  ...entries('AC5', {
    'journal-key-omitted': 'scripts/pr2-foundation/migration-journal.ts',
    'prepared-after-mutation': 'scripts/pr2-foundation/migration-journal.ts',
    'imported-before-durable-import': 'scripts/pr2-foundation/migration-journal.ts',
    'committed-before-imported': 'scripts/pr2-foundation/migration-journal.ts',
    'marker-crash-reimports': 'scripts/pr2-foundation/migration-journal.ts',
    'torn-journal-accepted': 'scripts/pr2-foundation/migration-journal.ts',
    'live-store-import-allowed': 'scripts/pr2-foundation/migration-journal.ts',
  }),
  ...entries('AC6', {
    'catalog-surface-omitted': 'scripts/pr2-foundation/runtime-catalog.ts',
    'candidate-catalog-downgrade': 'scripts/pr2-foundation/runtime-catalog.ts',
    'symlink-cleanup': 'scripts/pr2-foundation/runtime-catalog.ts',
    'swap-after-check-delete': 'scripts/pr2-foundation/runtime-catalog.ts',
    'unsupported-platform-cleanup-enabled': 'scripts/pr2-foundation/runtime-catalog.ts',
  }),
  ...entries('AC7', {
    'denominator-read-from-head': 'scripts/estate-cut/issue-906.manifest.json',
    'foundation-row-omitted': 'scripts/estate-cut/issue-906.manifest.json',
    'cutover-row-deleted': 'scripts/estate-cut/issue-906.manifest.json',
    'cutover-owner-generic': 'scripts/estate-cut/issue-906.manifest.json',
    'split-not-sixteen-six': 'scripts/estate-cut/issue-906.manifest.json',
    'unrelated-manifest-row-changed': 'scripts/estate-cut/issue-906.manifest.json',
  }),
  ...entries('AC8', {
    'suite-self-attests': 'scripts/pr2-foundation/mutation-runner.ts',
    'artifact-hash-delta-missing': 'scripts/pr2-foundation/mutation-runner.ts',
    'failing-test-identity-missing': 'scripts/pr2-foundation/mutation-runner.ts',
    'mutation-id-extra': 'scripts/pr2-foundation/mutation-catalog.ts',
    'mutation-id-missing': 'scripts/pr2-foundation/mutation-catalog.ts',
    'restore-hash-mismatch': 'scripts/pr2-foundation/mutation-runner.ts',
  }),
  ...entries('AC9', {
    'modification-outside-independent-union': 'scripts/pr2-foundation/real-scope-proof.test.ts',
    'manifest-self-authorizes': 'scripts/pr2-foundation/contracts.ts',
    'cutover-path-modified': 'scripts/review-trigger-reconcile.ps1',
    'registry-or-supervisor-modified': 'scripts/orchestrator-wake-supervisor.ps1',
    'declaration-snapshot-missing': 'scripts/pr2-foundation/real-scope-proof.test.ts',
    'declaration-created-after-implementation': 'scripts/pr2-foundation/real-scope-proof.test.ts',
    'addition-root-not-predeclared': 'scripts/pr2-foundation/contracts.ts',
    'candidate-tag-self-authorizes': 'scripts/pr2-foundation/contracts.ts',
    'addition-root-exists-at-base': 'scripts/pr2-foundation/contracts.ts',
    'capture-corpus-overreach': 'tests/external-output-references/capture-manifest.json',
    'raw-capture-added': 'tests/external-output-references/captures/issue-923/raw-live-ac9.json',
    'symlink-mode': 'scripts/pr2-foundation/contracts.ts',
    'gitlink-mode': 'scripts/pr2-foundation/contracts.ts',
    'test-classification-missing': 'scripts/vitest-ci-lanes.config.json',
    'lane-config-overreach': 'scripts/vitest-ci-lanes.config.json',
    'package-json-overreach': 'package.json',
    'multi-revert-plan': 'scripts/pr2-foundation/contracts.ts',
    'new-powershell-logic-added': 'scripts/pr2-foundation/contracts.ts',
  }, {
    'raw-capture-added': 'create',
  }),
]);

const catalogKeys = new Set(FOUNDATION_MUTATION_CATALOG.map((entry) => `${entry.ac}:${entry.mutationId}`));
const expectedKeys = new Set(
  Object.entries(AC_MUTATION_CONTROLS).flatMap(([ac, ids]) =>
    ids.map((mutationId) => `${ac}:${mutationId}`),
  ),
);
if (catalogKeys.size !== FOUNDATION_MUTATION_CATALOG.length
  || catalogKeys.size !== expectedKeys.size
  || [...expectedKeys].some((key) => !catalogKeys.has(key))) {
  throw new Error('mutation_catalog_control_set_mismatch');
}

export function mutationBinding(key: string): MutationBinding {
  const binding = FOUNDATION_MUTATION_CATALOG.find((entry) => `${entry.ac}:${entry.mutationId}` === key);
  if (!binding) throw new Error(`unknown_mutation_binding:${key}`);
  return binding;
}
