#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanWorkerRpcSignatures } from './vitest-ci-lanes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exit(1);
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function currentHeadSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

export function validateSupervisorHeavyLaneRpcArtifacts(repoRootOverride = repoRoot) {
  const manifestPath = join(
    repoRootOverride,
    'scripts/fixtures/supervisor-test-waits-heavy-lane-rpc/manifest.json',
  );
  if (!existsSync(manifestPath)) {
    fail(`missing RPC artifact manifest: ${manifestPath}`);
  }
  const manifest = loadJson(manifestPath);
  const head = currentHeadSha();
  const passes = manifest.passes ?? [];
  if (passes.length < (manifest.requiredConsecutivePasses ?? 3)) {
    fail(`RPC manifest requires >=${manifest.requiredConsecutivePasses ?? 3} passes, found ${passes.length}`);
  }

  let lastTimestamp = 0;
  for (const pass of passes) {
    const logPath = join(repoRootOverride, pass.logFile);
    const metaPath = join(repoRootOverride, pass.metadataFile);
    if (!existsSync(logPath) || !existsSync(metaPath)) {
      fail(`missing RPC artifact pair for ${pass.id}`);
    }
    const meta = loadJson(metaPath);
    if (!meta.commitSha) fail(`${pass.id}: metadata missing commitSha`);
    if (!meta.heavyLaneFingerprint) fail(`${pass.id}: metadata missing heavyLaneFingerprint`);
    if (!meta.runTimestampUtc) fail(`${pass.id}: metadata missing runTimestampUtc`);
    if (meta.commitSha !== head) {
      fail(`${pass.id}: metadata commitSha ${meta.commitSha} does not match HEAD ${head}`);
    }
    if (meta.heavyLaneFingerprint !== manifest.heavyLaneFingerprint) {
      fail(`${pass.id}: heavyLaneFingerprint mismatch`);
    }
    const ts = Date.parse(meta.runTimestampUtc);
    if (Number.isNaN(ts)) fail(`${pass.id}: invalid runTimestampUtc`);
    if (ts <= lastTimestamp) fail(`${pass.id}: passes must be strictly consecutive timestamps`);
    lastTimestamp = ts;

    const logText = readFileSync(logPath, 'utf8');
    const hits = scanWorkerRpcSignatures(logText);
    if (hits.length > 0) {
      fail(`${pass.id}: RPC timeout signature detected: ${hits.join('; ')}`);
    }
  }
  return { passCount: passes.length, head };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  validateSupervisorHeavyLaneRpcArtifacts();
  console.log('[PASS] supervisor heavy-lane RPC repeat-run artifacts');
}
