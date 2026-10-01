#!/usr/bin/env node
import { resolve } from 'node:path';
import { assertNpmRuntimeContract, NODE_VERSION_FILE } from './node-runtime-contract.mjs';
import { runProcessSync } from '../kernel/subprocess.ts';

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const repoRoot = resolve(argument(process.argv.slice(2), '--repo-root') ?? process.cwd());
const quiet = process.argv.includes('--quiet');

try {
  const npm = runProcessSync({ command: 'npm', args: ['--version'], cwd: repoRoot, inheritParentEnv: true });
  if (!npm.ok) throw new Error(`OPK_NPM_RUNTIME_MISSING: cannot execute npm: ${npm.stderr || npm.error || npm.outcome}`);
  const result = assertNpmRuntimeContract(repoRoot, npm.stdout.trim());
  if (!quiet) {
    process.stdout.write(
      `npm ${result.actualVersion} satisfies ${NODE_VERSION_FILE} (npmMajor ${result.canonicalMajor}) and package.json engines.npm (${result.engineMajor}.x).\n`,
    );
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
