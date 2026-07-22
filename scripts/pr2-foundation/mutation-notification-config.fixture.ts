import '../toolchain/native-entrypoint-preflight.ts';

import path from 'node:path';
import { sendPackReviewWorkerNotification } from './worker-notification.ts';

function invariant(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

async function main(): Promise<void> {
  const headSha = 'a'.repeat(40);
  const previousRealAdapter = process.env.PACK_REVIEW_WORKER_NOTIFICATION_REAL_ADAPTER;
  process.env.PACK_REVIEW_WORKER_NOTIFICATION_REAL_ADAPTER = '1';
  try {
    const result = await sendPackReviewWorkerNotification({
      trustedPackRoot: path.resolve('.'),
      repoRoot: path.resolve('.'),
      projectId: 'orchestrator-pack',
      sessionId: 'session-923',
      prNumber: 939,
      headSha,
      foundationConfig: {
        notification: {
          timeoutMs: 'not-an-integer',
        },
      },
      request: {
        message: 'Pack review completed for PR #939.',
        idempotencyKey: `worker-notification:fixture:${headSha}`,
        reviewRunId: 'mutation-fixture-run',
      },
    });
    invariant(
      result.state === 'escalated' && result.reason === 'invalid_config:notification.timeoutMs',
      `notification_config_not_consumed_live:${result.state}:${result.reason}`,
    );
  } finally {
    if (previousRealAdapter === undefined) {
      delete process.env.PACK_REVIEW_WORKER_NOTIFICATION_REAL_ADAPTER;
    } else {
      process.env.PACK_REVIEW_WORKER_NOTIFICATION_REAL_ADAPTER = previousRealAdapter;
    }
  }
  process.stdout.write('notification-config-consumed-live:passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
