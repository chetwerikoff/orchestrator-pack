import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_PAIRED_CYCLES,
  DEFAULT_MIN_SPAN_MS,
  DEFAULT_WINDOW_MS,
  FLOOD_SIGNATURE_NAME,
  detectTerminalMuxFlood,
  resolveEventSessionId,
  resolveFloodDetectConfig,
} from '../docs/terminal-flood-detect.mjs';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/terminal-flood-detect',
);

type FixturePayload = {
  description?: string;
  nowMs: number;
  events: Record<string, unknown>[];
  sessionIdFilter?: string;
  expect?: {
    flagged?: boolean;
    sessionId?: string;
    globalMuxChurn?: boolean;
  };
};

function loadFixture(name: string): FixturePayload {
  const raw = readFileSync(path.join(fixturesDir, name), 'utf8');
  return JSON.parse(raw) as FixturePayload;
}

function detectFromFixture(name: string) {
  const fixture = loadFixture(name);
  const config = resolveFloodDetectConfig({
    sessionIdFilter: fixture.sessionIdFilter,
  });
  return detectTerminalMuxFlood({
    events: fixture.events,
    nowMs: fixture.nowMs,
    ...config,
  });
}

describe('resolveEventSessionId', () => {
  it('reads sessionId from event or data', () => {
    expect(resolveEventSessionId({ sessionId: 'opk-1' })).toBe('opk-1');
    expect(resolveEventSessionId({ data: { sessionId: 'opk-2' } })).toBe('opk-2');
    expect(resolveEventSessionId({ sessionId: null })).toBeNull();
  });
});

describe('detectTerminalMuxFlood fixtures', () => {
  it('flags sustained session-local paired flapping', () => {
    const result = detectFromFixture('positive-sustained-paired-flap.json');
    expect(result.flagged).toBe(true);
    expect(result.signature).toBe(FLOOD_SIGNATURE_NAME);
    expect(result.flaggedSessions).toHaveLength(1);
    expect(result.flaggedSessions[0]?.sessionId).toBe('opk-flood-worker');
    const evidence = result.flaggedSessions[0]?.evidence as {
      pairedCycles: number;
      spanMs: number;
    };
    expect(evidence.pairedCycles).toBeGreaterThanOrEqual(DEFAULT_MIN_PAIRED_CYCLES);
    expect(evidence.spanMs).toBeGreaterThanOrEqual(DEFAULT_MIN_SPAN_MS);
  });

  it('does not flag a single dashboard refresh', () => {
    expect(detectFromFixture('negative-single-refresh.json').flagged).toBe(false);
  });

  it('does not flag a short AO restart blip', () => {
    expect(detectFromFixture('negative-ao-restart-blip.json').flagged).toBe(false);
  });

  it('does not flag benign multi-viewer disconnect churn', () => {
    expect(detectFromFixture('negative-multiple-viewers.json').flagged).toBe(false);
  });

  it('does not attribute global mux instability to a worker session', () => {
    const result = detectFromFixture('negative-global-instability.json');
    expect(result.flagged).toBe(false);
    expect(result.globalMuxChurn).toBe(true);
  });
});

describe('detectTerminalMuxFlood defaults', () => {
  it('exports safe default thresholds', () => {
    expect(DEFAULT_WINDOW_MS).toBe(60_000);
    expect(DEFAULT_MIN_PAIRED_CYCLES).toBe(6);
    expect(DEFAULT_MIN_SPAN_MS).toBe(30_000);
  });

  it('runs only from event inputs (no pane scraping)', () => {
    const fixture = loadFixture('positive-sustained-paired-flap.json');
    const result = detectTerminalMuxFlood({
      events: fixture.events,
      nowMs: fixture.nowMs,
    });
    expect(result.flagged).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/ESC\[|tmux|pane/i);
  });
});
