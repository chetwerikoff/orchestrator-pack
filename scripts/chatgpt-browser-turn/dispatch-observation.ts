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

export const GATE_B_PROBE_WINDOW_MS = 60_000;

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
  url?: () => string;
  context?: () => {
    on?: (event: string, handler: (request: { url: () => string }) => void) => void;
    pages?: () => unknown[];
    serviceWorkers?: () => unknown[];
    newPage?: () => Promise<{
      on?: (event: string, handler: (value: unknown) => void) => void;
      goto?: (url: string, options?: { waitUntil?: string }) => Promise<unknown>;
      reload?: (options?: { waitUntil?: string }) => Promise<unknown>;
      close?: () => Promise<unknown>;
      url?: () => string;
    }>;
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
  let websocketSentObserved = false;
  let serviceWorkerHttpDetail = 'no_service_worker_http_observed_within_probe_window';
  const noteServiceWorkerHttp = (detail = 'context_request_observed') => {
    serviceWorkerHttpObserved = true;
    serviceWorkerHttpDetail = detail;
  };
  const noteWebSocketSent = () => {
    websocketSentObserved = true;
  };
  if (typeof context.on === 'function') {
    context.on('request', (request: { url: () => string; serviceWorker?: () => unknown | null }) => {
      if (typeof request.serviceWorker === 'function' && request.serviceWorker()) {
        noteServiceWorkerHttp();
      }
    });
  }

  const observedCdpTargets = new WeakSet<object>();
  const characterizationPages: Array<{
    close?: () => Promise<unknown>;
    reload?: (options?: { waitUntil?: string }) => Promise<unknown>;
  }> = [];
  const attachGateBSecondaryPageObservers = async (secondaryPage: unknown): Promise<void> => {
    if (typeof secondaryPage !== 'object' || secondaryPage === null || observedCdpTargets.has(secondaryPage)) return;
    observedCdpTargets.add(secondaryPage);
    const pageLike = secondaryPage as {
      on?: (event: string, handler: (value: unknown) => void) => void;
    };
    if (typeof pageLike.on === 'function') {
      pageLike.on('websocket', (value: unknown) => {
        const ws = value as { on?: (event: string, handler: () => void) => void };
        ws.on?.('framesent', noteWebSocketSent);
      });
    }
    if (typeof context.newCDPSession !== 'function') return;
    try {
      const session = await context.newCDPSession(secondaryPage);
      await session.send('Network.enable');
      attachCdpOutboundWebSocketObserver(session, noteWebSocketSent);
    } catch {
      // Individual secondary-page attach failures are non-fatal for characterization.
    }
  };

  const attachGateBWebSocketObservers = async (): Promise<void> => {
    if (typeof context.pages === 'function') {
      const siblings = context.pages().filter((candidate) => candidate !== page).slice(0, 3);
      for (const otherPage of siblings) {
        await attachGateBSecondaryPageObservers(otherPage);
      }
    }
  };

  if (typeof context.newCDPSession === 'function') {
    try {
      if (typeof context.newPage === 'function') {
        const secondaryPage = await context.newPage();
        characterizationPages.push(secondaryPage);
        await attachGateBSecondaryPageObservers(secondaryPage);
        if (typeof secondaryPage.goto === 'function') {
          await secondaryPage.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
        }
      }
      await attachGateBWebSocketObservers();
      if (typeof context.on === 'function') {
        context.on('page', (createdPage: unknown) => { void attachGateBSecondaryPageObservers(createdPage); });
      }
    } catch {
      websocketSentObserved = false;
    }
  }

  if (typeof page.reload === 'function') {
    try {
      for (const secondaryPage of characterizationPages) {
        if (typeof secondaryPage.reload === 'function') {
          await secondaryPage.reload({ waitUntil: 'domcontentloaded' });
        }
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      if (typeof context.pages === 'function') {
        for (const otherPage of context.pages().filter((candidate) => candidate !== page).slice(0, 3)) {
          const reloadable = otherPage as { reload?: (options?: { waitUntil?: string }) => Promise<unknown> };
          if (typeof reloadable.reload === 'function') {
            await reloadable.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          }
        }
      }
    } catch {
      // Passive observation may still succeed on an already-active ChatGPT surface.
    }
  }

  let secondaryHomeNavigationAttempted = false;
  const deadline = Date.now() + GATE_B_PROBE_WINDOW_MS;
  while (Date.now() < deadline) {
    if (serviceWorkerHttpObserved && websocketSentObserved) break;
    if (!serviceWorkerHttpObserved
      && !secondaryHomeNavigationAttempted
      && Date.now() + 30_000 > deadline) {
      secondaryHomeNavigationAttempted = true;
      const secondaryPage = characterizationPages[0] as { goto?: (url: string, options?: { waitUntil?: string }) => Promise<unknown> } | undefined;
      if (typeof secondaryPage?.goto === 'function') {
        await secondaryPage.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
    }
    await new Promise((resolve) => { setTimeout(resolve, 100); });
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

  for (const secondaryPage of characterizationPages) {
    await secondaryPage.close?.().catch(() => {});
  }

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
  on: (event: string, handler: (...args: any[]) => void) => void;
};

async function sendFlatChildCdpCommand(
  cdp: FlatCdpSessionSend,
  sessionId: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  // Playwright routes flattened child commands via an undocumented third sessionId
  // argument at runtime; Target.sendMessageToTarget is rejected in flatten mode.
  try {
    return await cdp.send(method, params, sessionId);
  } catch {
    return cdp.send(method, { ...params, sessionId });
  }
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
    sendMessageToTarget: false,
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
    cdp: FlatCdpSessionSend,
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
      if (!cdpMethods.networkEnable) {
        failedTargetAttach = true;
        boundary.markCoverageLost();
        boundary.websocketTargetsCoverage = 'incomplete';
        return;
      }
      await sendFlatChildCdpCommand(cdp, sessionId, 'Network.enable');
      if (waitingForDebugger && cdpMethods.runIfWaitingForDebugger) {
        await sendFlatChildCdpCommand(cdp, sessionId, 'Runtime.runIfWaitingForDebugger');
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
        if (armed) {
          boundary.markCoverageLost();
          boundary.websocketTargetsCoverage = 'incomplete';
        }
      }
    }
  };

  const pendingSiblingAttachTasks = new Set<Promise<void>>();
  const attachSiblingTarget = (): Promise<void> => {
    if (armed) {
      boundary.markCoverageLost();
      boundary.websocketTargetsCoverage = 'incomplete';
    } else {
      boundary.websocketTargetsCoverage = 'incomplete';
    }
    const task = (async () => {
      try {
        await attachPlaywrightContextCdpObservers();
        if (!armed && !failedTargetAttach && boundary.coverageIntact) {
          boundary.websocketTargetsCoverage = 'complete';
        }
      } catch {
        failedTargetAttach = true;
        boundary.markCoverageLost();
        boundary.websocketTargetsCoverage = 'incomplete';
      }
    })();
    pendingSiblingAttachTasks.add(task);
    void task.finally(() => {
      pendingSiblingAttachTasks.delete(task);
    });
    return task;
  };

  const onSiblingTargetAfterArm = (): void => {
    void attachSiblingTarget();
  };

  if (typeof context.on === 'function') {
    context.on('page', onSiblingTargetAfterArm);
    context.on('serviceworker', onSiblingTargetAfterArm);
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
        if (cdpMethods.webSocketFrameSent) {
          attachCdpOutboundWebSocketObserver(cdp, noteWsSent);
        }
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
            boundary.websocketTargetsCoverage = 'incomplete';
            if (armed) boundary.markCoverageLost();
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

  if (pendingSiblingAttachTasks.size > 0) {
    await Promise.allSettled([...pendingSiblingAttachTasks]);
    if (fakePage && controls?.websocketTargetsCoverage) {
      boundary.websocketTargetsCoverage = controls.websocketTargetsCoverage;
      boundary.websocketTargetsArmed = controls.websocketTargetsCoverage === 'complete';
    } else if (cdpEstablished && boundary.coverageIntact && !failedTargetAttach) {
      boundary.websocketTargetsArmed = true;
      boundary.websocketTargetsCoverage = 'complete';
    } else {
      boundary.websocketTargetsArmed = false;
      boundary.websocketTargetsCoverage = failedTargetAttach || controls?.requireCdpWebSocketSent
        ? 'incomplete'
        : 'unknown';
    }
  }

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

