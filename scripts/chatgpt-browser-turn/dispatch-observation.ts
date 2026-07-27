import {
  DRIVER_DIAGNOSTIC_SCHEMA,
  DRIVER_DIAGNOSTIC_VERSION,
  mirrorDriverDiagnosticToStderr,
} from './diagnostics.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson, profileDirs } from './storage-common.ts';

export type DispatchCoverageStatus = 'complete' | 'incomplete' | 'unknown';

export interface DispatchObservationTestControls {
  readonly establishmentFails?: boolean;
  readonly httpContextCoverage?: DispatchCoverageStatus;
  readonly websocketTargetsCoverage?: DispatchCoverageStatus;
  readonly requireCdpWebSocketSent?: boolean;
  readonly incompleteWebSocketTargets?: boolean;
  readonly initialCoverageIntact?: boolean;
  readonly coverageLossAfterArm?: boolean;
  readonly cdpMethodsSupported?: {
    readonly setAutoAttach?: boolean;
    readonly setDiscoverTargets?: boolean;
    readonly getTargets?: boolean;
    readonly attachToTarget?: boolean;
    readonly sendMessageToTarget?: boolean;
    readonly networkEnable?: boolean;
    readonly webSocketFrameSent?: boolean;
    readonly targetAttached?: boolean;
    readonly targetDetached?: boolean;
    readonly runIfWaitingForDebugger?: boolean;
    readonly targetCreated?: boolean;
  };
}

export interface DispatchObservationDiagnostic {
  readonly http_context_armed: boolean;
  readonly websocket_targets_armed: boolean;
  readonly post_arm_http_request_count: number;
  readonly post_arm_websocket_frame_sent_count: number;
  readonly coverage_summary: string;
  readonly submitted_turn_window_exhausted: boolean;
  readonly user_node_delta: number;
  readonly new_chat_url_changed: boolean | 'na';
}

export interface DispatchObservationBoundary {
  dispatchObservationEngaged: boolean;
  gateBCharacterizationComplete: boolean;
  httpContextArmed: boolean;
  httpContextCoverage: DispatchCoverageStatus;
  websocketTargetsArmed: boolean;
  websocketTargetsCoverage: DispatchCoverageStatus;
  postArmHttpRequestCount: number;
  postArmWebSocketFrameSentCount: number;
  coverageIntact: boolean;
  preDispatchUserNodeCount: number;
  preDispatchNormalizedUrl: string;
  userNodeBaselineReliable: boolean;
  urlBaselineReliable: boolean;
  newChatMode: boolean;
  armDispatchObservation(): void;
  markCoverageLost(): void;
}

export class DispatchObservationEstablishmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchObservationEstablishmentError';
  }
}

export let lastDispatchObservationDiagnostic: DispatchObservationDiagnostic | undefined;


function attachCdpOutboundWebSocketObserver(
  cdp: { on: (event: string, handler: (...args: any[]) => void) => void },
  noteWsSent: () => void,
): void {
  const record = () => noteWsSent();
  cdp.on('Network.webSocketFrameSent', record);
  cdp.on('event', (payload: { method?: string }) => {
    if (payload?.method === 'Network.webSocketFrameSent') record();
  });
}




export const GATE_B_CHARACTERIZATION_VERSION = 'gate-b-characterization/v1';

