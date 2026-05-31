import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_WAKE_DEDUP_WINDOW_MS,
  HEARTBEAT_WAKE_KIND,
  applyDedupTry,
  buildHeartbeatWakeMessage,
  dedupLockPath,
  evaluateHeartbeatTick,
  evaluateOrchestratorWakeSend,
  GLOBAL_ORCHESTRATOR_WAKE_KEY,
  releaseDedupStateLock,
  acquireDedupStateLock,
} from '../docs/orchestrator-wake-filter.mjs';

describe('dedup state file lock', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempStateFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-dedup-test-'));
    tmpDirs.push(dir);
    return path.join(dir, 'orchestrator-wake-dedup.json');
  }

  it('applyDedupTry serializes a second wake within the global window', () => {
    const stateFile = tempStateFile();
    const now = 6_000_000;
    const first = applyDedupTry({
      filePath: stateFile,
      dedupeKey: 'ci.failing|op-1||',
      dedupWindowMs: DEFAULT_WAKE_DEDUP_WINDOW_MS,
      nowMs: now,
    });
    expect(first.ok).toBe(true);

    const second = applyDedupTry({
      filePath: stateFile,
      dedupeKey: 'heartbeat.reconcile|orchestrator',
      dedupWindowMs: DEFAULT_WAKE_DEDUP_WINDOW_MS,
      nowMs: now + 1_000,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('global_deduped');
    }
    expect(fs.existsSync(dedupLockPath(stateFile))).toBe(false);
  });

  it('returns dedup_lock_timeout when the lock is held', () => {
    const stateFile = tempStateFile();
    const held = acquireDedupStateLock(stateFile);
    expect(held).not.toBeNull();

    const blocked = applyDedupTry({
      filePath: stateFile,
      dedupeKey: 'ci.failing|op-9||',
      dedupWindowMs: DEFAULT_WAKE_DEDUP_WINDOW_MS,
      nowMs: Date.now(),
    });
    expect(blocked).toEqual({ ok: false, reason: 'dedup_lock_timeout' });

    releaseDedupStateLock(held);
  });
});

describe('buildHeartbeatWakeMessage', () => {
  it('is distinguishable from event-driven wake messages', () => {
    const message = buildHeartbeatWakeMessage();
    expect(message).toBe('wake heartbeat.reconcile periodic=reconcile');
    expect(message).toContain(HEARTBEAT_WAKE_KIND);
    expect(message).not.toMatch(/session=/);
  });
});

describe('evaluateOrchestratorWakeSend', () => {
  it('blocks a second wake within the global dedup window', () => {
    const now = 1_000_000;
    const first = evaluateOrchestratorWakeSend({
      dedupeKey: 'ci.failing|op-1||',
      nowMs: now,
      dedupWindowMs: DEFAULT_WAKE_DEDUP_WINDOW_MS,
      entries: {},
    });
    expect(first.ok).toBe(true);

    const heartbeat = evaluateOrchestratorWakeSend({
      dedupeKey: 'heartbeat.reconcile|orchestrator',
      nowMs: now + 5_000,
      dedupWindowMs: DEFAULT_WAKE_DEDUP_WINDOW_MS,
      entries: first.entries,
    });
    expect(heartbeat.ok).toBe(false);
    if (!heartbeat.ok) {
      expect(heartbeat.reason).toBe('global_deduped');
    }
    expect(first.entries?.[GLOBAL_ORCHESTRATOR_WAKE_KEY]).toBe(now);
  });
});

describe('evaluateHeartbeatTick', () => {
  it('accepts first heartbeat when interval elapsed', () => {
    const now = 2_000_000;
    const result = evaluateHeartbeatTick({
      nowMs: now,
      intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
      lastHeartbeatSentMs: undefined,
      entries: {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.wakeKind).toBe(HEARTBEAT_WAKE_KIND);
      expect(result.wakeMessage).toBe(buildHeartbeatWakeMessage());
      expect(result.lastHeartbeatSentMs).toBe(now);
    }
  });

  it('skips when interval has not elapsed', () => {
    const now = 3_000_000;
    const result = evaluateHeartbeatTick({
      nowMs: now + 60_000,
      intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
      lastHeartbeatSentMs: now,
      entries: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('interval_not_elapsed');
    }
  });

  it('skips heartbeat when a recent event wake consumed global dedup', () => {
    const now = 4_000_000;
    const event = evaluateOrchestratorWakeSend({
      dedupeKey: 'merge.ready|op-2||',
      nowMs: now,
      dedupWindowMs: DEFAULT_WAKE_DEDUP_WINDOW_MS,
      entries: {},
    });
    expect(event.ok).toBe(true);

    const heartbeat = evaluateHeartbeatTick({
      nowMs: now + 5_000,
      intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
      lastHeartbeatSentMs: undefined,
      entries: event.entries,
      dedupWindowMs: DEFAULT_WAKE_DEDUP_WINDOW_MS,
    });
    expect(heartbeat.ok).toBe(false);
    if (!heartbeat.ok) {
      expect(heartbeat.reason).toBe('global_deduped');
    }
  });

  it('accepts heartbeat after interval and dedup window passed', () => {
    const now = 5_000_000;
    const event = evaluateOrchestratorWakeSend({
      dedupeKey: 'ci.failing|op-3||',
      nowMs: now,
      dedupWindowMs: DEFAULT_WAKE_DEDUP_WINDOW_MS,
      entries: {},
    });
    expect(event.ok).toBe(true);

    const heartbeat = evaluateHeartbeatTick({
      nowMs: now + DEFAULT_HEARTBEAT_INTERVAL_MS + DEFAULT_WAKE_DEDUP_WINDOW_MS,
      intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
      lastHeartbeatSentMs: undefined,
      entries: event.entries,
      dedupWindowMs: DEFAULT_WAKE_DEDUP_WINDOW_MS,
    });
    expect(heartbeat.ok).toBe(true);
  });
});
