#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
import {
  bindOperatorPrimary,
  readOperatorPrimaryBinding,
  resolveWorkerAssignmentStorePath,
  retireOperatorPrimary,
  type OperatorPrimaryBindingV1,
} from './lib/worker-assignment-store.ts';

type Command = 'show' | 'bind' | 'replace' | 'retire';

interface ParsedCli {
  readonly command: Command;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly bindingKey?: string;
  readonly expectedCurrent?: OperatorPrimaryBindingV1;
  readonly operatorAttested: boolean;
}

function value(args: readonly string[], name: string): string {
  const indexes = args.flatMap((arg, index) => arg === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`duplicate argument: ${name}`);
  return indexes.length === 1 ? String(args[indexes[0]! + 1] ?? '').trim() : '';
}

function positiveInteger(raw: string, name: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function expectedBinding(args: readonly string[]): OperatorPrimaryBindingV1 {
  const taskId = value(args, '--expected-task-id');
  const bindingKey = value(args, '--expected-binding-key');
  const assignmentId = value(args, '--expected-assignment-id');
  const generationRaw = value(args, '--expected-assignment-generation');
  if (!taskId || !bindingKey || !assignmentId || !generationRaw) {
    throw new Error('replace/retire require the complete expected operator-primary binding');
  }
  return {
    route: 'operator-primary',
    taskId,
    bindingKey,
    assignmentId,
    assignmentGeneration: positiveInteger(generationRaw, '--expected-assignment-generation'),
  };
}

export function parseOperatorPrimaryBindingArgs(argv: readonly string[]): ParsedCli {
  const args = [...argv];
  const command = String(args.shift() ?? '') as Command;
  if (!(['show', 'bind', 'replace', 'retire'] as const).includes(command)) {
    throw new Error('command must be show, bind, replace, or retire');
  }

  const knownValueFlags = new Set([
    '--project-id',
    '--task-id',
    '--binding-key',
    '--expected-task-id',
    '--expected-binding-key',
    '--expected-assignment-id',
    '--expected-assignment-generation',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (knownValueFlags.has(arg)) {
      if (index + 1 >= args.length || String(args[index + 1]).startsWith('--')) {
        throw new Error(`missing value for ${arg}`);
      }
      index += 1;
      continue;
    }
    if (arg === '--operator-attested') continue;
    throw new Error(`unknown argument: ${arg}`);
  }

  const projectId = value(args, '--project-id');
  const operatorAttested = args.includes('--operator-attested');
  if (command === 'show') {
    if (operatorAttested) throw new Error('show does not accept --operator-attested');
    if (value(args, '--task-id') || value(args, '--binding-key')
      || value(args, '--expected-task-id') || value(args, '--expected-binding-key')
      || value(args, '--expected-assignment-id') || value(args, '--expected-assignment-generation')) {
      throw new Error('show accepts only --project-id');
    }
    return { command, ...(projectId ? { projectId } : {}), operatorAttested: false };
  }

  if (!operatorAttested) throw new Error('mutations require --operator-attested');
  if (command === 'bind') {
    const taskId = value(args, '--task-id');
    const bindingKey = value(args, '--binding-key');
    if (!taskId || !bindingKey) throw new Error('bind requires --task-id and --binding-key');
    if (value(args, '--expected-task-id') || value(args, '--expected-binding-key')
      || value(args, '--expected-assignment-id') || value(args, '--expected-assignment-generation')) {
      throw new Error('bind does not accept expected-binding arguments');
    }
    return {
      command,
      ...(projectId ? { projectId } : {}),
      taskId,
      bindingKey,
      operatorAttested: true,
    };
  }

  const expectedCurrent = expectedBinding(args);
  if (command === 'retire') {
    if (value(args, '--task-id') || value(args, '--binding-key')) {
      throw new Error('retire does not accept replacement target arguments');
    }
    return {
      command,
      ...(projectId ? { projectId } : {}),
      expectedCurrent,
      operatorAttested: true,
    };
  }

  const taskId = value(args, '--task-id');
  const bindingKey = value(args, '--binding-key');
  if (!taskId || !bindingKey) throw new Error('replace requires --task-id and --binding-key');
  return {
    command,
    ...(projectId ? { projectId } : {}),
    taskId,
    bindingKey,
    expectedCurrent,
    operatorAttested: true,
  };
}

export async function runOperatorPrimaryBindingCommand(
  parsed: ParsedCli,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
  const file = resolveWorkerAssignmentStorePath(parsed.projectId, env);
  if (parsed.command === 'show') {
    const current = readOperatorPrimaryBinding(file);
    if (!current.ok) {
      return { ok: false, reason: 'assignment_untrusted', cause: current.cause };
    }
    if (current.status === 'binding_absent') {
      return { ok: true, status: 'binding_absent', binding: null };
    }
    return { ok: true, status: current.status, binding: current.binding };
  }

  if (!parsed.operatorAttested) return { ok: false, reason: 'operator_attestation_required' };
  if (parsed.command === 'retire') {
    return retireOperatorPrimary({ file, expectedCurrent: parsed.expectedCurrent! });
  }
  return bindOperatorPrimary({
    file,
    taskId: parsed.taskId!,
    bindingKey: parsed.bindingKey!,
    ...(parsed.expectedCurrent ? { expectedCurrent: parsed.expectedCurrent } : {}),
  });
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let parsed: ParsedCli;
  try {
    parsed = parseOperatorPrimaryBindingArgs(argv);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      reason: error instanceof Error ? error.message : 'operator_primary_command_error',
    })}\n`);
    return 2;
  }
  const result = await runOperatorPrimaryBindingCommand(parsed, env);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok === true ? 0 : 1;
}

const direct = import.meta.url === new URL(process.argv[1] ?? '', 'file:').href;
if (direct) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      reason: error instanceof Error ? error.message : 'operator_primary_internal_error',
    })}\n`);
    process.exitCode = 2;
  });
}
