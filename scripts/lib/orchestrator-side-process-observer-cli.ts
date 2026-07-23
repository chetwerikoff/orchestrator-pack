#!/usr/bin/env node
import '../toolchain/native-entrypoint-preflight.ts';
import { readFileSync } from 'node:fs';
import { dispatchObserverOperation, type ObserverRecord } from './orchestrator-side-process-observer.ts';

try {
  const operation = String(process.argv[2] ?? '').trim();
  if (!operation) throw new Error('side_process_observer_operation_required');
  const raw = readFileSync(0, 'utf8');
  const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('side_process_observer_payload_must_be_object');
  process.stdout.write(`${JSON.stringify(dispatchObserverOperation(operation, parsed as ObserverRecord))}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
