import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DraftTextGuardBaseOptions {
  textPath: string | null;
  text: string | null;
  draftPath: string | null;
  repoRoot: string;
}

export function createDraftTextGuardBaseOptions(): DraftTextGuardBaseOptions {
  return {
    textPath: null,
    text: null,
    draftPath: null,
    repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
  };
}

export type DraftTextGuardArgHandler = (
  arg: string,
  argv: string[],
  index: number,
  opts: DraftTextGuardBaseOptions,
) => number | 'handled' | 'unknown';

export function parseDraftTextGuardArgv(
  argv: string[],
  opts: DraftTextGuardBaseOptions,
  handleExtra?: DraftTextGuardArgHandler,
): void {
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--text-file':
        opts.textPath = String(argv[++i] ?? '');
        break;
      case '--draft-path':
        opts.draftPath = String(argv[++i] ?? '');
        break;
      case '--text':
        opts.text = String(argv[++i] ?? '');
        break;
      case '--repo-root':
        opts.repoRoot = resolve(String(argv[++i] ?? opts.repoRoot));
        break;
      default:
        if (handleExtra) {
          const next = handleExtra(arg, argv, i, opts);
          if (next === 'handled') {
            continue;
          }
          if (typeof next === 'number') {
            i = next;
            continue;
          }
        }
        throw new Error(`unknown argument: ${arg}`);
    }
  }
}

export interface DraftTextGuardEvaluation {
  ok: boolean;
  errors?: string[];
  passMessage: string;
}

export interface DraftTextGuardRunner {
  guardLabel: string;
  missingInputMessage: string;
  evaluate(text: string, opts: DraftTextGuardBaseOptions): DraftTextGuardEvaluation;
}

export function runDraftTextGuardCli(
  argv: string[],
  runner: DraftTextGuardRunner,
  parseExtra?: DraftTextGuardArgHandler,
): number {
  const opts = createDraftTextGuardBaseOptions();
  try {
    parseDraftTextGuardArgv(argv, opts, parseExtra);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${runner.guardLabel}: ${message}\n`);
    return 2;
  }

  if (!opts.textPath && opts.text == null) {
    process.stderr.write(`${runner.guardLabel}: ${runner.missingInputMessage}\n`);
    return 2;
  }

  const text = opts.textPath ? readFileSync(opts.textPath, 'utf8') : String(opts.text);

  try {
    const result = runner.evaluate(text, opts);
    if (!result.ok) {
      for (const error of result.errors ?? []) {
        process.stderr.write(`${runner.guardLabel}: ${error}\n`);
      }
      return 1;
    }
    process.stdout.write(`${result.passMessage}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${runner.guardLabel}: ${message}\n`);
    return 1;
  }
}
