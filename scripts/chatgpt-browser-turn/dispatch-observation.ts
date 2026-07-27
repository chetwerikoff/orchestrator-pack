import {
  DRIVER_DIAGNOSTIC_SCHEMA,
  DRIVER_DIAGNOSTIC_VERSION,
  mirrorDriverDiagnosticToStderr,
} from './diagnostics.ts';

export type DispatchCoverageStatus = 'complete' | 'incomplete' | 'unknown';

export interface DispatchObservationTestControls {
  readonly establishmentFails?: boolean;
  readonly httpContextCoverage?: DispatchCoverageStatus;
  readonly websocketTargetsCoverage?: DispatchCoverageStatus;
  readonly requireCdpWebSocketSent?: boolean;
  readonly incompleteWebSocketTargets?: boolean;
  readonly initialCoverageIntact?: boolean;
  readonly cdpMethodsSupported?: {
    readonly setAutoAttach?: boolean;
    readonly setDiscoverTargets?: boolean;
    readonly networkEnable?: boolean;
    readonly webSocketFrameSent?: boolean;
    readonly targetAttached?: boolean;
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

export async function establishDispatchObservationBoundary(
  page: any,
  options: {
    newChatMode: boolean;
    preDispatchUserNodeCount: number;
    preDispatchNormalizedUrl: string;
    userNodeBaselineReliable: boolean;
    urlBaselineReliable: boolean;
  },
): Promise<DispatchObservationBoundary> {
  const controls = testControls(page);
  if (controls?.establishmentFails) {
    throw new DispatchObservationEstablishmentError('dispatch_observation_establishment_failed');
  }

  let armed = false;
  const boundary: DispatchObservationBoundary = {
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
    armDispatchObservation() { armed = true; },
    markCoverageLost() { this.coverageIntact = false; },
  };

  const context = page.context?.();
  if (!context) {
    throw new DispatchObservationEstablishmentError('dispatch_observation_context_unavailable');
  }

  try {
    if (typeof context.on !== 'function') {
      boundary.httpContextCoverage = controls?.httpContextCoverage ?? 'unknown';
    } else {
      context.on('request', () => {
        if (!armed) return;
        boundary.postArmHttpRequestCount++;
      });
      boundary.httpContextArmed = true;
      boundary.httpContextCoverage = controls?.httpContextCoverage ?? 'complete';
    }
  } catch {
    throw new DispatchObservationEstablishmentError('dispatch_observation_http_failed');
  }

  const noteWsSent = () => {
    if (!armed) return;
    boundary.postArmWebSocketFrameSentCount++;
  };

  let wsObservationLayers = 0;
  if (typeof page.on === 'function') {
    page.on('websocket', (ws: { on?: (event: string, handler: () => void) => void }) => {
      ws.on?.('framesent', noteWsSent);
    });
    wsObservationLayers++;
  }

  const cdpMethods = controls?.cdpMethodsSupported ?? {
    setAutoAttach: true,
    setDiscoverTargets: true,
    networkEnable: true,
    webSocketFrameSent: true,
    targetAttached: true,
  };

  if (typeof context.newCDPSession === 'function') {
    try {
      const cdp = await Promise.race([
        context.newCDPSession(page),
        new Promise<null>((resolve) => { setTimeout(() => resolve(null), 5_000); }),
      ]);
      if (cdp) {
        if (cdpMethods.setAutoAttach) {
          await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
        }
        if (cdpMethods.setDiscoverTargets) {
          await cdp.send('Target.setDiscoverTargets', { discover: true });
        }
        if (cdpMethods.networkEnable) {
          await cdp.send('Network.enable');
        }
        if (cdpMethods.webSocketFrameSent) {
          cdp.on('Network.webSocketFrameSent', noteWsSent);
          wsObservationLayers++;
        }
        if (cdpMethods.targetAttached) {
          cdp.on('Target.attachedToTarget', async (event: { sessionId?: string }) => {
            if (!event.sessionId) {
              boundary.markCoverageLost();
              boundary.websocketTargetsCoverage = 'incomplete';
              return;
            }
            try {
              await cdp.send('Network.enable', {}, event.sessionId);
            } catch {
              boundary.markCoverageLost();
              boundary.websocketTargetsCoverage = 'incomplete';
            }
          });
        }
      } else if (controls?.requireCdpWebSocketSent) {
        boundary.websocketTargetsCoverage = 'incomplete';
      }
    } catch {
      if (controls?.requireCdpWebSocketSent) {
        boundary.websocketTargetsCoverage = 'incomplete';
      }
    }
  }

  if (controls?.websocketTargetsCoverage) {
    boundary.websocketTargetsCoverage = controls.websocketTargetsCoverage;
    boundary.websocketTargetsArmed = controls.websocketTargetsCoverage === 'complete';
  } else if (controls?.incompleteWebSocketTargets) {
    boundary.websocketTargetsCoverage = 'incomplete';
  } else if (wsObservationLayers >= 2) {
    boundary.websocketTargetsArmed = true;
    boundary.websocketTargetsCoverage = 'complete';
  } else if (wsObservationLayers === 1) {
    boundary.websocketTargetsCoverage = 'incomplete';
  }

  return boundary;
}

export function dispatchObservationCoverageComplete(boundary: DispatchObservationBoundary): boolean {
  return boundary.coverageIntact
    && boundary.httpContextArmed
    && boundary.httpContextCoverage === 'complete'
    && boundary.websocketTargetsArmed
    && boundary.websocketTargetsCoverage === 'complete';
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
