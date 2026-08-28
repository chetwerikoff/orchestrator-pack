#!/usr/bin/env -S node --experimental-strip-types
import '../toolchain/native-entrypoint-preflight.ts';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { graphifyGraphOutDir, graphifyRepoRoot, runGraphify } from './lib/graphify-env.ts';

function value(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const rawPath = value(process.argv.slice(2), '--path') ?? graphifyRepoRoot();
const rawOut = value(process.argv.slice(2), '--out-dir') ?? graphifyGraphOutDir();
const targetPath = realpathSync(resolve(rawPath));
mkdirSync(rawOut, { recursive: true });
const outDir = realpathSync(resolve(rawOut));
process.stdout.write(`[graphify build] extracting (code-only, no LLM) from '${targetPath}' -> '${outDir}'\n`);
runGraphify('extract', [targetPath, '--code-only', '--out', outDir]);
const graphFile = join(outDir, 'graphify-out', 'graph.json');
if (!existsSync(graphFile)) throw new Error(`graphify extract reported success but no graph was written at '${graphFile}'.`);
process.stdout.write(`[PASS] graph built at ${graphFile}\n`);
