/**
 * Harness post-submit [Pn] content-shape validation (Issue #683).
 * Vitest: scripts/harness-post-submit-pn-content-shape.test.ts
 */
import { validateHarnessSubmitBody } from './harness-review-bridge.mjs';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';

export const ENV_CONTENT_SHAPE_DISABLED = 'PACK_HARNESS_PN_CONTENT_SHAPE_DISABLED';
export const DEFAULT_MAX_RETRIGGER_COUNT = 3;

export const CONTENT_SHAPE_ACCEPT = 'accept';
export const CONTENT_SHAPE_REJECT_RETRIGGER = 'reject_retrigger';
export const CONTENT_SHAPE_WAIT_RUNNING = 'wait_running';
export const CONTENT_SHAPE_ROUTE_FAILED = 'route_failed';
export const CONTENT_SHAPE_ESCALATE = 'escalate';

export const TERMINAL_ACCEPT_STATUSES = new Set(['complete', 'delivered']);
export const RUNNING_STATUSES = new Set(['running', 'queued', 'preparing']);

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function evaluateContentShapeKillSwitch(env = process.env) {
  const raw = String(env[ENV_CONTENT_SHAPE_DISABLED] ?? '').trim().toLowerCase();
  const disabled = raw === '1' || raw === 'true' || raw === 'yes';
  return {
    disabled,
    reason: disabled ? 'content_shape_kill_switch' : '',
  };
}

/**
 * @param {unknown} latestRun
 */
export function isHarnessLatestRun(latestRun) {
  return Boolean(String(latestRun?.harness ?? '').trim());
}

/**
 * @param {unknown} status
 */
export function normalizeHarnessRunStatus(status) {
  return String(status ?? '').trim().toLowerCase();
}

/**
 * @param {unknown} latestRun
 */
export function evaluateHarnessLatestRunContentShape(latestRun) {
  const status = normalizeHarnessRunStatus(latestRun?.status);

  if (RUNNING_STATUSES.has(status)) {
    return { action: CONTENT_SHAPE_WAIT_RUNNING, reason: 'run_still_in_flight', status };
  }

  if (status === 'failed') {
    return { action: CONTENT_SHAPE_ROUTE_FAILED, reason: 'terminal_failed', status };
  }

  if (!TERMINAL_ACCEPT_STATUSES.has(status)) {
    return { action: CONTENT_SHAPE_ESCALATE, reason: 'unreadable_terminal_status', status };
  }

  const body = String(latestRun?.body ?? '').trim();
  if (!body || /^lgtm$/i.test(body)) {
    return { action: CONTENT_SHAPE_REJECT_RETRIGGER, reason: 'empty_or_lgtm_non_clean', status };
  }

  const validation = validateHarnessSubmitBody(body);
  if (validation.ok) {
    const runVerdict = String(latestRun?.verdict ?? '').trim().toLowerCase();
    const payloadVerdict = String(validation.payload?.verdict ?? '').trim().toLowerCase();
    if (runVerdict === 'approved' && payloadVerdict === 'findings') {
      return {
        action: CONTENT_SHAPE_ESCALATE,
        reason: 'approved_run_with_findings_payload',
        status,
      };
    }
    if (runVerdict === 'changes_requested' && payloadVerdict === 'clean') {
      return {
        action: CONTENT_SHAPE_ESCALATE,
        reason: 'changes_requested_run_with_clean_payload',
        status,
      };
    }
    return {
      action: CONTENT_SHAPE_ACCEPT,
      reason: 'content_valid',
      status,
      payload: validation.payload,
    };
  }

  return {
    action: CONTENT_SHAPE_REJECT_RETRIGGER,
    reason: validation.reason ?? 'invalid_content',
    status,
  };
}

