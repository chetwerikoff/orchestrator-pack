import '../toolchain/native-entrypoint-preflight.ts';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';

export const WORKFLOW_BLOB_SHA = '7de8752a51faa6788f7196d79d14d0f05a970b2a';
export const WORKFLOW_CONTENT_SHA256 = '58a0950b7d0873d7c65efa4cc8fa02e15538a1e88df02ceaacb1ac876ab4e8f2';
export const RUNTIME_OUTPUTS = ['.vitest-runtime-report.json', '.vitest-runtime-report.meta.json'];

export type RowId =
  | 'structure.verify' | 'structure.reusable' | 'structure.cheap-wins'
  | 'structure.verify-runtime' | 'typescript.typecheck' | 'vitest.light-lane-all'
  | 'pester.track';

export type Diagnostic = {
  reason_code: string;
  path: string;
  expected: unknown;
  actual: unknown;
  remediation: string | null;
};

export type NativeStream = {
  stream: 'stdout' | 'stderr';
  text: string;
  byte_length: number;
  sha256: string;
};

export type NativeOutput = {
  schema: 'ci-preflight-native-output/v1';
  source: 'selected-child' | 'preflight-probe';
  text_encoding: 'utf-8';
  stdout: NativeStream;
  stderr: NativeStream;
};

export type Row = {
  row_id: RowId;
  selection: 'selected';
  applicability: 'applicable';
  termination: 'not_started' | 'exited' | 'signaled' | 'timed_out' | 'spawn_failed' | 'consumer_error';
  command_verdict: 'not_evaluated' | 'passed' | 'failed' | 'blocked';
  cleanup_status: 'not_required' | 'pending' | 'clean' | 'process_group_member_survived' | 'process_group_probe_error';
  snapshot_status: 'not_checked' | 'unchanged' | 'changed';
  reason_code: string | null;
  diagnostic: Diagnostic | null;
  native_output: NativeOutput;
};

export const TABLE = [
  { row_id: 'structure.verify', command: process.execPath, args: ['--experimental-strip-types', './scripts/verify.ts'], paths: ['scripts/verify.ts'], timeout: 120_000, grace: 500 },
  { row_id: 'structure.reusable', command: process.execPath, args: ['--experimental-strip-types', './scripts/verify.ts', '--reusable-only'], paths: ['scripts/verify.ts'], timeout: 120_000, grace: 500 },
  { row_id: 'structure.cheap-wins', command: process.execPath, args: ['--experimental-strip-types', './scripts/ci-policy-guards.ts', 'ci-cheap-wins'], paths: ['scripts/ci-policy-guards.ts'], timeout: 120_000, grace: 500 },
  { row_id: 'structure.verify-runtime', command: process.execPath, args: ['--experimental-strip-types', './scripts/ci-policy-guards.ts', 'verify-runtime'], paths: ['scripts/ci-policy-guards.ts'], timeout: 120_000, grace: 500 },
  { row_id: 'typescript.typecheck', command: 'npx', args: ['--no-install', 'tsc', '--project', 'tsconfig.base.json', '--noEmit'], paths: ['package.json', 'package-lock.json', 'node_modules/.package-lock.json', 'tsconfig.base.json'], timeout: 180_000, grace: 500 },
  { row_id: 'vitest.light-lane-all', command: process.execPath, args: ['--experimental-strip-types', './scripts/vitest-ci-runner.ts', 'light'], paths: ['scripts/vitest-ci-lanes.config.json', 'vitest.config.ts', 'scripts/vitest-ci-runner.ts'], timeout: 1_200_000, grace: 1_000 },
  { row_id: 'pester.track', command: 'npm', args: ['run', 'check:pwsh-test-growth', '--silent'], paths: ['package.json', 'scripts/toolchain/check-pwsh-test-growth.ts', 'scripts/toolchain/powershell-child-tests.json'], timeout: 120_000, grace: 500 },
] as const;