export const GATE_B_PROBE_WINDOW_MS = 30_000;

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
  reload?: (options?: { waitUntil?: string }) => Promise<unknown>;
  context?: () => {
    on?: (event: string, handler: (request: { url: () => string }) => void) => void;
    pages?: () => unknown[];
    serviceWorkers?: () => unknown[];
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
  let contextHttpObserved = false;
  let websocketSentObserved = false;
  let serviceWorkerHttpDetail = 'no_service_worker_http_observed_within_probe_window';
  const noteServiceWorkerHttp = (detail = 'context_request_observed') => {
    serviceWorkerHttpObserved = true;
    serviceWorkerHttpDetail = detail;
  };
  const noteWebSocketSent = () => {
    websocketSentObserved = true;
  };
  const serviceWorkerCount = typeof context.serviceWorkers === 'function' ? context.serviceWorkers().length : 0;

  if (typeof context.on === 'function') {
    context.on('request', (request: { url: () => string; serviceWorker?: () => unknown | null }) => {
      contextHttpObserved = true;
      if (typeof request.serviceWorker === 'function' && request.serviceWorker()) {
        noteServiceWorkerHttp();
      }
    });
  }

  const observedCdpTargets = new WeakSet<object>();
  const attachGateBWebSocketObservers = async (): Promise<void> => {
    if (typeof context.newCDPSession !== 'function') return;
    const targets: unknown[] = [page];
    if (typeof context.pages === 'function') {
      for (const otherPage of context.pages()) targets.push(otherPage);
    }
    if (typeof context.serviceWorkers === 'function') {
      targets.push(...context.serviceWorkers());
    }
    for (const target of targets) {
      if (typeof target !== 'object' || target === null || observedCdpTargets.has(target)) continue;
      observedCdpTargets.add(target);
      try {
        const session = await context.newCDPSession(target);
        await session.send('Network.enable');
        attachCdpOutboundWebSocketObserver(session, noteWebSocketSent);
      } catch {
        // Individual target attach failures are non-fatal for characterization.
      }
    }
  };

  if (typeof context.newCDPSession === 'function') {
    try {
      await attachGateBWebSocketObservers();
      if (typeof context.on === 'function') {
        context.on('page', () => { void attachGateBWebSocketObservers(); });
        context.on('serviceworker', () => { void attachGateBWebSocketObservers(); });
      }
    } catch {
      websocketSentObserved = false;
    }
  }

  if (typeof page.reload === 'function') {
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
    } catch {
      // Passive observation may still succeed on an already-active ChatGPT surface.
    }
  }

  const deadline = Date.now() + GATE_B_PROBE_WINDOW_MS;
  while (Date.now() < deadline) {
    if (serviceWorkerHttpObserved && websocketSentObserved) break;
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }

  if (!serviceWorkerHttpObserved && serviceWorkerCount > 0 && contextHttpObserved && typeof context.newCDPSession === 'function') {
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Target.setDiscoverTargets', { discover: true });
      await cdp.send('Network.enable');
      let cdpServiceWorkerHttpObserved = false;
      const noteCdpServiceWorkerHttp = () => {
        cdpServiceWorkerHttpObserved = true;
      };
      cdp.on('Network.requestWillBeSent', noteCdpServiceWorkerHttp);
      cdp.on('event', (payload: { method?: string }) => {
        if (payload?.method === 'Network.requestWillBeSent') noteCdpServiceWorkerHttp();
      });
      const targets = await cdp.send('Target.getTargets') as { targetInfos?: Array<{ targetId?: string; type?: string }> };
      const serviceWorkerTarget = (targets.targetInfos ?? []).find((row) => row.type === 'service_worker' && row.targetId);
      if (serviceWorkerTarget?.targetId) {
        const attached = await cdp.send('Target.attachToTarget', {
          targetId: serviceWorkerTarget.targetId,
          flatten: true,
        }) as { sessionId?: string };
        const sessionId = String(attached.sessionId ?? '');
        if (sessionId) {
          const flatCdp = cdp as FlatCdpSessionSend;
          await sendFlatChildCdpCommand(flatCdp, sessionId, 'Network.enable');
          await sendFlatChildCdpCommand(flatCdp, sessionId, 'Runtime.enable');
          await sendFlatChildCdpCommand(flatCdp, sessionId, 'Runtime.evaluate', {
            expression: "(async () => { await fetch('https://chatgpt.com/favicon.ico', { mode: 'no-cors' }); })()",
            awaitPromise: true,
          });
          const stimulusDeadline = Date.now() + 5_000;
          while (Date.now() < stimulusDeadline && !cdpServiceWorkerHttpObserved) {
            await new Promise((resolve) => { setTimeout(resolve, 100); });
          }
          if (cdpServiceWorkerHttpObserved) {
            noteServiceWorkerHttp('context_http_and_service_worker_cdp_network_observed');
          }
        }
      }
    } catch {
      // Stimulus failure is non-fatal; incomplete characterization remains fail-closed.
    }
  }

  probes.push({
    probe: 'service-worker-owned-http-on-configured-context',
    observed: serviceWorkerHttpObserved,
    detail: serviceWorkerHttpDetail,
  });
  probes.push({
    probe: 'worker-or-secondary-target-websocket-frame-sent',
    observed: websocketSentObserved,
    detail: websocketSentObserved ? 'websocket_frame_sent_observed' : 'no_websocket_frame_sent_observed_within_probe_window',
  });

  return summarizeGateBCharacterization(probes);
}


