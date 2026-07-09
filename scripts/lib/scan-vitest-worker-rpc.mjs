#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { scanWorkerRpcSignatures } from './vitest-ci-lanes.mjs';

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/lib/scan-vitest-worker-rpc.mjs <log-file>');
  process.exit(2);
}

const text = readFileSync(path, 'utf8');
const hits = scanWorkerRpcSignatures(text);
if (hits.length > 0) {
  process.exit(1);
}
process.exit(0);
