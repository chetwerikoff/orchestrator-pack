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


// Issue #2682: this probe is observational only. A shared CDP endpoint does not
// attest a Chrome browser context, profile, renderer cause or shared Web Lock.
export interface SiblingEvaluationTarget {
  readonly id: string;
  readonly url: string;
}

export interface SiblingEvaluationProbe {
  readonly nonresponsive: readonly SiblingEvaluationTarget[];
  readonly responsive: readonly SiblingEvaluationTarget[];
  readonly disappearedOrChanged: readonly SiblingEvaluationTarget[];
  readonly unknown: readonly SiblingEvaluationTarget[];
}

interface ProbePageTarget extends SiblingEvaluationTarget {
  readonly type: string;
  readonly webSocketDebuggerUrl?: string;
}

const SIBLING_PROBE_MAX_MS = 5_000;
const SIBLING_PROBE_MAX_BYTES = 256 * 1024;
const SIBLING_PROBE_MAX_TARGETS = 4;

// All awaits, including an HTTP reader or a fake/stalled fetch that ignores
// AbortSignal, must be bounded independently of the invocation clock.
async function untilProbeDeadline<T>(
  promise: Promise<T>,
  remainingMs: number,
  abort?: AbortSignal,
): Promise<T | undefined> {
  if (remainingMs <= 0 || abort?.aborted) return undefined;
  return await new Promise<T | undefined>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (value: T | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abort?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish(undefined);
    timer = setTimeout(() => finish(undefined), Math.max(1, remainingMs));
    abort?.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => finish(value), () => finish(undefined));
  });
}

async function enumerateSiblingTargets(
  cdp: string, remaining: () => number, signal: AbortSignal,
): Promise<ProbePageTarget[] | undefined> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const endpoint = new URL(cdp);
  endpoint.pathname = '/json/list';
  endpoint.search = '';
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await untilProbeDeadline(
      fetch(endpoint, { signal: controller.signal }), remaining(), signal,
    );
    if (!response?.ok || !response.body) return undefined;
    const statedSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(statedSize) && statedSize > SIBLING_PROBE_MAX_BYTES) return undefined;
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const part = await untilProbeDeadline(reader.read(), remaining(), signal);
      if (!part) return undefined;
      if (part.done) break;
      total += part.value.byteLength;
      if (total > SIBLING_PROBE_MAX_BYTES) return undefined;
      chunks.push(part.value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(parsed)) return undefined;
    const pages: ProbePageTarget[] = [];
    for (const target of parsed) {
      if (!target || typeof target !== 'object' || target.type !== 'page') continue;
      if (typeof target.id !== 'string' || !target.id
        || typeof target.url !== 'string') return undefined;
      pages.push(target as ProbePageTarget);
    }
    return pages;
  } catch {
    return undefined;
  } finally {
    controller.abort();
    signal.removeEventListener('abort', onAbort);
    if (reader) void reader.cancel().catch(() => undefined);
  }
}

function isChatGptProbeTarget(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.origin === 'https://chatgpt.com' || parsed.origin === 'https://chat.openai.com')
      && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