export function gateBCharacterizationRecordPath(profileKey: string): string {
  return join(profileDirs(profileKey).root, 'gate-b-characterization.json');
}

export function readGateBCharacterizationRecord(profileKey: string): GateBCharacterizationResult | null {
  const path = gateBCharacterizationRecordPath(profileKey);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as GateBCharacterizationResult;
    return parsed?.schema === GATE_B_CHARACTERIZATION_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

export function writeGateBCharacterizationRecord(profileKey: string, result: GateBCharacterizationResult): void {
  atomicJson(gateBCharacterizationRecordPath(profileKey), result);
}

const RELEVANT_TARGET_TYPES = new Set([
  'page',
  'service_worker',
  'worker',
  'shared_worker',
  'iframe',
]);

function coverageSummary(boundary: DispatchObservationBoundary): string {
  const http = boundary.httpContextCoverage;
  const ws = boundary.websocketTargetsCoverage;
  const intact = boundary.coverageIntact ? 'intact' : 'lost';
  return `http-context:${http};websocket-targets:${ws};${intact}`;
}

export function formatDispatchObservationDiagnostic(
  boundary: DispatchObservationBoundary,
  userNodeDelta: number,
  newChatUrlChanged: boolean | 'na',
  windowExhausted: boolean,
): DispatchObservationDiagnostic {
  return {
    http_context_armed: boundary.httpContextArmed,
    websocket_targets_armed: boundary.websocketTargetsArmed,
    post_arm_http_request_count: boundary.postArmHttpRequestCount,
    post_arm_websocket_frame_sent_count: boundary.postArmWebSocketFrameSentCount,
    coverage_summary: coverageSummary(boundary),
    submitted_turn_window_exhausted: windowExhausted,
    user_node_delta: userNodeDelta,
    new_chat_url_changed: newChatUrlChanged,
  };
}

export function recordDispatchObservationDiagnostic(
  diagnostic: DispatchObservationDiagnostic,
  cause: string,
): void {
  lastDispatchObservationDiagnostic = diagnostic;
  try {
    mirrorDriverDiagnosticToStderr({
      schema: DRIVER_DIAGNOSTIC_SCHEMA,
      version: DRIVER_DIAGNOSTIC_VERSION,
      configured_profile_key: 'profile-unresolved',
      cause,
      exception_name: 'DispatchObservationSummary',
      exception_message: '',
      exception_stack: '',
      created_at: new Date().toISOString(),
      operation: JSON.stringify(diagnostic),
    });
  } catch {
    // Diagnostic mirroring is best-effort and must not change the terminal result.
  }
}

function testControls(page: unknown): DispatchObservationTestControls | undefined {
  return (page as { __dispatchObservation?: DispatchObservationTestControls }).__dispatchObservation;
}

function isFakeTurnPage(page: unknown): boolean {
  return (page as { __fakeTurnPage?: boolean }).__fakeTurnPage === true;
}

function isRelevantTargetType(type: string | undefined): boolean {
  return type !== undefined && RELEVANT_TARGET_TYPES.has(type);
}


type FlatCdpSessionSend = {
  send: (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => Promise<unknown>;
};

async function sendFlatChildCdpCommand(
  cdp: FlatCdpSessionSend,
  sessionId: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return cdp.send(method, params, sessionId);
}

async function sendChildCdpCommand(
  cdp: { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> },
  sessionId: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<void> {
  const message = JSON.stringify({ id: 1, method, params });
  await cdp.send('Target.sendMessageToTarget', { sessionId, message });
}

export function dispatchObservationEstablished(boundary: DispatchObservationBoundary): boolean {
  return boundary.coverageIntact
    && boundary.httpContextArmed
    && boundary.httpContextCoverage === 'complete'
    && boundary.websocketTargetsArmed
    && boundary.websocketTargetsCoverage === 'complete';
}

export function dispatchObservationCoverageComplete(boundary: DispatchObservationBoundary): boolean {
  return dispatchObservationEstablished(boundary)
    && boundary.gateBCharacterizationComplete;
}

export function assertDispatchObservationReadyForDispatch(boundary: DispatchObservationBoundary): void {
  if (!boundary.dispatchObservationEngaged) return;
  if (!dispatchObservationEstablished(boundary)) {
    throw new DispatchObservationEstablishmentError('dispatch_observation_establishment_failed');
  }
}

export async function establishDispatchObservationBoundary(
  page: any,
  options: {
    newChatMode: boolean;
    preDispatchUserNodeCount: number;
    preDispatchNormalizedUrl: string;
    userNodeBaselineReliable: boolean;
    urlBaselineReliable: boolean;
    profileKey?: string;
  },
): Promise<DispatchObservationBoundary> {
  const controls = testControls(page);
  const fakePage = isFakeTurnPage(page);
  if (controls?.establishmentFails) {
    throw new DispatchObservationEstablishmentError('dispatch_observation_establishment_failed');
  }

  let armed = false;
  let cdpEstablished = false;
  const boundary: DispatchObservationBoundary = {
    dispatchObservationEngaged: false,
    gateBCharacterizationComplete: false,
    httpContextArmed: false,
    httpContextCoverage: 'unknown',
    websocketTargetsArmed: false,
    websocketTargetsCoverage: 'unknown',
    postArmHttpRequestCount: 0,
    postArmWebSocketFrameSentCount: 0,
    coverageIntact: controls?.initialCoverageIntact !== false,
    preDispatchUserNodeCount: options.preDispatchUserNodeCount,
    preDispatchNormalizedUrl: options.preDispatchNormalizedUrl,
    userNodeBaselineReliable: options.userNodeBaselineReliable,
    urlBaselineReliable: options.urlBaselineReliable,
    newChatMode: options.newChatMode,
    armDispatchObservation() {
      armed = true;
      if (fakePage && controls?.coverageLossAfterArm) {
        boundary.markCoverageLost();
      }
    },
    markCoverageLost() { this.coverageIntact = false; },
  };

  const context = page.context?.();
  if (!context) {
    throw new DispatchObservationEstablishmentError('dispatch_observation_context_unavailable');
  }

  try {
    if (typeof context.on !== 'function') {
      boundary.httpContextCoverage = fakePage && controls?.httpContextCoverage
        ? controls.httpContextCoverage
        : 'unknown';
    } else {
      context.on('request', () => {
        if (!armed) return;
        boundary.postArmHttpRequestCount++;
      });
      boundary.httpContextArmed = true;
      boundary.httpContextCoverage = fakePage && controls?.httpContextCoverage
        ? controls.httpContextCoverage
        : 'complete';
    }
  } catch {
    throw new DispatchObservationEstablishmentError('dispatch_observation_http_failed');
  }

  const noteWsSent = () => {
    if (!armed) return;
    boundary.postArmWebSocketFrameSentCount++;
  };

  if (typeof page.on === 'function') {
    page.on('websocket', (ws: { on?: (event: string, handler: () => void) => void }) => {
      ws.on?.('framesent', noteWsSent);
    });
  }

  const cdpMethods = controls?.cdpMethodsSupported ?? {
    setAutoAttach: true,
    setDiscoverTargets: true,
    getTargets: true,
    attachToTarget: true,
    sendMessageToTarget: true,
    networkEnable: true,
    webSocketFrameSent: true,
    targetAttached: true,
    targetDetached: true,
    runIfWaitingForDebugger: true,
    targetCreated: true,
  };

  let attachedTargetCount = 0;
  let failedTargetAttach = false;
  let contextCdpSessions = 0;

  const enableChildTargetSession = async (
    cdp: { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> },
    sessionId: string,
    waitingForDebugger = false,
  ): Promise<void> => {
    if (!sessionId) {
      failedTargetAttach = true;
      boundary.markCoverageLost();
      boundary.websocketTargetsCoverage = 'incomplete';
      return;
    }
    try {
      if (cdpMethods.sendMessageToTarget && cdpMethods.networkEnable) {
        await sendChildCdpCommand(cdp, sessionId, 'Network.enable');
      } else {
        failedTargetAttach = true;
        boundary.markCoverageLost();
        boundary.websocketTargetsCoverage = 'incomplete';
        return;
      }
      if (waitingForDebugger && cdpMethods.runIfWaitingForDebugger) {
        await sendChildCdpCommand(cdp, sessionId, 'Runtime.runIfWaitingForDebugger');
      }
      attachedTargetCount++;
    } catch {
      failedTargetAttach = true;
      boundary.markCoverageLost();
      boundary.websocketTargetsCoverage = 'incomplete';
    }
  };

  const observedCdpTargets = new WeakSet<object>();
  const attachPlaywrightContextCdpObservers = async (): Promise<void> => {
    if (typeof context.newCDPSession !== 'function') {
      failedTargetAttach = true;
      return;
    }
    const targets: unknown[] = [page];
    if (typeof context.pages === 'function') {
      for (const otherPage of context.pages()) {
        targets.push(otherPage);
      }
    }
    if (typeof context.serviceWorkers === 'function') {
      targets.push(...context.serviceWorkers());
    }
    for (const target of targets) {
      if (typeof target === 'object' && target !== null && observedCdpTargets.has(target)) continue;
      if (typeof target === 'object' && target !== null) observedCdpTargets.add(target);
      try {
        const session = await Promise.race([
          context.newCDPSession(target),
          new Promise<null>((resolve) => { setTimeout(() => resolve(null), 5_000); }),
        ]);
        if (!session) {
          failedTargetAttach = true;
          continue;
        }
        if (cdpMethods.networkEnable) {
          await session.send('Network.enable');
        }
        if (cdpMethods.webSocketFrameSent) {
          attachCdpOutboundWebSocketObserver(session, noteWsSent);
        }
        contextCdpSessions++;
      } catch {
        failedTargetAttach = true;
      }
    }
  };

  const attachSiblingTarget = async (): Promise<void> => {
    try {
      await attachPlaywrightContextCdpObservers();
    } catch {
      failedTargetAttach = true;
      boundary.markCoverageLost();
      boundary.websocketTargetsCoverage = 'incomplete';
    }
  };

  if (typeof context.on === 'function') {
    context.on('page', () => { void attachSiblingTarget(); });
    context.on('serviceworker', () => { void attachSiblingTarget(); });
  }

  if (typeof context.newCDPSession === 'function') {
    try {
      await attachPlaywrightContextCdpObservers();
      const cdp = await Promise.race([
        context.newCDPSession(page),
        new Promise<null>((resolve) => { setTimeout(() => resolve(null), 5_000); }),
      ]);
      if (!cdp) {
        failedTargetAttach = true;
      } else {
        const onTargetDetached = () => {
          boundary.markCoverageLost();
          if (boundary.websocketTargetsCoverage === 'complete') {
            boundary.websocketTargetsCoverage = 'incomplete';
          }
        };

        if (cdpMethods.targetDetached) {
          cdp.on('Target.detachedFromTarget', onTargetDetached);
        }
        if (typeof cdp.on === 'function') {
          cdp.on('disconnected', onTargetDetached);
        }

        if (cdpMethods.targetAttached) {
          cdp.on('Target.attachedToTarget', async (event: { sessionId?: string; waitingForDebugger?: boolean }) => {
            await enableChildTargetSession(cdp, event.sessionId ?? '', event.waitingForDebugger === true);
            await attachPlaywrightContextCdpObservers();
          });
        }

        if (cdpMethods.targetCreated) {
          cdp.on('Target.targetCreated', async (event: { targetInfo?: { targetId?: string; type?: string } }) => {
            const targetId = event.targetInfo?.targetId;
            if (!targetId || !isRelevantTargetType(event.targetInfo?.type)) return;
            try {
              const attached = await cdp.send('Target.attachToTarget', {
                targetId,
                flatten: true,
              }) as { sessionId?: string };
              await enableChildTargetSession(cdp, attached.sessionId ?? '');
              await attachPlaywrightContextCdpObservers();
            } catch {
              failedTargetAttach = true;
              boundary.markCoverageLost();
              boundary.websocketTargetsCoverage = 'incomplete';
            }
          });
        }

        if (cdpMethods.setDiscoverTargets) {
          await cdp.send('Target.setDiscoverTargets', { discover: true });
        }

        if (cdpMethods.setAutoAttach) {
          await cdp.send('Target.setAutoAttach', {
            autoAttach: true,
            waitForDebuggerOnStart: true,
            flatten: true,
          });
        }

        if (cdpMethods.getTargets && cdpMethods.attachToTarget) {
          try {
            const targets = await cdp.send('Target.getTargets') as { targetInfos?: Array<{ targetId?: string; type?: string }> };
            const relevantTargets = (targets.targetInfos ?? []).filter((target) => isRelevantTargetType(target.type));
            for (const target of relevantTargets) {
              if (!target.targetId) continue;
              try {
                const attached = await cdp.send('Target.attachToTarget', {
                  targetId: target.targetId,
                  flatten: true,
                }) as { sessionId?: string };
                await enableChildTargetSession(cdp, attached.sessionId ?? '');
              } catch {
                failedTargetAttach = true;
                boundary.markCoverageLost();
                boundary.websocketTargetsCoverage = 'incomplete';
              }
            }
            if (relevantTargets.length > 0 && attachedTargetCount < relevantTargets.length) {
              failedTargetAttach = true;
              boundary.markCoverageLost();
              boundary.websocketTargetsCoverage = 'incomplete';
            }
          } catch {
            failedTargetAttach = true;
            boundary.markCoverageLost();
            boundary.websocketTargetsCoverage = 'incomplete';
          }
        }

        let rootNetworkEnabled = false;
        if (cdpMethods.networkEnable) {
          await cdp.send('Network.enable');
          rootNetworkEnabled = true;
        }
        if (cdpMethods.webSocketFrameSent) {
          attachCdpOutboundWebSocketObserver(cdp, noteWsSent);
        }

        cdpEstablished = !failedTargetAttach
          && rootNetworkEnabled
          && contextCdpSessions > 0
          && cdpMethods.setAutoAttach === true
          && cdpMethods.webSocketFrameSent === true
          && cdpMethods.targetAttached === true;
      }
    } catch {
      failedTargetAttach = true;
      if (controls?.requireCdpWebSocketSent) {
        boundary.websocketTargetsCoverage = 'incomplete';
      }
    }
  } else if (!fakePage) {
    failedTargetAttach = true;
  }

  if (fakePage && controls?.websocketTargetsCoverage) {
    boundary.websocketTargetsCoverage = controls.websocketTargetsCoverage;
    boundary.websocketTargetsArmed = controls.websocketTargetsCoverage === 'complete';
  } else if (fakePage && controls?.incompleteWebSocketTargets) {
    boundary.websocketTargetsCoverage = 'incomplete';
  } else if (cdpEstablished && boundary.coverageIntact) {
    boundary.websocketTargetsArmed = true;
    boundary.websocketTargetsCoverage = 'complete';
  } else {
    boundary.websocketTargetsArmed = false;
    boundary.websocketTargetsCoverage = failedTargetAttach || controls?.requireCdpWebSocketSent
      ? 'incomplete'
      : 'unknown';
  }

  if (fakePage && controls) {
    boundary.gateBCharacterizationComplete = true;
  } else if (options.profileKey) {
    boundary.gateBCharacterizationComplete = readGateBCharacterizationRecord(options.profileKey)?.complete === true;
  }

  boundary.dispatchObservationEngaged = fakePage
    ? Boolean(controls)
    : true;

  if (boundary.dispatchObservationEngaged && !dispatchObservationEstablished(boundary)) {
    throw new DispatchObservationEstablishmentError('dispatch_observation_establishment_failed');
  }

  return boundary;
}

export async function evaluateDispatchRequestNotObserved(
  boundary: DispatchObservationBoundary,
  page: any,
  baselineIds: ReadonlySet<string>,
  countUserNodes: (page: any) => Promise<number>,
  readServiceId: (locator: any) => Promise<string>,
): Promise<{ proven: boolean; diagnostic: DispatchObservationDiagnostic }> {
  const windowExhausted = true;
  let userNodeDelta = Number.NaN;
  let newChatUrlChanged: boolean | 'na' = boundary.newChatMode ? false : 'na';
  let proven = false;

  if (dispatchObservationCoverageComplete(boundary)
    && boundary.userNodeBaselineReliable
    && boundary.postArmHttpRequestCount === 0
    && boundary.postArmWebSocketFrameSentCount === 0) {
    let postDispatchUserNodeCount: number;
    try {
      postDispatchUserNodeCount = await countUserNodes(page);
    } catch {
      postDispatchUserNodeCount = Number.NaN;
    }

    if (Number.isFinite(postDispatchUserNodeCount)) {
      userNodeDelta = postDispatchUserNodeCount - boundary.preDispatchUserNodeCount;
      if (userNodeDelta <= 0) {
        const users = page.locator('[data-message-author-role="user"]');
        let newDomUser = false;
        try {
          const count = await users.count();
          for (let index = 0; index < count; index++) {
            const id = await readServiceId(users.nth(index));
            if (id && !baselineIds.has(id)) {
              newDomUser = true;
              break;
            }
          }
        } catch {
          newDomUser = true;
        }

        if (!newDomUser) {
          let urlOk = true;
          if (boundary.newChatMode) {
            if (!boundary.urlBaselineReliable) {
              urlOk = false;
            } else {
              try {
                const normalized = normalizePageUrl(String(page.url()));
                newChatUrlChanged = normalized !== boundary.preDispatchNormalizedUrl;
                urlOk = !newChatUrlChanged;
              } catch {
                urlOk = false;
                newChatUrlChanged = true;
              }
            }
          }
          proven = urlOk;
        }
      }
    }
  }

  const diagnostic = formatDispatchObservationDiagnostic(
    boundary,
    Number.isFinite(userNodeDelta) ? userNodeDelta : -1,
    newChatUrlChanged,
    windowExhausted,
  );
  return { proven, diagnostic };
}

function normalizePageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

