import type { AoSessionRow } from './binding.ts';

export function fixtureAoSession(overrides: Partial<AoSessionRow> = {}): AoSessionRow {
  return {
    createdAt: '2026-07-20T00:00:00.000Z',
    harness: 'cursor',
    id: 'session-923',
    isTerminated: false,
    issueId: 923,
    lastActivityAt: '2026-07-20T00:10:00.000Z',
    projectId: 'orchestrator-pack',
    role: 'worker',
    status: 'working',
    updatedAt: '2026-07-20T00:10:00.000Z',
    ...overrides,
  };
}
