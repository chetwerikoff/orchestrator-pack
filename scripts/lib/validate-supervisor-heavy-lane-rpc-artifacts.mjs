#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanWorkerRpcSignatures } from './vitest-ci-lanes.mjs';
import { cliFail, loadJsonFile } from './cli-guard-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const RPC_FIXTURE_PREFIX = 'scripts/fixtures/supervisor-test-waits-heavy-lane-rpc/';
const RPC_ARTIFACT_BINDING_SCOPE_RE =
  /^scripts\/(orchestrator-wake-supervisor|supervisor-fault-boundary|supervisor-recovery\.test-helpers|lib\/supervisor-test-wait-inventory|lib\/validate-supervisor-heavy-lane-rpc-artifacts|lib\/bind-supervisor-heavy-lane-rpc-metadata|lib\/vitest-ci-lanes|check-supervisor-test-wait-inventory|vitest-runtime-history\.json)/;

function resolvePrHeadSha(repoRootOverride = repoRoot) {
  for (const candidate of [
    process.env.SUPERVISOR_RPC_BIND_HEAD,
    process.env.PR_HEAD_SHA,
    process.env.AO_PR_HEAD_SHA,
  ]) {
    if (candidate && FULL_SHA_RE.test(candidate)) {
      return candidate;
    }
  }

  // pull_request checkout is a merge commit; second parent is the PR head (not GITHUB_SHA).
  try {
    const secondParent = execFileSync('git', ['rev-parse', 'HEAD^2'], {
      cwd: repoRootOverride,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (FULL_SHA_RE.test(secondParent)) {
      return secondParent;
    }
  } catch {
    // not a merge commit
  }

  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRootOverride,
    encoding: 'utf8',
  }).trim();
}

function resolveBindingHead(repoRootOverride = repoRoot) {
  return resolvePrHeadSha(repoRootOverride);
}

function pathsChangedInCommit(commitSha, repoRootOverride) {
  return execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', commitSha], {
    cwd: repoRootOverride,
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function bindingScopePathsChangedSince(repoRootOverride, fromSha, toSha) {
  const changed = execFileSync('git', ['diff', '--name-only', fromSha, toSha], {
    cwd: repoRootOverride,
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return changed.filter((path) => RPC_ARTIFACT_BINDING_SCOPE_RE.test(path));
}

export function resolveExpectedCaptureSha(repoRootOverride = repoRoot) {
  const head = resolveBindingHead(repoRootOverride);
  const changed = pathsChangedInCommit(head, repoRootOverride);
  const changedFixtures = changed.filter((path) => path.startsWith(RPC_FIXTURE_PREFIX));
  const changedNonFixtures = changed.filter((path) => !path.startsWith(RPC_FIXTURE_PREFIX));

  if (changedNonFixtures.length > 0 && changedFixtures.length > 0) {
    cliFail(
      'RPC metadata binding must be committed separately: only scripts/fixtures/supervisor-test-waits-heavy-lane-rpc/ may change in the metadata bind commit',
    );
  }

  if (changed.length > 0 && changed.every((path) => path.startsWith(RPC_FIXTURE_PREFIX))) {
    try {
      return execFileSync('git', ['rev-parse', `${head}^`], {
        cwd: repoRootOverride,
        encoding: 'utf8',
      }).trim();
    } catch {
      cliFail('metadata-only RPC fixture commit requires a parent commit');
    }
  }

  return head;
}

export function assertRpcMetadataCommitSha(commitSha, expectedCaptureSha, passId, repoRootOverride = repoRoot) {
  if (!commitSha || commitSha.startsWith('@') || !FULL_SHA_RE.test(commitSha)) {
    cliFail(`${passId}: metadata commitSha must be a full 40-char git commit SHA, got ${commitSha}`);
  }
  if (commitSha !== expectedCaptureSha) {
    cliFail(
      `${passId}: metadata commitSha ${commitSha} must match expected capture commit ${expectedCaptureSha}; refresh heavy-lane RPC artifacts (run scripts/bind-supervisor-heavy-lane-rpc-metadata.ps1 at the code commit, then commit fixtures only)`,
    );
  }

  const head = resolveBindingHead(repoRootOverride);
  if (commitSha !== head) {
    const stalePaths = bindingScopePathsChangedSince(repoRootOverride, commitSha, head);
    if (stalePaths.length > 0) {
      cliFail(
        `${passId}: RPC artifacts bound to ${commitSha} but binding-scope paths changed since capture (${stalePaths.join(', ')}); refresh heavy-lane RPC artifacts at HEAD`,
      );
    }
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
  const head = resolveBindingHead(repoRootOverride);
  const expectedCaptureSha = resolveExpectedCaptureSha(repoRootOverride);
  const passes = manifest.passes ?? [];
  if (passes.length < (manifest.requiredConsecutivePasses ?? 3)) {
    cliFail(`RPC manifest requires >=${manifest.requiredConsecutivePasses ?? 3} passes, found ${passes.length}`);
  }

  if (!manifest.captureCommitSha) {
    cliFail('RPC manifest missing captureCommitSha');
  }
  assertRpcMetadataCommitSha(manifest.captureCommitSha, expectedCaptureSha, 'manifest', repoRootOverride);

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
    assertRpcMetadataCommitSha(meta.commitSha, expectedCaptureSha, pass.id, repoRootOverride);
    if (meta.commitSha !== manifest.captureCommitSha) {
      cliFail(`${pass.id}: metadata commitSha must match manifest captureCommitSha`);
    }
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
  return { passCount: passes.length, head, expectedCaptureSha };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  validateSupervisorHeavyLaneRpcArtifacts();
  console.log('[PASS] supervisor heavy-lane RPC repeat-run artifacts');
}
