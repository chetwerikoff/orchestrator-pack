#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliFail, loadJsonFile } from './cli-guard-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const fixtureDir = join(repoRoot, 'scripts/fixtures/supervisor-test-waits-heavy-lane-rpc');

function currentHeadSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

export function bindSupervisorHeavyLaneRpcMetadata(headSha = currentHeadSha(), repoRootOverride = repoRoot) {
  const manifestPath = join(repoRootOverride, 'scripts/fixtures/supervisor-test-waits-heavy-lane-rpc/manifest.json');
  const manifest = loadJsonFile(manifestPath);
  manifest.captureCommitSha = headSha;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  for (const pass of manifest.passes ?? []) {
    const metaPath = join(repoRootOverride, pass.metadataFile);
    const meta = loadJsonFile(metaPath);
    meta.commitSha = headSha;
    if (!meta.heavyLaneFingerprint) {
      meta.heavyLaneFingerprint = manifest.heavyLaneFingerprint;
    }
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  }
  return { headSha, passCount: manifest.passes?.length ?? 0 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const head = process.argv[2] ?? currentHeadSha();
  if (!/^[0-9a-f]{40}$/.test(head)) {
    cliFail(`invalid HEAD SHA: ${head}`);
  }
  const result = bindSupervisorHeavyLaneRpcMetadata(head);
  console.log(`[PASS] bound supervisor heavy-lane RPC metadata to ${result.headSha}`);
}
