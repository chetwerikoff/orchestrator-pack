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
  if (!commitSha || !FULL_SHA_RE.test(commitSha)) return false;
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

function splitNullList(value) {
  return value.toString('utf8').split('\0').map((item) => item.trim()).filter(Boolean);
}

function listBindingScopePaths(repoRootOverride, captureSha) {
  const paths = new Set();
  const current = execFileSync('git', ['ls-files'], {
    cwd: repoRootOverride,
    encoding: 'utf8',
  });
  for (const path of current.split('\n').map((line) => line.trim()).filter(Boolean)) {
    if (RPC_ARTIFACT_BINDING_SCOPE_RE.test(path)) paths.add(path);
  }
  return [...paths].sort();
}

function compareBindingScopeToCapture(repoRootOverride, captureSha) {
  if (!commitObjectExists(captureSha, repoRootOverride)) {
    return {
      ok: false,
      reason: `capture commit ${captureSha} is unavailable; CI must fetch full history before validating RPC artifacts`,
      stalePaths: [],
    };
  }

  const paths = listBindingScopePaths(repoRootOverride, captureSha);
  if (paths.length === 0) {
    return { ok: false, reason: 'RPC binding scope resolved to zero tracked paths', stalePaths: [] };
  }

  const stalePaths = [];
  for (const path of paths) {
    let captured;
    try {
      captured = execFileSync('git', ['show', `${captureSha}:${path}`], {
        cwd: repoRootOverride,
      });
    } catch {
      stalePaths.push(path);
      continue;
    }
    const currentPath = join(repoRootOverride, path);
    const current = existsSync(currentPath) ? readFileSync(currentPath) : null;
    if (!captured || !current || !captured.equals(current)) stalePaths.push(path);
  }
  if (stalePaths.length > 0) {
    return {
      ok: false,
      reason: `binding-scope content drifted since capture ${captureSha}: ${stalePaths.join(', ')}`,
      stalePaths,
    };
  }
  return { ok: true, reason: 'binding-scope tree content matches capture', stalePaths: [] };
}

function resolveCurrentHeadSha(repoRootOverride) {
  return execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: repoRootOverride,
    encoding: 'utf8',
  }).trim();
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
  const comparison = compareBindingScopeToCapture(repoRootOverride, capture);
  return { ...comparison, captureCommitSha: capture, bindingMode: manifest.bindingMode };
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
  const head = resolveCurrentHeadSha(repoRootOverride);
  const expectedCaptureSha = resolveExpectedCaptureSha(repoRootOverride);
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

  return { passCount: passes.length, head, expectedCaptureSha, bindingMode: manifest.bindingMode };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  validateSupervisorHeavyLaneRpcArtifacts();
  console.log('[PASS] supervisor heavy-lane RPC repeat-run artifacts');
}
