/**
 * Read-only diagnostic for undelivered changes_requested results and stuck open
 * findings. The pack review producer/store is the only active authority.
 * Vitest: scripts/review-bulk-send-diagnose.test.ts
 */
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';
import { isDeliveredChangesRequested, isUndeliveredChangesRequested } from './review-producer-contract.mjs';

export const ACTIONABLE_REVIEW_STATUSES = ['changes_requested'];

export const GATE0_CAPABILITIES = {
  selectiveSend: false,
  terminalNonForward: false,
  priorSentAtRouting: false,
};

export const TRACKING = {
  packIssue: 'https://github.com/chetwerikoff/orchestrator-pack/issues/140',
  authority: 'pack-review-producer-contract',
};

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {unknown} payload
 * @returns {Array<Record<string, unknown>>}
 */
export function normalizeReviewRuns(payload) {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload.runs)) return payload.runs;
  if (isRecord(payload) && Array.isArray(payload.data)) return payload.data;
  return [];
}

/** @param {Record<string, unknown>} run */
export function classifyBulkSendRun(run) {
  const status = String(run?.prReviewStatus ?? run?.status ?? '').toLowerCase();
  const open = toCount(run.openFindingCount);
  const delivered = toCount(run.deliveredFindingCount);
  const findingCount = toCount(run.findingCount);
  const undelivered = isUndeliveredChangesRequested(run);
  const deliveredChanges = isDeliveredChangesRequested(run);

  /** @type {Array<{ kind: string, detail: string }>} */
  const signals = [];

  if (ACTIONABLE_REVIEW_STATUSES.includes(status) && undelivered && open > 0) {
    signals.push({
      kind: 'undelivered_changes_requested',
      detail:
        'changes_requested without deliveredAt: open findings are not yet confirmed as delivered by the pack producer.',
    });
  }

  if (deliveredChanges && delivered > 0 && open > 0) {
    signals.push({
      kind: 'stuck_open',
      detail:
        'Partial delivery: deliveredFindingCount > 0 but openFindingCount remains > 0.',
    });
  }

  if (undelivered && open > 0 && delivered === 0 && findingCount > 1) {
    signals.push({
      kind: 'multi_open_awaiting_dispatch',
      detail: 'Multiple open findings await the pack-owned publication path.',
    });
  }

  return {
    runId: typeof run.id === 'string' ? run.id : '',
    status,
    openFindingCount: open,
    deliveredFindingCount: delivered,
    findingCount,
    prNumber: run.prNumber ?? null,
    linkedSessionId: run.linkedSessionId ?? null,
    signals,
    flagged: signals.length > 0,
  };
}

/**
 * @param {object} input
 * @param {unknown} input.runs
 * @param {string} [input.projectId]
 */
export function diagnoseBulkSendBlock(input = {}) {
  let runs = normalizeReviewRuns(input.runs ?? input);
  const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
  if (projectId) {
    runs = runs.filter((run) => isRecord(run) && run.projectId === projectId);
  }

  const classified = runs
    .filter(isRecord)
    .map((run) => classifyBulkSendRun(run))
    .filter((entry) => entry.flagged);

  return {
    readOnly: true,
    gate0: {
      producerContractNote:
        'Validated against pack review status, verdict, deliveredAt, and deliveredFindingCount fields.',
      capabilities: { ...GATE0_CAPABILITIES },
      verdict:
        'Per-finding routing remains unavailable until the pack contract explicitly adds selective send and terminal non-forward behavior.',
    },
    tracking: { ...TRACKING },
    summary: {
      totalRuns: runs.length,
      flaggedRuns: classified.length,
      signalKinds: [...new Set(classified.flatMap((entry) => entry.signals.map((signal) => signal.kind)))],
    },
    flaggedRuns: classified,
  };
}

runStdinJsonCli('review-bulk-send-diagnose.mjs', {
  diagnose() {
    return diagnoseBulkSendBlock(readStdinJson());
  },
});
