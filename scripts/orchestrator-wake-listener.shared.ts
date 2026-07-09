import type { AoWebhookBody } from '../docs/orchestrator-wake-filter.mjs';

export function notificationEvent(
  overrides: Partial<NonNullable<AoWebhookBody['event']>> & {
    data?: Record<string, unknown>;
  } = {},
) {
  return {
    type: 'notification' as const,
    event: {
      id: 'evt-1',
      type: 'ci.failing',
      priority: 'action',
      sessionId: 'op-worker-3',
      projectId: 'orchestrator-pack',
      timestamp: '2026-05-28T12:00:00.000Z',
      message: 'CI failed',
      data: {
        schemaVersion: 3,
        semanticType: 'ci.failing',
        subject: {
          session: { id: 'op-worker-3', projectId: 'orchestrator-pack' },
          pr: { number: 42, url: 'https://github.com/org/repo/pull/42' },
        },
      },
      ...overrides,
    },
  };
}
