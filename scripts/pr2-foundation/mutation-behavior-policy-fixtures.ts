import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';
import {
  AC_MUTATION_CONTROLS,
  CUTOVER_ROWS,
  FOUNDATION_DOC_ROWS,
  validateEstateSplit,
  validateFoundationScope,
  validateMutationEvidence,
  type AcceptanceId,
  type DeclarationSnapshotShape,
} from './contracts.ts';
import { FOUNDATION_MUTATION_CATALOG } from './mutation-catalog.ts';
import {
  FOUNDATION_RUNTIME_CATALOG,
  cleanupOwnedFixtureRoot,
  validateRuntimeCatalog,
} from './runtime-catalog.ts';

function invariant(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

function runtimeCatalogFailClosed(): void {
  invariant(validateRuntimeCatalog(FOUNDATION_RUNTIME_CATALOG, FOUNDATION_RUNTIME_CATALOG).ok, 'clean_catalog_rejected');
  const omitted = validateRuntimeCatalog(FOUNDATION_RUNTIME_CATALOG, FOUNDATION_RUNTIME_CATALOG.slice(1));
  invariant(!omitted.ok && omitted.reason === 'catalog_surface_omitted', 'catalog_omission_accepted');
  const downgraded = FOUNDATION_RUNTIME_CATALOG.map((row) => row.id === 'worker-notification'
    ? { ...row, classification: 'dormant' as const }
    : row);
  const downgrade = validateRuntimeCatalog(FOUNDATION_RUNTIME_CATALOG, downgraded);
  invariant(!downgrade.ok && downgrade.reason === 'candidate_catalog_downgrade', 'catalog_downgrade_accepted');
}

function cleanupFailClosed(): void {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-mutation-cleanup-'));
  try {
    const ownedRoot = path.join(root, 'owned');
    const real = path.join(ownedRoot, 'real');
    const link = path.join(ownedRoot, 'link');
    mkdirSync(real, { recursive: true });
    if (process.platform !== 'win32') {
      symlinkSync(real, link, 'dir');
      const symlinkResult = cleanupOwnedFixtureRoot({
        target: link,
        ownedRoot,
        enabled: true,
        platform: 'linux',
      });
      invariant(!symlinkResult.ok && symlinkResult.reason === 'symlink_cleanup_refused', 'symlink_cleanup_allowed');
      invariant(lstatSync(link).isSymbolicLink(), 'symlink_deleted');
    }

    const swap = path.join(ownedRoot, 'swap');
    mkdirSync(swap, { recursive: true });
    const before = statSync(swap);
    rmSync(swap, { recursive: true, force: true });
    mkdirSync(swap, { recursive: true });
    const swapped = cleanupOwnedFixtureRoot({
      target: swap,
      ownedRoot,
      enabled: true,
      platform: 'linux',
      beforeIdentity: { dev: before.dev, ino: before.ino },
    });
    invariant(!swapped.ok && swapped.reason === 'swap_after_check_delete_refused', 'swap_after_check_deleted');
    invariant(existsSync(swap), 'swapped_target_deleted');

    const unsupported = path.join(ownedRoot, 'unsupported');
    mkdirSync(unsupported, { recursive: true });
    const unsupportedResult = cleanupOwnedFixtureRoot({
      target: unsupported,
      ownedRoot,
      enabled: true,
      platform: 'win32',
    });
    invariant(
      !unsupportedResult.ok && unsupportedResult.reason === 'unsupported_platform_cleanup_disabled',
      'unsupported_platform_cleanup_enabled',
    );
    invariant(existsSync(unsupported), 'unsupported_target_deleted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function estateSplitValid(): void {
  const manifest = JSON.parse(
    readFileSync(path.resolve('scripts/estate-cut/issue-906.manifest.json'), 'utf8'),
  ) as { rows?: Array<{ path: string; terminalState: string; replacementOwner?: string }> };
  const denominator = (manifest.rows ?? []).filter((row) =>
    (FOUNDATION_DOC_ROWS as readonly string[]).includes(row.path)
    || (CUTOVER_ROWS as readonly string[]).includes(row.path));
  const result = validateEstateSplit(denominator);
  invariant(result.ok && result.result === 'foundation-16-cutover-6', 'estate_split_invalid');
  invariant(denominator.length === 22, `estate_denominator_size:${denominator.length}`);
  for (const file of FOUNDATION_DOC_ROWS) {
    invariant(existsSync(path.resolve(file)), `foundation_row_missing:${file}`);
    invariant(
      readFileSync(path.resolve(file), 'utf8').startsWith('// Issue #923 foundation-terminalized:'),
      `foundation_row_not_terminalized:${file}`,
    );
  }
  for (const file of CUTOVER_ROWS) invariant(existsSync(path.resolve(file)), `cutover_row_deleted:${file}`);
}

function estateGeneratorClean(): void {
  const result = runProcessSync({
    command: process.execPath,
    args: [
      '--experimental-strip-types',
      path.resolve('scripts/estate-cut/manifest-generator.mjs'),
      '--check',
    ],
    cwd: path.resolve('.'),
    inheritParentEnv: true,
    allowEmptyStdout: true,
    timeoutMs: 120_000,
  });
  invariant(result.ok, `estate_manifest_drift:${result.stderr || result.stdout || result.error || result.outcome}`);
}

function mutationCatalogSetStrict(): void {
  const expected = Object.entries(AC_MUTATION_CONTROLS).flatMap(([ac, ids]) =>
    ids.map((mutationId) => `${ac}:${mutationId}`)).sort();
  const actual = FOUNDATION_MUTATION_CATALOG.map((row) => `${row.ac}:${row.mutationId}`).sort();
  invariant(JSON.stringify(actual) === JSON.stringify(expected), 'mutation_catalog_control_set_mismatch');
}

function mutationEvidenceSetStrict(): void {
  const rows = Object.entries(AC_MUTATION_CONTROLS).flatMap(([ac, ids]) => ids.map((mutationId) => ({
    ac: ac as AcceptanceId,
    mutationId,
    executed: true,
    artifactHashBefore: `sha256:before:${ac}:${mutationId}`,
    artifactHashAfter: `sha256:after:${ac}:${mutationId}`,
    failingTestId: `mutation-contract:${ac}:${mutationId}`,
    negativeOutcome: 'failed',
    restoredHash: `sha256:before:${ac}:${mutationId}`,
    restoredOutcome: 'passed',
  })));
  const clean = validateMutationEvidence(rows);
  invariant(clean.ok && clean.result === 'externally-grounded', 'clean_mutation_evidence_rejected');
  const missing = validateMutationEvidence(rows.slice(1));
  invariant(!missing.ok && missing.reason === 'mutation_id_set_mismatch', 'missing_mutation_id_accepted');
  const extra = validateMutationEvidence([
    ...rows,
    { ...rows[0]!, mutationId: 'unexpected-extra' },
  ]);
  invariant(!extra.ok && extra.reason === 'mutation_id_set_mismatch', 'extra_mutation_id_accepted');
}

function laneConfigBounded(): void {
  const config = JSON.parse(readFileSync(path.resolve('scripts/vitest-ci-lanes.config.json'), 'utf8')) as {
    classification?: Record<string, string>;
  };
  const expected: Record<string, string> = {
    'scripts/pr2-foundation/binding-cache.test.ts': 'light',
    'scripts/pr2-foundation/foundation.test.ts': 'heavy',
    'scripts/pr2-foundation/migration-symlink.test.ts': 'light',
    'scripts/pr2-foundation/mutation-catalog.test.ts': 'light',
    'scripts/pr2-foundation/mutation-external-ci.test.ts': 'heavy',
    'scripts/pr2-foundation/mutation-semantic-gates.test.ts': 'light',
    'scripts/pr2-foundation/real-scope-proof.test.ts': 'light',
    'scripts/pr2-foundation/review-4750643719-regression.test.ts': 'light',
    'scripts/pr2-foundation/review-head-ready.test.ts': 'light',
    'scripts/pr2-foundation/terminalized-port.test.ts': 'light',
    'scripts/pr2-foundation/worker-notification-compat.test.ts': 'light',
  };
  for (const [file, lane] of Object.entries(expected)) {
    invariant(config.classification?.[file] === lane, `lane_classification_invalid:${file}`);
  }
  const unexpected = Object.keys(config.classification ?? {})
    .filter((file) => file.startsWith('scripts/pr2-foundation/') && file.endsWith('.test.ts'))
    .filter((file) => !(file in expected));
  invariant(unexpected.length === 0, `lane_config_overreach:${unexpected.join(',')}`);
}

function packageScriptExact(): void {
  const pkg = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  invariant(
    pkg.scripts?.['test:contract-mutations']
      === 'npm run check:node-major --silent && node --experimental-strip-types scripts/pr2-foundation/contract-test-runner.ts',
    'contract_mutation_script_overreach',
  );
}

function scopeFixture(): {
  declaration: DeclarationSnapshotShape;
  base: Parameters<typeof validateFoundationScope>[0];
} {
  const declaration: DeclarationSnapshotShape = {
    issue_number: 923,
    created_at: '2026-07-20T00:00:00.000Z',
    baseline: { commit_sha: 'a'.repeat(40) },
    declared_paths: [],
    declared_globs: ['scripts/pr2-foundation/**'],
  };
  return {
    declaration,
    base: {
      issueNumber: 923,
      baseCommitSha: declaration.baseline.commit_sha,
      declaration,
      changedPaths: ['scripts/pr2-foundation/new.ts'],
      addedPaths: ['scripts/pr2-foundation/new.ts'],
      basePaths: [],
      modes: { 'scripts/pr2-foundation/new.ts': '100644' },
      laneClassification: {},
      packageJsonChangedKeys: [],
      revertCommitCount: 1,
    },
  };
}

function expectScopeFailure(
  input: Parameters<typeof validateFoundationScope>[0],
  reasonPrefix: string,
): void {
  const result = validateFoundationScope(input);
  invariant(!result.ok && result.reason.startsWith(reasonPrefix), `scope_failure_not_observed:${reasonPrefix}`);
}

function scopeFailClosed(): void {
  const { declaration, base } = scopeFixture();
  invariant(validateFoundationScope(base).ok, 'clean_scope_rejected');
  expectScopeFailure({ ...base, declaration: null }, 'declaration_snapshot_missing');
  expectScopeFailure({
    ...base,
    changedPaths: ['README.md'],
    addedPaths: [],
    modes: { 'README.md': '100644' },
  }, 'modification_outside_independent_union');
  expectScopeFailure({
    ...base,
    changedPaths: ['scripts/pr2-foundation/undeclared.ts'],
    addedPaths: ['scripts/pr2-foundation/undeclared.ts'],
    declaration: { ...declaration, declared_globs: [], declared_paths: [] },
    modes: { 'scripts/pr2-foundation/undeclared.ts': '100644' },
  }, 'addition_not_declared');
  expectScopeFailure({
    ...base,
    changedPaths: ['candidate/self-authorized.ts'],
    addedPaths: ['candidate/self-authorized.ts'],
    declaration: { ...declaration, declared_globs: [], declared_paths: [] },
    modes: { 'candidate/self-authorized.ts': '100644' },
  }, 'addition_not_declared');
  expectScopeFailure({
    ...base,
    changedPaths: ['scripts/review-trigger-reconcile.ps1'],
    addedPaths: [],
    modes: { 'scripts/review-trigger-reconcile.ps1': '100644' },
  }, 'protected_runtime_path_changed');
  expectScopeFailure({ ...base, basePaths: ['scripts/pr2-foundation/new.ts'] }, 'addition_root_exists_at_base');
  expectScopeFailure({ ...base, modes: { 'scripts/pr2-foundation/new.ts': '120000' } }, 'symlink_mode');
  expectScopeFailure({ ...base, modes: { 'scripts/pr2-foundation/new.ts': '160000' } }, 'gitlink_mode');
  expectScopeFailure({
    ...base,
    changedPaths: ['scripts/pr2-foundation/new.test.ts'],
    addedPaths: ['scripts/pr2-foundation/new.test.ts'],
    modes: { 'scripts/pr2-foundation/new.test.ts': '100644' },
  }, 'test_classification_missing');
  expectScopeFailure({ ...base, packageJsonChangedKeys: ['dependencies.left-pad'] }, 'package_json_overreach');
  expectScopeFailure({ ...base, revertCommitCount: 2 }, 'multi_revert_plan');
  expectScopeFailure({
    ...base,
    changedPaths: ['scripts/pr2-foundation/new.ps1'],
    addedPaths: ['scripts/pr2-foundation/new.ps1'],
    modes: { 'scripts/pr2-foundation/new.ps1': '100644' },
  }, 'new_powershell_logic_added');
}

async function main(): Promise<void> {
  const probeIndex = process.argv.indexOf('--probe');
  const probe = probeIndex >= 0 ? String(process.argv[probeIndex + 1] ?? '') : '';
  if (probe === 'runtime-catalog-fail-closed') runtimeCatalogFailClosed();
  else if (probe === 'cleanup-fail-closed') cleanupFailClosed();
  else if (probe === 'estate-split-valid') estateSplitValid();
  else if (probe === 'estate-generator-clean') estateGeneratorClean();
  else if (probe === 'mutation-catalog-set-strict') mutationCatalogSetStrict();
  else if (probe === 'mutation-evidence-set-strict') mutationEvidenceSetStrict();
  else if (probe === 'lane-config-bounded') laneConfigBounded();
  else if (probe === 'package-script-exact') packageScriptExact();
  else if (probe === 'scope-fail-closed') scopeFailClosed();
  else throw new Error(`unknown_policy_fixture:${probe}`);
  process.stdout.write(`policy-fixture:${probe}:passed\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
