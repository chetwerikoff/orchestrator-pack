#!/usr/bin/env -S node --experimental-strip-types
import '../toolchain/native-entrypoint-preflight.ts';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { graphifyGraphOutDir, runGraphify } from './lib/graphify-env.ts';

function value(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const rawOut = value(process.argv.slice(2), '--out-dir') ?? graphifyGraphOutDir();
const graphFile = join(resolve(rawOut), 'graphify-out', 'graph.json');
if (!existsSync(graphFile)) throw new Error(`No existing graph at '${graphFile}'. Run scripts/graphify/build-graph.ts first.`);
const outDir = realpathSync(resolve(rawOut));
process.stdout.write(`[graphify refresh] updating existing graph in '${outDir}' (no LLM needed)\n`);
runGraphify('update', [outDir]);
process.stdout.write(`[PASS] graph refreshed at ${graphFile}\n`);
