import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess } from './kernel/subprocess.js';
import {
  classifyPackReviewDeliveryOutcome,
  parsePackReviewDeliveryOutcomeCliArgs,
  recordPackReviewDeliveryOutcome,
  type PackReviewDeliveryGateOutcome,
} from './lib/pack-review-delivery-outcome.js';
import {
  createPackReviewRun,
  getPackReviewRun,
  setPackReviewRunTerminal,
} from './lib/pack-review-run-store.js';
import { repoRoot } from './_test-vitest-harness-env.js';

const HEAD = 'd'.repeat(40);
const recorderPath = path.join(repoRoot, 'scripts/lib/pack-review-delivery-outcome.ts');
const loaderPath = path.join(repoRoot, 'scripts/toolchain/typescript-loader.mjs');
const tempRoots = new Set<string>();

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

function createRun(storeRoot: string, prNumber: number) {
  return createPackReviewRun({
    storeRoot,
    projectId: 'orchestrator-pack',
    prNumber,
    headSha: HEAD,
    linkedSessionId: `worker-${prNumber}`,
    startReason: 'delivery-outcome-test',
    surface: 'vitest',
    trustedPackRoot: repoRoot,
    sourceRepoRoot: repoRoot,
  }).run;
}

function recorderNodeArgs(
  storeRoot: string,
  runId: string,
  outcome: PackReviewDeliveryGateOutcome,
): string[] {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const entrypoint = nodeMajor >= 22
    ? ['--experimental-strip-types', recorderPath]
    : ['--no-warnings', '--loader', loaderPath, recorderPath];
  return [
    ...entrypoint,
    `--run-id=${runId}`,
    '--project-id=orchestrator-pack',
    `--store-root=${storeRoot}`,
    `--ok=${String(outcome.ok)}`,
    `--skipped=${String(outcome.skipped)}`,
    `--escalated=${String(outcome.escalated)}`,
    `--reason-base64=${Buffer.from(outcome.reason, 'utf8').toString('base64')}`,
  ];
}

async function runRecorder(
  storeRoot: string,
  runId: string,
  outcome: PackReviewDeliveryGateOutcome,
) {
  return runProcess({
    command: process.execPath,
    args: recorderNodeArgs(storeRoot, runId, outcome),
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: true,
    timeoutMs: 30_000,
  });
}

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

