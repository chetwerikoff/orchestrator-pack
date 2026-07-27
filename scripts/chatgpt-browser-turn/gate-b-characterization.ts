/**
 * Gate-B live characterization probes for Issue #1024 Half A.
 *
 * Run against the operator's headed automation Chrome profile after connecting
 * over CDP. This script does not send prompts; it only verifies that the supported
 * Chromium/Playwright runtime exposes the observation surfaces required before
 * proven non-delivery may be minted.
 *
 * Usage:
 *   npm run chatgpt-browser-turn -- gate-b-characterization \
 *     --profile /absolute/path/to/profile \
 *     --cdp http://127.0.0.1:9222
 */

export const GATE_B_CHARACTERIZATION_VERSION = 'gate-b-characterization/v1';

export const GATE_B_REQUIRED_PROBES = [
  'service-worker-owned-http-on-configured-context',
  'worker-or-secondary-target-websocket-frame-sent',
] as const;

export type GateBProbeId = (typeof GATE_B_REQUIRED_PROBES)[number];

export interface GateBProbeResult {
  readonly probe: GateBProbeId;
  readonly observed: boolean;
  readonly detail: string;
}

export interface GateBCharacterizationResult {
  readonly schema: typeof GATE_B_CHARACTERIZATION_VERSION;
  readonly observed_at: string;
  readonly probes: readonly GateBProbeResult[];
  readonly complete: boolean;
}

export function summarizeGateBCharacterization(probes: readonly GateBProbeResult[]): GateBCharacterizationResult {
  const complete = GATE_B_REQUIRED_PROBES.every((probe) => probes.some((row) => row.probe === probe && row.observed));
  return {
    schema: GATE_B_CHARACTERIZATION_VERSION,
    observed_at: new Date().toISOString(),
    probes,
    complete,
  };
}

export async function runGateBCharacterization(page: {
  context?: () => {
    on?: (event: string, handler: (request: { url: () => string }) => void) => void;
    newCDPSession?: (target: unknown) => Promise<{
      send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
      on: (event: string, handler: (event: Record<string, unknown>) => void) => void;
    }>;
  };
}): Promise<GateBCharacterizationResult> {
  const probes: GateBProbeResult[] = [];
  const context = page.context?.();
  if (!context) {
    return summarizeGateBCharacterization([
      {
        probe: 'service-worker-owned-http-on-configured-context',
        observed: false,
        detail: 'browser_context_unavailable',
      },
      {
        probe: 'worker-or-secondary-target-websocket-frame-sent',
        observed: false,
        detail: 'browser_context_unavailable',
      },
    ]);
  }

  let serviceWorkerHttpObserved = false;
  if (typeof context.on === 'function') {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      context.on?.('request', (request) => {
        const url = request.url();
        if (/service-worker|sw\.js|backend-api/i.test(url)) {
          serviceWorkerHttpObserved = true;
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }
  probes.push({
    probe: 'service-worker-owned-http-on-configured-context',
    observed: serviceWorkerHttpObserved,
    detail: serviceWorkerHttpObserved ? 'context_request_observed' : 'no_service_worker_http_observed_within_probe_window',
  });

  let websocketSentObserved = false;
  if (typeof context.newCDPSession === 'function') {
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Target.setDiscoverTargets', { discover: true });
      await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      await cdp.send('Network.enable');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        cdp.on('Network.webSocketFrameSent', () => {
          websocketSentObserved = true;
          clearTimeout(timer);
          resolve();
        });
        cdp.on('Target.attachedToTarget', async (event) => {
          const sessionId = String(event.sessionId ?? '');
          if (!sessionId) return;
          const message = JSON.stringify({ id: 1, method: 'Network.enable', params: {} });
          await cdp.send('Target.sendMessageToTarget', { sessionId, message });
          if (event.waitingForDebugger === true) {
            const resume = JSON.stringify({ id: 2, method: 'Runtime.runIfWaitingForDebugger', params: {} });
            await cdp.send('Target.sendMessageToTarget', { sessionId, message: resume });
          }
        });
      });
    } catch {
      websocketSentObserved = false;
    }
  }
  probes.push({
    probe: 'worker-or-secondary-target-websocket-frame-sent',
    observed: websocketSentObserved,
    detail: websocketSentObserved ? 'websocket_frame_sent_observed' : 'no_websocket_frame_sent_observed_within_probe_window',
  });

  return summarizeGateBCharacterization(probes);
}
