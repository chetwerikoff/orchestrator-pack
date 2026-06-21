#!/usr/bin/env node
/**
 * Genuine NEW-row proof: invokes the repo producer script then reports emission.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const producer = path.join(here, 'emit-reverify-status.mjs');
const result = spawnSync(process.execPath, [producer], {
  encoding: 'utf8',
  env: { ...process.env, REVERIFY_PRODUCER_INVOKED: '1' },
});
if (result.status !== 0) {
  process.stderr.write(result.stderr ?? '');
  process.exit(result.status ?? 1);
}
const payload = JSON.parse(result.stdout.trim());
process.stdout.write(JSON.stringify({ invokedProducerPath: true, ...payload }));
