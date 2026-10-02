#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChangedPathManifest } from './lib/vitest-pr-scoped-selection.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = join(scriptDir, '..');

function parseArgs(argv) {
  const values = {
    repoRoot: process.env.OPK_REPO_ROOT?.replace(/\\/g, '/') || defaultRepoRoot,
    baseSha: '',
    headSha: '',
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--base' && argv[index + 1]) {
      values.baseSha = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--head' && argv[index + 1]) {
      values.headSha = argv[index + 1];
      index += 1;
      continue;
    }
  }
  return values;
}

const { repoRoot, baseSha, headSha } = parseArgs(process.argv);
const manifest = buildChangedPathManifest(repoRoot, baseSha, headSha);
process.stdout.write(`${JSON.stringify(manifest)}\n`);
