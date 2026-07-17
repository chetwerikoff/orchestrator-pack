import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareAndSetPackReviewDeliveryOutcome,
  type PackReviewDeliveryOutcome,
  type PackReviewRunRecord,
  type PackReviewStoreOptions,
} from './pack-review-run-store.ts';

export interface PackReviewDeliveryGateOutcome {
  ok: boolean;
  skipped: boolean;
  escalated: boolean;
  reason: string;
}

export interface RecordPackReviewDeliveryOutcomeInput extends PackReviewDeliveryGateOutcome, PackReviewStoreOptions {
  runId: string;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('pack review delivery outcome must be an object');
  }
  return value as Record<string, unknown>;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`pack review delivery outcome requires boolean ${name}`);
  return value;
}

function requiredReason(value: unknown): string {
  if (typeof value !== 'string') throw new Error('pack review delivery outcome requires string reason');
  if (!value.trim()) throw new Error('pack review delivery outcome requires non-blank string reason');
  return value;
}

export function classifyPackReviewDeliveryOutcome(value: unknown): PackReviewDeliveryOutcome {
  const raw = asObject(value);
  const skipped = requiredBoolean(raw.skipped, 'skipped');
  const ok = requiredBoolean(raw.ok, 'ok');
  return {
    classification: skipped ? 'skipped' : ok ? 'delivered' : 'failed',
    escalated: requiredBoolean(raw.escalated, 'escalated'),
    reason: requiredReason(raw.reason),
  };
}

export function recordPackReviewDeliveryOutcome(
  input: RecordPackReviewDeliveryOutcomeInput,
): PackReviewRunRecord {
  const runId = String(input.runId ?? '').trim();
  if (!runId) throw new Error('pack review delivery outcome requires runId');
  const deliveryOutcome = classifyPackReviewDeliveryOutcome(input);
  return compareAndSetPackReviewDeliveryOutcome(runId, deliveryOutcome, {
    projectId: input.projectId,
    storeRoot: input.storeRoot,
    now: input.now,
  });
}

function argumentValue(argv: readonly string[], name: string): string {
  const prefix = `${name}=`;
  const argument = argv.find((candidate) => candidate.startsWith(prefix));
  if (argument === undefined) throw new Error(`pack review delivery outcome requires ${name}`);
  return argument.slice(prefix.length);
}

function booleanArgument(argv: readonly string[], name: string): boolean {
  const value = argumentValue(argv, name);
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`pack review delivery outcome requires ${name}=true|false`);
}

function decodeReason(encoded: string): string {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new Error('pack review delivery outcome requires canonical base64 reason');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) {
    throw new Error('pack review delivery outcome requires canonical base64 reason');
  }
  return bytes.toString('utf8');
}

export function parsePackReviewDeliveryOutcomeCliArgs(
  argv: readonly string[],
): RecordPackReviewDeliveryOutcomeInput {
  return {
    runId: argumentValue(argv, '--run-id'),
    projectId: argumentValue(argv, '--project-id'),
    storeRoot: argumentValue(argv, '--store-root'),
    ok: booleanArgument(argv, '--ok'),
    skipped: booleanArgument(argv, '--skipped'),
    escalated: booleanArgument(argv, '--escalated'),
    reason: decodeReason(argumentValue(argv, '--reason-base64')),
  };
}

async function main(): Promise<void> {
  recordPackReviewDeliveryOutcome(parsePackReviewDeliveryOutcomeCliArgs(process.argv.slice(2)));
}

const direct = process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false;
if (direct) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