/**
 * Content-shape stage on a polled latestRun snapshot (no independent poll).
 *
 * @param {object} input
 * @param {unknown} [input.latestRun]
 * @param {boolean} [input.attributionOk]
 * @param {string} [input.attributionReason]
 * @param {number} [input.retriggerCount]
 * @param {number} [input.maxRetriggerCount]
 * @param {boolean} [input.contentShapeEnabled]
 */
export function evaluateHarnessContentShapeStage(input) {
  if (input.contentShapeEnabled === false) {
    return { action: CONTENT_SHAPE_ACCEPT, reason: 'content_shape_disabled', skipped: true };
  }

  const killSwitch = evaluateContentShapeKillSwitch();
  if (killSwitch.disabled) {
    return { action: CONTENT_SHAPE_ESCALATE, reason: killSwitch.reason };
  }

  if (!input.attributionOk) {
    return {
      action: CONTENT_SHAPE_ESCALATE,
      reason: input.attributionReason ?? 'ambiguous_attribution',
    };
  }

  const latestRun = input.latestRun;
  if (!latestRun || typeof latestRun !== 'object') {
    return { action: CONTENT_SHAPE_ESCALATE, reason: 'missing_latest_run' };
  }

  const shape = evaluateHarnessLatestRunContentShape(latestRun);
  if (shape.action === CONTENT_SHAPE_REJECT_RETRIGGER) {
    const max = Number(input.maxRetriggerCount ?? DEFAULT_MAX_RETRIGGER_COUNT);
    const count = Number(input.retriggerCount ?? 0);
    if (count >= max) {
      return {
        action: CONTENT_SHAPE_ESCALATE,
        reason: 'retrigger_bound_exhausted',
        retriggerCount: count,
        maxRetriggerCount: max,
        priorReason: shape.reason,
      };
    }
    return {
      ...shape,
      retriggerCount: count,
      maxRetriggerCount: max,
      needsSupersede: normalizeHarnessRunStatus(latestRun.status) === 'delivered',
    };
  }

  return shape;
}

/**
 * Map content-shape stage outcome to gate terminal action for harness reconcile.
 *
 * @param {{ action?: string, reason?: string }} contentShape
 */
export function mapContentShapeToGateTerminal(contentShape) {
  const action = String(contentShape?.action ?? '').trim();
  if (action === CONTENT_SHAPE_ACCEPT) {
    return { action: null, reason: 'content_valid_continue_delivery' };
  }
  if (action === CONTENT_SHAPE_WAIT_RUNNING) {
    return { action: null, reason: contentShape.reason ?? 'wait_running' };
  }
  if (action === CONTENT_SHAPE_REJECT_RETRIGGER) {
    return { action: 'reject_retrigger', reason: contentShape.reason ?? 'invalid_content' };
  }
  if (action === CONTENT_SHAPE_ROUTE_FAILED) {
    return { action: 'escalate', reason: contentShape.reason ?? 'terminal_failed' };
  }
  return { action: 'escalate', reason: contentShape.reason ?? 'content_shape_escalate' };
}

/**
 * Whether the polled snapshot should run harness content-shape validation.
 *
 * @param {object} input
 * @param {{ latestRun?: unknown } | null | undefined} attribution
 */
export function shouldRunHarnessContentShapeStage(input, attribution) {
  if (input.harnessContentShape === false) {
    return false;
  }
  if (input.harnessContentShape === true) {
    return true;
  }
  return isHarnessLatestRun(attribution?.latestRun);
}

runStdinJsonCli('harness-post-submit-pn-content-shape.mjs', {
  'evaluate-stage': () => evaluateHarnessContentShapeStage(readStdinJson()),
  'evaluate-latest-run': () => evaluateHarnessLatestRunContentShape(readStdinJson().latestRun),
  'map-terminal': () => mapContentShapeToGateTerminal(readStdinJson()),
  'should-run': () => {
    const payload = readStdinJson();
    return { ok: shouldRunHarnessContentShapeStage(payload.input ?? {}, payload.attribution) };
  },
});
