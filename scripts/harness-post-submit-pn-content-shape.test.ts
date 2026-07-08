import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONTENT_SHAPE_ESCALATE,
  CONTENT_SHAPE_REJECT_RETRIGGER,
  CONTENT_SHAPE_WAIT_RUNNING,
  evaluateHarnessContentShapeStage,
  evaluateHarnessLatestRunContentShape,
  mapContentShapeToGateTerminal,
} from '../docs/harness-post-submit-pn-content-shape.mjs';
import { evaluateGatePollStep } from '../docs/scripted-review-confirmed-delivery-gate.mjs';
import { classifyReviewerHarnessAbort } from '../docs/harness-review-bridge.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(repoRoot, 'tests/fixtures/harness-post-submit-pn');
const captureDir = path.join(repoRoot, 'tests/external-output-references/captures/ao-0-10-daemon');

function loadJson(relativePath: string) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function loadMatrix(): Array<{
  name: string;
  latestRun: Record<string, unknown>;
  expectedAction: string;
  expectedReason?: string;
  expectedNeedsSupersede?: boolean;
  retriggerCount?: number;
  maxRetriggerCount?: number;
}> {
  return JSON.parse(readFileSync(path.join(fixtureDir, 'matrix.json'), 'utf8')).cases;
}

function gateInput(latestRun: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    verdict: 'changes_requested',
    reviews: [
      {
        prNumber: 683,
        targetSha: 'abcdef1234567890',
        latestRun: {
          batchId: 'batch-683',
          targetSha: 'abcdef1234567890',
          ...latestRun,
        },
      },
    ],
    runId: latestRun.id,
    batchId: 'batch-683',
    prNumber: 683,
    targetSha: 'abcdef1234567890',
    session: {
      sessionId: 'orchestrator-pack-45',
      prNumber: 683,
      status: 'working',
      ownedHeadSha: 'abcdef1234567890',
    },
    openPrs: [{ number: 683, headRefOid: 'abcdef1234567890' }],
    startedAtMs: 1_000_000,
    nowMs: 1_001_000,
    ...overrides,
  };
}

describe('harness post-submit [Pn] content-shape matrix (Issue #683)', () => {
  for (const cell of loadMatrix()) {
    it(cell.name, () => {
      const stage = evaluateHarnessContentShapeStage({
        latestRun: cell.latestRun,
        attributionOk: true,
        retriggerCount: cell.retriggerCount ?? 0,
        maxRetriggerCount: cell.maxRetriggerCount ?? 3,
      });
      expect(stage.action).toBe(cell.expectedAction);
      if (cell.expectedReason) expect(stage.reason).toBe(cell.expectedReason);
      if (cell.expectedNeedsSupersede) expect(stage.needsSupersede).toBe(true);
    });
  }

  it('runs inside the #669 poll step before delivered suppression', () => {
    const delivered = loadJson('tests/external-output-references/captures/ao-0-10-daemon/per-session-reviews-delivered-status.raw.json');
    const latestRun = delivered.reviews[0].latestRun;
    const step = evaluateGatePollStep(gateInput(latestRun, {
      harnessContentShape: true,
      runId: latestRun.id,
      batchId: latestRun.batchId,
      prNumber: delivered.reviews[0].prNumber,
      targetSha: latestRun.targetSha,
      openPrs: [{ number: delivered.reviews[0].prNumber, headRefOid: latestRun.targetSha }],
      session: {
        sessionId: latestRun.sessionId,
        prNumber: delivered.reviews[0].prNumber,
        status: 'working',
        ownedHeadSha: latestRun.targetSha,
      },
      reviews: delivered.reviews,
    }));
    expect(step.contentShape?.action).toBe(CONTENT_SHAPE_REJECT_RETRIGGER);
    expect(step.terminal.action).toBe('reject_retrigger');
  });

  it('rejects complete prose capture instead of treating approved prose as clean', () => {
    const complete = loadJson('tests/external-output-references/captures/ao-0-10-daemon/per-session-reviews-latestRun-status.raw.json');
    expect(evaluateHarnessLatestRunContentShape(complete.reviews[0].latestRun).action).toBe(CONTENT_SHAPE_REJECT_RETRIGGER);
  });

  it('keeps running rows waiting for #624 rather than accepting on body shape', () => {
    const cell = loadMatrix().find((entry) => entry.name === 'running-wait-624');
    expect(cell).toBeDefined();
    const mapped = mapContentShapeToGateTerminal(evaluateHarnessLatestRunContentShape(cell!.latestRun));
    expect(mapped.action).toBeNull();
    expect(evaluateHarnessLatestRunContentShape(cell!.latestRun).action).toBe(CONTENT_SHAPE_WAIT_RUNNING);
  });

  it('kill-switch escalates rather than silently accepting prose', () => {
    const cell = loadMatrix().find((entry) => entry.name === 'prose-complete-reject-retrigger');
    expect(cell).toBeDefined();
    const prior = process.env.PACK_HARNESS_PN_CONTENT_SHAPE_DISABLED;
    process.env.PACK_HARNESS_PN_CONTENT_SHAPE_DISABLED = '1';
    try {
      const stage = evaluateHarnessContentShapeStage({ latestRun: cell!.latestRun, attributionOk: true });
      expect(stage.action).toBe(CONTENT_SHAPE_ESCALATE);
      expect(stage.reason).toBe('content_shape_kill_switch');
    } finally {
      if (prior === undefined) delete process.env.PACK_HARNESS_PN_CONTENT_SHAPE_DISABLED;
      else process.env.PACK_HARNESS_PN_CONTENT_SHAPE_DISABLED = prior;
    }
  });

  it('pre-trigger reviewers-unset boundary stays delegated to #682 guard', () => {
    const fixture = JSON.parse(readFileSync(path.join(fixtureDir, 'pretrigger-reviewers-unset-boundary.json'), 'utf8'));
    const guard = classifyReviewerHarnessAbort(fixture.projectConfig, 'codex');
    expect(guard.abort).toBe(true);
    expect(guard.reason).toBe(fixture.expectedReason);
  });

  it('enforcement fixtures contain no soft instruction escape hatches', () => {
    const text = readFileSync(path.join(fixtureDir, 'matrix.json'), 'utf8');
    expect(text).not.toMatch(/soft instruction|best effort|warn-only|may accept/i);
  });
});
