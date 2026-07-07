import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';
import { aggregateReviewsBoard } from './aggregate.js';
import type { DaemonClient } from './daemon-client.js';
import type { ReviewsBoardDocument } from './types.js';

export interface ReviewsBoardServerOptions {
  host?: string;
  port?: number;
  client: DaemonClient;
  /** Override UI dist directory (tests). */
  uiDistDir?: string;
}

export interface ReviewsBoardServer {
  host: string;
  port: number;
  close(): Promise<void>;
  baseUrl: string;
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultUiDistDir = path.join(moduleDir, '../ui/dist');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

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

function runtimeFallbackHtml(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>AO Reviews Board Runtime</title></head>
<body>
  <h1>AO Reviews Board Runtime</h1>
  <p>UI bundle not built. Run <code>npm install && npm run build</code> in <code>tests/ao-reviews-board-runtime/ui</code>.</p>
  <p>Health: <a href="/health">/health</a></p>
  <p>Board JSON: <a href="/api/reviews">/api/reviews</a></p>
</body>
</html>`;
}

async function readUiFile(
  uiDistDir: string,
  requestPath: string,
): Promise<{ content: Buffer; contentType: string } | null> {
  const relativePath =
    requestPath === '/' || requestPath === ''
      ? 'index.html'
      : requestPath.replace(/^\/+/, '');
  const resolvedRoot = path.resolve(uiDistDir);
  const resolvedFile = path.resolve(path.join(uiDistDir, relativePath));
  if (!resolvedFile.startsWith(resolvedRoot)) {
    return null;
  }

  try {
    const content = await fs.readFile(resolvedFile);
    const ext = path.extname(resolvedFile).toLowerCase();
    return {
      content,
      contentType: MIME_TYPES[ext] ?? 'application/octet-stream',
    };
  } catch {
    return null;
  }
}

export function createReviewsBoardServer(options: ReviewsBoardServerOptions): http.Server {
  const host = options.host ?? '127.0.0.1';
  const uiDistDir = options.uiDistDir ?? defaultUiDistDir;

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

    if (request.method === 'GET') {
      const staticFile = await readUiFile(uiDistDir, pathname);
      if (staticFile) {
        response.writeHead(200, {
          'content-type': staticFile.contentType,
          'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=3600' : 'no-store',
        });
        response.end(staticFile.content);
        return;
      }

      if (pathname === '/' || pathname === '/index.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(runtimeFallbackHtml());
        return;
      }
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
