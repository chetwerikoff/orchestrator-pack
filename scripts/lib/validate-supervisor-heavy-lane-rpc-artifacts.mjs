#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanWorkerRpcSignatures, resolveHeavyLaneFingerprint } from './vitest-ci-lanes.mjs';
import { cliFail, loadJsonFile } from './cli-guard-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const CONTENT_BINDING_MODE = 'scoped-tree-content-v1';
const RPC_ARTIFACT_BINDING_SCOPE_RE =
  /^scripts\/(orchestrator-wake-supervisor|supervisor-fault-boundary|supervisor-recovery\.test-helpers|lib\/supervisor-test-wait-inventory|lib\/validate-supervisor-heavy-lane-rpc-artifacts|lib\/bind-supervisor-heavy-lane-rpc-metadata|lib\/vitest-ci-lanes|check-supervisor-test-wait-inventory|vitest-runtime-history\.json)/;

function commitObjectExists(commitSha, repoRootOverride) {
  if (!commitSha || !FULL_SHA_RE.test(commitSha)) {
    return false;
  }
  try {
    execFileSync('git', ['cat-file', '-e', `${commitSha}^{commit}`], {
      cwd: repoRootOverride,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function listBindingScopePaths(repoRootOverride) {
  return execFileSync('git', ['ls-files'], {
    cwd: repoRootOverride,
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter((path) => path && RPC_ARTIFACT_BINDING_SCOPE_RE.test(path));
}

function bindingScopeMatchesCaptureWorktree(repoRootOverride, captureSha) {
  if (!commitObjectExists(captureSha, repoRootOverride)) {
    return null;
  }
  for (const path of listBindingScopePaths(repoRootOverride)) {
    let atCapture;
    try {
      atCapture = execFileSync('git', ['show', `${captureSha}:${path}`], {
        cwd: repoRootOverride,
      });
    } catch {
      return false;
    }
    const worktreePath = join(repoRootOverride, path);
    if (!existsSync(worktreePath)) return false;
    const worktree = readFileSync(worktreePath);
    if (!atCapture.equals(worktree)) {
      return false;
    }
  }
  return true;
}

function resolveCurrentHeadSha(repoRootOverride = repoRoot) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRootOverride,
    encoding: 'utf8',
  }).trim();
}

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
    try {
      const subject = execFileSync('git', ['log', '-1', '--pretty=%s', 'HEAD'], {
        cwd: repoRootOverride,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const match = subject.match(/^Merge ([0-9a-f]{40}) into [0-9a-f]{40}$/);
      if (match && FULL_SHA_RE.test(match[1])) {
        return match[1];
      }
    } catch {
      // diagnostic provenance only
    }
  }

  return resolveCurrentHeadSha(repoRootOverride);
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

function resolveMetadataParentForDiagnostics(head, repoRootOverride) {
  try {
    return execFileSync('git', ['rev-parse', `${head}^`], {
      cwd: repoRootOverride,
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

export function inspectSupervisorHeavyLaneRpcBinding(repoRootOverride = repoRoot) {
  const manifestPath = join(
    repoRootOverride,
    'scripts/fixtures/supervisor-test-waits-heavy-lane-rpc/manifest.json',
  );
  if (!existsSync(manifestPath)) {
    return { ok: false, reason: `missing RPC artifact manifest: ${manifestPath}`, stalePaths: [] };
  }
  const manifest = loadJsonFile(manifestPath);
  const capture = manifest.captureCommitSha;
  if (!capture || !FULL_SHA_RE.test(capture)) {
    return { ok: false, reason: 'RPC manifest missing captureCommitSha', stalePaths: [] };
  }
  if (manifest.bindingMode !== CONTENT_BINDING_MODE) {
    return {
      ok: false,
      reason: `RPC manifest bindingMode must be ${CONTENT_BINDING_MODE}; commit identity alone is not merge-stable`,
      stalePaths: [],
    };
  }
  if (!commitObjectExists(capture, repoRootOverride)) {
    return {
      ok: false,
      reason: `capture commit ${capture} is unavailable; fetch full history before validating RPC artifacts`,
      stalePaths: [],
    };
  }

  const head = resolveCurrentHeadSha(repoRootOverride);
  const stalePaths = bindingScopePathsChangedSince(repoRootOverride, capture, head);
  const worktreeMatch = bindingScopeMatchesCaptureWorktree(repoRootOverride, capture);
  const diagnosticPrHead = resolvePrHeadSha(repoRootOverride);
  const diagnosticParent = resolveMetadataParentForDiagnostics(head, repoRootOverride);
  const diagnosticHeadPaths = pathsChangedInCommit(head, repoRootOverride);

  if (stalePaths.length > 0 || worktreeMatch !== true) {
    return {
      ok: false,
      reason: `binding-scope content drifted since capture ${capture}: ${stalePaths.join(', ') || 'worktree mismatch'}`,
      stalePaths,
      captureCommitSha: capture,
      diagnosticPrHead,
      diagnosticParent,
      diagnosticHeadPaths,
    };
  }
  return {
    ok: true,
    reason: 'binding-scope tree content matches capture',
    stalePaths: [],
    captureCommitSha: capture,
    bindingMode: manifest.bindingMode,
    diagnosticPrHead,
    diagnosticParent,
    diagnosticHeadPaths,
  };
}

export function resolveExpectedCaptureSha(repoRootOverride = repoRoot) {
  const result = inspectSupervisorHeavyLaneRpcBinding(repoRootOverride);
  if (!result.ok) cliFail(result.reason);
  return result.captureCommitSha;
}

export function assertRpcMetadataCommitSha(commitSha, expectedCaptureSha, passId) {
  if (!commitSha || commitSha.startsWith('@') || !FULL_SHA_RE.test(commitSha)) {
    cliFail(`${passId}: metadata commitSha must be a full 40-char git commit SHA, got ${commitSha}`);
  }
  if (commitSha !== expectedCaptureSha) {
    cliFail(
      `${passId}: metadata commitSha ${commitSha} must identify the scoped-tree capture ${expectedCaptureSha}; refresh heavy-lane RPC artifacts`,
    );
  }
}

export function validateSupervisorHeavyLaneRpcArtifacts(repoRootOverride = repoRoot) {
  const manifestPath = join(
    repoRootOverride,
    'scripts/fixtures/supervisor-test-waits-heavy-lane-rpc/manifest.json',
  );
  const manifest = loadJsonFile(manifestPath);
  const binding = inspectSupervisorHeavyLaneRpcBinding(repoRootOverride);
  if (!binding.ok) cliFail(binding.reason);
  const expectedCaptureSha = binding.captureCommitSha;
  const expectedHeavyLaneFingerprint = resolveHeavyLaneFingerprint(repoRootOverride);
  const passes = manifest.passes ?? [];

  if (passes.length < (manifest.requiredConsecutivePasses ?? 3)) {
    cliFail(`RPC manifest requires >=${manifest.requiredConsecutivePasses ?? 3} passes, found ${passes.length}`);
  }
  assertRpcMetadataCommitSha(manifest.captureCommitSha, expectedCaptureSha, 'manifest');
  if (!manifest.heavyLaneFingerprint) cliFail('RPC manifest missing heavyLaneFingerprint');
  if (manifest.heavyLaneFingerprint !== expectedHeavyLaneFingerprint) {
    cliFail(
      `manifest heavyLaneFingerprint (${manifest.heavyLaneFingerprint}) must match current heavy-lane config (${expectedHeavyLaneFingerprint})`,
    );
  }

  let lastTimestamp = 0;
  for (const pass of passes) {
    const logPath = join(repoRootOverride, pass.logFile);
    const metaPath = join(repoRootOverride, pass.metadataFile);
    if (!existsSync(logPath) || !existsSync(metaPath)) cliFail(`missing RPC artifact pair for ${pass.id}`);

    const meta = loadJsonFile(metaPath);
    if (!meta.commitSha) cliFail(`${pass.id}: metadata missing commitSha`);
    if (!meta.heavyLaneFingerprint) cliFail(`${pass.id}: metadata missing heavyLaneFingerprint`);
    if (!meta.runTimestampUtc) cliFail(`${pass.id}: metadata missing runTimestampUtc`);
    assertRpcMetadataCommitSha(meta.commitSha, expectedCaptureSha, pass.id);
    if (meta.commitSha !== manifest.captureCommitSha) {
      cliFail(`${pass.id}: metadata commitSha must match manifest captureCommitSha`);
    }
    if (meta.heavyLaneFingerprint !== expectedHeavyLaneFingerprint) {
      cliFail(
        `${pass.id}: heavyLaneFingerprint (${meta.heavyLaneFingerprint}) must match current heavy-lane config (${expectedHeavyLaneFingerprint})`,
      );
    }

    const timestamp = Date.parse(meta.runTimestampUtc);
    if (Number.isNaN(timestamp)) cliFail(`${pass.id}: invalid runTimestampUtc`);
    if (timestamp <= lastTimestamp) cliFail(`${pass.id}: passes must be strictly consecutive timestamps`);
    lastTimestamp = timestamp;

    const hits = scanWorkerRpcSignatures(readFileSync(logPath, 'utf8'));
    if (hits.length > 0) cliFail(`${pass.id}: RPC timeout signature detected: ${hits.join('; ')}`);
  }

  return { passCount: passes.length, expectedCaptureSha, bindingMode: manifest.bindingMode };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  validateSupervisorHeavyLaneRpcArtifacts();
  console.log('[PASS] supervisor heavy-lane RPC repeat-run artifacts');
}