describe('pack review delivery outcome linkage (Issue #862)', () => {
  it('classifies with skipped precedence and decodes exact multiline Unicode reason', () => {
    expect(classifyPackReviewDeliveryOutcome({
      ok: false,
      skipped: true,
      escalated: true,
      reason: 'skip wins',
    })).toEqual({
      classification: 'skipped',
      escalated: true,
      reason: 'skip wins',
    });

    const reason = 'confirmation failed:\nđã thử lại — 再試行 ✓';
    expect(parsePackReviewDeliveryOutcomeCliArgs([
      '--run-id=prr-fixture',
      '--project-id=orchestrator-pack',
      '--store-root=/tmp/review-runs=fixture',
      '--ok=false',
      '--skipped=false',
      '--escalated=true',
      `--reason-base64=${Buffer.from(reason, 'utf8').toString('base64')}`,
    ])).toEqual({
      runId: 'prr-fixture',
      projectId: 'orchestrator-pack',
      storeRoot: '/tmp/review-runs=fixture',
      ok: false,
      skipped: false,
      escalated: true,
      reason,
    });
  });

  it('rejects absent, non-string, and blank reasons without changing valid bytes', () => {
    const base = { ok: true, skipped: false, escalated: false };

    expect(() => classifyPackReviewDeliveryOutcome(base)).toThrow(/requires string reason/u);
    expect(() => classifyPackReviewDeliveryOutcome({ ...base, reason: 42 })).toThrow(/requires string reason/u);
    for (const reason of ['', '   ', '\r\n\t']) {
      expect(() => classifyPackReviewDeliveryOutcome({ ...base, reason }))
        .toThrow(/requires non-blank string reason/u);
    }

    const exactReason = '  exact reason bytes stay unchanged  ';
    expect(classifyPackReviewDeliveryOutcome({ ...base, reason: exactReason }).reason).toBe(exactReason);
  });

  it('is mechanically registered in the required Vitest light lane', () => {
    const config = JSON.parse(
      readFileSync(path.join(repoRoot, 'scripts/vitest-ci-lanes.config.json'), 'utf8'),
    ) as { classification?: Record<string, string> };
    expect(config.classification?.['scripts/pack-review-delivery-outcome.test.ts']).toBe('light');
  });

  it('atomically commits exactly one of two conflicting recorder processes', async () => {
    const storeRoot = tempRoot('opk-delivery-conflict-');
    const run = createRun(storeRoot, 862);
    const candidates = [
      { ok: true, skipped: false, escalated: false, reason: 'delivered winner candidate' },
      { ok: false, skipped: false, escalated: true, reason: 'failed winner candidate' },
    ] satisfies PackReviewDeliveryGateOutcome[];

    const results = await Promise.all(candidates.map((outcome) => runRecorder(storeRoot, run.id, outcome)));
    const successful = results.map((result, index) => ({ result, index })).filter(({ result }) => result.ok);
    const rejected = results.filter((result) => !result.ok);

    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.stderr).toMatch(/conflicting pack review delivery outcome/u);
    expect(getPackReviewRun(run.id, { storeRoot })?.deliveryOutcome).toEqual(
      classifyPackReviewDeliveryOutcome(candidates[successful[0]!.index]!),
    );
  });

  it('keeps concurrent same-value recorder processes idempotent', async () => {
    const storeRoot = tempRoot('opk-delivery-idempotent-');
    const run = createRun(storeRoot, 863);
    const outcome = {
      ok: true,
      skipped: true,
      escalated: false,
      reason: 'already_delivered — 同じ値',
    } satisfies PackReviewDeliveryGateOutcome;

    const results = await Promise.all([
      runRecorder(storeRoot, run.id, outcome),
      runRecorder(storeRoot, run.id, outcome),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(getPackReviewRun(run.id, { storeRoot })?.deliveryOutcome).toEqual(
      classifyPackReviewDeliveryOutcome(outcome),
    );
  });

  it('rejects a conflicting sequential rewrite and preserves the committed value', () => {
    const storeRoot = tempRoot('opk-delivery-sequential-');
    const run = createRun(storeRoot, 864);
    const first = {
      runId: run.id,
      storeRoot,
      ok: true,
      skipped: false,
      escalated: false,
      reason: 'confirmed',
    } as const;

    recordPackReviewDeliveryOutcome(first);
    expect(recordPackReviewDeliveryOutcome(first).deliveryOutcome?.classification).toBe('delivered');
    expect(() => recordPackReviewDeliveryOutcome({
      ...first,
      ok: false,
      reason: 'different',
    })).toThrow(/conflicting pack review delivery outcome/u);
    expect(getPackReviewRun(run.id, { storeRoot })?.deliveryOutcome).toEqual({
      classification: 'delivered',
      escalated: false,
      reason: 'confirmed',
    });
  });

  it('preserves the outcome when a later step fails the terminal run', () => {
    const storeRoot = tempRoot('opk-delivery-terminal-');
    const run = createRun(storeRoot, 865);

    recordPackReviewDeliveryOutcome({
      runId: run.id,
      storeRoot,
      ok: true,
      skipped: false,
      escalated: false,
      reason: 'confirmed before GitHub failure',
    });
    setPackReviewRunTerminal(
      run.id,
      'failed',
      { failureReason: 'GitHub review post failed', exitCode: 1 },
      { storeRoot },
    );

    expect(getPackReviewRun(run.id, { storeRoot })?.deliveryOutcome).toEqual({
      classification: 'delivered',
      escalated: false,
      reason: 'confirmed before GitHub failure',
    });
    expect(getPackReviewRun(run.id, { storeRoot })?.status).toBe('failed');
  });

  it('keeps legacy records without the datum explicitly absent', () => {
    const storeRoot = tempRoot('opk-delivery-legacy-');
    const run = createRun(storeRoot, 866);
    const recordPath = path.join(storeRoot, 'runs', `${run.id}.json`);
    const raw = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    delete raw.deliveryOutcome;
    writeFileSync(recordPath, `${JSON.stringify(raw)}\n`, 'utf8');

    expect(getPackReviewRun(run.id, { storeRoot })?.deliveryOutcome).toBeUndefined();
  });
});
