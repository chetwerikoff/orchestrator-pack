import { FORBIDDEN_DAEMON_AGGREGATION_PATHS } from './types.js';

export const DAEMON_API_PATHS = {
  sessions: '/api/v1/sessions',
  projects: '/api/v1/projects',
  sessionReviews: (sessionId: string) => `/api/v1/sessions/${encodeURIComponent(sessionId)}/reviews`,
} as const;

export interface DaemonClient {
  fetchJson(path: string): Promise<unknown>;
  getRequestLog(): readonly string[];
}

export interface HttpDaemonClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function assertAllowedAggregationPath(path: string): void {
  const normalized = path.split('?')[0] ?? path;
  for (const forbidden of FORBIDDEN_DAEMON_AGGREGATION_PATHS) {
    if (normalized === forbidden || normalized.startsWith(`${forbidden}/`)) {
      throw new Error(`forbidden cross-session daemon path: ${normalized}`);
    }
  }
}

export function createHttpDaemonClient(options: HttpDaemonClientOptions): DaemonClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestLog: string[] = [];

  return {
    async fetchJson(path: string): Promise<unknown> {
      assertAllowedAggregationPath(path);
      const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
      requestLog.push(url);
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`daemon HTTP ${response.status} for ${path}`);
      }
      return response.json();
    },
    getRequestLog() {
      return requestLog;
    },
  };
}

export interface CaptureReplayDaemonClientOptions {
  sessions: unknown;
  projects: unknown;
  reviewsBySessionId: Record<string, unknown>;
  baseUrl?: string;
}

export function createCaptureReplayDaemonClient(
  options: CaptureReplayDaemonClientOptions,
): DaemonClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? 'http://127.0.0.1:3001');
  const requestLog: string[] = [];

  return {
    async fetchJson(path: string): Promise<unknown> {
      assertAllowedAggregationPath(path);
      const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
      requestLog.push(url);

      if (path === DAEMON_API_PATHS.sessions) {
        return options.sessions;
      }
      if (path === DAEMON_API_PATHS.projects) {
        return options.projects;
      }
      const reviewsMatch = /^\/api\/v1\/sessions\/([^/]+)\/reviews$/.exec(path);
      if (reviewsMatch) {
        const sessionId = decodeURIComponent(reviewsMatch[1] ?? '');
        if (Object.prototype.hasOwnProperty.call(options.reviewsBySessionId, sessionId)) {
          return options.reviewsBySessionId[sessionId];
        }
        return { reviewerHandleId: '', reviews: [] };
      }
      throw new Error(`capture replay has no fixture for path: ${path}`);
    },
    getRequestLog() {
      return requestLog;
    },
  };
}