export const INVENTORY = [
  ['verify-pack.tiering-calibration', 'not_selected', 'npm run tiering:calibration', 'callable local check, intentionally omitted from the bounded v1 table'],
  ['verify-pack.pipeline-split', 'not_selected', 'node --experimental-strip-types scripts/ci-policy-guards.ts pipeline-split', 'callable local topology-policy check, intentionally omitted'],
  ['typecheck.review-start-claim-guard', 'not_selected', 'node --experimental-strip-types scripts/review-start-claim-guard.ts', 'callable local check, intentionally omitted from v1'],
  ['pester.install', 'not_selected', 'retired Pester installer (not executed by Node preflight)', 'callable installer path, deliberately not run'],
  ['vitest.topology-producer', 'not_selected', 'node scripts/emit-vitest-heavy-topology.mjs --skip-oversized-guard', 'callable topology producer omitted from v1; workflow coverage is uncovered'],
  ['vitest.heavy-shard-1', 'not_selected', 'node --experimental-strip-types scripts/vitest-ci-runner.ts heavy --shard 1', 'callable heavy consumer omitted from v1'],
  ['vitest.heavy-shard-matrix-except-1', 'not_selected', 'node --experimental-strip-types scripts/vitest-ci-runner.ts heavy --shard <each plan shard other than 1>', 'dynamic matrix members outside the fixed consumer row'],
  ['classify-pr-changes', 'not_applicable', 'workflow inline Bash step classify-pr-changes', 'requires PR base/head and GitHub event context'],
  ['pr-scope-guard', 'not_applicable', 'workflow job pr-scope-guard, trusted scripts/pr-scope-runner.ts', 'requires PR and GitHub context'],
  ['pr-scope-declaration-path-producer', 'not_applicable', 'PR scope declaration/path evaluation inside pr-scope-guard', 'PR/GitHub inputs are absent'],
  ['OPK_CHANGED_VITEST_FILES/PR changed-path manifest', 'not_applicable', 'OPK_CHANGED_VITEST_FILES produced from the PR changed-path manifest', 'PR changed paths are absent'],
  ['vitest.pr-scoped-topology', 'not_applicable', 'OPK_VITEST_PR_SCOPE_MODE plus PR-scoped topology invocation', 'PR-scoped selection is absent'],
  ['topology-producer.github-output', 'not_applicable', 'node scripts/emit-vitest-heavy-topology.mjs --gha-output --skip-oversized-guard', 'requires hosted GITHUB_OUTPUT; emits heavy_shard_count, heavy_shard_matrix, light_shard_count, light_shard_matrix, fallback_classification'],
  ['self-architect-lint', 'not_applicable', 'node --experimental-strip-types scripts/lint-self-architect.ts --strict --base-ref $PR_BASE_SHA --head-ref $PR_HEAD_SHA', 'PR refs are absent'],
  ['test-aggregate', 'not_applicable', 'node --experimental-strip-types scripts/vitest-ci-runner.ts aggregate', 'consumes GitHub job-result outputs'],
  ['hosted-checkout-and-setup', 'not_applicable', 'actions/checkout@v4, actions/setup-node@v4', 'hosted-runner behavior is not local'],
  ['hosted-dependency-install', 'not_applicable', 'npm ci --include=dev in workflow jobs', 'CI installation is not repeated'],
  ['hosted-pester-cache', 'not_applicable', 'actions/cache@v4 for Pester', 'hosted cache transport is not local'],
  ['topology-artifact-upload-download', 'not_applicable', 'actions/upload-artifact@v4 / actions/download-artifact@v4', 'Actions artifact transport is outside v1'],
  ['workflow-event-guards-and-matrices', 'not_applicable', 'job if, needs, matrix, always(), and scheduler cancellation', 'GitHub scheduler semantics are not locally reproduced'],
] as const;

export function emptyStream(stream: 'stdout' | 'stderr'): NativeStream {
  return { stream, text: '', byte_length: 0, sha256: createHash('sha256').update('').digest('hex') };
}

export function nativeOutput(source: NativeOutput['source'], stdout = '', stderr = ''): NativeOutput {
  const make = (stream: 'stdout' | 'stderr', text: string): NativeStream => ({
    stream, text, byte_length: Buffer.byteLength(text, 'utf8'), sha256: createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'),
  });
  return { schema: 'ci-preflight-native-output/v1', source, text_encoding: 'utf-8', stdout: make('stdout', stdout), stderr: make('stderr', stderr) };
}

export function workflowHashes(repoRoot: string): { blob: string; content: string } {
  const path = join(repoRoot, '.github/workflows/scope-guard.yml');
  const bytes = readFileSync(path);
  return { blob: requireGitBlob(repoRoot, path), content: createHash('sha256').update(bytes).digest('hex') };
}

function requireGitBlob(repoRoot: string, path: string): string {
  const result = runProcessSync({ command: 'git', args: ['hash-object', path], cwd: repoRoot, inheritParentEnv: true });
  return result.ok ? String(result.stdout).trim() : '';
}

export function workflowCoverage() {
  return {
    schema: 'ci-preflight-workflow-coverage/v1',
    mode: 'bounded_local_only',
    inventory: INVENTORY.map(([inventory_id, selection, command, rationale]) => ({
      inventory_id, selection, applicability: selection === 'not_selected' ? 'applicable' : 'not_applicable',
      execution: 'not_started', command_verdict: 'not_evaluated', workflow_coverage: 'uncovered', rationale,
    })),
  };
}
