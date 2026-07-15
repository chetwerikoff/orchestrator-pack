import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '#opk-kernel/subprocess';
import {
  COMPACT_JSON_NO_NEWLINE,
  COMPACT_JSON_WITH_NEWLINE,
  serializeGenericJsonArtifact,
  validateJsonValue,
  type JsonObject,
  type JsonValue,
} from '#opk-kernel/json-artifact';
import {
  argumentValue,
  describeError,
  integerArgument,
  isDirectExecution,
  parseArguments,
  readStdin,
} from './cli.ts';

export const READ_DELEGATION_STOP_WRAPPER = 'scripts/invoke-read-delegation-audit-stop.ps1';
export const READ_DELEGATION_STOP_COMMAND_SHAPE =
  'pwsh <repo>/scripts/invoke-read-delegation-audit-stop.ps1 [-ArtifactPath <redacted>] [-RepoRoot <repo>]';

function asObject(value: JsonValue): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as JsonObject;
}

export interface ReadDelegationNormalizeOptions {
  readonly artifactPath?: string;
  readonly homeDirectory: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly wrapperHash: string;
}

export function normalizeReadDelegationStopPayload(
  input: string,
  options: ReadDelegationNormalizeOptions,
): JsonObject {
  let payload: Record<string, JsonValue>;
  try {
    const parsed = input.trim() ? JSON.parse(input) as unknown : {};
    payload = { ...asObject(validateJsonValue(parsed)) };
  } catch (error) {
    payload = { parseError: describeError(error) };
  }

  if (options.artifactPath) {
    payload.artifactPath = options.artifactPath;
  } else if (!Object.hasOwn(payload, 'artifactPath')) {
    payload.artifactPath = join(options.homeDirectory, '.orchestrator-pack', 'read-delegation-audit.jsonl');
  }

  if (!Object.hasOwn(payload, 'surface')) {
    const hookEventName = Object.hasOwn(payload, 'hookEventName')
      ? payload.hookEventName
      : payload.hook_event_name;
    payload.surface = hookEventName === 'Stop' ? 'claude' : 'cursor';
  }

  if (!Object.hasOwn(payload, 'env')) {
    payload.env = {
      PACK_REVIEWER: options.env?.PACK_REVIEWER ?? null,
      REVIEW_COMMAND: options.env?.REVIEW_COMMAND ?? null,
      REVIEW_SIGNAL_SOURCE: 'ambient-env',
    };
  }

  if (!Object.hasOwn(payload, 'hookWiringFingerprint')) {
    payload.hookWiringFingerprint = {
      wrapper: READ_DELEGATION_STOP_WRAPPER,
      wrapperHash: options.wrapperHash,
      commandShape: READ_DELEGATION_STOP_COMMAND_SHAPE,
    };
  }
  return payload;
}

export interface ReadDelegationAuditHealth {
  readonly kind: 'audit_error';
  readonly surface: string;
  readonly eventId: string;
  readonly emittedAtMs: number;
  readonly message: string;
}

export function buildReadDelegationAuditHealth(
  payload: JsonObject,
  message: string,
  nowMs: number,
): ReadDelegationAuditHealth {
  const timestamp = new Date(nowMs).toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace('T', '')
    .replace(/\.\d{3}Z$/, '');
  return {
    kind: 'audit_error',
    surface: typeof payload.surface === 'string' ? payload.surface : 'unknown',
    eventId: `hook-error:${timestamp}`,
    emittedAtMs: nowMs,
    message,
  };
}

export function wrapperSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function defaultRepoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArguments(argv);
  const repoRoot = argumentValue(args, 'repo-root') ?? defaultRepoRoot();
  const auditModule = join(repoRoot, 'docs', 'read-delegation-audit.mjs');
  if (!existsSync(auditModule)) {
    process.stderr.write(`WARNING: read-delegation audit module missing: ${auditModule}\n`);
    return 0;
  }
  const wrapperPath = join(repoRoot, READ_DELEGATION_STOP_WRAPPER);
  const payload = normalizeReadDelegationStopPayload(await readStdin(), {
    artifactPath: argumentValue(args, 'artifact-path'),
    homeDirectory: process.env.HOME ?? process.env.USERPROFILE ?? '',
    env: process.env,
    wrapperHash: wrapperSha256(wrapperPath),
  });
  const inputBytes = serializeGenericJsonArtifact(payload, COMPACT_JSON_NO_NEWLINE, 'read-delegation-stop-input/v1');
  const result = await runProcess({
    command: 'node',
    args: [auditModule, 'stop'],
    input: inputBytes,
    inheritParentEnv: true,
    timeoutMs: 120_000,
  });
  if (result.ok) return 0;

  const message = `audit module exited ${result.exitCode ?? result.outcome}: ${result.stderr || result.error || result.stdout}`;
  const artifact = typeof payload.artifactPath === 'string' ? payload.artifactPath : '';
  if (!artifact) {
    process.stderr.write(`WARNING: failed to record audit health error: artifact path is empty\n`);
    return 0;
  }
  try {
    mkdirSync(dirname(artifact), { recursive: true });
    const nowMs = integerArgument(args, 'now-ms', Date.now());
    const health = buildReadDelegationAuditHealth(payload, message, nowMs);
    appendFileSync(
      artifact,
      serializeGenericJsonArtifact(validateJsonValue(health), COMPACT_JSON_WITH_NEWLINE, 'read-delegation-stop-health/v1'),
    );
  } catch (error) {
    process.stderr.write(`WARNING: failed to record audit health error: ${describeError(error)}\n`);
  }
  return 0;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`WARNING: read-delegation audit wrapper failed open: ${describeError(error)}\n`);
    return 0;
  });
}
