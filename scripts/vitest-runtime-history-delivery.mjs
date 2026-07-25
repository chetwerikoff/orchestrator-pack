#!/usr/bin/env node
/**
 * Runtime-history protected-branch delivery helper.
 *
 * Issue #990 extends the existing #731 path with exact refresh provenance,
 * live main required-check policy, narrow machine admission for pack-review,
 * race-safe same-context status precedence, and authoritative merge read-back.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TARGET_REPOSITORY = 'chetwerikoff/orchestrator-pack';
export const DELIVERY_BRANCH = 'ci/vitest-runtime-history-refresh';
export const DELIVERY_BASE = 'main';
export const DELIVERY_PATH = 'scripts/vitest-runtime-history.json';
export const PACK_REVIEW_CONTEXT = 'orchestrator-pack/pack-review';
export const PROVENANCE_CONTEXT = 'orchestrator-pack/runtime-history-provenance';
export const MACHINE_ADMISSION_MARKER = 'runtime-history-machine-admission';
export const PROVENANCE_MARKER = 'runtime-history-provenance';
export const REFRESH_WORKFLOW_PATH = '.github/workflows/vitest-runtime-history-refresh.yml';
export const DEFAULT_WAIT_SECONDS = 900;
export const DEFAULT_POLL_SECONDS = 15;

const FAIL_STATES = new Set(['failure', 'failed', 'error', 'cancelled', 'timed_out', 'action_required']);
const PASS_STATES = new Set(['success', 'successful', 'neutral', 'skipped', 'skipping']);
const PENDING_STATES = new Set(['pending', 'queued', 'requested', 'waiting', 'in_progress']);
const SHA_RE = /^[0-9a-f]{40}$/i;
const PROVENANCE_DESCRIPTION_RE =
  /^runtime-history-provenance run=(\d+) attempt=(\d+) source=([0-9a-f]{40})$/i;

function printUsage() {
  console.error(`Usage:
  node scripts/vitest-runtime-history-delivery.mjs upsert-pr \\
    --repo <owner/name> \\
    [--branch ${DELIVERY_BRANCH}] \\
    [--base ${DELIVERY_BASE}] \\
    [--title <title>] \\
    --body-file <path>

  node scripts/vitest-runtime-history-delivery.mjs monitor-pr \\
    --repo <owner/name> \\
    --pr <number> \\
    --expected-head-sha <sha> \\
    --trusted-actor <login> \\
    --event-sender <login> \\
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
    title: 'chore(ci): refresh vitest runtime-history',
    bodyFile: '',
    prNumber: '',
    expectedHeadSha: '',
    trustedActor: '',
    eventSender: '',
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
      // Kept as a no-op compatibility flag for older callers. The snapshot is no longer
      // merge-readiness authority under Issue #990.
      index += 1;
    } else if (arg === '--title') {
      options.title = rest[++index] ?? options.title;
    } else if (arg === '--body-file') {
      options.bodyFile = rest[++index] ?? '';
    } else if (arg === '--pr') {
      options.prNumber = rest[++index] ?? '';
    } else if (arg === '--expected-head-sha') {
      options.expectedHeadSha = rest[++index] ?? '';
    } else if (arg === '--trusted-actor') {
      options.trustedActor = rest[++index] ?? '';
    } else if (arg === '--event-sender') {
      options.eventSender = rest[++index] ?? '';
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
  if (!owner || !repo || `${owner}/${repo}` !== ownerRepo) {
    throw new Error(`invalid repo: ${ownerRepo}`);
  }
  return { owner, repo, fullName: `${owner}/${repo}` };
}

export function validateDeliveryFiles(files, expectedPath = DELIVERY_PATH) {
  if (!Array.isArray(files)) {
    return { ok: false, reason: 'delivery PR files payload is malformed' };
  }
  const names = files.map((entry) => entry?.filename).filter(Boolean);
  if (files.length !== 1 || names.length !== 1 || names[0] !== expectedPath) {
    return {
      ok: false,
      reason: `delivery PR must change only ${expectedPath}; saw ${names.join(', ') || '<none>'}`,
    };
  }
  return { ok: true };
}

function classifyCheckState(entry) {
  const candidates = [entry?.bucket, entry?.state]
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

export function validateSanctionedIdentity({
  repo,
  pr,
  expectedHeadSha,
  trustedActor,
  eventSender,
}) {
  if (repo !== TARGET_REPOSITORY) {
    return { ok: false, outcome: 'identity-invalid', reason: `repository ${repo} is not sanctioned` };
  }
  if (!SHA_RE.test(expectedHeadSha ?? '')) {
    return { ok: false, outcome: 'identity-invalid', reason: 'expected head sha is invalid' };
  }
  if (!trustedActor || !eventSender || trustedActor !== eventSender) {
    return {
      ok: false,
      outcome: 'identity-invalid',
      reason: 'delivery event sender does not match the trusted delivery actor',
    };
  }
  if (pr?.base?.ref !== DELIVERY_BASE) {
    return { ok: false, outcome: 'identity-invalid', reason: `delivery base must be ${DELIVERY_BASE}` };
  }
  if (pr?.head?.ref !== DELIVERY_BRANCH) {
    return { ok: false, outcome: 'identity-invalid', reason: `delivery head branch must be ${DELIVERY_BRANCH}` };
  }
  if (pr?.head?.repo?.full_name !== TARGET_REPOSITORY) {
    return { ok: false, outcome: 'identity-invalid', reason: 'delivery head must come from the same repository' };
  }
  if (pr?.head?.sha !== expectedHeadSha) {
    return {
      ok: false,
      outcome: 'non-generated-head',
      reason: `PR head ${pr?.head?.sha ?? '<missing>'} does not equal generated head ${expectedHeadSha}`,
    };
  }
  return { ok: true };
}

function statusOrderKey(status) {
  const id = Number(status?.id);
  const createdAt = Date.parse(status?.created_at ?? '');
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(createdAt)) {
    return null;
  }
  return { id, createdAt };
}

export function projectPackReviewStatusHistory(statusHistory) {
  if (!Array.isArray(statusHistory)) {
    return { ok: false, outcome: 'status-history-unprovable', reason: 'status history is not an array' };
  }

  const relevant = statusHistory.filter((row) => row?.context === PACK_REVIEW_CONTEXT);
  const seenIds = new Set();
  const normalized = [];
  for (const row of relevant) {
    const key = statusOrderKey(row);
    const state = String(row?.state ?? '').toLowerCase();
    const description = String(row?.description ?? '');
    if (!key || !['success', 'pending', 'failure', 'error'].includes(state)) {
      return { ok: false, outcome: 'status-history-unprovable', reason: 'malformed pack-review status record' };
    }
    if (seenIds.has(key.id)) {
      return { ok: false, outcome: 'status-history-unprovable', reason: 'duplicate status identity' };
    }
    seenIds.add(key.id);
    normalized.push({
      id: key.id,
      createdAt: key.createdAt,
      state,
      machine: description === MACHINE_ADMISSION_MARKER,
      row,
    });
  }

  normalized.sort((a, b) => a.id - b.id);
  for (let index = 1; index < normalized.length; index += 1) {
    const prior = normalized[index - 1];
    const current = normalized[index];
    if (current.createdAt < prior.createdAt) {
      return {
        ok: false,
        outcome: 'status-history-unprovable',
        reason: 'status id/time ordering is ambiguous',
      };
    }
  }

  const machineRecords = normalized.filter((entry) => entry.machine);
  const outOfBand = normalized.filter((entry) => !entry.machine);
  const latestOutOfBand = outOfBand.at(-1) ?? null;
  const machineSuccess = machineRecords.some((entry) => entry.state === 'success');

  if (!latestOutOfBand) {
    return { ok: true, state: 'absent', machineSuccess, latestOutOfBand: null };
  }
  if (latestOutOfBand.state === 'success') {
    return { ok: true, state: 'success', machineSuccess, latestOutOfBand: latestOutOfBand.row };
  }
  if (latestOutOfBand.state === 'pending') {
    return { ok: true, state: 'pending', machineSuccess, latestOutOfBand: latestOutOfBand.row };
  }
  return {
    ok: true,
    state: 'veto',
    machineSuccess,
    latestOutOfBand: latestOutOfBand.row,
    outcome: 'operator-veto-observed',
  };
}

export function parseRefreshProvenance(statusHistory, expectedHeadSha) {
  if (!Array.isArray(statusHistory)) {
    return { ok: false, outcome: 'status-history-unprovable', reason: 'status history is not an array' };
  }
  if (!SHA_RE.test(expectedHeadSha ?? '')) {
    return { ok: false, outcome: 'provenance-invalid', reason: 'expected head sha is invalid' };
  }

  const rows = statusHistory.filter((row) => row?.context === PROVENANCE_CONTEXT);
  if (rows.length === 0) {
    return { ok: false, outcome: 'provenance-invalid', reason: 'refresh provenance status is missing' };
  }

  const normalized = [];
  const seenIds = new Set();
  for (const row of rows) {
    const key = statusOrderKey(row);
    const state = String(row?.state ?? '').toLowerCase();
    const description = String(row?.description ?? '');
    const match = description.match(PROVENANCE_DESCRIPTION_RE);
    const creator = String(row?.creator?.login ?? '');
    if (!key || seenIds.has(key.id) || !match || !['pending', 'success', 'failure', 'error'].includes(state)) {
      return { ok: false, outcome: 'provenance-invalid', reason: 'refresh provenance status is malformed or ambiguous' };
    }
    const runId = Number(match[1]);
    const runAttempt = Number(match[2]);
    const expectedTargetUrl = `https://github.com/${TARGET_REPOSITORY}/actions/runs/${runId}/attempts/${runAttempt}`;
    if (creator !== 'github-actions[bot]' || row?.target_url !== expectedTargetUrl) {
      return {
        ok: false,
        outcome: 'provenance-invalid',
        reason: 'refresh provenance status is not a trusted repository-owned run output',
      };
    }
    seenIds.add(key.id);
    normalized.push({
      id: key.id,
      createdAt: key.createdAt,
      state,
      runId,
      runAttempt,
      sourceMainSha: match[3].toLowerCase(),
      row,
    });
  }
  normalized.sort((a, b) => a.id - b.id);
  for (let index = 1; index < normalized.length; index += 1) {
    const prior = normalized[index - 1];
    const current = normalized[index];
    if (
      current.createdAt < prior.createdAt
      || current.runId !== prior.runId
      || current.runAttempt !== prior.runAttempt
      || current.sourceMainSha !== prior.sourceMainSha
    ) {
      return { ok: false, outcome: 'provenance-invalid', reason: 'refresh provenance records do not bind one episode' };
    }
  }

  return {
    ok: true,
    exactHeadSha: expectedHeadSha.toLowerCase(),
    ...normalized.at(-1),
  };
}

export function verifyRefreshRun(run, provenance) {
  if (!run || typeof run !== 'object') {
    return { ok: false, outcome: 'provenance-invalid', reason: 'refresh workflow run is unavailable' };
  }
  if (
    Number(run.id) !== provenance.runId
    || Number(run.run_attempt) !== provenance.runAttempt
    || run.repository?.full_name !== TARGET_REPOSITORY
    || run.path !== REFRESH_WORKFLOW_PATH
    || String(run.head_sha ?? '').toLowerCase() !== provenance.sourceMainSha
  ) {
    return { ok: false, outcome: 'provenance-invalid', reason: 'refresh workflow run does not match provenance binding' };
  }

  const status = String(run.status ?? '').toLowerCase();
  const conclusion = String(run.conclusion ?? '').toLowerCase();
  if (status !== 'completed') {
    return { ok: true, state: 'pending', reason: 'refresh workflow episode has not completed' };
  }
  if (conclusion !== 'success' || provenance.state !== 'success') {
    return { ok: false, outcome: 'provenance-invalid', reason: `refresh workflow episode ended ${conclusion || provenance.state}` };
  }
  return { ok: true, state: 'success' };
}

export function normalizeCurrentRequiredPolicy(policy) {
  if (!policy || typeof policy !== 'object' || typeof policy.strict !== 'boolean') {
    return { ok: false, outcome: 'current-policy-unavailable', reason: 'current main required-status policy is malformed' };
  }

  const rawChecks = Array.isArray(policy.checks)
    ? policy.checks
    : Array.isArray(policy.contexts)
      ? policy.contexts.map((context) => ({ context, app_id: null }))
      : null;
  if (!rawChecks) {
    return { ok: false, outcome: 'current-policy-unsupported', reason: 'current main required-status policy has no checks/contexts list' };
  }

  const seen = new Set();
  const checks = [];
  for (const raw of rawChecks) {
    const context = typeof raw === 'string' ? raw : raw?.context;
    const appId = typeof raw === 'object' && raw !== null ? (raw.app_id ?? null) : null;
    if (!context || typeof context !== 'string' || seen.has(context)) {
      return { ok: false, outcome: 'current-policy-unsupported', reason: 'current policy contains malformed or duplicate required checks' };
    }
    if (appId !== null && (!Number.isSafeInteger(Number(appId)) || Number(appId) <= 0)) {
      return { ok: false, outcome: 'current-policy-unsupported', reason: `invalid app restriction for ${context}` };
    }
    seen.add(context);
    checks.push({ context, appId: appId === null ? null : Number(appId) });
  }

  return { ok: true, strict: policy.strict, checks, names: checks.map((entry) => entry.context) };
}

export function evaluateRequiredChecks({
  checks,
  policy,
  packReviewProjection,
  machineAdmissionAttempted = false,
}) {
  if (!Array.isArray(checks)) {
    return { action: 'fail', outcome: 'current-checks-unavailable', reason: 'current checks payload is malformed' };
  }
  if (!policy?.ok) {
    return { action: 'fail', outcome: policy?.outcome ?? 'current-policy-unavailable', reason: policy?.reason ?? 'current policy unavailable' };
  }

  const stateByName = new Map();
  for (const check of checks) {
    if (!check?.name) {
      continue;
    }
    stateByName.set(String(check.name), classifyCheckState(check));
  }

  const requiredOrdinary = policy.names.filter((name) => name !== PACK_REVIEW_CONTEXT);
  const failed = requiredOrdinary.filter((name) => stateByName.get(name) === 'fail');
  if (failed.length > 0) {
    return { action: 'fail', outcome: 'required-check-failed', reason: `required checks failed: ${failed.join(', ')}` };
  }

  const pending = requiredOrdinary.filter((name) => stateByName.get(name) === 'pending');
  if (pending.length > 0) {
    return { action: 'wait', outcome: 'required-check-pending', reason: `required checks pending: ${pending.join(', ')}` };
  }

  const missing = requiredOrdinary.filter((name) => !stateByName.has(name));
  if (missing.length > 0) {
    const anyPending = checks.some((check) => classifyCheckState(check) === 'pending');
    if (checks.length === 0 || anyPending) {
      return { action: 'wait', outcome: 'required-check-pending', reason: `required checks not reported yet: ${missing.join(', ')}` };
    }
    return {
      action: 'fail',
      outcome: 'required-context-unreported',
      reason: `required contexts unreported: ${missing.join(', ')}`,
    };
  }

  if (!policy.names.includes(PACK_REVIEW_CONTEXT)) {
    return { action: 'ready', reason: 'all current required checks pass; pack-review is not required' };
  }

  if (!packReviewProjection?.ok) {
    return {
      action: 'fail',
      outcome: packReviewProjection?.outcome ?? 'status-history-unprovable',
      reason: packReviewProjection?.reason ?? 'pack-review status history unavailable',
    };
  }
  if (packReviewProjection.state === 'veto') {
    return { action: 'fail', outcome: 'operator-veto-observed', reason: 'latest out-of-band pack-review state is failure/error' };
  }
  if (packReviewProjection.state === 'pending') {
    return { action: 'wait', outcome: 'operator-status-pending', reason: 'latest out-of-band pack-review state is pending' };
  }
  if (packReviewProjection.state === 'success') {
    return { action: 'ready', reason: 'pack-review is satisfied by latest out-of-band success' };
  }
  if (!packReviewProjection.machineSuccess) {
    return { action: 'machine-admit', reason: 'pack-review is required and no out-of-band status exists' };
  }

  const currentPackState = stateByName.get(PACK_REVIEW_CONTEXT);
  if (currentPackState === 'pass') {
    return { action: 'ready', reason: 'pack-review is satisfied by machine admission' };
  }
  if (currentPackState === 'fail') {
    return { action: 'fail', outcome: 'required-check-failed', reason: 'current pack-review context is failing' };
  }
  if (currentPackState === 'pending') {
    return { action: 'wait', outcome: 'required-check-pending', reason: 'current pack-review context is pending' };
  }
  if (machineAdmissionAttempted || packReviewProjection.machineSuccess) {
    return {
      action: 'fail',
      outcome: 'required-context-unreported',
      reason: 'machine admission exists but current required pack-review context is unreported',
    };
  }
  return { action: 'machine-admit', reason: 'pack-review machine admission is eligible' };
}

function ghCommand(repoRoot) {
  return join(repoRoot, 'scripts', 'gh');
}

function runGh(repoRoot, args, options = {}) {
  const result = spawnSync(ghCommand(repoRoot), args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
  });
  const allowedExitCodes = options.allowedExitCodes ?? [0];
  if (!allowedExitCodes.includes(result.status ?? 1)) {
    const error = new Error(
      `gh ${args.join(' ')} failed (exit ${result.status ?? 'null'}): ${result.stderr || result.stdout}`,
    );
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
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
  return existingPulls.find((pullRequest) => pullRequest?.state === 'open') ?? null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function upsertPr(options) {
  if (!options.repo || !options.bodyFile) {
    printUsage();
    process.exit(1);
  }
  if (options.repo !== TARGET_REPOSITORY) {
    throw new Error(`runtime-history delivery is only sanctioned for ${TARGET_REPOSITORY}`);
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

function createRealIo(options) {
  const { owner, repo } = normalizeRepo(options.repo);
  const prNumber = String(options.prNumber);
  return {
    getPr() {
      return runGhJson(options.repoRoot, ['api', `repos/${owner}/${repo}/pulls/${prNumber}`]);
    },
    getFiles() {
      return runGhJson(options.repoRoot, [
        'api',
        `repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`,
      ]) ?? [];
    },
    getChecks() {
      const result = runGh(options.repoRoot, [
        'pr',
        'checks',
        prNumber,
        '--json',
        'name,state,bucket,link,startedAt,completedAt,workflow,description',
      ], { allowedExitCodes: [0, 1, 8] });
      return result.stdout.trim() ? JSON.parse(result.stdout) : [];
    },
    getPolicy() {
      return runGhJson(options.repoRoot, [
        'api',
        `repos/${owner}/${repo}/branches/${DELIVERY_BASE}/protection/required_status_checks`,
      ]);
    },
    getStatusHistory(headSha) {
      return runGhJson(options.repoRoot, [
        'api',
        `repos/${owner}/${repo}/commits/${headSha}/statuses`,
      ]) ?? [];
    },
    getActionsRun(runId) {
      return runGhJson(options.repoRoot, [
        'api',
        `repos/${owner}/${repo}/actions/runs/${runId}`,
      ]);
    },
    publishMachineAdmission(headSha) {
      if (!process.env.MACHINE_STATUS_TOKEN) {
        throw new Error('MACHINE_STATUS_TOKEN is required for repository-owned machine admission');
      }
      return runGhJson(options.repoRoot, [
        'api',
        '-X',
        'POST',
        `repos/${owner}/${repo}/statuses/${headSha}`,
        '-f',
        'state=success',
        '-f',
        `context=${PACK_REVIEW_CONTEXT}`,
        '-f',
        `description=${MACHINE_ADMISSION_MARKER}`,
      ], {
        env: { GH_TOKEN: process.env.MACHINE_STATUS_TOKEN },
      });
    },
    merge(headSha) {
      return runGhJson(options.repoRoot, [
        'api',
        '-X',
        'PUT',
        `repos/${owner}/${repo}/pulls/${prNumber}/merge`,
        '-f',
        'merge_method=squash',
        '-f',
        `sha=${headSha}`,
      ]);
    },
    closeObsolete(reason) {
      closeObsoleteDeliveryPr({
        repoRoot: options.repoRoot,
        repo: options.repo,
        prNumber: options.prNumber,
        reason,
      });
    },
    sleep,
  };
}

async function inspectCurrentState(config, io) {
  const pr = await io.getPr();
  const identity = validateSanctionedIdentity({
    repo: config.repo,
    pr,
    expectedHeadSha: config.expectedHeadSha,
    trustedActor: config.trustedActor,
    eventSender: config.eventSender,
  });
  if (!identity.ok) {
    return { terminal: true, ...identity, pr };
  }

  const files = await io.getFiles();
  const fileGate = validateDeliveryFiles(files);
  if (!fileGate.ok) {
    return { terminal: true, ok: false, outcome: 'scope-invalid', reason: fileGate.reason, pr };
  }

  if (pr?.mergeable === false || pr?.mergeable_state === 'dirty') {
    return {
      terminal: true,
      ok: false,
      outcome: 'close-as-obsolete',
      reason: 'delivery PR is conflicted or unmergeable',
      pr,
    };
  }
  if (pr?.mergeable === null || pr?.mergeable_state === 'unknown') {
    return { wait: true, outcome: 'mergeability-pending', reason: 'delivery PR mergeability still computing', pr };
  }

  let statusHistory;
  try {
    statusHistory = await io.getStatusHistory(config.expectedHeadSha);
  } catch (error) {
    return {
      terminal: true,
      ok: false,
      outcome: 'status-history-unprovable',
      reason: `status history read failed: ${error.message}`,
      pr,
    };
  }

  const provenance = parseRefreshProvenance(statusHistory, config.expectedHeadSha);
  if (!provenance.ok) {
    return { terminal: true, ...provenance, pr };
  }

  let refreshRun;
  try {
    refreshRun = await io.getActionsRun(provenance.runId);
  } catch (error) {
    return {
      terminal: true,
      ok: false,
      outcome: 'provenance-invalid',
      reason: `refresh run read failed: ${error.message}`,
      pr,
    };
  }
  const runProof = verifyRefreshRun(refreshRun, provenance);
  if (!runProof.ok) {
    return { terminal: true, ...runProof, pr };
  }
  if (runProof.state === 'pending') {
    return { wait: true, outcome: 'provenance-pending', reason: runProof.reason, pr };
  }

  let rawPolicy;
  try {
    rawPolicy = await io.getPolicy();
  } catch (error) {
    return {
      terminal: true,
      ok: false,
      outcome: 'current-policy-unavailable',
      reason: `current main policy read failed: ${error.message}`,
      pr,
    };
  }
  const policy = normalizeCurrentRequiredPolicy(rawPolicy);
  if (!policy.ok) {
    return { terminal: true, ...policy, pr };
  }

  const projection = projectPackReviewStatusHistory(statusHistory);
  if (!projection.ok) {
    return { terminal: true, ...projection, pr, policy, statusHistory };
  }
  if (projection.state === 'veto') {
    return {
      terminal: true,
      ok: false,
      outcome: 'operator-veto-observed',
      reason: 'latest out-of-band pack-review status is failure/error',
      pr,
      policy,
      statusHistory,
      projection,
    };
  }
  if (projection.state === 'pending') {
    return {
      wait: true,
      outcome: 'operator-status-pending',
      reason: 'latest out-of-band pack-review status is pending',
      pr,
      policy,
      statusHistory,
      projection,
    };
  }

  const checks = await io.getChecks();
  return {
    ok: true,
    pr,
    files,
    statusHistory,
    provenance,
    refreshRun,
    policy,
    projection,
    checks,
  };
}

export async function runDeliveryMonitor(config, io) {
  const deadline = Date.now() + config.waitSeconds * 1000;
  let machineAdmissionAttempted = false;
  let missingProvenanceObserved = false;

  while (Date.now() <= deadline) {
    let state = await inspectCurrentState(config, io);
    if (
      state.terminal
      && state.outcome === 'provenance-invalid'
      && state.reason === 'refresh provenance status is missing'
      && !missingProvenanceObserved
    ) {
      missingProvenanceObserved = true;
      await io.sleep(config.pollSeconds * 1000);
      continue;
    }
    if (state.terminal) {
      if (state.outcome === 'close-as-obsolete') {
        await io.closeObsolete(state.reason);
        return { outcome: 'close-as-obsolete', reason: state.reason };
      }
      if (state.outcome === 'non-generated-head') {
        return { outcome: 'non-generated-head', reason: state.reason };
      }
      return { outcome: state.outcome, reason: state.reason, failed: true };
    }
    if (state.wait) {
      await io.sleep(config.pollSeconds * 1000);
      continue;
    }

    let decision = evaluateRequiredChecks({
      checks: state.checks,
      policy: state.policy,
      packReviewProjection: state.projection,
      machineAdmissionAttempted,
    });

    if (decision.action === 'fail') {
      return { outcome: decision.outcome, reason: decision.reason, failed: true };
    }
    if (decision.action === 'wait') {
      await io.sleep(config.pollSeconds * 1000);
      continue;
    }

    if (decision.action === 'machine-admit') {
      let writeConfirmed = false;
      try {
        const published = await io.publishMachineAdmission(config.expectedHeadSha);
        writeConfirmed =
          published?.context === PACK_REVIEW_CONTEXT
          && published?.state === 'success'
          && published?.description === MACHINE_ADMISSION_MARKER;
      } catch {
        // A timed-out/ambiguous write must be read back before any retry.
      }

      machineAdmissionAttempted = true;
      let postHistory;
      try {
        postHistory = await io.getStatusHistory(config.expectedHeadSha);
      } catch (error) {
        return {
          outcome: 'status-history-unprovable',
          reason: `post-publication status history read failed: ${error.message}`,
          failed: true,
        };
      }
      const postProjection = projectPackReviewStatusHistory(postHistory);
      if (!postProjection.ok) {
        return { outcome: postProjection.outcome, reason: postProjection.reason, failed: true };
      }
      if (postProjection.state === 'veto') {
        return {
          outcome: 'operator-veto-observed',
          reason: 'out-of-band pack-review veto observed after machine publication',
          failed: true,
        };
      }
      if (postProjection.state === 'pending') {
        await io.sleep(config.pollSeconds * 1000);
        continue;
      }
      if (!postProjection.machineSuccess && !writeConfirmed) {
        return {
          outcome: 'machine-admission-unconfirmed',
          reason: 'machine admission write was not confirmed by exact-head status history',
          failed: true,
        };
      }
    }

    // Final decision boundary: re-read every mutable proof. No machine status write occurs
    // after this point before the merge call.
    state = await inspectCurrentState(config, io);
    if (state.terminal) {
      if (state.outcome === 'non-generated-head') {
        return { outcome: 'non-generated-head', reason: state.reason };
      }
      if (state.outcome === 'close-as-obsolete') {
        await io.closeObsolete(state.reason);
        return { outcome: 'close-as-obsolete', reason: state.reason };
      }
      return { outcome: state.outcome, reason: state.reason, failed: true };
    }
    if (state.wait) {
      await io.sleep(config.pollSeconds * 1000);
      continue;
    }

    decision = evaluateRequiredChecks({
      checks: state.checks,
      policy: state.policy,
      packReviewProjection: state.projection,
      machineAdmissionAttempted,
    });
    if (decision.action === 'machine-admit') {
      // Policy/status changed after the earlier publication boundary. Do not write again in
      // the same decision; return to the loop and re-establish precedence first.
      await io.sleep(config.pollSeconds * 1000);
      continue;
    }
    if (decision.action === 'fail') {
      return { outcome: decision.outcome, reason: decision.reason, failed: true };
    }
    if (decision.action === 'wait') {
      await io.sleep(config.pollSeconds * 1000);
      continue;
    }

    let mergeResult;
    try {
      mergeResult = await io.merge(config.expectedHeadSha);
    } catch (error) {
      const rebound = await inspectCurrentState(config, io);
      if (rebound.terminal) {
        return {
          outcome: rebound.outcome,
          reason: `merge rejected and fresh state changed: ${rebound.reason}`,
          failed: rebound.outcome !== 'non-generated-head',
        };
      }
      if (rebound.wait) {
        await io.sleep(config.pollSeconds * 1000);
        continue;
      }
      return {
        outcome: 'merge-rejected',
        reason: `expected-head merge request rejected: ${error.message}`,
        failed: true,
      };
    }

    if (mergeResult && mergeResult.merged === false) {
      const rebound = await inspectCurrentState(config, io);
      if (rebound.terminal) {
        return { outcome: rebound.outcome, reason: rebound.reason, failed: rebound.outcome !== 'non-generated-head' };
      }
      if (rebound.wait) {
        await io.sleep(config.pollSeconds * 1000);
        continue;
      }
      return {
        outcome: 'merge-rejected',
        reason: mergeResult.message || 'GitHub rejected expected-head merge request',
        failed: true,
      };
    }

    const mergedPr = await io.getPr();
    if (
      mergedPr?.number !== Number(config.prNumber)
      || mergedPr?.base?.ref !== DELIVERY_BASE
      || mergedPr?.merged !== true
      || !mergedPr?.merged_at
    ) {
      return {
        outcome: 'merge-readback-failed',
        reason: 'authoritative PR read-back did not confirm the expected merge into main',
        failed: true,
      };
    }

    return {
      outcome: 'merged',
      merged: true,
      prNumber: Number(config.prNumber),
      expectedHeadSha: config.expectedHeadSha,
      mergedAt: mergedPr.merged_at,
    };
  }

  return {
    outcome: 'timeout',
    reason: `runtime-history delivery timed out after ${config.waitSeconds}s waiting for PR #${config.prNumber}`,
    failed: true,
  };
}

async function monitorPr(options) {
  if (
    !options.repo
    || !options.prNumber
    || !options.expectedHeadSha
    || !options.trustedActor
    || !options.eventSender
  ) {
    printUsage();
    process.exit(1);
  }

  const result = await runDeliveryMonitor(
    {
      repo: options.repo,
      prNumber: Number(options.prNumber),
      expectedHeadSha: options.expectedHeadSha,
      trustedActor: options.trustedActor,
      eventSender: options.eventSender,
      waitSeconds: options.waitSeconds,
      pollSeconds: options.pollSeconds,
    },
    createRealIo(options),
  );

  if (result.outcome === 'merged') {
    console.log(`[PASS] runtime-history delivery merged PR #${options.prNumber} with authoritative read-back`);
    return;
  }
  if (result.outcome === 'non-generated-head') {
    console.log(`[PASS] runtime-history delivery exited unattended class: non-generated-head: ${result.reason}`);
    return;
  }
  if (result.outcome === 'close-as-obsolete') {
    console.log(`[PASS] runtime-history delivery closed obsolete PR #${options.prNumber}: ${result.reason}`);
    return;
  }
  throw new Error(`runtime-history delivery ${result.outcome}: ${result.reason}`);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[FAIL] ${error.message}`);
    process.exit(1);
  });
}