async function probeOneTarget(
  cdp: string, target: ProbePageTarget, remaining: () => number, signal: AbortSignal,
): Promise<'nonresponsive' | 'responsive' | 'unknown'> {
  let socket: WebSocket | undefined;
  let live = true;
  let protocolError = false;
  try {
    const targetSocket = new URL(String(target.webSocketDebuggerUrl ?? ''));
    const source = new URL(cdp);
    // /json/list on the selected endpoint is our only source of candidates.
    // Never follow a debugger socket advertising an unrelated host or port.
    if (!['ws:', 'wss:'].includes(targetSocket.protocol)
      || targetSocket.host !== source.host
      || targetSocket.username || targetSocket.password
      || !targetSocket.pathname.endsWith('/' + target.id)) return 'unknown';
    socket = new WebSocket(targetSocket.toString());
    const direct = socket;
    const onLoss = (): void => { live = false; };
    const onProtocol = (event: MessageEvent): void => {
      try {
        const reply = JSON.parse(String(event.data)) as { error?: unknown };
        if (reply.error) protocolError = true;
      } catch { protocolError = true; }
    };
    direct.addEventListener('error', onLoss);
    direct.addEventListener('close', onLoss);
    direct.addEventListener('message', onProtocol);
    try {
      const opened = await new Promise<boolean>((resolve) => {
        let done = false;
        let timer: ReturnType<typeof setTimeout>;
        const finish = (value: boolean): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', aborted);
          direct.removeEventListener('open', onOpen);
          direct.removeEventListener('error', failed);
          direct.removeEventListener('close', failed);
          resolve(value);
        };
        const onOpen = (): void => finish(true);
        const failed = (): void => finish(false);
        const aborted = (): void => finish(false);
        timer = setTimeout(() => finish(false), Math.max(1, Math.min(1_000, remaining())));
        signal.addEventListener('abort', aborted, { once: true });
        direct.addEventListener('open', onOpen, { once: true });
        direct.addEventListener('error', failed, { once: true });
        direct.addEventListener('close', failed, { once: true });
        if (signal.aborted || remaining() <= 0) finish(false);
      });
      if (!opened || !live || direct.readyState !== 1) return 'unknown';

      let nextId = 0;
      const command = async (method: string, params: Record<string, unknown>, timeoutMs: number) =>
        await new Promise<Record<string, any> | undefined>((resolve) => {
          if (signal.aborted || !live || protocolError || direct.readyState !== 1) {
            resolve(undefined);
            return;
          }
          const id = ++nextId;
          let settled = false;
          let timer: ReturnType<typeof setTimeout>;
          const complete = (value?: Record<string, any>): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', aborted);
            direct.removeEventListener('message', received);
            direct.removeEventListener('error', lost);
            direct.removeEventListener('close', lost);
            resolve(value);
          };
          const aborted = (): void => complete();
          const lost = (): void => complete();
          const received = (event: MessageEvent): void => {
            try {
              const message = JSON.parse(String(event.data)) as Record<string, any>;
              if (message.id === id) complete(message);
            } catch { complete(); }
          };
          timer = setTimeout(() => complete(), Math.max(1, Math.min(timeoutMs, remaining())));
          signal.addEventListener('abort', aborted, { once: true });
          direct.addEventListener('message', received);
          direct.addEventListener('error', lost);
          direct.addEventListener('close', lost);
          try { direct.send(JSON.stringify({ id, method, params })); }
          catch { complete(); }
        });
      const control = async (): Promise<boolean> => {
        const result = await command('Target.getTargetInfo', { targetId: target.id }, 650);
        const info = result?.result?.targetInfo;
        return live && !protocolError && direct.readyState === 1 && !result?.error
          && info?.targetId === target.id && info?.url === target.url && info?.type === 'page';
      };
      if (!await control()) return 'unknown';
      const evaluated = await command(
        'Runtime.evaluate', { expression: '1+1', returnByValue: true }, 2_000,
      );
      if (!live || protocolError || direct.readyState !== 1) return 'unknown';
      // A timed-out evaluation alone says nothing about the renderer. The
      // independent target-control channel must still answer *after* it.
      if (!await control()) return 'unknown';
      if (!live || protocolError || signal.aborted || remaining() <= 0) return 'unknown';
      if (!evaluated) return 'nonresponsive';
      return !evaluated.error && !evaluated.result?.exceptionDetails
        && evaluated.result?.result?.value === 2 ? 'responsive' : 'unknown';
    } finally {
      direct.removeEventListener('error', onLoss);
      direct.removeEventListener('close', onLoss);
      direct.removeEventListener('message', onProtocol);
    }
  } catch {
    return 'unknown';
  } finally {
    if (socket) {
      // This is a read-only socket close, never Target.closeTarget or Page.close.
      // If a handshake is late, the one-shot open handler disposes it too.
      if (socket.readyState === 0) {
        socket.addEventListener('open', () => { try { socket?.close(); } catch { /* disconnected */ } },
          { once: true });
      }
      try { socket.close(); } catch { /* connection still pending or lost */ }
    }
  }
}

/**
 * One bounded direct-target fanout on the *selected* CDP endpoint. This API
 * never uses Playwright enumeration, never changes sibling DOM and never
 * establishes browser-context membership. A lost discriminator is unknown.
 */
