#!/usr/bin/env node
/**
 * Delivery helper for Issue #731.
 *
 * Opens or updates the dedicated runtime-history PR from a fixed bot branch,
 * then monitors a trusted PR run until the branch is mergeable or fails
 * closed. GitHub reads flow through the pack `scripts/gh` wrapper.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DELIVERY_BRANCH = 'ci/vitest-runtime-history-refresh';
export const DELIVERY_BASE = 'main';
export const DELIVERY_PATH = 'scripts/vitest-runtime-history.json';
export const DELIVERY_SNAPSHOT_PATH = 'docs/vitest-runtime-history-delivery-branch-protection.snapshot.json';
export const DEFAULT_WAIT_SECONDS = 900;
export const DEFAULT_POLL_SECONDS = 15;

const FAIL_STATES = new Set(['failure', 'failed', 'error', 'cancelled', 'timed_out', 'action_required']);
const PASS_STATES = new Set(['success', 'successful', 'neutral', 'skipped']);
const PENDING_STATES = new Set(['pending', 'queued', 'requested', 'waiting', 'in_progress']);

function printUsage() {
  console.error(`Usage:
  node scripts/vitest-runtime-history-delivery.mjs upsert-pr \\
    --repo <owner/name> \\
    [--branch ${DELIVERY_BRANCH}] \\
    [--base ${DELIVERY_BASE}] \\
    [--snapshot <path>] \\
    [--title <title>] \\
    --body-file <path>

  node scripts/vitest-runtime-history-delivery.mjs monitor-pr \\
    --repo <owner/name> \\
    --pr <number> \\
    --expected-head-sha <sha> \\
    [--snapshot <path>] \\
    [--wait-seconds ${DEFAULT_WAIT_SECONDS}] \\
    [--poll-seconds ${DEFAULT_POLL_SECONDS}]`);
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const [command, ...rest] = argv;
  const options = {
    command,
    repoRoot: fileURLToPath(new URL('..', import.meta.url)),
    repo: '',
    branch: DELIVERY_BRANCH,
    base: DELIVERY_BASE,
    snapshotPath: DELIVERY_SNAPSHOT_PATH,
    title: 'chore(ci): refresh vitest runtime-history',
    bodyFile: '',
    prNumber: '',
    expectedHeadSha: '',
    waitSeconds: DEFAULT_WAIT_SECONDS,
    pollSeconds: DEFAULT_POLL_SECONDS,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--repo') {
      options.repo = rest[++index] ?? '';
    } else if (arg === '--branch') {
      options.branch = rest[++index] ?? DELIVERY_BRANCH;
    } else if (arg === '--base') {
      options.base = rest[++index] ?? DELIVERY_BASE;
    } else if (arg === '--snapshot') {
      options.snapshotPath = rest[++index] ?? DELIVERY_SNAPSHOT_PATH;
    } else if (arg === '--title') {
      options.title = rest[++index] ?? options.title;
    } else if (arg === '--body-file') {
      options.bodyFile = rest[++index] ?? '';
    } else if (arg === '--pr') {
      options.prNumber = rest[++index] ?? '';
    } else if (arg === '--expected-head-sha') {
      options.expectedHeadSha = rest[++index] ?? '';
    } else if (arg === '--wait-seconds') {
      options.waitSeconds = Number(rest[++index] ?? DEFAULT_WAIT_SECONDS);
    } else if (arg === '--poll-seconds') {
      options.pollSeconds = Number(rest[++index] ?? DEFAULT_POLL_SECONDS);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function normalizeRepo(ownerRepo) {
  const [owner, repo] = ownerRepo.split('/');
  if (!owner || !repo) {
    throw new Error(`invalid repo: ${ownerRepo}`);
  }
  return { owner, repo, fullName: `${owner}/${repo}` };
}

function resolveSnapshotPath(repoRoot, snapshotPath) {
  if (snapshotPath.startsWith('/')) {
    return snapshotPath;
  }
  return join(repoRoot, snapshotPath);
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadDeliverySnapshot(snapshotPath, now = new Date()) {
  const snapshot = loadJson(snapshotPath);
  const failures = [];
  if (snapshot.schemaVersion !== 1) {
    failures.push('snapshot schemaVersion must be 1');
  }
  if (!snapshot.capturedAt) {
    failures.push('snapshot capturedAt missing');
  }
  if (!snapshot.capturedBy?.login) {
    failures.push('snapshot capturedBy.login missing');
  }
  if (!snapshot.repository?.fullName) {
    failures.push('snapshot repository.fullName missing');
  }
  if (!Array.isArray(snapshot.branchProtection?.requiredStatusChecks)) {
    failures.push('snapshot branchProtection.requiredStatusChecks missing');
  }
  if (typeof snapshot.maxAgeDays !== 'number' || snapshot.maxAgeDays <= 0) {
    failures.push('snapshot maxAgeDays must be a positive number');
  }
  const capturedAt = new Date(snapshot.capturedAt);
  if (Number.isNaN(capturedAt.getTime())) {
    failures.push('snapshot capturedAt invalid');
  } else {
    const maxAgeMs = snapshot.maxAgeDays * 24 * 60 * 60 * 1000;
    if (now.getTime() - capturedAt.getTime() > maxAgeMs) {
      failures.push(
        `snapshot stale: capturedAt=${snapshot.capturedAt} exceeds ${snapshot.maxAgeDays} day bound`,
      );
    }
  }
  return { snapshot, failures };
}

export function requiredCheckNamesFromSnapshot(snapshot) {
  return [...new Set(snapshot.branchProtection.requiredStatusChecks ?? [])];
}

export function validateDeliveryFiles(files, expectedPath = DELIVERY_PATH) {
  const names = files.map((entry) => entry.filename);
  if (files.length !== 1 || names[0] !== expectedPath) {
    return {
      ok: false,
      reason: `delivery PR must change only ${expectedPath}; saw ${names.join(', ') || '<none>'}`,
    };
  }
  return { ok: true };
}

function classifyCheckState(entry) {
  const candidates = [entry.bucket, entry.state]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase());
  if (candidates.some((value) => FAIL_STATES.has(value))) {
    return 'fail';
  }
  if (candidates.some((value) => PENDING_STATES.has(value))) {
    return 'pending';
  }
  if (candidates.some((value) => PASS_STATES.has(value))) {
    return 'pass';
  }
  return 'pending';
}

export function evaluateDeliveryState({
  pr,
  files,
  checks,
  requiredChecks,
  expectedHeadSha,
  expectedPath = DELIVERY_PATH,
}) {
  if (expectedHeadSha && pr.head?.sha !== expectedHeadSha) {
    return { action: 'superseded', reason: `PR head advanced to ${pr.head?.sha}` };
  }

  const fileGate = validateDeliveryFiles(files, expectedPath);
  if (!fileGate.ok) {
    return { action: 'fail', reason: fileGate.reason };
  }

  if (pr.mergeable === null || pr.mergeable_state === 'unknown') {
    return { action: 'wait', reason: 'delivery PR mergeability still computing' };
  }

  if (pr.mergeable === false || pr.mergeable_state === 'dirty') {
    return {
      action: 'close-as-obsolete',
      reason: 'delivery PR is conflicted or unmergeable',
    };
  }

  const checkStates = new Map();
  for (const check of checks) {
    checkStates.set(check.name, classifyCheckState(check));
  }

  const missing = requiredChecks.filter((name) => !checkStates.has(name));
  if (missing.length > 0) {
    return { action: 'wait', reason: `required checks missing: ${missing.join(', ')}` };
  }

  const failed = requiredChecks.filter((name) => checkStates.get(name) === 'fail');
  if (failed.length > 0) {
    return { action: 'fail', reason: `required checks failed: ${failed.join(', ')}` };
  }

  const pending = requiredChecks.filter((name) => checkStates.get(name) !== 'pass');
  if (pending.length > 0) {
    return { action: 'wait', reason: `required checks pending: ${pending.join(', ')}` };
  }

  return { action: 'merge', reason: 'delivery PR passed required checks' };
}

function ghCommand(repoRoot) {
  return join(repoRoot, 'scripts', 'gh');
}

function runGh(repoRoot, args, options = {}) {
  const result = spawnSync(ghCommand(repoRoot), args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });
  const allowedExitCodes = options.allowedExitCodes ?? [0];
  if (!allowedExitCodes.includes(result.status ?? 1)) {
    throw new Error(
      `gh ${args.join(' ')} failed (exit ${result.status ?? 'null'}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function runGhJson(repoRoot, args, options = {}) {
  const result = runGh(repoRoot, args, options);
  const text = result.stdout.trim();
  if (!text) {
    return null;
  }
  return JSON.parse(text);
}

export function closeObsoleteDeliveryPr({
  repoRoot,
  repo,
  prNumber,
  reason,
  runCommand = runGh,
}) {
  runCommand(
    repoRoot,
    [
      'pr',
      'close',
      String(prNumber),
      '--repo',
      repo,
      '--comment',
      `Closing obsolete runtime-history delivery PR: ${reason}. A later refresh trigger will regenerate it from current main.`,
    ],
    { allowedExitCodes: [0] },
  );
}

export function selectReusableDeliveryPr(existingPulls) {
  if (!Array.isArray(existingPulls) || existingPulls.length === 0) {
    return null;
  }

  return (
    existingPulls.find((pullRequest) => pullRequest?.state === 'open') ??
    existingPulls.find((pullRequest) => pullRequest?.state === 'closed' && !pullRequest?.merged_at) ??
    null
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function upsertPr(options) {
  if (!options.repo || !options.bodyFile) {
    printUsage();
    process.exit(1);
  }

  const snapshotPath = resolveSnapshotPath(options.repoRoot, options.snapshotPath);
  const { snapshot, failures } = loadDeliverySnapshot(snapshotPath);
  if (failures.length > 0) {
    throw new Error(failures.join('; '));
  }
  if (snapshot.repository.fullName !== options.repo) {
    throw new Error(`snapshot repo mismatch: ${snapshot.repository.fullName} != ${options.repo}`);
  }

  const { owner, repo } = normalizeRepo(options.repo);
  const body = readFileSync(options.bodyFile, 'utf8');
  const listArgs = [
    'api',
    `repos/${owner}/${repo}/pulls?state=all&head=${owner}:${encodeURIComponent(options.branch)}&base=${options.base}`,
  ];
  const reusablePr = selectReusableDeliveryPr(runGhJson(options.repoRoot, listArgs) ?? []);

  let pr;
  if (reusablePr) {
    const number = reusablePr.number;
    if (reusablePr.state === 'closed') {
      runGh(
        options.repoRoot,
        ['pr', 'reopen', String(number), '--repo', options.repo],
        { allowedExitCodes: [0] },
      );
      console.log(`[INFO] runtime-history delivery PR reopened: #${number}`);
    }
    pr = runGhJson(options.repoRoot, [
      'api',
      '-X',
      'PATCH',
      `repos/${owner}/${repo}/pulls/${number}`,
      '-f',
      `title=${options.title}`,
      '-f',
      `body=${body}`,
    ]);
    console.log(`[PASS] runtime-history delivery PR updated: #${number}`);
  } else {
    pr = runGhJson(options.repoRoot, [
      'api',
      `repos/${owner}/${repo}/pulls`,
      '-f',
      `title=${options.title}`,
      '-f',
      `head=${options.branch}`,
      '-f',
      `base=${options.base}`,
      '-f',
      `body=${body}`,
    ]);
    console.log(`[PASS] runtime-history delivery PR created: #${pr.number}`);
  }

  console.log(JSON.stringify({ number: pr.number, url: pr.html_url, headSha: pr.head?.sha }));
}

async function monitorPr(options) {
  if (!options.repo || !options.prNumber || !options.expectedHeadSha) {
    printUsage();
    process.exit(1);
  }

  const snapshotPath = resolveSnapshotPath(options.repoRoot, options.snapshotPath);
  const { snapshot, failures } = loadDeliverySnapshot(snapshotPath);
  if (failures.length > 0) {
    throw new Error(failures.join('; '));
  }
  const requiredChecks = requiredCheckNamesFromSnapshot(snapshot);
  const { owner, repo } = normalizeRepo(options.repo);
  const deadline = Date.now() + options.waitSeconds * 1000;

  while (Date.now() <= deadline) {
    const pr = runGhJson(options.repoRoot, ['api', `repos/${owner}/${repo}/pulls/${options.prNumber}`]);
    const files =
      runGhJson(options.repoRoot, [
        'api',
        `repos/${owner}/${repo}/pulls/${options.prNumber}/files?per_page=100`,
      ]) ?? [];
    const checksResult = runGh(options.repoRoot, [
      'pr',
      'checks',
      options.prNumber,
      '--json',
      'name,state,bucket,link,startedAt,completedAt,workflow,description',
    ], {
      allowedExitCodes: [0, 1, 8],
    });
    const checks = checksResult.stdout.trim() ? JSON.parse(checksResult.stdout) : [];

    const decision = evaluateDeliveryState({
      pr,
      files,
      checks,
      requiredChecks,
      expectedHeadSha: options.expectedHeadSha,
    });

    if (decision.action === 'superseded') {
      console.log(`[PASS] runtime-history delivery monitor superseded: ${decision.reason}`);
      return;
    }
    if (decision.action === 'close-as-obsolete') {
      closeObsoleteDeliveryPr({
        repoRoot: options.repoRoot,
        repo: options.repo,
        prNumber: options.prNumber,
        reason: decision.reason,
      });
      console.log(
        `[PASS] runtime-history delivery closed obsolete PR #${options.prNumber}: ${decision.reason}`,
      );
      return;
    }
    if (decision.action === 'fail') {
      throw new Error(`runtime-history delivery failed: ${decision.reason}`);
    }
    if (decision.action === 'merge') {
      runGh(
        options.repoRoot,
        [
          'api',
          '-X',
          'PUT',
          `repos/${owner}/${repo}/pulls/${options.prNumber}/merge`,
          '-f',
          'merge_method=squash',
          '-f',
          `sha=${options.expectedHeadSha}`,
        ],
        { allowedExitCodes: [0] },
      );
      console.log(`[PASS] runtime-history delivery merged PR #${options.prNumber}`);
      return;
    }

    console.log(`[INFO] runtime-history delivery waiting: ${decision.reason}`);
    await sleep(options.pollSeconds * 1000);
  }

  throw new Error(
    `runtime-history delivery timed out after ${options.waitSeconds}s waiting for PR #${options.prNumber}`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'upsert-pr') {
    await upsertPr(options);
    return;
  }
  if (options.command === 'monitor-pr') {
    await monitorPr(options);
    return;
  }

  printUsage();
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[FAIL] ${error.message}`);
    process.exit(1);
  });
}
