import { describe, expect, it } from 'vitest';
import {
  isDedicatedFixtureHolderBranch,
  pickDedicatedFixtureHolderSession,
  resolveAoFixtureSessionId,
} from './lib/reverify-e2e-fixture-session.js';

describe('reverify e2e fixture session resolution', () => {
  it('recognizes dedicated fixture-holder branch names', () => {
    expect(isDedicatedFixtureHolderBranch('session/opk-175')).toBe(true);
    expect(isDedicatedFixtureHolderBranch('feat/opk-176-reverify-e2e-holder')).toBe(true);
    expect(isDedicatedFixtureHolderBranch('feat/opk-178-reverify-e2e-holder-clean')).toBe(true);
    expect(isDedicatedFixtureHolderBranch('feat/issue-376')).toBe(false);
    expect(isDedicatedFixtureHolderBranch('fix/reverify-ci-fixture-holder')).toBe(false);
  });

  it('prefers session/opk-* fixture holders over feat/opk-*-reverify-e2e-holder branches', () => {
    const picked = pickDedicatedFixtureHolderSession([
      { id: 'opk-173', branch: 'feat/issue-376' },
      { id: 'opk-176', branch: 'feat/opk-176-reverify-e2e-holder' },
      { id: 'opk-175', branch: 'session/opk-175' },
    ]);
    expect(picked).toBe('opk-175');
  });

  it('prefers dedicated fixture holder before the first arbitrary worker', () => {
    const resolved = resolveAoFixtureSessionId({
      envSession: '',
      liveE2eEnabled: true,
      preferredSessionId: 'opk-reverify-e2e',
      knownSessionIds: ['opk-172', 'opk-173', 'opk-175'],
      knownSessions: [
        { id: 'opk-172', branch: 'feat/402' },
        { id: 'opk-173', branch: 'feat/issue-376' },
        { id: 'opk-175', branch: 'session/opk-175' },
      ],
      allowSpawn: false,
      spawnSession: () => null,
    });
    expect(resolved).toBe('opk-175');
  });

  it('honors OPK_REVERIFY_E2E_SESSION over dedicated fixture holders', () => {
    const resolved = resolveAoFixtureSessionId({
      envSession: 'opk-173',
      liveE2eEnabled: true,
      preferredSessionId: 'opk-reverify-e2e',
      knownSessionIds: ['opk-173', 'opk-175'],
      knownSessions: [
        { id: 'opk-173', branch: 'feat/issue-376' },
        { id: 'opk-175', branch: 'session/opk-175' },
      ],
      allowSpawn: false,
      spawnSession: () => null,
    });
    expect(resolved).toBe('opk-173');
  });

  it('does not hijack an arbitrary worker when no dedicated holder exists', () => {
    const resolved = resolveAoFixtureSessionId({
      envSession: '',
      liveE2eEnabled: true,
      preferredSessionId: 'opk-reverify-e2e',
      knownSessionIds: ['opk-172', 'opk-173'],
      knownSessions: [
        { id: 'opk-172', branch: 'feat/402' },
        { id: 'opk-173', branch: 'feat/issue-376' },
      ],
      allowSpawn: false,
      spawnSession: () => 'opk-should-not-run',
    });
    expect(resolved).toBeNull();
  });

  it('spawns an explicit fixture holder when none is live and spawn is allowed', () => {
    const resolved = resolveAoFixtureSessionId({
      envSession: '',
      liveE2eEnabled: true,
      preferredSessionId: 'opk-reverify-e2e',
      knownSessionIds: ['opk-172'],
      knownSessions: [{ id: 'opk-172', branch: 'feat/402' }],
      allowSpawn: true,
      spawnSession: () => 'opk-spawned-holder',
    });
    expect(resolved).toBe('opk-spawned-holder');
  });
});