export async function probeCdpSiblingEvaluations(
  cdp: string,
  ownedTargetId: string,
  originals?: readonly SiblingEvaluationTarget[],
  budgetMs = SIBLING_PROBE_MAX_MS,
): Promise<SiblingEvaluationProbe> {
  const empty = (): SiblingEvaluationProbe => ({
    nonresponsive: [], responsive: [], disappearedOrChanged: [], unknown: originals ?? [],
  });
  if (!ownedTargetId || !Number.isFinite(budgetMs) || budgetMs <= 0) return empty();
  const end = performance.now() + Math.min(budgetMs, SIBLING_PROBE_MAX_MS);
  const remaining = (): number => Math.max(0, end - performance.now());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, remaining()));
  try {
    const pages = await enumerateSiblingTargets(cdp, remaining, controller.signal);
    if (!pages || controller.signal.aborted) return empty();
    const own = pages.find((target) => target.id === ownedTargetId
      && target.type === 'page' && isChatGptProbeTarget(target.url));
    if (!own) return empty();
    const selected = originals
      ? [...originals].sort((a, b) => a.id.localeCompare(b.id)).slice(0, SIBLING_PROBE_MAX_TARGETS)
      : pages.filter((target) => target.id !== ownedTargetId && isChatGptProbeTarget(target.url))
        .sort((a, b) => a.id.localeCompare(b.id)).slice(0, SIBLING_PROBE_MAX_TARGETS)
        .map((target) => ({ id: target.id, url: target.url }));
    const disappearedOrChanged: SiblingEvaluationTarget[] = [];
    const candidates: Array<{ identity: SiblingEvaluationTarget; target: ProbePageTarget }> = [];
    for (const original of selected) {
      const current = pages.find((target) => target.id === original.id);
      if (!current || current.type !== 'page' || current.url !== original.url
        || !isChatGptProbeTarget(current.url)) {
        disappearedOrChanged.push(original);
      } else {
        candidates.push({ identity: original, target: current });
      }
    }
    const [ownHealth, ...observations] = await Promise.all([
      probeOneTarget(cdp, own, remaining, controller.signal),
      ...candidates.map(({ target }) => probeOneTarget(cdp, target, remaining, controller.signal)),
    ]);
    if (ownHealth !== 'responsive' || controller.signal.aborted) {
      return { nonresponsive: [], responsive: [],
        disappearedOrChanged, unknown: candidates.map(({ identity }) => identity) };
    }
    const nonresponsive: SiblingEvaluationTarget[] = [];
    const responsive: SiblingEvaluationTarget[] = [];
    const unknown: SiblingEvaluationTarget[] = [];
    candidates.forEach(({ identity }, index) => {
      const kind = observations[index];
      if (kind === 'nonresponsive') nonresponsive.push(identity);
      else if (kind === 'responsive') responsive.push(identity);
      else unknown.push(identity);
    });
    return { nonresponsive, responsive, disappearedOrChanged, unknown };
  } catch {
    return empty();
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
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
  private readonly createCommands = new Map<number, string | undefined>();
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

  private sendFailure(id: number, cause: string, sessionId?: string): void {
    this.sendClient({ id, ...(sessionId ? { sessionId } : {}), error: { code: -32000, message: cause } });
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
      this.sendFailure(id, 'foreign_page_session_forbidden', sessionId);
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
        this.sendClient({ id, ...(sessionId ? { sessionId } : {}), result: {} });
      } catch {
        this.sendFailure(id, 'own_target_attach_failed', sessionId);
      }
      return;
    }
    if (method === 'Target.autoAttachRelated' || method === 'Target.setRemoteLocations'
      || method === 'Target.attachToBrowserTarget' || method === 'Browser.close'
      || method === 'Target.disposeBrowserContext') {
      this.sendFailure(id, 'cross_target_attach_forbidden', sessionId);
      return;
    }
    if (typeof params.sessionId === 'string' && !this.sessions.has(params.sessionId)) {
      this.sendFailure(id, 'foreign_page_session_forbidden', sessionId);
      return;
    }
    if (typeof params.targetId === 'string' && !this.allowedTargetIds.has(params.targetId)) {
      this.sendFailure(id, 'foreign_target_forbidden', sessionId);
      return;
    }
    if (method === 'Target.closeTarget' && !this.createdTargetIds.has(String(params.targetId ?? ''))) {
      this.sendFailure(id, 'existing_page_close_forbidden', sessionId);
      return;
    }
    if (method === 'Target.createTarget') this.createCommands.set(id, sessionId);
    if (this.remote.readyState !== WebSocket.OPEN) {
      this.sendFailure(id, 'cdp_proxy_disconnected', sessionId);
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
    const createSessionId = typeof message.id === 'number'
      ? this.createCommands.get(message.id) : undefined;
    if (typeof message.id === 'number' && this.createCommands.has(message.id)) {
      this.createCommands.delete(message.id);
      const targetId = message.result?.targetId;
      if (typeof targetId === 'string' && !message.error) {
        this.allowedTargetIds.add(targetId);
        this.createdTargetIds.add(targetId);
        try {
          if (this.bootstrapEnabled) await this.attachOne(targetId);
        } catch {
          this.sendFailure(message.id, 'own_target_attach_failed', createSessionId);
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('cdp_proxy_cleanup_unconfirmed')),
            Math.max(1, budgetMs),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
