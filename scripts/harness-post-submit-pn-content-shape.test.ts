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
  shouldRunHarnessContentShapeStage,
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

  it('bound allows retrigger at max-1 and escalates at max', () => {
    const cell = loadMatrix().find((entry) => entry.name === 'prose-complete-reject-retrigger');
    expect(cell).toBeDefined();
    const atMaxMinusOne = evaluateHarnessContentShapeStage({
      latestRun: cell!.latestRun,
      attributionOk: true,
      retriggerCount: 2,
      maxRetriggerCount: 3,
    });
    expect(atMaxMinusOne.action).toBe(CONTENT_SHAPE_REJECT_RETRIGGER);
    const atMax = evaluateHarnessContentShapeStage({
      latestRun: cell!.latestRun,
      attributionOk: true,
      retriggerCount: 3,
      maxRetriggerCount: 3,
    });
    expect(atMax.action).toBe(CONTENT_SHAPE_ESCALATE);
    expect(atMax.reason).toBe('retrigger_bound_exhausted');
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

  it('persists harness retrigger count across gate reruns', () => {
    const gate = readFileSync(path.join(repoRoot, 'scripts/scripted-review-confirmed-delivery-gate.ps1'), 'utf8');
    const reconcile = readFileSync(path.join(repoRoot, 'scripts/harness-post-submit-pn-reconcile.ps1'), 'utf8');
    const state = readFileSync(path.join(repoRoot, 'scripts/lib/Harness-PnRetriggerState.ps1'), 'utf8');
    expect(state).toMatch(/Set-HarnessPnRetriggerCount/);
    expect(state).toMatch(/Resolve-HarnessPnRetriggerCount/);
    expect(reconcile).toMatch(/Set-HarnessPnRetriggerCount/);
    expect(gate).toMatch(/Resolve-HarnessPnRetriggerCount/);
  });

  it('limits content-shape stage to harness latestRun rows', () => {
    expect(shouldRunHarnessContentShapeStage({ harnessContentShape: true }, { latestRun: { harness: 'codex' } })).toBe(true);
    expect(shouldRunHarnessContentShapeStage({ harnessContentShape: true }, { latestRun: { harness: '' } })).toBe(false);
    expect(shouldRunHarnessContentShapeStage({ harnessContentShape: true }, { latestRun: {} })).toBe(false);
  });

  it('does not reject non-harness prose inside the #669 poll step', () => {
    const step = evaluateGatePollStep(gateInput({
      id: 'run-non-harness',
      status: 'complete',
      verdict: 'changes_requested',
      body: 'Finding: prose without Pn prefix',
    }, { harnessContentShape: true }));
    expect(step.contentShape?.reason).toBe('non_harness_run');
    expect(step.terminal.action).not.toBe('reject_retrigger');
  });

  it('dispatches explicit delivery on content-valid send terminal', () => {
    const gate = readFileSync(path.join(repoRoot, 'scripts/scripted-review-confirmed-delivery-gate.ps1'), 'utf8');
    const reconcile = readFileSync(path.join(repoRoot, 'scripts/harness-post-submit-pn-reconcile.ps1'), 'utf8');
    const explicit = readFileSync(path.join(repoRoot, 'scripts/lib/Invoke-ScriptedReviewDeliveryExplicitSend.ps1'), 'utf8');
    expect(explicit).toMatch(/Invoke-ScriptedReviewDeliveryExplicitSend/);
    expect(reconcile).toMatch(/Invoke-HarnessPnReconcileExplicitSend/);
    expect(reconcile).toMatch(/Complete-HarnessPnReconcileAfterExplicitSend/);
    expect(reconcile).toMatch(/action -eq 'send'/);
    expect(reconcile).not.toMatch(/suppress'\s+-or\s+\$action\s+-eq\s+'send'/);
    expect(gate).toMatch(/-DeliveryMessage/);
  });

  it('live smoke workflow arms on session var and stays fail-closed in-script', () => {
    const workflow = readFileSync(path.join(repoRoot, '.github/workflows/harness-pn-live-smoke.yml'), 'utf8');
    const liveSmoke = readFileSync(path.join(repoRoot, 'scripts/check-harness-post-submit-pn-live-smoke.ps1'), 'utf8');
    expect(workflow).not.toMatch(/^\s*if:\s*.*PACK_HARNESS_PN_SMOKE_ENABLED/m);
    expect(workflow).toMatch(/if:\s*\$\{\{\s*vars\.PACK_HARNESS_PN_SMOKE_SESSION/);
    expect(workflow).toMatch(/PACK_HARNESS_PN_SMOKE_ENABLED/);
    expect(workflow).toMatch(/PACK_HARNESS_PN_SMOKE_SESSION/);
    expect(liveSmoke).not.toMatch(/\[SKIP\] live harness \[Pn\] smoke not operator-enabled/);
    expect(liveSmoke).toMatch(/Get-AoDaemonHealthJson|Resolve-HarnessPnLiveSmokeDaemonBaseUrl/);
    expect(workflow).toMatch(/pull_request:/);
    expect(workflow).toMatch(/check-harness-post-submit-pn-live-smoke\.ps1/);
  });
});
