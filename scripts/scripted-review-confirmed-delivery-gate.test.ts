import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildGateEscalationMessage,
  evaluateGatePollStep,
  evaluateGateTerminalAction,
  evaluatePostSendComposition,
  findReviewEntryForSubmit,
  isDaemonDeliveryConfirmed,
  isTerminalNotDelivered,
  resolveGateConfig,
} from '../docs/scripted-review-confirmed-delivery-gate.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'scripts/fixtures/scripted-review-confirmed-delivery-gate');
const captureRoot = path.join(repoRoot, 'tests/external-output-references/captures/ao-0-10-daemon');

function loadCapture(name: string) {
  return JSON.parse(readFileSync(path.join(captureRoot, `${name}.raw.json`), 'utf8'));
}

function loadScenario(name: string) {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8'));
}

describe('confirmed-delivery gate config', () => {
  it('defaults poll window to 45s with 2s interval and caps at 120s', () => {
    expect(resolveGateConfig({})).toEqual({ pollWindowMs: 45_000, pollIntervalMs: 2_000 });
    expect(resolveGateConfig({ pollWindowSeconds: 300 })).toEqual({
      pollWindowMs: 120_000,
      pollIntervalMs: 2_000,
    });
  });
});

describe('confirmation predicate (AC#2)', () => {
  it('confirms only latestRun.status=delivered from live delivered capture', () => {
    const capture = loadCapture('per-session-reviews-delivered-status');
    const latest = capture.reviews[0].latestRun;
    expect(isDaemonDeliveryConfirmed(latest.status)).toBe(true);
    expect(latest).not.toHaveProperty('deliveredAt');
  });

  it('treats complete changes_requested capture as not confirmed', () => {
    const capture = loadCapture('per-session-reviews-latestRun-status');
    const latest = capture.reviews[0].latestRun;
    expect(isTerminalNotDelivered(latest.status)).toBe(true);
    expect(isDaemonDeliveryConfirmed(latest.status)).toBe(false);
  });
});

describe('poll contract (AC#1)', () => {
  it('gate ps1 reads reviews via Get-AoSessionReviewsJson shim only', () => {
    const text = readFileSync(path.join(repoRoot, 'scripts/scripted-review-confirmed-delivery-gate.ps1'), 'utf8');
    expect(text).toMatch(/Get-AoSessionReviewsJson/);
    expect(text).not.toMatch(/(?:Read-|Open-|sqlite3|SELECT\s+).{0,20}ao\.db/i);
  });
});

describe('gate decision matrix (AC#9)', () => {
  it('cr-delivered-live suppresses explicit send', () => {
    const scenario = loadScenario('cr-delivered-live-suppress.json');
    const step = evaluateGatePollStep(scenario.input);
    expect(step.terminal.action).toBe('suppress');
  });

  it('cr-delivered-drift escalates', () => {
    const scenario = loadScenario('cr-delivered-drift-escalate.json');
    const step = evaluateGatePollStep(scenario.input);
    expect(step.terminal.action).toBe('escalate');
  });

  it('cr-not-delivered-live sends after window expiry', () => {
    const scenario = loadScenario('cr-not-delivered-live-send.json');
    const step = evaluateGatePollStep(scenario.input);
    expect(step.terminal.action).toBe('send');
  });

  it('cr-ambiguous-live escalates', () => {
    const scenario = loadScenario('cr-ambiguous-live-escalate.json');
    const step = evaluateGatePollStep(scenario.input);
    expect(step.terminal.action).toBe('escalate');
  });

  it('approved-live sends without polling', () => {
    const terminal = evaluateGateTerminalAction({
      verdict: 'approved',
      pollOutcome: { outcome: 'not_delivered' },
      liveness: { liveness: 'live_head_owning' },
      windowExpired: false,
    });
    expect(terminal.action).toBe('send');
  });

  it('approved-dead escalates', () => {
    const scenario = loadScenario('approved-dead-escalate.json');
    const step = evaluateGatePollStep(scenario.input);
    expect(step.terminal.action).toBe('escalate');
  });

  it.each([
    'cr-delivered-dead-escalate.json',
    'cr-not-delivered-drift-escalate.json',
    'cr-not-delivered-dead-escalate.json',
    'cr-ambiguous-drift-escalate.json',
    'cr-ambiguous-dead-escalate.json',
    'approved-drift-escalate.json',
  ])('matrix cell %s escalates', (fixtureName) => {
    const scenario = loadScenario(fixtureName);
    const step = evaluateGatePollStep(scenario.input);
    expect(step.terminal.action).toBe('escalate');
  });

  it('approved-live fixture sends', () => {
    const scenario = loadScenario('approved-live-send.json');
    const step = evaluateGatePollStep(scenario.input);
    expect(step.terminal.action).toBe('send');
  });
});

describe('post-send composition (AC#8)', () => {
  it('confirmed explicit send delivers once', () => {
    expect(
      evaluatePostSendComposition({ explicitSendOutcome: 'confirmed' }).terminal,
    ).toBe('delivered_once');
  });

  it('failed explicit send escalates', () => {
    expect(evaluatePostSendComposition({ explicitSendOutcome: 'failed' }).terminal).toBe('escalate');
  });

  it('late auto-delivery race dedups or escalates', () => {
    expect(
      evaluatePostSendComposition({
        explicitSendOutcome: 'race_late_auto_delivery',
        lateAutoDeliveryConfirmed: true,
        dedupApplied: true,
      }).terminal,
    ).toBe('dedup_or_escalate');
    expect(
      evaluatePostSendComposition({
        explicitSendOutcome: 'race_late_auto_delivery',
        lateAutoDeliveryConfirmed: true,
        dedupFailed: true,
      }).terminal,
    ).toBe('escalate');
  });

  it.each([
    ['post-send-confirmed.json', 'delivered_once'],
    ['post-send-failed.json', 'escalate'],
    ['post-send-race-dedup.json', 'dedup_or_escalate'],
  ])('post-send fixture %s', (fixtureName, expected) => {
    const scenario = loadScenario(fixtureName);
    expect(evaluatePostSendComposition(scenario.input).terminal).toBe(expected);
  });
});

describe('attribution and overlapping runs (AC#7)', () => {
  it('flags unattributable latestRun as ambiguous', () => {
    const result = findReviewEntryForSubmit([], {
      runId: 'missing',
      prNumber: 649,
      targetSha: 'abc',
    });
    expect(result.ok).toBe(false);
  });

  it('builds operator escalation message with remedy text', () => {
    const message = buildGateEscalationMessage({
      runId: 'run-1',
      sessionId: 'opk-1',
      prNumber: 649,
      reason: 'ambiguous_poll',
    });
    expect(message).toContain('[scripted-review-confirmed-delivery-gate] ESCALATION:');
    expect(message).toContain('Operator remedy:');
  });
});

describe('supervisor compatibility (AC#10)', () => {
  it('registers scripted-review-confirmed-delivery-gate side-process progress id', () => {
    const text = readFileSync(path.join(repoRoot, 'scripts/scripted-review-confirmed-delivery-gate.ps1'), 'utf8');
    expect(text).toMatch(/scripted-review-confirmed-delivery-gate/);
    expect(text).toMatch(/Write-OrchestratorSideProcessProgress/);
  });
});

describe('post-submit seam wiring', () => {
  it('invoke-scripted-review-post-submit-delivery forwards to gate script', () => {
    const text = readFileSync(
      path.join(repoRoot, 'scripts/invoke-scripted-review-post-submit-delivery.ps1'),
      'utf8',
    );
    expect(text).toMatch(/scripted-review-confirmed-delivery-gate\.ps1/);
  });
});
