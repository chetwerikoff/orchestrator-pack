#!/usr/bin/env node
import '../toolchain/native-entrypoint-preflight.ts';
import { readFileSync } from 'node:fs';
import { dispatchReviewStartClaimOperation } from './review-start-claim-store.ts';

function readPayload(): Record<string, unknown> {
  const raw = readFileSync(0, 'utf8');
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('claim_cli_payload_must_be_object');
  return parsed as Record<string, unknown>;
}

try {
  const operation = String(process.argv[2] ?? '').trim();
  if (!operation) throw new Error('claim_cli_operation_required');
  const result = dispatchReviewStartClaimOperation(operation, readPayload());
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
