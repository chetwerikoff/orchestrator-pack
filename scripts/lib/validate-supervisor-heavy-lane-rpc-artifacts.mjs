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
const RPC_FIXTURE_PREFIX = 'scripts/fixtures/supervisor-test-waits-heavy-lane-rpc/';
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

function resolveGithubEventPrHeadSha(repoRootOverride) {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) {
    return null;
  }
  try {
    const head = loadJsonFile(eventPath)?.pull_request?.head?.sha;
    return head && FULL_SHA_RE.test(head) ? head : null;
  } catch {
    return null;
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
    const worktree = readFileSync(join(repoRootOverride, path));
    if (!atCapture.equals(worktree)) {
      return false;
    }
  }
  return true;
}

function resolvePrHeadSha(repoRootOverride = repoRoot) {
  for (const candidate of [
    process.env.SUPERVISOR_RPC_BIND_HEAD,
    process.env.PR_HEAD_SHA,
    process.env.AO_PR_HEAD_SHA,
    resolveGithubEventPrHeadSha(repoRootOverride),
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
    // shallow merge checkout may not fetch HEAD^2; parse GitHub merge subject instead.
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
      // not a merge commit
    }
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

function bindingScopePathsChangedSinceSafe(repoRootOverride, fromSha, toSha) {
  if (!commitObjectExists(fromSha, repoRootOverride) || !commitObjectExists(toSha, repoRootOverride)) {
    const worktreeMatch = bindingScopeMatchesCaptureWorktree(repoRootOverride, fromSha);
    if (worktreeMatch === true) {
      return [];
    }
    if (worktreeMatch === false) {
      return listBindingScopePaths(repoRootOverride);
    }
    if (isPrValidationContext()) {
      return [];
    }
    return bindingScopePathsChangedSince(repoRootOverride, fromSha, toSha);
  }
  return bindingScopePathsChangedSince(repoRootOverride, fromSha, toSha);
}

function bindingScopeTreeMatches(repoRootOverride, fromSha, toSha) {
  return bindingScopePathsChangedSinceSafe(repoRootOverride, fromSha, toSha).length === 0;
}

function isPrValidationContext() {
  return Boolean(
    process.env.PR_HEAD_SHA ||
      process.env.PR_BASE_SHA ||
      process.env.GITHUB_EVENT_NAME === 'pull_request',
  );
}

export function resolveExpectedCaptureSha(repoRootOverride = repoRoot) {
  const head = resolveBindingHead(repoRootOverride);
  const manifestPath = join(
    repoRootOverride,
    'scripts/fixtures/supervisor-test-waits-heavy-lane-rpc/manifest.json',
  );
  const manifest = loadJsonFile(manifestPath);
  const capture = manifest.captureCommitSha;

  if (!capture || !FULL_SHA_RE.test(capture)) {
    cliFail('RPC manifest missing captureCommitSha');
  }

  if (!commitObjectExists(head, repoRootOverride) || !commitObjectExists(capture, repoRootOverride)) {
    if (capture === head) {
      return capture;
    }
    const worktreeMatch = bindingScopeMatchesCaptureWorktree(repoRootOverride, capture);
    if (worktreeMatch === true || (worktreeMatch === null && isPrValidationContext())) {
      return capture;
    }
    cliFail(
      `RPC captureCommitSha ${capture} does not match binding-scope worktree at PR head ${head}; refresh heavy-lane RPC artifacts`,
    );
  }

  let changed;
  try {
    changed = pathsChangedInCommit(head, repoRootOverride);
  } catch {
    if (bindingScopeTreeMatches(repoRootOverride, capture, head)) {
      return capture;
    }
    if (capture === head) {
      return head;
    }
    cliFail(
      `RPC captureCommitSha ${capture} does not match binding-scope tree at HEAD ${head}; refresh heavy-lane RPC artifacts`,
    );
  }
  const changedFixtures = changed.filter((path) => path.startsWith(RPC_FIXTURE_PREFIX));
  const changedNonFixtures = changed.filter((path) => !path.startsWith(RPC_FIXTURE_PREFIX));

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

  if (bindingScopeTreeMatches(repoRootOverride, capture, head)) {
    return capture;
  }

  if (capture === head) {
    return head;
  }

  if (isPrValidationContext() && changedNonFixtures.length > 0 && changedFixtures.length > 0) {
    cliFail(
      'RPC metadata binding must be committed separately: only scripts/fixtures/supervisor-test-waits-heavy-lane-rpc/ may change in the metadata bind commit',
    );
  }

  cliFail(
    `RPC captureCommitSha ${capture} does not match binding-scope tree at HEAD ${head}; refresh heavy-lane RPC artifacts`,
  );
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
    if (!commitObjectExists(head, repoRootOverride) || !commitObjectExists(commitSha, repoRootOverride)) {
      const worktreeMatch = bindingScopeMatchesCaptureWorktree(repoRootOverride, commitSha);
      if (worktreeMatch === false) {
        cliFail(
          `${passId}: RPC artifacts bound to ${commitSha} but binding-scope worktree no longer matches capture; refresh heavy-lane RPC artifacts at HEAD`,
        );
      }
      return;
    }
    const stalePaths = bindingScopePathsChangedSinceSafe(repoRootOverride, commitSha, head);
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
  const expectedHeavyLaneFingerprint = resolveHeavyLaneFingerprint(repoRootOverride);
  const passes = manifest.passes ?? [];
  if (passes.length < (manifest.requiredConsecutivePasses ?? 3)) {
    cliFail(`RPC manifest requires >=${manifest.requiredConsecutivePasses ?? 3} passes, found ${passes.length}`);
  }

  if (!manifest.captureCommitSha) {
    cliFail('RPC manifest missing captureCommitSha');
  }
  assertRpcMetadataCommitSha(manifest.captureCommitSha, expectedCaptureSha, 'manifest', repoRootOverride);
  if (!manifest.heavyLaneFingerprint) {
    cliFail('RPC manifest missing heavyLaneFingerprint');
  }
  if (manifest.heavyLaneFingerprint !== expectedHeavyLaneFingerprint) {
    cliFail(
      `manifest heavyLaneFingerprint (${manifest.heavyLaneFingerprint}) must match current heavy-lane config (${expectedHeavyLaneFingerprint})`,
    );
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
    assertRpcMetadataCommitSha(meta.commitSha, expectedCaptureSha, pass.id, repoRootOverride);
    if (meta.commitSha !== manifest.captureCommitSha) {
      cliFail(`${pass.id}: metadata commitSha must match manifest captureCommitSha`);
    }
    if (meta.heavyLaneFingerprint !== expectedHeavyLaneFingerprint) {
      cliFail(
        `${pass.id}: heavyLaneFingerprint (${meta.heavyLaneFingerprint}) must match current heavy-lane config (${expectedHeavyLaneFingerprint})`,
      );
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
