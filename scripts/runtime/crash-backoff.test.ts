import { describe, expect, it } from 'vitest';
import {
  EMPTY_CRASH_BACKOFF_STATE,
  recordChildExit,
  rearmTerminalCrashState,
  restartDecisionAt,
  type CrashBackoffPolicy,
} from './crash-backoff.ts';

const policy: CrashBackoffPolicy = {
  rapidExitThresholdMs: 5_000,
  maxRapidExitsBeforeBackoff: 3,
  terminalRapidExits: 5,
  baseBackoffMs: 1_000,
  maxBackoffMs: 8_000,
};

describe('TypeScript crash-loop backoff', () => {
  it('backs off exponentially after the configured rapid-exit floor', () => {
    let state = EMPTY_CRASH_BACKOFF_STATE;
    for (let index = 0; index < 3; index += 1) {
      state = recordChildExit({
        previous: state,
        startedAtMs: index * 10_000,
        exitedAtMs: index * 10_000 + 100,
        policy,
      });
    }
    expect(state.reason).toBe('backoff');
    expect(state.waitMs).toBe(1_000);
    expect(restartDecisionAt(state, state.lastExitMs + 999).restartAllowed).toBe(false);
    expect(restartDecisionAt(state, state.lastExitMs + 1_000).restartAllowed).toBe(true);
  });

  it('opens a terminal circuit without probing AO', () => {
    let state = EMPTY_CRASH_BACKOFF_STATE;
    for (let index = 0; index < policy.terminalRapidExits; index += 1) {
      state = recordChildExit({
        previous: state,
        startedAtMs: index * 10_000,
        exitedAtMs: index * 10_000 + 100,
        policy,
      });
    }
    expect(state.terminal).toBe(true);
    expect(state.reason).toBe('terminal');
    expect(rearmTerminalCrashState({ state, replacementHealthy: false })).toBe(state);
    expect(rearmTerminalCrashState({ state, replacementHealthy: true })).toEqual(EMPTY_CRASH_BACKOFF_STATE);
  });

  it('resets rapid-exit history after healthy progress', () => {
    const first = recordChildExit({
      startedAtMs: 100,
      exitedAtMs: 200,
      policy,
    });
    const healthy = recordChildExit({
      previous: first,
      startedAtMs: 1_000,
      exitedAtMs: 10_000,
      progressObserved: true,
      policy,
    });
    expect(healthy.rapidExits).toBe(0);
    expect(healthy.restartAllowed).toBe(true);
  });
});
