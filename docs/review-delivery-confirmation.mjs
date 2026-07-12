/** Shared review-delivery confirmation planner; not a supervised child entrypoint. */
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';
import {
  DEFAULT_TICK_INTERVAL_MS,
  evaluateDeliveryTickInterval,
  pendingDeliveredRunsLackReportReceiptSurface,
} from './review-delivery-confirmation-core.mjs';
import { planDeliveryConfirmActions } from './review-delivery-confirmation-plan.mjs';

export * from './review-delivery-confirmation-core.mjs';
export * from './review-delivery-confirmation-plan.mjs';

runStdinJsonCli('review-delivery-confirmation.mjs', {
  plan: () => {
    const payload = readStdinJson();
    return planDeliveryConfirmActions({
      reviewRuns: payload.reviewRuns,
      sessions: payload.sessions,
      openPrs: payload.openPrs,
      tracking: payload.tracking ?? { runs: {} },
      nowMs: Number(payload.nowMs) || Date.now(),
      config: payload.config ?? {},
    });
  },
  interval: () => {
    const payload = readStdinJson();
    return evaluateDeliveryTickInterval({
      nowMs: Number(payload.nowMs) || Date.now(),
      lastTickMs: payload.lastTickMs,
      intervalMs: Number(payload.intervalMs) || DEFAULT_TICK_INTERVAL_MS,
    });
  },
  pendingReportReceiptDescope: () => {
    const payload = readStdinJson();
    return {
      descope: pendingDeliveredRunsLackReportReceiptSurface(
        payload.reviewRuns,
        payload.sessions,
      ),
    };
  },
});
