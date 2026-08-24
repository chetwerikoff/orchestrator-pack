#!/usr/bin/env -S node --experimental-strip-types

import '../toolchain/native-entrypoint-preflight.ts';
import { existsSync, readFileSync } from 'node:fs';
import {
  currentWorkerAssignment,
  inspectWorkerAssignmentStore,
  parseWorkerAssignmentRole,
  publishCurrentWorkerAssignment,
  resolveWorkerAssignmentStorePath,
  type WorkerAssignmentExpectation,
  type WorkerAssignmentRole,
  type WorkerAssignmentStoreTrustCause,
} from '../lib/worker-assignment-store.ts';
import { admitCurrentWorkerAssignmentReplacement } from '../lib/worker-assignment-runtime.ts';
import { selectRuntimeAdapter } from '../runtime/registry.ts';
import type { RuntimeAdapter } from '../runtime/contracts.ts';

export type RemoteWorkerAssignmentExpectation =
  | { readonly kind: 'none' }
  | { readonly kind: 'exact'; readonly assignmentId: string; readonly generation: number };

export type RemoteWorkerAssignmentResult =
  | { readonly ok: true; readonly reason: 'remote_assignment_published'; readonly assignment: import('../lib/worker-assignment-store.ts').WorkerAssignment }
  | { readonly ok: false; readonly reason: string; readonly cause?: WorkerAssignmentStoreTrustCause };

function bounded(value: unknown, max: number): string {
  const text = String(value ?? '').trim();
  return text.length > 0 && text.length <= max && !/[\u0000-\u001f\u007f]/u.test(text) ? text : '';
}

function exactExpectation(expectation: RemoteWorkerAssignmentExpectation): WorkerAssignmentExpectation | undefined {
  return expectation.kind === 'exact'
    ? { assignmentId: expectation.assignmentId, generation: expectation.generation }
    : undefined;
}

export async function publishOperatorRemoteWorkerAssignment(input: {
  readonly repository: string;
  readonly issueNumber: number;
  readonly taskId: string;
  readonly provider: string;
  readonly bindingKey: string;
  readonly expectation: RemoteWorkerAssignmentExpectation;
  /** Direct invocation is the trust root; this explicit bit prevents accidental library-path use. */
  readonly operatorAttested: boolean;
  readonly role?: WorkerAssignmentRole | string;
  readonly projectId?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly adapter?: RuntimeAdapter;
}): Promise<RemoteWorkerAssignmentResult> {
  const repository = bounded(input.repository, 240).toLowerCase();
  const taskId = bounded(input.taskId, 160);
  const provider = bounded(input.provider, 80).toLowerCase();
  const bindingKey = bounded(input.bindingKey, 240);
  const role = parseWorkerAssignmentRole(input.role);
  if (!role) return { ok: false, reason: 'assignment_role_invalid' };
  if (!input.operatorAttested) return { ok: false, reason: 'operator_attestation_required' };
  if (!repository || !Number.isInteger(input.issueNumber) || input.issueNumber <= 0
    || !taskId || !provider || !bindingKey) {
    return { ok: false, reason: 'remote_assignment_input_invalid' };
  }
  if (input.expectation.kind === 'exact'
    && (!bounded(input.expectation.assignmentId, 160)
      || !Number.isInteger(input.expectation.generation)
      || input.expectation.generation <= 0)) {
    return { ok: false, reason: 'remote_assignment_expectation_invalid' };
  }

  const file = resolveWorkerAssignmentStorePath(input.projectId, input.env ?? process.env);
  if (existsSync(file)) {
    let raw: string;
    try { raw = readFileSync(file, 'utf8'); }
    catch { return { ok: false, reason: 'assignment_store_untrusted', cause: 'json_invalid' }; }
    const inspected = inspectWorkerAssignmentStore(raw);
    if (!inspected.ok) return { ok: false, reason: 'assignment_store_untrusted', cause: inspected.cause };
  }
  const current = currentWorkerAssignment(file, input.issueNumber);
  if (input.expectation.kind === 'none') {
    if (current) return { ok: false, reason: 'assignment_stale' };
  } else {
    if (!current
      || current.assignmentId !== input.expectation.assignmentId
      || current.generation !== input.expectation.generation
      || current.repository !== repository
      || current.taskId !== taskId) {
      return { ok: false, reason: 'assignment_stale' };
    }
    if (current.kind === 'local') {
      let adapter = input.adapter;
      if (!adapter) {
        try {
          const env = input.env ?? process.env;
          adapter = await selectRuntimeAdapter(
            { env },
            { cwd: input.cwd ?? process.cwd(), transport: { env } },
          );
        } catch {
          return { ok: false, reason: 'runtime_unavailable' };
        }
      }
      const admission = await admitCurrentWorkerAssignmentReplacement({
        file,
        expected: current,
        adapter,
      });
      if (admission.status !== 'replaceable') {
        return { ok: false, reason: admission.status };
      }
    }
  }

  const published = await publishCurrentWorkerAssignment({
    file,
    projectId: input.projectId,
    repository,
    issueNumber: input.issueNumber,
    taskId,
    kind: 'remote',
    provider,
    bindingKey,
    expectedCurrent: exactExpectation(input.expectation),
    role,
  });
  if (!published.ok) {
    return {
      ok: false,
      reason: published.reason,
      ...(published.cause ? { cause: published.cause } : {}),
    };
  }
  return { ok: true, reason: 'remote_assignment_published', assignment: published.assignment };
}

