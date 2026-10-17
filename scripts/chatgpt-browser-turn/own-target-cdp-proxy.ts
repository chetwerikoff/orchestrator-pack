// Invocation-local CDP transport. No browser-wide auto-attach is ever sent:
// Playwright receives manually attached sessions for only allowlisted targets.
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

export interface CdpPageTarget {
  readonly id: string;
  readonly type: string;
  readonly url: string;
}

type CdpMessage = {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: Record<string, any>;
};

const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export async function listCdpPageTargets(cdp: string, timeoutMs: number): Promise<CdpPageTarget[]> {
  const root = new URL(cdp);
  root.pathname = '/json/list';
  root.search = '';
  const response = await fetch(root, { signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
  if (!response.ok) throw new Error('cdp_target_enumeration_http_' + response.status);
  const value: unknown = await response.json();
  if (!Array.isArray(value)) throw new Error('cdp_target_enumeration_invalid');
  const pages: CdpPageTarget[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || item.type !== 'page') continue;
    if (typeof item.id !== 'string' || item.id.length === 0
      || typeof item.url !== 'string') {
      throw new Error('cdp_page_target_metadata_incomplete');
    }
    pages.push(item as CdpPageTarget);
  }
  return pages;
}

export async function createOwnCdpTarget(cdp: string, timeoutMs: number): Promise<string> {
  const root = new URL(cdp);
  root.pathname = '/json/new';
  root.search = '?about:blank';
  const response = await fetch(root, {
    method: 'PUT', signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
  });
  if (!response.ok) throw new Error('cdp_target_create_http_' + response.status);
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof (value as { id?: unknown }).id !== 'string') {
    throw new Error('cdp_target_create_unconfirmed');
  }
  return (value as { id: string }).id;
}

function encodeFrame(data: Buffer, opcode = 1): Buffer {
  const length = data.length;
  const header = Buffer.alloc(length < 126 ? 2 : length <= 65535 ? 4 : 10);
  header[0] = 0x80 | opcode;
  if (length < 126) header[1] = length;
  else if (length <= 65535) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, data]);
}

export class OwnTargetCdpProxy {
  readonly allowedTargetIds: Set<string>;
  readonly createdTargetIds: Set<string>;
  private readonly token = randomUUID();
  private readonly server: Server;
  private readonly remote: WebSocket;
  private client?: Duplex;
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentedOpcode = 0;
  private readonly sessions = new Map<string, string>();
  private readonly internal = new Map<number, {
    resolve: (value: CdpMessage) => void;
    reject: (error: Error) => void;
  }>();
  private readonly createCommands = new Set<number>();
  private nextInternalId = 1_000_000_000;
  private attaching = new Set<string>();
  private bootstrapEnabled = false;
  private disposed = false;
  readonly endpoint: string;

  private constructor(server: Server, remote: WebSocket, port: number, allowed: readonly string[], created: readonly string[]) {
    this.server = server;
    this.remote = remote;
    this.endpoint = 'ws://127.0.0.1:' + port + '/' + this.token;
    this.allowedTargetIds = new Set(allowed);
    this.createdTargetIds = new Set(created);
    this.server.on('upgrade', (req, socket, head) => {
      const key = req.headers['sec-websocket-key'];
      if (this.disposed || this.client || req.url !== '/' + this.token
        || typeof key !== 'string' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
        socket.destroy();
        return;
      }
      const accept = createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + 'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      this.client = socket;
      socket.on('data', (chunk: Buffer) => this.consumeFrame(chunk));
      socket.on('error', () => { void this.dispose(); });
      socket.on('close', () => { void this.dispose(); });
      if (head.length) this.consumeFrame(head);
    });
    this.remote.addEventListener('message', (event) => {
      if (typeof event.data === 'string') void this.fromChrome(event.data);
    });
    this.remote.addEventListener('close', () => { void this.dispose(); });
    this.remote.addEventListener('error', () => { void this.dispose(); });
  }

