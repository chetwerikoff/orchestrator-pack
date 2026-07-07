/**
 * Pack scripted PR-review post-submit delivery wiring (Issue #669).
 * Vitest: scripts/scripted-review-confirmed-delivery-gate.test.ts
 */
import { normalizeSha } from './review-reconcile-primitives.mjs';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';

export const DEFAULT_SUBMIT_VISIBILITY_MS = 30 * 1000;
export const DEFAULT_SUBMIT_VISIBILITY_INTERVAL_MS = 1000;
export const ENV_SUBMIT_VISIBILITY_SECONDS = 'AO_SCRIPTED_REVIEW_SUBMIT_VISIBILITY_SECONDS';

const TERMINAL_RUN_STATUSES = new Set(['complete', 'delivered', 'failed']);

/**
 * @param {unknown} stdout
 * @returns {{ ok: boolean, reason?: string, packVerdict?: 'clean' | 'findings', gateVerdict?: 'approved' | 'changes_requested' }}
 */
export function parsePackReviewTerminalStdout(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) {
    return { ok: false, reason: 'empty_stdout' };
  }

  /** @type {{ verdict?: string, findingCount?: number, findings?: unknown[] }} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'non_json_stdout' };
  }

  if (parsed.verdict !== 'clean' && parsed.verdict !== 'findings') {
    return { ok: false, reason: 'missing_terminal_verdict' };
  }
  if (typeof parsed.findingCount !== 'number' || !Number.isFinite(parsed.findingCount)) {
    return { ok: false, reason: 'missing_finding_count' };
  }
  if (!Array.isArray(parsed.findings)) {
    return { ok: false, reason: 'missing_findings_array' };
  }

  return {
    ok: true,
    packVerdict: parsed.verdict,
    gateVerdict: parsed.verdict === 'clean' ? 'approved' : 'changes_requested',
  };
}

/**
 * @param {{ prNumber?: number, runId?: string, gateVerdict?: string }} input
 */
export function buildScriptedReviewDeliveryMessage(input) {
  const prNumber = Number(input.prNumber ?? 0);
  const runId = String(input.runId ?? '').trim();
  const gateVerdict = String(input.gateVerdict ?? '').trim();
  if (!prNumber || !runId) {
    return { ok: false, reason: 'missing_pr_or_run' };
  }
  if (gateVerdict === 'approved') {
    return {
      ok: true,
      message: `Review approved for PR #${prNumber} (run ${runId}). Report ready_for_review when CI is green on the current head.`,
    };
  }
  if (gateVerdict === 'changes_requested') {
    return {
      ok: true,
      message: `Review findings for PR #${prNumber} (run ${runId}). Check pending AO review findings, report addressing_reviews, or report terminal failure with a reason.`,
    };
  }
  return { ok: false, reason: 'unsupported_gate_verdict' };
}

/**
 * @param {Array<Record<string, unknown>>} reviewRuns
 * @param {{ prNumber?: number, targetSha?: string }} submit
 */
export function findSubmittedReviewRun(reviewRuns, submit) {
  const prNumber = Number(submit.prNumber ?? 0);
  const targetSha = normalizeSha(submit.targetSha);
  if (!prNumber || !targetSha) {
    return { ok: false, reason: 'missing_pr_or_head' };
  }

  const matches = (Array.isArray(reviewRuns) ? reviewRuns : [])
    .filter((run) => Number(run?.prNumber ?? 0) === prNumber)
    .filter((run) => normalizeSha(run?.targetSha) === targetSha)
    .filter((run) => TERMINAL_RUN_STATUSES.has(String(run?.status ?? run?.latestRunStatus ?? '').trim()))
    .sort((left, right) => String(right?.createdAt ?? right?.updatedAt ?? '').localeCompare(String(left?.createdAt ?? left?.updatedAt ?? '')));

  const run = matches[0];
  if (!run) {
    return { ok: false, reason: 'run_not_visible' };
  }

  const runId = String(run.id ?? run.runId ?? '').trim();
  const sessionId = String(run.linkedSessionId ?? run.sessionId ?? '').trim();
  if (!runId || !sessionId) {
    return { ok: false, reason: 'run_missing_identity' };
  }

  return {
    ok: true,
    runId,
    batchId: String(run.batchId ?? '').trim(),
    sessionId,
    status: String(run.status ?? run.latestRunStatus ?? '').trim(),
  };
}

/**
 * @param {Record<string, string | undefined>} env
 */
export function resolveSubmitVisibilityConfig(env = process.env) {
  const raw = String(env[ENV_SUBMIT_VISIBILITY_SECONDS] ?? '').trim();
  const parsed = Number.parseInt(raw, 10);
  const visibilityMs = Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed * 1000, 120 * 1000)
    : DEFAULT_SUBMIT_VISIBILITY_MS;
  return {
    visibilityMs,
    intervalMs: DEFAULT_SUBMIT_VISIBILITY_INTERVAL_MS,
  };
}

runStdinJsonCli('scripted-review-post-submit-delivery.mjs', {
  'parse-terminal-stdout': () => {
    const payload = readStdinJson();
    return parsePackReviewTerminalStdout(payload.stdout);
  },
  'build-delivery-message': () => buildScriptedReviewDeliveryMessage(readStdinJson()),
  'find-submitted-run': () => {
    const payload = readStdinJson();
    return findSubmittedReviewRun(payload.reviewRuns, payload);
  },
  'resolve-submit-visibility-config': () => {
    const payload = readStdinJson();
    return resolveSubmitVisibilityConfig(payload.env ?? process.env);
  },
});
