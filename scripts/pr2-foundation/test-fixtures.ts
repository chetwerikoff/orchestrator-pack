import type { AoSessionRow } from './binding.ts';

const SESSION_TIMESTAMPS = Object.freeze({
  createdAt: '2026-07-20T00:00:00.000Z',
  lastActivityAt: '2026-07-20T00:10:00.000Z',
  updatedAt: '2026-07-20T00:10:00.000Z',
});

export function fixtureAoSession(overrides: Partial<AoSessionRow> = {}): AoSessionRow {
  return {
    ...SESSION_TIMESTAMPS,
    harness: 'cursor',
    id: 'session-923',
    isTerminated: false,
    issueId: 923,
    projectId: 'orchestrator-pack',
    role: 'worker',
    status: 'working',
    ...overrides,
  };
}
