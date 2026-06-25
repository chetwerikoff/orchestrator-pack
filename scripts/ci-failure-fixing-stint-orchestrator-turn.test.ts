import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  armPostStaleEscalationLock,
  decideCiFailureNotification,
  evaluateCiFailureSuppressorDecision,
  evaluateLiveWorkerSuppressor,
  evaluateEpisodeTerminal,
  readPostStaleEscalationLock,
  recordPendingEpisode,
} from '../docs/ci-failure-notification.mjs';
import { evaluateNudgeGate } from '../docs/worker-nudge-gate.mjs';
import { buildCaptureWorkerState } from './lib/ci-failure-capture-worker-state.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'scripts/fixtures/ci-failure-notification');

const H1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const H2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const H3 = 'cccccccccccccccccccccccccccccccccccccccc';

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8')) as T;
}

function progressPins() {
  return fixture<{
    defaultProgressFreshnessMs: number;
    reportedAt: string;
    freshEvaluationMs: number;
    staleEvaluationMs: number;
  }>('ci-failure-progress-pinned.json');
}

function episodeForHead(headSha: string, redPeriod = 'suite-200-attempt-1') {
  return {
    repo: 'chetwerikoff/orchestrator-pack',
    prNumber: 283,
    headSha,
    redPeriod,
    targetId: 'session-active-redacted',
    targetGeneration: 'generation-active-redacted',
  };
}

function captureWorkerState(scenarioFixture: string, headSha: string) {
  return buildCaptureWorkerState(scenarioFixture, episodeForHead(headSha), fixturesDir);
}

function freshClock() {
  const pins = progressPins();
  return {
    nowMs: pins.freshEvaluationMs,
    config: { progressFreshnessMs: pins.defaultProgressFreshnessMs },
  };
}

function auditRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function staleClock() {
  const pins = progressPins();
  return {
    nowMs: pins.staleEvaluationMs,
    config: { progressFreshnessMs: pins.defaultProgressFreshnessMs },
  };
}

function tempStore() {
  return mkdtempSync(path.join(tmpdir(), 'ci-failure-fixing-stint-'));
}

