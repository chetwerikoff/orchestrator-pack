/**
 * Generate deterministic AO 0.10.2 direct-gate spawn captures (Issue #480 / #821).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from './_test-pwsh-helpers.js';

type SpawnEvent = {
  atMs: number;
  commandLine: string;
  sourceHint: string;
  childId: string;
};

function supervisorEvent(atMs: number): SpawnEvent {
  return {
    atMs,
    commandLine: 'pwsh -NoProfile -File scripts/review-trigger-reconcile.ps1 -DryRun -Once',
    sourceHint: 'review-trigger-reconcile.ps1',
    childId: 'review-trigger-reconcile',
  };
}

function reviewStartEvent(atMs: number): SpawnEvent {
  return {
    atMs,
    commandLine: 'pwsh -NoProfile -File scripts/ao-review.ps1 run opk-75',
    sourceHint: 'ao-review.ps1',
    childId: 'llm-orchestrator-review-start',
  };
}

function buildEvents(count: number): SpawnEvent[] {
  return Array.from({ length: count }, (_, index) => {
    const atMs = Math.round((index / Math.max(1, count - 1)) * 60_000);
    return index % 2 === 0 ? supervisorEvent(atMs) : reviewStartEvent(atMs);
  });
}

function writeCapture(caseId: 'storm-baseline' | 'reduced-post-change', count: number) {
  const events = buildEvents(count);
  const capture = {
    version: 'review-pipeline-spawn-capture/v1',
    caseId,
    measurementModel: 'journal-rate-attribution',
    captureProvenance: {
      callerPath: 'generate-review-pipeline-spawn-captures.ts',
      capturedAt: '2026-07-15T00:00:00.000Z',
      profile: caseId,
      method: 'deterministic-ao-0.10.2-direct-gate-fixture',
      measurementModel: 'journal-rate-attribution',
      subprocessInvocationCount: events.length,
    },
    window: {
      startedAtMs: 0,
      endedAtMs: 60_000,
      elapsedMs: 60_000,
      callerCadencePerMinute: 12,
    },
    events,
    pointInTimePsSnapshot: {
      processCount: caseId === 'storm-baseline' ? 4 : 1,
      capturedAtMs: 60_000,
      note: 'supplementary point-in-time snapshot; journal-rate attribution is authoritative',
    },
  };
  const outDir = path.join(repoRoot, 'tests/external-output-references/review-pipeline-spawn-budget');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, `${caseId}.capture.json`), `${JSON.stringify(capture, null, 2)}\n`);
}

writeCapture('storm-baseline', 30);
writeCapture('reduced-post-change', 2);
