import http from 'node:http';
import { URL } from 'node:url';
import { aggregateReviewsBoard } from './aggregate.js';
import type { DaemonClient } from './daemon-client.js';
import type { ReviewsBoardDocument } from './types.js';

export interface ReviewsBoardServerOptions {
  host?: string;
  port?: number;
  client: DaemonClient;
}

export interface ReviewsBoardServer {
  host: string;
  port: number;
  close(): Promise<void>;
  baseUrl: string;
}

function sendJson(
  response: http.ServerResponse,
  statusCode: number,
  body: ReviewsBoardDocument | { ok: boolean; service: string },
): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(payload);
}

export function createReviewsBoardServer(options: ReviewsBoardServerOptions): http.Server {
  const host = options.host ?? '127.0.0.1';

  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', `http://${host}`);
    const pathname = requestUrl.pathname;

    if (request.method === 'GET' && pathname === '/health') {
      sendJson(response, 200, { ok: true, service: 'ao-reviews-board' });
      return;
    }

    if (request.method === 'GET' && (pathname === '/api/reviews' || pathname === '/api/dashboard/reviews')) {
      const projectId = requestUrl.searchParams.get('projectId');
      const board = await aggregateReviewsBoard(options.client, { projectId });
      if (board.dashboardLoadError) {
        sendJson(response, 503, board);
        return;
      }
      sendJson(response, 200, board);
      return;
    }

    if (request.method === 'GET' && pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>AO Reviews Board Runtime</title></head>
<body>
  <h1>AO Reviews Board Runtime</h1>
  <p>Health: <a href="/health">/health</a></p>
  <p>Board JSON: <a href="/api/reviews">/api/reviews</a></p>
</body>
</html>`);
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });
}

export async function startReviewsBoardServer(
  options: ReviewsBoardServerOptions,
): Promise<ReviewsBoardServer> {
  const host = options.host ?? '127.0.0.1';
  const server = createReviewsBoardServer(options);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind reviews board server');
  }

  return {
    host,
    port: address.port,
    baseUrl: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
