import '../toolchain/native-entrypoint-preflight.ts';

import path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';

type ClosureExecutionClass = 'reachable-helper' | 'explicitly-unsupported';

const repoRoot = path.resolve(process.cwd());
const explicitlyUnsupportedPrefixes = [
  'docs/archive/',
  'docs/declarations/',
  'docs/issues_drafts/',
  'tests/external-output-references/',
  'vendor/',
] as const;

function git(args: string[]): string {
  const result = runProcessSync({
    command: 'git',
    args,
    cwd: repoRoot,
    inheritParentEnv: true,
  });
  if (!result.ok) throw new Error(result.stderr || result.error || `git_${args.join('_')}_failed`);
  return result.stdout.trim();
}

function executionClass(file: string): ClosureExecutionClass {
  return explicitlyUnsupportedPrefixes.some((prefix) => file.startsWith(prefix))
    ? 'explicitly-unsupported'
    : 'reachable-helper';
}

export function buildCurrentClosure(ref: string): {
  schemaVersion: 1;
  lineage: { planningCommit: string; planningBaseTreeOid: string };
  denominator: Array<{ path: string; executionClass: ClosureExecutionClass }>;
  unknown: [];
  dynamicUnsupported: [];
} {
  const planningCommit = git(['rev-parse', `${ref}^{commit}`]);
  const planningBaseTreeOid = git(['rev-parse', `${ref}^{tree}`]);
  const files = git(['ls-tree', '-r', '--name-only', ref])
    .split(/\r?\n/u)
    .filter(Boolean);

  return {
    schemaVersion: 1,
    lineage: { planningCommit, planningBaseTreeOid },
    denominator: files.map((file) => ({ path: file, executionClass: executionClass(file) })),
    unknown: [],
    dynamicUnsupported: [],
  };
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    process.stdout.write(`${JSON.stringify(buildCurrentClosure(arg('--ref') ?? 'HEAD'))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
