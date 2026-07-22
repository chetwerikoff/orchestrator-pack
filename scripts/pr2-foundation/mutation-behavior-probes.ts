import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';
import { AC_MUTATION_CONTROLS } from './contracts.ts';

type Probe = () => void;

const PROBES = new Map<string, Probe>();

const IMMUTABLE_DIGESTS: Readonly<Record<string, string>> = Object.freeze({
  'scripts/orchestrator-side-process-registry.json': 'b1c945541db67d48cdbf7c44777ae478e3cf11bd66255a82f7852767f0e0f39a',
  'scripts/review-trigger-reconcile.ps1': '20762cfc1549a1c7d03516b87da7c8d0a6d9daf9606cac99d27f3cc3ee1864d8',
  'scripts/pack-review-runner.ts': '20889c052830aa8d8039e0099bd97234ced63cc226342512e0f24a1f26b4afec',
  'scripts/orchestrator-wake-supervisor.ps1': 'c84ebfe9166960f1b4079f86019f9eaa997276680a6e42f8db5d402e71cf3391',
  'tests/external-output-references/capture-manifest.json': '82ac82a443123b90dd688a31f1af5f00b9058e96c4f536f8ae691ed01e917987',
});

function invariant(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

function source(file: string): string {
  const absolute = path.resolve(file);
  invariant(existsSync(absolute), `probe_artifact_missing:${file}`);
  return readFileSync(absolute, 'utf8');
}

function addProbe(keys: readonly string[], probe: Probe): void {
  for (const key of keys) {
    const previous = PROBES.get(key);
    PROBES.set(key, previous
      ? () => {
        previous();
        probe();
      }
      : probe);
  }
}

function runFixture(file: string, probe: string): void {
  const result = runProcessSync({
    command: process.execPath,
    args: ['--experimental-strip-types', path.resolve(file), '--probe', probe],
    cwd: path.resolve('.'),
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 120_000,
  });
  if (!result.ok) {
    throw new Error(`independent_fixture_failed:${probe}:${result.stderr || result.stdout || result.error || result.outcome}`);
  }
}

function runBehaviorFixture(probe: string): void {
  runFixture('scripts/pr2-foundation/mutation-behavior-fixtures.ts', probe);
}

function runPolicyFixture(probe: string): void {
  runFixture('scripts/pr2-foundation/mutation-behavior-policy-fixtures.ts', probe);
}

function assertDigest(file: string): void {
  const expected = IMMUTABLE_DIGESTS[file];
  invariant(expected, `probe_digest_missing:${file}`);
  const actual = createHash('sha256').update(readFileSync(path.resolve(file))).digest('hex');
  invariant(actual === expected, `immutable_behavior_changed:${file}`);
}

function assertAbsent(file: string): void {
  invariant(!existsSync(path.resolve(file)), `forbidden_artifact_present:${file}`);
}

function requireSource(file: string, required: readonly string[], forbidden: readonly string[] = []): void {
  const text = source(file);
  for (const token of required) invariant(text.includes(token), `independent_required_missing:${file}:${token}`);
  for (const token of forbidden) invariant(!text.includes(token), `independent_forbidden_present:${file}:${token}`);
}

addProbe([
  'AC1:scheduler-acquirer-running',
  'AC1:activation-epoch-enforced',
  'AC1:dormant-config-reader-live',
], () => runBehaviorFixture('scheduler-inert'));
addProbe(['AC1:registry-changed'], () => assertDigest('scripts/orchestrator-side-process-registry.json'));
addProbe(['AC1:live-store-opened'], () => runBehaviorFixture('migration-live-root-refused'));
addProbe(['AC1:legacy-starter-disabled'], () => assertDigest('scripts/review-trigger-reconcile.ps1'));
addProbe(['AC1:non-notification-runtime-delta'], () => assertDigest('scripts/pack-review-runner.ts'));
addProbe(['AC1:notification-config-reader-absent'], () => requireSource(
  'scripts/pr2-foundation/worker-notification.ts',
  ['config = notificationConfig(options.foundationConfig ?? {});'],
));

addProbe(['AC2:raw-live-capture-committed'], () => assertAbsent('tests/external-output-references/captures/issue-923/raw-live.json'));
addProbe(['AC2:capture-metadata-secret-scan-omitted'], () => runBehaviorFixture('capture-secret-rejected'));
addProbe(['AC2:schema-shape-changed'], () => runBehaviorFixture('schema-exact'));
addProbe([
  'AC2:preflight-missing',
  'AC2:preflight-empty-fleet-accepted',
  'AC2:preflight-version-unverifiable-accepted',
], () => runBehaviorFixture('preflight-fail-closed'));
addProbe([
  'AC2:hypothetical-prs-or-branch-trust',
  'AC2:pr-body-reference-trusted',
], () => runBehaviorFixture('pr-body-not-trusted'));
addProbe(['AC2:draft-candidate-accepted'], () => runBehaviorFixture('draft-rejected'));
addProbe(['AC2:missing-draft-bit-accepted'], () => runBehaviorFixture('missing-draft-rejected'));
addProbe([
  'AC2:ambiguous-live-issue-index-zero',
  'AC2:zero-candidate-bound',
  'AC2:multiple-candidates-bound',
  'AC2:bound-head-not-recorded',
], () => runBehaviorFixture('binding-fail-closed'));
addProbe(['AC2:cross-repo-candidate-accepted'], () => runBehaviorFixture('cross-repo-rejected'));
addProbe(['AC2:per-session-detail-call'], () => requireSource(
  'scripts/pr2-foundation/worker-notification-target.ts',
  ["args: ['session', 'ls', '--json']"],
  ["'session', 'get'"],
));
addProbe(['AC2:legacy-cache-projection-dependency'], () => requireSource(
  'scripts/pr2-foundation/worker-notification-target.ts',
  ['collectOpenPrSnapshot'],
  ['Gh-FleetInventoryCache'],
));

addProbe([
  'AC3:malformed-value-defaulted',
  'AC3:invalid-config-accepted',
  'AC3:unknown-config-key-ignored',
  'AC3:notification-key-not-consumed-live',
  'AC3:foundation-config-activates-non-notification-consumer',
], () => runBehaviorFixture('config-fail-closed'));
addProbe(['AC3:untyped-live-key'], () => requireSource(
  'scripts/pr2-foundation/config.ts',
  ['parseFoundationConfig'],
  ['process.env'],
));

addProbe(['AC4:notify-before-journal'], () => requireSource(
  'scripts/pr2-foundation/worker-notification.ts',
  ['const inspected = await inspectNotification({'],
  ['await runProcess({ command: config.aoPath, args: [], allowEmptyStdout: true, timeoutMs: 1 });'],
));
addProbe(['AC4:inline-powershell'], () => requireSource(
  'scripts/lib/pack-review-worker-notification.ts',
  ['worker-notification.ts'],
  ['pwsh', '.ps1'],
));
addProbe(['AC4:powershell-child'], () => requireSource(
  'scripts/pr2-foundation/worker-notification.ts',
  ['runProcess'],
  ['pwsh', '.ps1'],
));
addProbe(['AC4:historical-record-unreadable'], () => runBehaviorFixture('historical-journal-readable'));
addProbe(['AC4:duplicate-send-unaccounted'], () => requireSource(
  'scripts/pr2-foundation/worker-notification.ts',
  ['journal_duplicate_no_op'],
));
addProbe(['AC4:run-linkage-missing'], () => requireSource(
  'scripts/lib/pack-review-delivery.ts',
  ['reviewRunId'],
));
addProbe(['AC4:channel-outcome-corruption'], () => requireSource(
  'scripts/lib/pack-review-delivery.ts',
  ['workerNotification'],
));

addProbe(['AC5:journal-key-omitted'], () => runBehaviorFixture('migration-journal-key-required'));
addProbe(['AC5:prepared-after-mutation'], () => runBehaviorFixture('migration-prepare-before-effects'));
addProbe([
  'AC5:imported-before-durable-import',
  'AC5:committed-before-imported',
], () => runBehaviorFixture('migration-prepared-before-import'));
addProbe(['AC5:marker-crash-reimports'], () => runBehaviorFixture('migration-replay-idempotent'));
addProbe(['AC5:torn-journal-accepted'], () => runBehaviorFixture('migration-torn-rejected'));
addProbe(['AC5:live-store-import-allowed'], () => runBehaviorFixture('migration-live-root-refused'));

addProbe([
  'AC6:catalog-surface-omitted',
  'AC6:candidate-catalog-downgrade',
], () => runPolicyFixture('runtime-catalog-fail-closed'));
addProbe([
  'AC6:symlink-cleanup',
  'AC6:swap-after-check-delete',
  'AC6:unsupported-platform-cleanup-enabled',
], () => runPolicyFixture('cleanup-fail-closed'));

addProbe(AC_MUTATION_CONTROLS.AC7.map((id) => `AC7:${id}`), () => runPolicyFixture('estate-split-valid'));
addProbe(AC_MUTATION_CONTROLS.AC7.map((id) => `AC7:${id}`), () => runPolicyFixture('estate-generator-clean'));

addProbe(['AC8:suite-self-attests'], () => {
  requireSource('scripts/pr2-foundation/mutation-semantic-check.ts', ['mutation-behavior-probes.ts'], ['mutation-semantic-gates.ts']);
  requireSource('scripts/pr2-foundation/mutation-runner.ts', ['mutation-semantic-check.ts', 'mutation-behavior-recipes.ts'], ['git status']);
  requireSource('scripts/pr2-foundation/mutation-behavior-probes.ts', ['mutation-behavior-policy-fixtures.ts'], ['mutation-semantic-gates.ts']);
});
addProbe(['AC8:artifact-hash-delta-missing'], () => requireSource(
  'scripts/pr2-foundation/mutation-runner.ts',
  ['artifactHashAfter === artifactHashBefore'],
));
addProbe(['AC8:failing-test-identity-missing'], () => requireSource(
  'scripts/pr2-foundation/mutation-runner.ts',
  ['specific_failing_test_not_observed'],
));
addProbe(['AC8:restore-hash-mismatch'], () => requireSource(
  'scripts/pr2-foundation/mutation-runner.ts',
  ['restore_hash_mismatch'],
));
addProbe([
  'AC8:mutation-id-extra',
  'AC8:mutation-id-missing',
], () => runPolicyFixture('mutation-catalog-set-strict'));
addProbe([
  'AC8:mutation-id-extra',
  'AC8:mutation-id-missing',
], () => runPolicyFixture('mutation-evidence-set-strict'));

addProbe([
  'AC9:manifest-self-authorizes',
  'AC9:addition-root-not-predeclared',
  'AC9:candidate-tag-self-authorizes',
  'AC9:addition-root-exists-at-base',
  'AC9:symlink-mode',
  'AC9:gitlink-mode',
  'AC9:multi-revert-plan',
  'AC9:new-powershell-logic-added',
], () => runPolicyFixture('scope-fail-closed'));
addProbe(['AC9:modification-outside-independent-union'], () => requireSource(
  'scripts/pr2-foundation/real-scope-proof.test.ts',
  ['validateFoundationScope', 'currentDiff.changedPaths'],
));
addProbe(['AC9:cutover-path-modified'], () => assertDigest('scripts/review-trigger-reconcile.ps1'));
addProbe(['AC9:registry-or-supervisor-modified'], () => assertDigest('scripts/orchestrator-wake-supervisor.ps1'));
addProbe(['AC9:declaration-snapshot-missing'], () => requireSource(
  'scripts/pr2-foundation/real-scope-proof.test.ts',
  ['resolveLatestCommittedSnapshotAtCommit'],
));
addProbe(['AC9:declaration-created-after-implementation'], () => requireSource(
  'scripts/pr2-foundation/real-scope-proof.test.ts',
  ['--full-history', 'declarationCommitSha'],
));
addProbe(['AC9:capture-corpus-overreach'], () => assertDigest('tests/external-output-references/capture-manifest.json'));
addProbe(['AC9:raw-capture-added'], () => assertAbsent('tests/external-output-references/captures/issue-923/raw-live-ac9.json'));
addProbe([
  'AC9:test-classification-missing',
  'AC9:lane-config-overreach',
], () => runPolicyFixture('lane-config-bounded'));
addProbe(['AC9:package-json-overreach'], () => runPolicyFixture('package-script-exact'));

const EXPECTED_KEYS = Object.entries(AC_MUTATION_CONTROLS).flatMap(([ac, ids]) =>
  ids.map((mutationId) => `${ac}:${mutationId}`),
);
if (PROBES.size !== EXPECTED_KEYS.length || EXPECTED_KEYS.some((key) => !PROBES.has(key))) {
  throw new Error('behavioral_mutation_probe_set_mismatch');
}

export const MUTATION_BEHAVIOR_PROBE_KEYS = Object.freeze([...PROBES.keys()].sort());

export function behavioralProbeIdForMutation(key: string): string {
  return `mutation-contract:${key}`;
}

export function runBehavioralMutationProbe(key: string): void {
  const probe = PROBES.get(key);
  if (!probe) throw new Error(`behavioral_mutation_probe_missing:${key}`);
  probe();
}