describe('ci-failure-fixing-stint-orchestrator-turn (Issue #459)', () => {
  it('AC#1 orchestrator-turn cross-head suppress on H2 with fresh H1 fixing_ci bridge', () => {
    const ws = captureWorkerState('live-worker-cross-head-h2-bridge.json', H2);
    const decision = evaluateCiFailureSuppressorDecision({
      episode: episodeForHead(H2),
      workerState: ws,
      surface: 'orchestrator-turn',
      ...freshClock(),
    });
    expect(decision.decision).toBe('SUPPRESS');
    expect(decision.reason).toBe('suppressed-live-worker');
    expect(decision.stintClass).toBe('B');
    expect(auditRecord(decision.audit).suppressReason).toBe('suppressed-live-worker');

    const gate = evaluateNudgeGate({
      prNumber: 283,
      headSha: H2,
      sessionId: 'session-active-redacted',
      targetId: 'session-active-redacted',
      targetGeneration: 'generation-active-redacted',
      intentClass: 'ci-failure',
      source: 'orchestrator-turn',
      surface: 'orchestrator-turn',
      workerState: ws,
      storePath: '/tmp/test-claims',
      claims: [],
      ...freshClock(),
    });
    expect(gate.allow).toBe(false);
    expect(gate.reason).toBe('suppressed-live-worker');
    expect((gate.audit as Record<string, unknown>)?.ciFailureFixingStint).toMatchObject({
      suppressReason: 'suppressed-live-worker',
    });
  });

  it('AC#2 same-head dedup preserved with open stint and prior SENT claim', () => {
    const ws = captureWorkerState('live-worker-fixing-ci-captured.json', H1);
    const tupleKey = `283|episode:${H1}|ci-failure|session-active-redacted:generation-active-redacted`;
    const gate = evaluateNudgeGate({
      prNumber: 283,
      headSha: H1,
      sessionId: 'session-active-redacted',
      targetId: 'session-active-redacted',
      targetGeneration: 'generation-active-redacted',
      intentClass: 'ci-failure',
      source: 'orchestrator-turn',
      surface: 'orchestrator-turn',
      workerState: ws,
      storePath: '/tmp/test-claims',
      claims: [{ tupleKey, phase: 'SENT' }],
      ...freshClock(),
    });
    expect(gate.allow).toBe(false);
    expect(['already_served', 'suppressed-live-worker']).toContain(gate.reason);
  });

  it('AC#3 reconcile and orchestrator-turn agree on open cross-head stint', () => {
    const ws = captureWorkerState('live-worker-cross-head-h2-bridge.json', H2);
    const episode = episodeForHead(H2);
    const reconcile = evaluateCiFailureSuppressorDecision({
      episode,
      workerState: ws,
      surface: 'ci-failure-notification-reconcile',
      ...freshClock(),
    });
    const turn = evaluateCiFailureSuppressorDecision({
      episode,
      workerState: ws,
      surface: 'orchestrator-turn',
      ...freshClock(),
    });
    expect(reconcile.decision).toBe('SUPPRESS');
    expect(turn.decision).toBe('SUPPRESS');
    expect(reconcile.reason).toBe(turn.reason);
  });

  it('AC#4 progress_stale reconcile SEND arms post-stale lock that suppresses orchestrator-turn', () => {
    const storeDir = tempStore();
    try {
      const episode = episodeForHead(H1);
      mkdirSync(path.join(storeDir, 'episodes'), { recursive: true });
      recordPendingEpisode({ storeDir, episode, nowMs: Date.now() });
      const ws = captureWorkerState('live-worker-stale-same-head-fixing-ci.json', H1);
      const reconcile = evaluateCiFailureSuppressorDecision({
        episode,
        workerState: ws,
        surface: 'ci-failure-notification-reconcile',
        storeDir,
        ...staleClock(),
      });
      expect(reconcile.decision).toBe('SEND');
      expect(reconcile.reason).toBe('progress_stale');

      const lock = readPostStaleEscalationLock(storeDir, episode);
      expect(lock.open).toBe(true);

      const turn = evaluateCiFailureSuppressorDecision({
        episode,
        workerState: ws,
        surface: 'orchestrator-turn',
        storeDir,
        ...staleClock(),
      });
      expect(turn.decision).toBe('SUPPRESS');
      expect(turn.reason).toBe('post_stale_escalation_lock');

      const recovered = evaluateCiFailureSuppressorDecision({
        episode,
        workerState: captureWorkerState('live-worker-fixing-ci-captured.json', H1),
        surface: 'orchestrator-turn',
        storeDir,
        ...freshClock(),
      });
      expect(recovered.decision).toBe('SUPPRESS');
      expect(recovered.reason).toBe('suppressed-live-worker');
      expect(readPostStaleEscalationLock(storeDir, episode).open).toBe(false);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it('AC#5 stale-head without bridge remains SEND on both surfaces', () => {
    const ws = captureWorkerState('live-worker-cross-head-stale-bridge.json', H2);
    const episode = episodeForHead(H2);
    for (const surface of ['orchestrator-turn', 'ci-failure-notification-reconcile']) {
      const decision = evaluateCiFailureSuppressorDecision({
        episode,
        workerState: ws,
        surface,
        ...staleClock(),
      });
      expect(decision.decision).toBe('SEND');
      expect(decision.reason).toBe('no_suppressor');
      expect(decision.stintClass).toBe('C');
    }
  });

  it('AC#6 H1 fresh fixing_ci with H3 current suppresses orchestrator-turn', () => {
    const ws = captureWorkerState('live-worker-cross-head-h3-bridge.json', H3);
    const live = evaluateLiveWorkerSuppressor({
      episode: episodeForHead(H3),
      workerState: ws,
      ...freshClock(),
    });
    expect(live.status).toBe('matched');
    expect(live.stintClass).toBe('B');
    expect(live.bridgeHeadSha).toBe(H1);

    const turn = evaluateCiFailureSuppressorDecision({
      episode: episodeForHead(H3),
      workerState: ws,
      surface: 'orchestrator-turn',
      ...freshClock(),
    });
    expect(turn.decision).toBe('SUPPRESS');
  });

  it('AC#7 newly red during open stint still suppresses orchestrator-turn', () => {
    const ws = captureWorkerState('live-worker-cross-head-h2-bridge.json', H2);
    const episode = episodeForHead(H2, 'suite-201-attempt-2');
    const turn = evaluateCiFailureSuppressorDecision({
      episode,
      workerState: ws,
      surface: 'orchestrator-turn',
      ...freshClock(),
    });
    expect(turn.decision).toBe('SUPPRESS');
  });

  it('AC#8 cold path without qualifying report still SENDs once', () => {
    const ws = captureWorkerState('live-worker-same-head-recency.json', H1);
    const decision = evaluateCiFailureSuppressorDecision({
      episode: episodeForHead(H1),
      workerState: ws,
      surface: 'orchestrator-turn',
      ...freshClock(),
    });
    expect(decision.decision).toBe('SEND');
    expect(decision.reason).toBe('no_suppressor');
  });

  it('AC#9 cross-surface agreement matrix for Classes A/B/C', () => {
    const cases = [
      {
        label: 'A',
        ws: captureWorkerState('live-worker-fixing-ci-captured.json', H1),
        head: H1,
        expect: 'SUPPRESS',
      },
      {
        label: 'B',
        ws: captureWorkerState('live-worker-cross-head-h2-bridge.json', H2),
        head: H2,
        expect: 'SUPPRESS',
      },
      {
        label: 'C',
        ws: captureWorkerState('live-worker-cross-head-stale-bridge.json', H2),
        head: H2,
        expect: 'SEND',
        clock: staleClock(),
      },
    ];
    for (const row of cases) {
      const episode = episodeForHead(row.head);
      const clock = row.clock ?? freshClock();
      const reconcile = evaluateCiFailureSuppressorDecision({
        episode,
        workerState: row.ws,
        surface: 'ci-failure-notification-reconcile',
        ...clock,
      });
      const turn = evaluateCiFailureSuppressorDecision({
        episode,
        workerState: row.ws,
        surface: 'orchestrator-turn',
        ...clock,
      });
      expect(reconcile.decision, row.label).toBe(row.expect);
      expect(turn.decision, row.label).toBe(row.expect);
    }
  });

  it('AC#10 operator audit records stint class and surface', () => {
    const ws = captureWorkerState('live-worker-cross-head-h2-bridge.json', H2);
    const gate = evaluateNudgeGate({
      prNumber: 283,
      headSha: H2,
      sessionId: 'session-active-redacted',
      targetId: 'session-active-redacted',
      targetGeneration: 'generation-active-redacted',
      intentClass: 'ci-failure',
      source: 'orchestrator-turn',
      surface: 'orchestrator-turn',
      workerState: ws,
      storePath: '/tmp/test-claims',
      claims: [],
      ...freshClock(),
    });
    const audit = auditRecord(gate.audit).ciFailureFixingStint as Record<string, unknown>;
    expect(audit?.surface).toBe('orchestrator-turn');
    expect(audit?.stintClass).toBe('B');
    expect(audit?.headSha).toBe(H2);
    expect(audit?.bridgeHeadSha).toBe(H1);
    expect(audit?.suppressReason).toBe('suppressed-live-worker');
  });

  it('producer emission: ci-failure-fixing-stint.suppressReason', () => {
    const ws = captureWorkerState('live-worker-cross-head-h2-bridge.json', H2);
    const decision = evaluateCiFailureSuppressorDecision({
      episode: episodeForHead(H2),
      workerState: ws,
      surface: 'orchestrator-turn',
      ...freshClock(),
    });
    const emission = {
      'ci-failure-fixing-stint': {
        suppressReason: auditRecord(decision.audit).suppressReason ?? decision.reason,
      },
    };
    expect(emission['ci-failure-fixing-stint'].suppressReason).toBe('suppressed-live-worker');
    console.log(JSON.stringify(emission));
  });

  it('evaluateEpisodeTerminal preserves cross-head bridge on reconcile path', () => {
    const ws = captureWorkerState('live-worker-cross-head-h2-bridge.json', H2);
    const result = evaluateEpisodeTerminal({
      episode: episodeForHead(H2),
      workerState: ws,
      ...freshClock(),
    });
    expect(result.terminal_action).toBe('SUPPRESS');
    expect(result.reason).toBe('suppressed-live-worker');
  });

  it('decideCiFailureNotification cross-head bridge on reconcile decide path', () => {
    const ws = captureWorkerState('live-worker-cross-head-h2-bridge.json', H2);
    const result = decideCiFailureNotification({
      episode: episodeForHead(H2),
      workerState: ws,
      ...freshClock(),
    });
    expect(result.terminal_action).toBe('SUPPRESS');
    expect(result.reason).toBe('suppressed-live-worker');
  });

  it('superseded episode suppresses on orchestrator-turn instead of SEND (review opk-rev-968)', () => {
    const ws = captureWorkerState('live-worker-cross-head-h2-bridge.json', H2);
    ws.openPrs = [{ number: 283, headRefOid: H3, headCommittedAt: '2026-06-18T13:25:00.000Z' }];
    const episode = episodeForHead(H2);
    const decision = evaluateCiFailureSuppressorDecision({
      episode,
      workerState: ws,
      surface: 'orchestrator-turn',
      ...freshClock(),
    });
    expect(decision.decision).toBe('SUPPRESS');
    expect(decision.reason).toBe('abandoned-superseded');

    const gate = evaluateNudgeGate({
      prNumber: 283,
      headSha: H2,
      sessionId: 'session-active-redacted',
      targetId: 'session-active-redacted',
      targetGeneration: 'generation-active-redacted',
      intentClass: 'ci-failure',
      source: 'orchestrator-turn',
      surface: 'orchestrator-turn',
      workerState: ws,
      storePath: '/tmp/test-claims',
      claims: [],
      ...freshClock(),
    });
    expect(gate.allow).toBe(false);
    expect(gate.reason).toBe('abandoned-superseded');
  });

  it('cross-head bridge closes after non-fixing catch-up on new head (opk-rev-977)', () => {
    const ws = captureWorkerState('live-worker-cross-head-h2-bridge.json', H2);
    ws.sessions[0].reports = [
      ...ws.sessions[0].reports,
      {
        reportState: 'working',
        reportedAt: '2026-06-18T13:18:00.000Z',
        accepted: true,
        headRefOid: H2,
      },
    ];
    ws.sessions[0].status = 'working';
    const decision = evaluateCiFailureSuppressorDecision({
      episode: episodeForHead(H2),
      surface: 'orchestrator-turn',
      workerState: ws,
      ...freshClock(),
    });
    expect(decision.decision).toBe('SEND');
    expect(decision.reason).toBe('no_suppressor');
    expect(decision.stintClass).toBe('C');
  });

  it('evaluate-suppressor CLI subcommand is registered (review opk-rev-968)', () => {
    const ws = captureWorkerState('live-worker-cross-head-h2-bridge.json', H2);
    const payload = {
      episode: episodeForHead(H2),
      workerState: ws,
      surface: 'orchestrator-turn',
      ...freshClock(),
    };
    const result = spawnSync(
      'node',
      [path.join(repoRoot, 'docs/ci-failure-notification.mjs'), 'evaluate-suppressor'],
      { input: JSON.stringify(payload), encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.decision).toBe('SUPPRESS');
    expect(out.reason).toBe('suppressed-live-worker');
  });
});

describe('ci-failure-progress-stale post-stale lock (Issue #459 AC#4 emission)', () => {
  it('producer emission: ci-failure-progress-stale.auditReason', () => {
    const storeDir = tempStore();
    try {
      const episode = episodeForHead(H1);
      recordPendingEpisode({ storeDir, episode, nowMs: Date.now() });
      const ws = captureWorkerState('live-worker-stale-same-head-fixing-ci.json', H1);
      const decision = evaluateCiFailureSuppressorDecision({
        episode,
        workerState: ws,
        surface: 'ci-failure-notification-reconcile',
        storeDir,
        ...staleClock(),
      });
      const emission = {
        'ci-failure-progress-stale': {
          auditReason: auditRecord(decision.audit).auditReason ?? decision.reason,
        },
      };
      expect(emission['ci-failure-progress-stale'].auditReason).toBe('progress_stale');
      console.log(JSON.stringify(emission));
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it('armPostStaleEscalationLock persists reconcile-owned marker', () => {
    const storeDir = tempStore();
    try {
      const episode = episodeForHead(H1);
      recordPendingEpisode({ storeDir, episode, nowMs: Date.now() });
      const armed = armPostStaleEscalationLock(storeDir, episode);
      expect(armed.armed).toBe(true);
      const lock = readPostStaleEscalationLock(storeDir, episode);
      expect(lock.open).toBe(true);
      expect(lock.owner).toBe('reconcile');
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });
});
