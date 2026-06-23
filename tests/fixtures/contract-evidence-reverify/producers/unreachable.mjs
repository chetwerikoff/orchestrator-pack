#!/usr/bin/env node
/** Fixture producer that simulates unreachable/offline producer by sleeping past timeout. */
const delayMs = Number(process.env.REVERIFY_DELAY_MS ?? '30000');
const start = Date.now();
while (Date.now() - start < delayMs) {
  // busy wait for deterministic timeout without network
}
