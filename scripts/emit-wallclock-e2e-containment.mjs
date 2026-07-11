#!/usr/bin/env node
/**
 * Emit machine-readable wall-clock e2e containment status for a main head (Issue #694).
 *
 * Usage:
 *   node scripts/emit-wallclock-e2e-containment.mjs --head <sha> --stage-result success|failure|pending
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadSplitManifest } from './lib/vitest-wallclock-e2e-split.mjs';
import { resolveRepoRoot } from './lib/vitest-ci-lanes.mjs';

function parseArgs(argv) {
  let head = process.env.GITHUB_SHA ?? '';
  let stageResult = 'pending';
  let writeOnly = false;
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--head' && argv[i + 1]) {
      head = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--stage-result' && argv[i + 1]) {
      stageResult = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--write-only') {
      writeOnly = true;
    }
  }
  return { head, stageResult, writeOnly };
}

const { head, stageResult, writeOnly } = parseArgs(process.argv);
const manifest = loadSplitManifest();
const contained = stageResult === 'success';
const status = {
  schema: 'wallclock-e2e-containment.v1',
  checkName: manifest.containmentCheckName,
  headSha: head,
  stageResult,
  contained,
  blocksPromotion: !contained,
  issue: manifest.issue,
};

const outPath = join(resolveRepoRoot(), 'scratch/wallclock-e2e-containment.json');
mkdirSync(join(resolveRepoRoot(), 'scratch'), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(status, null, 2)}\n`);
console.log(JSON.stringify(status));

if (!contained && !writeOnly) {
  console.error(`[FAIL] wall-clock containment blocks promotion for head=${head} stageResult=${stageResult}`);
  process.exit(1);
}
