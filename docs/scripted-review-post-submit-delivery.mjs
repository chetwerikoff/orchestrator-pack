/**
 * Pack scripted PR-review post-submit delivery wiring (Issue #669).
 * Vitest: scripts/scripted-review-confirmed-delivery-gate.test.ts
 */
import { normalizeSha } from './review-reconcile-primitives.mjs';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';

export const DEFAULT_SUBMIT_VISIBILITY_MS = 30 * 1000;
export const DEFAULT_SUBMIT_VISIBILITY_INTERVAL_MS = 1000;
export const ENV_SUBMIT_VISIBILITY_SECONDS = 'AO_SCRIPTED_REVIEW_SUBMIT_VISIBILITY_SECONDS';
export const SUBMIT_BIND_TERMINAL_STATUSES = new Set(['complete', 'failed', 'delivered']);
export const SUBMIT_BIND_LOOKBACK_MS = 15 * 1000;

/**
 * Terminal status for submit visibility — prefer latestRunStatus (daemon run row)
 * over status (PR review state such as changes_requested).
 * @param {Record<string, unknown> | undefined | null} run
 */
export function resolveSubmittedRunTerminalStatus(run) {
  const latest = String(run?.latestRunStatus ?? '').trim();
  if (latest) {
    return latest;
  }
  return String(run?.status ?? '').trim();
}

/**
 * @param {string | undefined} iso
 */
export function parseSubmitRunIsoMs(iso) {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(String(iso));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Bind epoch for submit lookback/sort — prefer completion time over creation time so
 * runs that finish >15s after row creation still bind within submitObservedAfterMs lookback.
 * @param {Record<string, unknown> | undefined | null} run
 */
export function resolveSubmitRunEpochMs(run) {
  return (
    parseSubmitRunIsoMs(run?.updatedAt) ??
    parseSubmitRunIsoMs(run?.submittedAt) ??
    parseSubmitRunIsoMs(run?.completedAt) ??
    parseSubmitRunIsoMs(run?.completedAtUtc) ??
    parseSubmitRunIsoMs(run?.startedAt) ??
    parseSubmitRunIsoMs(run?.createdAt) ??
    null
  );
}

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
 * Bind the review run created by the just-finished ao review submit.
 * Accepts complete, failed, and delivered terminal rows; stale same-head rows from
 * earlier cycles are excluded by submitObservedAfterMs lookback.
 *
 * @param {Array<Record<string, unknown>>} reviewRuns
 * @param {{ prNumber?: number, targetSha?: string, submitObservedAfterMs?: number }} submit
 */
export function findSubmittedReviewRun(reviewRuns, submit) {
  const prNumber = Number(submit.prNumber ?? 0);
  const targetSha = normalizeSha(submit.targetSha);
  const submitObservedAfterMs = Number(submit.submitObservedAfterMs ?? 0);
  if (!prNumber || !targetSha) {
    return { ok: false, reason: 'missing_pr_or_head' };
  }

  const matches = (Array.isArray(reviewRuns) ? reviewRuns : [])
    .filter((run) => Number(run?.prNumber ?? 0) === prNumber)
    .filter((run) => normalizeSha(run?.targetSha) === targetSha)
    .filter((run) => SUBMIT_BIND_TERMINAL_STATUSES.has(resolveSubmittedRunTerminalStatus(run)))
    .filter((run) => {
      if (!submitObservedAfterMs) {
        return true;
      }
      const epochMs = resolveSubmitRunEpochMs(run);
      if (epochMs === null) {
        return false;
      }
      return epochMs >= submitObservedAfterMs - SUBMIT_BIND_LOOKBACK_MS;
    })
    .sort((left, right) => {
      const leftMs = resolveSubmitRunEpochMs(left) ?? 0;
      const rightMs = resolveSubmitRunEpochMs(right) ?? 0;
      if (rightMs !== leftMs) {
        return rightMs - leftMs;
      }
      return String(right?.id ?? right?.runId ?? '').localeCompare(String(left?.id ?? left?.runId ?? ''));
    });

  if (matches.length > 1) {
    return { ok: false, reason: 'ambiguous_overlapping_submits', matchCount: matches.length };
  }

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
    status: resolveSubmittedRunTerminalStatus(run),
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