interface ParsedCli {
  readonly repository: string;
  readonly issueNumber: number;
  readonly taskId: string;
  readonly provider: string;
  readonly bindingKey: string;
  readonly projectId?: string;
  readonly expectation: RemoteWorkerAssignmentExpectation;
  readonly operatorAttested: boolean;
  readonly role: string;
}

function value(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] ?? '').trim() : '';
}

export function parseRemoteWorkerAssignmentArgs(argv: readonly string[]): ParsedCli {
  const args = [...argv];
  const expectNone = args.includes('--expect-none');
  const expectedAssignmentId = value(args, '--expected-assignment-id');
  const expectedGenerationRaw = value(args, '--expected-generation');
  const hasExact = Boolean(expectedAssignmentId || expectedGenerationRaw);
  if (expectNone === hasExact) {
    throw new Error('exactly one of --expect-none or --expected-assignment-id/--expected-generation is required');
  }
  if (hasExact && (!expectedAssignmentId || !expectedGenerationRaw)) {
    throw new Error('--expected-assignment-id and --expected-generation must be provided together');
  }
  const knownValueFlags = new Set([
    '--repository', '--issue-number', '--task-id', '--provider', '--binding-key', '--project-id',
    '--expected-assignment-id', '--expected-generation', '--role',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (knownValueFlags.has(arg)) {
      index += 1;
      continue;
    }
    if (arg === '--expect-none' || arg === '--operator-attested') continue;
    throw new Error(`unknown argument: ${arg}`);
  }
  const roleFlags = args.filter((arg) => arg === '--role').length;
  if (roleFlags !== 1) {
    throw new Error('exactly one --role worker|orchestrator is required');
  }
  const projectId = value(args, '--project-id');
  return {
    repository: value(args, '--repository'),
    issueNumber: Number(value(args, '--issue-number')),
    taskId: value(args, '--task-id'),
    provider: value(args, '--provider'),
    bindingKey: value(args, '--binding-key'),
    role: value(args, '--role'),
    ...(projectId ? { projectId } : {}),
    expectation: expectNone
      ? { kind: 'none' }
      : {
          kind: 'exact',
          assignmentId: expectedAssignmentId,
          generation: Number(expectedGenerationRaw),
        },
    operatorAttested: args.includes('--operator-attested'),
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let parsed: ParsedCli;
  try {
    parsed = parseRemoteWorkerAssignmentArgs(argv);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      reason: error instanceof Error ? error.message : 'remote_assignment_command_error',
    })}\n`);
    return 2;
  }
  const result = await publishOperatorRemoteWorkerAssignment({ ...parsed });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

const direct = import.meta.url === new URL(process.argv[1] ?? '', 'file:').href;
if (direct) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      reason: error instanceof Error ? error.message : 'remote_assignment_internal_error',
    })}\n`);
    process.exitCode = 2;
  });
}
