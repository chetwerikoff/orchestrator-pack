import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkSmokeTestPlan,
  ensureSmokeRunArtifactDir,
  evaluateReadyForReviewCombinations,
  smokeDeliverySealedPath,
} from './lib/worker-smoke-core.ts';
import { DeterministicRuntimeAdapter } from './runtime/test-adapter.ts';
import type { RuntimeDispatchResult, RuntimeWorkerIdentity } from './runtime/contracts.ts';
import { establishRuntimeSmokeDelivery } from './worker-smoke-run.ts';

const issueBody = `
\`\`\`behavior-kind
action-producing
\`\`\`

\`\`\`smoke-test-plan
scenarios:
  - action: run runtime lifecycle | expected: PASS
\`\`\`
`;

describe('runtime-neutral worker smoke', () => {
  it('keeps the smoke-plan authoring floor', () => {
    const result = checkSmokeTestPlan(issueBody);
    expect(result.ok).toBe(true);
    expect(result.plan?.scenarios).toHaveLength(1);
  });

  it('dispatches the prompt once and consumes child delivery evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-smoke-'));
    try {
      const artifactDir = join(root, 'run-1');
      ensureSmokeRunArtifactDir(artifactDir);
      writeFileSync(smokeDeliverySealedPath(artifactDir), JSON.stringify({ runId: 'run-1' }), 'utf8');
      const adapter = new DeterministicRuntimeAdapter();
      const spawned = adapter.spawnWorker({ title: 'smoke', command: 'cursor-agent' });
      expect(spawned.status).toBe('ok');
      if (spawned.status !== 'ok') return;
      const dispatch = vi.spyOn(adapter, 'dispatchInput');

      const result = establishRuntimeSmokeDelivery({
        adapter,
        worker: spawned.value.identity,
        prompt: 'verify',
        binding: { runId: 'run-1', artifactDir },
        cwd: root,
        deadlineMs: 100,
        now: () => 1,
        sleepMs: () => undefined,
      });

      expect(result.ok).toBe(true);
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never resends after dispatch_unknown', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const spawned = adapter.spawnWorker({ title: 'smoke', command: 'cursor-agent' });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;
    const dispatch = vi.spyOn(adapter, 'dispatchInput').mockImplementation((
      _input: { readonly worker: RuntimeWorkerIdentity; readonly text?: string; readonly submitOnly?: boolean },
    ): RuntimeDispatchResult => ({ status: 'dispatch_unknown', reason: 'transport_interrupted' }));

    const result = establishRuntimeSmokeDelivery({
      adapter,
      worker: spawned.value.identity,
      prompt: 'verify',
      binding: { runId: 'run-2', artifactDir: '/missing' },
      cwd: process.cwd(),
      deadlineMs: 100,
      now: () => 1,
      sleepMs: () => undefined,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'dispatch_unknown:transport_interrupted',
      submitCount: 0,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('requires both current-head smoke and CI for ready handoff', () => {
    expect(evaluateReadyForReviewCombinations({ smokePass: true, ciGreen: true })).toBe(true);
    expect(evaluateReadyForReviewCombinations({ smokePass: true, ciGreen: false })).toBe(false);
  });
});