  static async open(cdp: string, allowed: readonly string[], created: readonly string[], timeoutMs: number): Promise<OwnTargetCdpProxy> {
    const root = new URL(cdp);
    root.pathname = '/json/version';
    root.search = '';
    const response = await fetch(root, { signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
    if (!response.ok) throw new Error('cdp_browser_websocket_http_' + response.status);
    const version: unknown = await response.json();
    const wsUrl = (version as { webSocketDebuggerUrl?: unknown } | null)?.webSocketDebuggerUrl;
    if (typeof wsUrl !== 'string' || !/^wss?:\/\//u.test(wsUrl)) {
      throw new Error('cdp_browser_websocket_unavailable');
    }
    const remote = new WebSocket(wsUrl);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('cdp_proxy_backend_timeout')), Math.max(1, timeoutMs));
        remote.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        remote.addEventListener('error', () => { clearTimeout(timer); reject(new Error('cdp_proxy_backend_error')); }, { once: true });
      });
    } catch (error) {
      remote.close();
      throw error;
    }
    const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    } catch (error) {
      remote.close();
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      remote.close();
      throw new Error('cdp_proxy_listen_unavailable');
    }
    return new OwnTargetCdpProxy(server, remote, address.port, allowed, created);
  }

  private sendClient(value: CdpMessage): void {
    if (!this.client || this.disposed) return;
    this.client.write(encodeFrame(Buffer.from(JSON.stringify(value), 'utf8')));
  }

  private sendFailure(id: number, cause: string): void {
    this.sendClient({ id, error: { code: -32000, message: cause } });
  }

  private consumeFrame(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2 && !this.disposed) {
      const fin = (this.buffer[0]! & 0x80) !== 0;
      const opcode = this.buffer[0]! & 0x0f;
      const masked = (this.buffer[1]! & 0x80) !== 0;
      let length = this.buffer[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const rawLength = this.buffer.readBigUInt64BE(2);
        if (rawLength > BigInt(MAX_FRAME_BYTES)) { void this.dispose(); return; }
        length = Number(rawLength);
        offset = 10;
      }
      if (!masked || length > MAX_FRAME_BYTES) { void this.dispose(); return; }
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
      this.buffer = this.buffer.subarray(offset + 4 + length);
      if (opcode === 8) { void this.dispose(); return; }
      if (opcode === 9) { this.client?.write(encodeFrame(payload, 10)); continue; }
      if (opcode === 10) continue;
      if (opcode === 1 || opcode === 0) {
        if (opcode === 1) {
          this.fragments = [];
          this.fragmentedOpcode = 1;
        } else if (this.fragmentedOpcode !== 1) { void this.dispose(); return; }
        this.fragments.push(payload);
        if (this.fragments.reduce((sum, part) => sum + part.length, 0) > MAX_FRAME_BYTES) {
          void this.dispose();
          return;
        }
        if (fin) {
          const text = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.fragmentedOpcode = 0;
          void this.fromPlaywright(text);
        }
      } else { void this.dispose(); return; }
    }
  }

  private async sendInternal(method: string, params: Record<string, unknown>): Promise<CdpMessage> {
    if (this.disposed || this.remote.readyState !== WebSocket.OPEN) {
      throw new Error('cdp_proxy_disconnected');
    }
    const id = this.nextInternalId++;
    return await new Promise<CdpMessage>((resolve, reject) => {
      this.internal.set(id, { resolve, reject });
      this.remote.send(JSON.stringify({ id, method, params }));
    });
  }

  private async attachOne(id: string): Promise<void> {
    if (!this.allowedTargetIds.has(id) || this.attaching.has(id)) return;
    this.attaching.add(id);
    try {
      const response = await this.sendInternal('Target.attachToTarget', { targetId: id, flatten: true });
      if (response.error) throw new Error('own_target_attach_failed');
    } finally {
      this.attaching.delete(id);
    }
  }

  private async fromPlaywright(raw: string): Promise<void> {
    let message: CdpMessage;
    try { message = JSON.parse(raw) as CdpMessage; }
    catch { void this.dispose(); return; }
    if (typeof message.id !== 'number' || !message.method || this.disposed) return;
    const { id, method, params = {}, sessionId } = message;
    if (sessionId && !this.sessions.has(sessionId)) {
      this.sendFailure(id, 'foreign_page_session_forbidden');
      return;
    }
    if (method === 'Target.setAutoAttach') {
      // Sending this on the browser root would pause unrelated pages, including
      // pages created after bootstrap. Explicit allowed-target attach replaces it.
      this.bootstrapEnabled ||= params.autoAttach === true && !sessionId;
      try {
        if (this.bootstrapEnabled && !sessionId) {
          for (const targetId of this.allowedTargetIds) await this.attachOne(targetId);
        }
        this.sendClient({ id, result: {} });
      } catch {
        this.sendFailure(id, 'own_target_attach_failed');
      }
      return;
    }
    if (method === 'Target.autoAttachRelated' || method === 'Target.setRemoteLocations'
      || method === 'Target.attachToBrowserTarget' || method === 'Browser.close'
      || method === 'Target.disposeBrowserContext') {
      this.sendFailure(id, 'cross_target_attach_forbidden');
      return;
    }
    if (typeof params.sessionId === 'string' && !this.sessions.has(params.sessionId)) {
      this.sendFailure(id, 'foreign_page_session_forbidden');
      return;
    }
    if (typeof params.targetId === 'string' && !this.allowedTargetIds.has(params.targetId)) {
      this.sendFailure(id, 'foreign_target_forbidden');
      return;
    }
    if (method === 'Target.closeTarget' && !this.createdTargetIds.has(String(params.targetId ?? ''))) {
      this.sendFailure(id, 'existing_page_close_forbidden');
      return;
    }
    if (method === 'Target.createTarget') this.createCommands.add(id);
    if (this.remote.readyState !== WebSocket.OPEN) {
      this.sendFailure(id, 'cdp_proxy_disconnected');
      return;
    }
    this.remote.send(raw);
  }

  private async fromChrome(raw: string): Promise<void> {
    if (this.disposed) return;
    let message: CdpMessage;
    try { message = JSON.parse(raw) as CdpMessage; }
    catch { return; }
    if (typeof message.id === 'number' && this.internal.has(message.id)) {
      const pending = this.internal.get(message.id)!;
      this.internal.delete(message.id);
      pending.resolve(message);
      return;
    }
    if (typeof message.id === 'number' && this.createCommands.delete(message.id)) {
      const targetId = message.result?.targetId;
      if (typeof targetId === 'string' && !message.error) {
        this.allowedTargetIds.add(targetId);
        this.createdTargetIds.add(targetId);
        try {
          if (this.bootstrapEnabled) await this.attachOne(targetId);
        } catch {
          this.sendFailure(message.id, 'own_target_attach_failed');
          return;
        }
      }
    }
    const event = message.method ?? '';
    const targetId = message.params?.targetInfo?.targetId ?? message.params?.targetId;
    if (typeof targetId === 'string' && !this.allowedTargetIds.has(targetId)) return;
    if (event === 'Target.attachedToTarget') {
      const id = message.params?.targetInfo?.targetId;
      const session = message.params?.sessionId;
      if (typeof id !== 'string' || !this.allowedTargetIds.has(id) || typeof session !== 'string') return;
      this.sessions.set(session, id);
    }
    if (event === 'Target.detachedFromTarget') {
      const session = message.params?.sessionId;
      if (typeof session !== 'string' || !this.sessions.has(session)) return;
      this.sessions.delete(session);
    }
    if (typeof message.sessionId === 'string' && !this.sessions.has(message.sessionId)) return;
    if (event === 'Target.getTargets' || event === 'Target.targetCreated') {
      // Target.getTargets response filtering is handled below by shape, too.
    }
    if (Array.isArray(message.result?.targetInfos)) {
      message.result!.targetInfos = message.result!.targetInfos.filter(
        (target: { targetId?: string }) => this.allowedTargetIds.has(String(target.targetId ?? '')),
      );
    }
    this.sendClient(message);
  }

  async dispose(budgetMs = 5_000): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.internal.values()) pending.reject(new Error('cdp_proxy_disposed'));
    this.internal.clear();
    this.client?.destroy();
    this.server.close();
    if (this.remote.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => {
      this.remote.addEventListener('close', () => resolve(), { once: true });
    });
    this.remote.close();
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('cdp_proxy_cleanup_unconfirmed')), Math.max(1, budgetMs))),
    ]);
  }
}
