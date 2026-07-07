#!/usr/bin/env node
/**
 * AO Reviews board runtime — cross-session aggregation on AO 0.10 daemon HTTP (Issue #627).
 *
 * Usage:
 *   node --import tsx tests/ao-reviews-board-runtime/start.ts
 *   AO_DAEMON_URL=http://127.0.0.1:3001 AO_REVIEWS_BOARD_PORT=4310 node --import tsx tests/ao-reviews-board-runtime/start.ts
 */
import { createHttpDaemonClient } from './src/daemon-client.js';
import { startReviewsBoardServer } from './src/server.js';

const daemonUrl = process.env.AO_DAEMON_URL ?? 'http://127.0.0.1:3001';
const host = process.env.AO_REVIEWS_BOARD_HOST ?? '127.0.0.1';
const port = Number(process.env.AO_REVIEWS_BOARD_PORT ?? '4310');

if (!Number.isFinite(port) || port <= 0) {
  console.error('AO_REVIEWS_BOARD_PORT must be a positive integer');
  process.exit(1);
}

const client = createHttpDaemonClient({ baseUrl: daemonUrl });
const server = await startReviewsBoardServer({ host, port, client });

console.log(`AO Reviews board runtime listening on ${server.baseUrl}`);
console.log(`Board UI: ${server.baseUrl}/`);
console.log(`Daemon source: ${daemonUrl}`);
console.log(`Board JSON: ${server.baseUrl}/api/reviews`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}
