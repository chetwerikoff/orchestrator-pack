#!/usr/bin/env -S node --experimental-strip-types
import '../toolchain/native-entrypoint-preflight.ts';
import { selectRuntimeAdapter } from './registry.ts';
import type { RuntimeWorkerIdentity } from './contracts.ts';

interface ParsedArgs {
  adapter?: string;
  cwd?: string;
  timeoutMs?: number;
  workspace?: string;
  runtime?: string;
  id?: string;
  generation?: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const result: ParsedArgs = {};
  const keyByFlag: Record<string, keyof ParsedArgs> = {
    '--adapter': 'adapter',
    '--cwd': 'cwd',
    '--timeout-ms': 'timeoutMs',
    '--workspace': 'workspace',
    '--runtime': 'runtime',
    '--id': 'id',
    '--generation': 'generation',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const key = keyByFlag[flag];
    if (!key) throw new Error(`unknown argument: ${flag}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (key === 'timeoutMs') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('--timeout-ms must be a positive integer');
      result.timeoutMs = parsed;
    } else {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

function exactIdentity(input: ParsedArgs): RuntimeWorkerIdentity {
  const runtime = input.runtime?.trim() ?? '';
  const id = input.id?.trim() ?? '';
  const generation = input.generation?.trim() ?? '';
  if (!runtime || !id || !generation) {
    throw new Error('find requires --runtime, --id, and --generation');
  }
  return { runtime, id, generation };
}

async function main(): Promise<void> {
  const [command = 'help', ...argv] = process.argv.slice(2);
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write('runtime-cli <readiness|list|find> [--adapter id] [--cwd path] [--timeout-ms n] [--workspace active|path] [--runtime id --id id --generation generation]\n');
    return;
  }
  const input = parseArgs(argv);
  const adapter = await selectRuntimeAdapter(
    input.adapter ? { adapter: input.adapter } : {},
    { cwd: input.cwd, timeoutMs: input.timeoutMs },
  );
  const options = { cwd: input.cwd, timeoutMs: input.timeoutMs };
  if (command === 'readiness') {
    process.stdout.write(`${JSON.stringify(adapter.readiness(options))}\n`);
    return;
  }
  if (command === 'list') {
    process.stdout.write(`${JSON.stringify(adapter.listWorkers({ workspace: input.workspace ?? 'active' }, options))}\n`);
    return;
  }
  if (command === 'find') {
    process.stdout.write(`${JSON.stringify(adapter.findWorker(exactIdentity(input), options))}\n`);
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${detail}\n`);
  process.exitCode = 1;
});
