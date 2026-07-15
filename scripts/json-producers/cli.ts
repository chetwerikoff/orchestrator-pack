import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly values: Readonly<Record<string, string>>;
  readonly flags: ReadonlySet<string>;
}

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]!;
    if (!current.startsWith('--')) {
      positionals.push(current);
      continue;
    }
    const equals = current.indexOf('=');
    if (equals >= 0) {
      values[current.slice(2, equals)] = current.slice(equals + 1);
      continue;
    }
    const name = current.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values[name] = next;
      index += 1;
    } else {
      flags.add(name);
    }
  }
  return { positionals, values, flags };
}

export function argumentValue(args: ParsedArguments, name: string, fallback = ''): string {
  return args.values[name] ?? fallback;
}

export function integerArgument(
  args: ParsedArguments,
  name: string,
  fallback: number,
): number {
  const raw = args.values[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new Error(`--${name} must be an integer`);
  return parsed;
}

export function isDirectExecution(moduleUrl: string, argv1: string | undefined): boolean {
  return argv1 !== undefined && resolve(argv1) === resolve(fileURLToPath(moduleUrl));
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
