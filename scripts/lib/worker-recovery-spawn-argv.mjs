/**
 * Worker recovery AO 0.10.2 spawn argv builders (Issues #638, #652).
 * Vitest: scripts/worker-recovery-spawn-argv.test.ts
 */
import { asRecord, runAsyncStdinJsonSubcommandCli } from '../../docs/review-mechanical-cli.mjs';

export const RECOVERY_SPAWN_DISPLAY_NAME_PREFIX = 'wr-';
export const RECOVERY_SPAWN_DISPLAY_NAME_MAX_LENGTH = 20;

/**
 * @param {object} input
 */
export function deriveRecoverySpawnDisplayName(input) {
  const action = String(input.spawnAction ?? '');
  if (action === 'claim-pr-resume') {
    const pr = Number.parseInt(String(input.prNumber ?? ''), 10);
    if (!Number.isFinite(pr) || pr <= 0) {
      return { ok: false, reason: 'missing_pr_number' };
    }
    const name = `${RECOVERY_SPAWN_DISPLAY_NAME_PREFIX}pr${pr}`;
    if (name.length > RECOVERY_SPAWN_DISPLAY_NAME_MAX_LENGTH) {
      return { ok: false, reason: 'display_name_too_long' };
    }
    return { ok: true, name };
  }
  if (action === 'spawn-new') {
    const issue = Number.parseInt(String(input.issueNumber ?? ''), 10);
    if (!Number.isFinite(issue) || issue <= 0) {
      return { ok: false, reason: 'missing_issue_number' };
    }
    const name = `${RECOVERY_SPAWN_DISPLAY_NAME_PREFIX}i${issue}`;
    if (name.length > RECOVERY_SPAWN_DISPLAY_NAME_MAX_LENGTH) {
      return { ok: false, reason: 'display_name_too_long' };
    }
    return { ok: true, name };
  }
  return { ok: false, reason: 'unknown_spawn_action' };
}

/**
 * @param {object} input
 */
export function resolveRecoverySpawnProjectId(input) {
  const record = asRecord(input.worktreeRecord);
  if (record?.projectId && String(record.projectId).trim()) {
    return { ok: true, projectId: String(record.projectId).trim() };
  }
  const aoRow = asRecord(input.aoSessionRow);
  if (aoRow?.projectId && String(aoRow.projectId).trim()) {
    return { ok: true, projectId: String(aoRow.projectId).trim() };
  }
  const fallback = String(input.fallbackProjectId ?? '').trim();
  if (fallback) {
    return { ok: true, projectId: fallback };
  }
  return { ok: false, reason: 'missing_project_id' };
}

/**
 * @param {string} raw
 */
function parseStrictPositiveIssueValue(raw) {
  const value = String(raw).trim();
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Non-empty recovery task text delivered via AO `--prompt` (Issue #652).
 *
 * @param {object} input
 */
export function buildRecoverySpawnPrompt(input) {
  const action = String(input.spawnAction ?? '');
  if (action === 'spawn-new') {
    const issue = parseStrictPositiveIssueValue(input.issueNumber);
    if (issue === null) {
      return { ok: false, reason: 'missing_issue_number' };
    }
    return {
      ok: true,
      prompt:
        `Implement GitHub issue #${issue}: read the issue body and prerequisites. `
        + 'Continue the task and open a PR when ready.',
    };
  }
  if (action === 'claim-pr-resume') {
    const pr = Number.parseInt(String(input.prNumber ?? ''), 10);
    if (!Number.isFinite(pr) || pr <= 0) {
      return { ok: false, reason: 'missing_pr_number' };
    }
    const issue = parseStrictPositiveIssueValue(input.issueNumber);
    const issueClause =
      issue === null ? '' : ` Read GitHub issue #${issue} (body and prerequisites) as well.`;
    return {
      ok: true,
      prompt:
        `Resume work on PR #${pr}:${issueClause} Continue implementation and keep the PR ready for review.`,
    };
  }
  return { ok: false, reason: 'unknown_spawn_action' };
}

/**
 * @param {object} input
 */
export function buildRecoverySpawnArgv(input) {
  const action = String(input.spawnAction ?? '');
  const projectId = String(input.projectId ?? '').trim();
  if (!projectId) {
    return { ok: false, reason: 'missing_project_id' };
  }
  const nameResult = deriveRecoverySpawnDisplayName(input);
  if (!nameResult.ok) {
    return { ok: false, reason: nameResult.reason };
  }
  const promptResult = buildRecoverySpawnPrompt({
    spawnAction: action,
    issueNumber: input.issueNumber,
    prNumber: input.prNumber,
  });
  if (!promptResult.ok) {
    return { ok: false, reason: promptResult.reason };
  }

  const argv = ['spawn'];
  if (action === 'claim-pr-resume') {
    const pr = Number.parseInt(String(input.prNumber ?? ''), 10);
    if (!Number.isFinite(pr) || pr <= 0) {
      return { ok: false, reason: 'missing_pr_number' };
    }
    argv.push(
      '--project',
      projectId,
      '--name',
      nameResult.name,
      '--claim-pr',
      String(pr),
      '--no-takeover',
      '--prompt',
      promptResult.prompt,
    );
  }
  else if (action === 'spawn-new') {
    const issue = parseStrictPositiveIssueValue(input.issueNumber);
    if (issue === null) {
      return { ok: false, reason: 'missing_issue_number' };
    }
    const issueToken = String(issue);
    argv.push(
      '--project',
      projectId,
      '--name',
      nameResult.name,
      '--issue',
      issueToken,
      '--prompt',
      promptResult.prompt,
    );
  }
  else {
    return { ok: false, reason: 'unknown_spawn_action' };
  }
  return { ok: true, argv, displayName: nameResult.name, projectId, prompt: promptResult.prompt };
}

/**
 * @param {object} input
 */
export function classifyRecoverySpawnExit(input) {
  const exitCode = Number(input.exitCode ?? 1);
  const action = String(input.spawnAction ?? '');
  if (exitCode === 0) {
    return { ok: true, reason: 'spawn_started', defer: false };
  }
  const combined = `${input.stdout ?? ''}${input.stderr ?? ''}`.toLowerCase();
  if (action === 'claim-pr-resume') {
    const takeoverRefusal =
      combined.includes('no-takeover')
      || combined.includes('no takeover')
      || /\banother\s+active\s+session\b/.test(combined)
      || /\balready\s+owns?\b/.test(combined)
      || /\brefus\w*\b.*\btakeover\b/.test(combined);
    if (takeoverRefusal) {
      return { ok: false, reason: 'claim_pr_active_owner_refused', defer: true };
    }
  }
  return { ok: false, reason: `spawn_exit_${exitCode}`, defer: false };
}

/**
 * @param {object} payload
 */
function handleCliSubcommand(subcommand, payload) {
  switch (subcommand) {
    case 'deriveRecoverySpawnDisplayName':
      return deriveRecoverySpawnDisplayName(payload);
    case 'resolveRecoverySpawnProjectId':
      return resolveRecoverySpawnProjectId(payload);
    case 'buildRecoverySpawnPrompt':
      return buildRecoverySpawnPrompt(payload);
    case 'buildRecoverySpawnArgv':
      return buildRecoverySpawnArgv(payload);
    case 'classifyRecoverySpawnExit':
      return classifyRecoverySpawnExit(payload);
    default:
      return { ok: false, reason: 'unknown_subcommand' };
  }
}

runAsyncStdinJsonSubcommandCli('worker-recovery-spawn-argv.mjs', handleCliSubcommand);
