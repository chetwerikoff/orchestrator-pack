#!/usr/bin/env node
import { resolve } from 'node:path';
import { assertNodeRuntimeContract, NODE_VERSION_SOURCE } from './node-runtime-contract.mjs';

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const repoRoot = resolve(argument(process.argv.slice(2), '--repo-root') ?? process.cwd());
const quiet = process.argv.includes('--quiet');

try {
  const result = assertNodeRuntimeContract(repoRoot);
  if (!quiet) {
    process.stdout.write(
      `Node.js ${result.actualVersion} satisfies ${NODE_VERSION_SOURCE} (${result.engineMajor}.x).\n`,
    );
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
