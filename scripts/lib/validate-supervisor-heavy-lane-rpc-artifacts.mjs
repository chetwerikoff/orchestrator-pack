#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanWorkerRpcSignatures } from './vitest-ci-lanes.mjs';
import { cliFail, loadJsonFile } from './cli-guard-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

function currentHeadSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const RPC_ARTIFACT_SCOPE_RE =
  /^scripts\/(orchestrator-wake-supervisor|supervisor-fault-boundary|supervisor-recovery\.test-helpers)/;

function supervisorPathsChangedSince(repoRootOverride, fromSha, toSha) {
  const changed = execFileSync('git', ['diff', '--name-only', fromSha, toSha], {
    cwd: repoRootOverride,
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return changed.filter((path) => RPC_ARTIFACT_SCOPE_RE.test(path));
}

export function assertRpcMetadataCommitSha(commitSha, head, passId, repoRootOverride = repoRoot) {
  if (!commitSha || commitSha.startsWith('@') || !FULL_SHA_RE.test(commitSha)) {
    cliFail(`${passId}: metadata commitSha must be a full 40-char git commit SHA, got ${commitSha}`);
  }
  if (commitSha === head) {
    return;
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commitSha, head], {
      cwd: repoRootOverride,
      stdio: 'ignore',
    });
  } catch {
    cliFail(`${passId}: metadata commitSha ${commitSha} is not an ancestor of HEAD ${head}`);
  }
  const stalePaths = supervisorPathsChangedSince(repoRootOverride, commitSha, head);
  if (stalePaths.length > 0) {
    cliFail(
      `${passId}: RPC artifacts bound to ${commitSha} but supervisor/wake paths changed since capture (${stalePaths.join(', ')}); refresh heavy-lane RPC artifacts at HEAD`,
    );
  }
}

export function validateSupervisorHeavyLaneRpcArtifacts(repoRootOverride = repoRoot) {
  const manifestPath = join(
    repoRootOverride,
    'scripts/fixtures/supervisor-test-waits-heavy-lane-rpc/manifest.json',
  );
  if (!existsSync(manifestPath)) {
    cliFail(`missing RPC artifact manifest: ${manifestPath}`);
  }
  const manifest = loadJsonFile(manifestPath);
  const head = currentHeadSha();
  const passes = manifest.passes ?? [];
  if (passes.length < (manifest.requiredConsecutivePasses ?? 3)) {
    cliFail(`RPC manifest requires >=${manifest.requiredConsecutivePasses ?? 3} passes, found ${passes.length}`);
  }

  let lastTimestamp = 0;
  for (const pass of passes) {
    const logPath = join(repoRootOverride, pass.logFile);
    const metaPath = join(repoRootOverride, pass.metadataFile);
    if (!existsSync(logPath) || !existsSync(metaPath)) {
      cliFail(`missing RPC artifact pair for ${pass.id}`);
    }
    const meta = loadJsonFile(metaPath);
    if (!meta.commitSha) cliFail(`${pass.id}: metadata missing commitSha`);
    if (!meta.heavyLaneFingerprint) cliFail(`${pass.id}: metadata missing heavyLaneFingerprint`);
    if (!meta.runTimestampUtc) cliFail(`${pass.id}: metadata missing runTimestampUtc`);
    assertRpcMetadataCommitSha(meta.commitSha, head, pass.id, repoRootOverride);
    if (meta.heavyLaneFingerprint !== manifest.heavyLaneFingerprint) {
      cliFail(`${pass.id}: heavyLaneFingerprint mismatch`);
    }
    const ts = Date.parse(meta.runTimestampUtc);
    if (Number.isNaN(ts)) cliFail(`${pass.id}: invalid runTimestampUtc`);
    if (ts <= lastTimestamp) cliFail(`${pass.id}: passes must be strictly consecutive timestamps`);
    lastTimestamp = ts;

    const logText = readFileSync(logPath, 'utf8');
    const hits = scanWorkerRpcSignatures(logText);
    if (hits.length > 0) {
      cliFail(`${pass.id}: RPC timeout signature detected: ${hits.join('; ')}`);
    }
  }
  return { passCount: passes.length, head };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  validateSupervisorHeavyLaneRpcArtifacts();
  console.log('[PASS] supervisor heavy-lane RPC repeat-run artifacts');
}
