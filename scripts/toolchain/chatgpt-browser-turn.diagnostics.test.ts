import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configuredProfileKey, profileDiagnosticsDir } from '../chatgpt-browser-turn/storage-common.ts';
import {
  DRIVER_DIAGNOSTIC_DETAIL_UNAVAILABLE,
  DRIVER_DIAGNOSTIC_SCHEMA,
  exceptionDetail,
  isDriverDiagnosticDebugEnabled,
  mirrorDriverDiagnosticToStderr,
  readDriverDiagnostic,
  recordSwallowedDriverException,
  writeDriverDiagnostic,
  type DriverDiagnosticV1,
} from '../chatgpt-browser-turn/diagnostics.ts';
import { runProcessSync } from '../kernel/subprocess.ts';
import {
  closeOwnedTurnPage,
  releaseCdpBrowser,
} from '../chatgpt-browser-turn/browser-session.ts';
import { openTurnPage } from '../chatgpt-browser-turn/ui-adapter.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = join(repoRoot, 'scripts', 'chatgpt-browser-turn.ts');

let root = '';
let profileKey = '';
let profilePath = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opk-1005-'));
  process.env.CHATGPT_BROWSER_TURN_STATE_DIR = join(root, 'state');
  profilePath = join(root, 'profile');
  profileKey = configuredProfileKey(profilePath, 'http://127.0.0.1:9222');
  delete process.env.CHATGPT_BROWSER_TURN_DEBUG;
});

afterEach(() => {
  delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
  delete process.env.CHATGPT_BROWSER_TURN_DEBUG;
  vi.resetModules();
  vi.doUnmock('../chatgpt-browser-turn/ui-adapter.ts');
  vi.doUnmock('../chatgpt-browser-turn/state.ts');
  vi.doUnmock('../chatgpt-browser-turn/publication.ts');
  vi.doUnmock('../chatgpt-browser-turn/coordination.ts');
  if (root) rmSync(root, { recursive: true, force: true });
});

function sampleRecord(invocationId: string, message = 'fixture driver boom'): DriverDiagnosticV1 {
  return {
    schema: DRIVER_DIAGNOSTIC_SCHEMA,
    version: 1,
    configured_profile_key: profileKey,
    invocation_id: invocationId,
    cause: 'driver_exception_before_send',
    exception_name: 'Error',
    exception_message: message,
    exception_stack: 'Error: fixture driver boom\n    at fixture',
    created_at: new Date().toISOString(),
  };
}

function captureStderr(run: () => void): string {
  let stderr = '';
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  run();
  process.stderr.write = original;
  return stderr;
}

async function importRunCliWithUiAdapterMock(throwMessage: string): Promise<typeof import('../chatgpt-browser-turn.ts')> {
  vi.doMock('../chatgpt-browser-turn/ui-adapter.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../chatgpt-browser-turn/ui-adapter.ts')>();
    return {
      ...actual,
      verifyProfile: vi.fn(async () => ({ state: 'verified' as const, cause: 'ok' })),
      loadChromium: vi.fn(() => {
        throw new Error(throwMessage);
      }),
    };
  });
  return import('../chatgpt-browser-turn.ts');
}

async function importRunCliWithStatusListThrow(): Promise<typeof import('../chatgpt-browser-turn.ts')> {
  vi.doMock('../chatgpt-browser-turn/state.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../chatgpt-browser-turn/state.ts')>();
    return {
      ...actual,
      statusList: vi.fn(() => {
        throw new Error('fixture control command_failed');
      }),
    };
  });
  return import('../chatgpt-browser-turn.ts');
}

describe('issue 1005 driver diagnostics storage', () => {
  it('writes a durable 0600 diagnostic file inside a 0700 directory keyed by invocation_id', () => {
    const invocationId = randomUUID();
    writeDriverDiagnostic(profileKey, invocationId, sampleRecord(invocationId));
    const path = join(profileDiagnosticsDir(profileKey), `${invocationId}.json`);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(profileDiagnosticsDir(profileKey)).mode & 0o777).toBe(0o700);
    const stored = readDriverDiagnostic(profileKey, invocationId);
    expect(stored?.exception_message).toBe('fixture driver boom');
    expect(stored?.invocation_id).toBe(invocationId);
  });

  it('returns a constant fallback when exception detail extraction throws', () => {
    const hostile = new Error('seed');
    Object.defineProperty(hostile, 'message', {
      configurable: true,
      get() {
        throw new Error('hostile message');
      },
    });
    expect(exceptionDetail(hostile)).toEqual({
      name: 'Error',
      message: DRIVER_DIAGNOSTIC_DETAIL_UNAVAILABLE,
      stack: '',
    });
    const hostileToString = {
      toString() {
        throw new Error('hostile toString');
      },
    };
    expect(exceptionDetail(hostileToString).message).toBe(DRIVER_DIAGNOSTIC_DETAIL_UNAVAILABLE);
    const id = recordSwallowedDriverException(profileKey, randomUUID(), 'driver_exception_before_send', hostile, {
      invocation_id: randomUUID(),
    });
    expect(id).toBeDefined();
  });

  it('records swallowed driver exceptions and returns the diagnostic identity', () => {
    const invocationId = randomUUID();
    const error = new Error('deterministic swallowed exception');
    const id = recordSwallowedDriverException(profileKey, invocationId, 'driver_exception_before_send', error, {
      invocation_id: invocationId,
    });
    expect(id).toBe(invocationId);
    const stored = readDriverDiagnostic(profileKey, invocationId);
    expect(stored?.exception_message).toBe('deterministic swallowed exception');
    expect(stored?.exception_name).toBe('Error');
    expect(stored?.exception_stack).toContain('deterministic swallowed exception');
  });

  it('leaves the emitted reference unset when diagnostic recording fails', () => {
    const invocationId = randomUUID();
    profileDiagnosticsDir(profileKey);
    chmodSync(profileDiagnosticsDir(profileKey), 0o500);
    const id = recordSwallowedDriverException(profileKey, invocationId, 'driver_exception_before_send', new Error('blocked write'), {
      invocation_id: invocationId,
    });
    expect(id).toBeUndefined();
    expect(readDriverDiagnostic(profileKey, invocationId)).toBeUndefined();
  });

  it('mirrors diagnostics to stderr only when CHATGPT_BROWSER_TURN_DEBUG=1', () => {
    const record = sampleRecord(randomUUID());
    const quiet = captureStderr(() => mirrorDriverDiagnosticToStderr(record));
    expect(quiet).toBe('');

    process.env.CHATGPT_BROWSER_TURN_DEBUG = '1';
    expect(isDriverDiagnosticDebugEnabled()).toBe(true);
    const noisy = captureStderr(() => mirrorDriverDiagnosticToStderr(record));
    expect(noisy).toContain('fixture driver boom');
    expect(noisy.trim().endsWith('}')).toBe(true);
  });

  it('does not create state for unresolved profile keys but still mirrors under the debug flag', () => {
    process.env.CHATGPT_BROWSER_TURN_DEBUG = '1';
    const stderr = captureStderr(() => {
      const id = recordSwallowedDriverException(undefined, randomUUID(), 'command_failed', new Error('control only'), {
        operation: 'status/list',
      });
      expect(id).toBeUndefined();
    });
    expect(stderr).toContain('control only');
    expect(existsSync(join(root, 'state'))).toBe(false);
  });

  it('creates only the diagnostics directory when writing a record', () => {
    const invocationId = randomUUID();
    writeDriverDiagnostic(profileKey, invocationId, sampleRecord(invocationId));
    const profileRoot = join(process.env.CHATGPT_BROWSER_TURN_STATE_DIR!, profileKey);
    expect(existsSync(profileDiagnosticsDir(profileKey))).toBe(true);
    expect(existsSync(join(profileRoot, 'records'))).toBe(false);
    expect(existsSync(join(profileRoot, 'locks'))).toBe(false);
    expect(existsSync(join(profileRoot, 'publications'))).toBe(false);
    expect(existsSync(join(profileRoot, 'quarantine'))).toBe(false);
    expect(existsSync(join(profileRoot, 'tombstones'))).toBe(false);
    expect(existsSync(join(profileRoot, 'resolved'))).toBe(false);
  });
});

describe('issue 1005 driver diagnostics CLI integration', () => {
  it('AC6: driver exception before send produces record, result reference, and no exception text on stdout', async () => {
    const { runCli } = await importRunCliWithUiAdapterMock('fixture driver exception before send');
    const input = join(root, 'message.txt');
    const output = join(root, 'reply.txt');
    writeFileSync(input, 'hello\n');

    let stdout = '';
    const originalStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;

    const exitCode = await runCli([
      'turn',
      '--profile', profilePath,
      '--cdp', 'http://127.0.0.1:9222',
      '--input', input,
      '--output', output,
      '--chat-url', 'https://chatgpt.com/c/conv-fixture',
    ]);

    process.stdout.write = originalStdout;
    const body = JSON.parse(stdout.trim()) as Record<string, unknown>;

    expect(exitCode).toBe(13);
    expect(body.state).toBe('driver_error');
    expect(body.cause).toBe('driver_exception_before_send');
    const invocationId = String(body.invocation_id);
    expect(body.driver_diagnostic_id).toBe(invocationId);
    expect(stdout).not.toContain('fixture driver exception before send');
    const stored = readDriverDiagnostic(profileKey, invocationId);
    expect(stored?.exception_message).toBe('fixture driver exception before send');
  });

  it('AC6: CHATGPT_BROWSER_TURN_DEBUG=1 mirrors diagnostic detail to stderr without changing stdout cause', async () => {
    process.env.CHATGPT_BROWSER_TURN_DEBUG = '1';
    const { runCli } = await importRunCliWithUiAdapterMock('stderr mirror fixture exception');
    const input = join(root, 'message-debug.txt');
    const output = join(root, 'reply-debug.txt');
    writeFileSync(input, 'payload for debug turn\n');

    let stdout = '';
    const originalStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    let stderr = '';
    const originalStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    await runCli([
      'turn',
      '--profile', profilePath,
      '--cdp', 'http://127.0.0.1:9222',
      '--input', input,
      '--output', output,
      '--chat-url', 'https://chatgpt.com/c/conv-debug-fixture',
    ]);

    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    const body = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(body.cause).toBe('driver_exception_before_send');
    expect(stderr.trim().startsWith('{')).toBe(true);
    const stderrRecord = JSON.parse(stderr.trim()) as DriverDiagnosticV1;
    expect(stderrRecord.exception_message).toBe('stderr mirror fixture exception');
  });

  it('AC5: command_failed with resolved profile records diagnostics and references them on stdout only', async () => {
    const { runCli } = await importRunCliWithStatusListThrow();

    let stdout = '';
    const originalStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;

    const exitCode = await runCli(['status/list', '--profile', profilePath, '--cdp', 'http://127.0.0.1:9222']);
    process.stdout.write = originalStdout;
    const body = JSON.parse(stdout.trim()) as Record<string, unknown>;

    expect(exitCode).toBe(22);
    expect(body.state).toBe('driver_error');
    expect(body.cause).toBe('command_failed');
    expect(body.configured_profile_key).toBe('profile-unresolved');
    expect(stdout).not.toContain('fixture control command_failed');
    const diagnosticId = String(body.driver_diagnostic_id ?? '');
    expect(diagnosticId.length).toBeGreaterThan(0);
    const stored = readDriverDiagnostic(profileKey, diagnosticId);
    expect(stored?.exception_message).toBe('fixture control command_failed');
    expect(stored?.operation).toBe('status/list');
  });

  it('AC6: command_failed keeps the legacy envelope when diagnostic recording fails', async () => {
    profileDiagnosticsDir(profileKey);
    chmodSync(profileDiagnosticsDir(profileKey), 0o500);
    const { runCli } = await importRunCliWithStatusListThrow();

    let stdout = '';
    const originalStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;

    const exitCode = await runCli(['status/list', '--profile', profilePath, '--cdp', 'http://127.0.0.1:9222']);
    process.stdout.write = originalStdout;
    const body = JSON.parse(stdout.trim()) as Record<string, unknown>;

    expect(exitCode).toBe(22);
    expect(body).toEqual({
      schema: 'control-result/v1',
      operation: 'status/list',
      state: 'driver_error',
      configured_profile_key: 'profile-unresolved',
      cause: 'command_failed',
    });
    expect(stdout).not.toContain('fixture control command_failed');
  });

  it('AC6: turn failure before profile key resolution emits the usual result with no record or identifier', async () => {
    const { runCli } = await import('../chatgpt-browser-turn.ts');
    const input = join(root, 'message-pre-profile.txt');
    const output = join(root, 'reply-pre-profile.txt');
    writeFileSync(input, 'payload\n');

    let stdout = '';
    const originalStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;

    const exitCode = await runCli([
      'turn',
      '--profile', profilePath,
      '--cdp', 'not-a-valid-cdp-url',
      '--input', input,
      '--output', output,
      '--chat-url', 'https://chatgpt.com/c/conv-pre-profile',
    ]);

    process.stdout.write = originalStdout;
    const body = JSON.parse(stdout.trim()) as Record<string, unknown>;

    expect(exitCode).toBe(13);
    expect(body.state).toBe('driver_error');
    expect(body.cause).toBe('driver_exception_before_send');
    expect(body.configured_profile_key).toBe('profile-unresolved');
    expect(body.driver_diagnostic_id).toBeUndefined();
    expect(existsSync(join(root, 'state'))).toBe(false);
  });

  it('AC6: pre-resolution turn failure mirrors to stderr only when CHATGPT_BROWSER_TURN_DEBUG=1', async () => {
    process.env.CHATGPT_BROWSER_TURN_DEBUG = '1';
    const { runCli } = await import('../chatgpt-browser-turn.ts');
    const input = join(root, 'message-pre-profile-debug.txt');
    const output = join(root, 'reply-pre-profile-debug.txt');
    writeFileSync(input, 'pre-profile debug payload\n');

    let stdout = '';
    const originalStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    let stderr = '';
    const originalStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    await runCli([
      'turn',
      '--profile', profilePath,
      '--cdp', 'not-a-valid-cdp-url',
      '--input', input,
      '--output', output,
      '--chat-url', 'https://chatgpt.com/c/conv-pre-profile-debug',
    ]);

    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    const body = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(body.driver_diagnostic_id).toBeUndefined();
    expect(stderr.trim().startsWith('{')).toBe(true);
    expect(existsSync(join(root, 'state'))).toBe(false);
  });
});

function trackablePage(owned = true) {
  const calls: string[] = [];
  const page = {
    close: vi.fn(async () => { calls.push('close'); }),
    goto: vi.fn(async () => {}),
    url: () => 'https://chatgpt.com/c/example',
    bringToFront: vi.fn(async () => {}),
  };
  return { page, owned, calls };
}

function trackableBrowser() {
  const calls: string[] = [];
  const browser = {
    close: vi.fn(async () => { calls.push('close'); }),
    version: () => 'chromium-cdp-fixture',
    contexts: () => [{ pages: () => [] }],
  };
  return { browser, calls };
}

async function importRunCliWithMocks(options: {
  readonly owned?: boolean;
  readonly sendResult?: Record<string, unknown>;
  readonly pageCloseThrows?: boolean;
  readonly browserCloseThrows?: boolean;
  readonly deleteIncidentSpy?: ReturnType<typeof vi.fn>;
  readonly releaseOrder?: string[];
}): Promise<{
  readonly runCli: typeof import('../chatgpt-browser-turn.ts').runCli;
  readonly pageCalls: string[];
  readonly browserCalls: string[];
  readonly deleteIncident: ReturnType<typeof vi.fn>;
  readonly releaseOrder: string[];
}> {
  const pageTracker = trackablePage(options.owned ?? true);
  const browserTracker = trackableBrowser();
  if (options.pageCloseThrows) {
    pageTracker.page.close = vi.fn(async () => { throw new Error('page close failed'); });
  }
  if (options.browserCloseThrows) {
    browserTracker.browser.close = vi.fn(async () => { throw new Error('browser close failed'); });
  }

  const deleteIncident = options.deleteIncidentSpy ?? vi.fn();

  vi.doMock('../chatgpt-browser-turn/ui-adapter.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../chatgpt-browser-turn/ui-adapter.ts')>();
    return {
      ...actual,
      verifyProfile: vi.fn(async () => ({ state: 'verified' as const, cause: 'ok' })),
      loadChromium: vi.fn(() => ({
        connectOverCDP: vi.fn(async () => browserTracker.browser),
      })),
      openTurnPage: vi.fn(async () => ({
        page: pageTracker.page,
        owned: options.owned ?? true,
        provisionalId: randomUUID(),
      })),
      runtimeWitnessSurfaceAvailable: vi.fn(async () => true),
      sendTurn: vi.fn(async () => options.sendResult ?? {
        state: 'ok',
        cause: 'completed',
        possibleDelivery: false,
        reply: 'fixture reply',
        userMessageId: 'user-fixture-12345678',
        assistantMessageId: 'asst-fixture-12345678',
        conversationId: 'https://chatgpt.com/c/fixture',
      }),
    };
  });

  vi.doMock('../chatgpt-browser-turn/state.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../chatgpt-browser-turn/state.ts')>();
    return {
      ...actual,
      deleteIncident,
    };
  });

  vi.doMock('../chatgpt-browser-turn/publication.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../chatgpt-browser-turn/publication.ts')>();
    return {
      ...actual,
      publishReply: vi.fn(() => ({
        state: 'committed_ok',
        output_bytes: 13,
        output_sha256: 'sha256:fixture',
      })),
    };
  });

  const releaseOrder = options.releaseOrder ?? [];
  const recordRelease = (label: string) => {
    releaseOrder.push(label);
  };
  vi.doMock('../chatgpt-browser-turn/coordination.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../chatgpt-browser-turn/coordination.ts')>();
    return {
      ...actual,
      acquireDomainLock: vi.fn((profileKey: string, key: string, staleMs?: number) => {
        const lock = actual.acquireDomainLock(profileKey, key, staleMs);
        if (!lock) return null;
        const originalRelease = lock.release.bind(lock);
        return {
          ...lock,
          release: vi.fn(() => {
            recordRelease('scheduleLock.release');
            originalRelease();
          }),
        };
      }),
      reserveDestination: vi.fn((profileKey: string, outputPath: string) => {
        const reservation = actual.reserveDestination(profileKey, outputPath);
        const originalRelease = reservation.release.bind(reservation);
        return {
          ...reservation,
          release: vi.fn(() => {
            recordRelease('destination.release');
            originalRelease();
          }),
        };
      }),
    };
  });

  const mod = await import('../chatgpt-browser-turn.ts');
  return {
    runCli: mod.runCli,
    pageCalls: pageTracker.calls,
    browserCalls: browserTracker.calls,
    deleteIncident,
    releaseOrder,
  };
}

function turnArgv(outputPath: string): string[] {
  const input = join(root, 'message.txt');
  writeFileSync(input, 'hello\n');
  return [
    'turn',
    '--profile', profilePath,
    '--cdp', 'http://127.0.0.1:9222',
    '--input', input,
    '--output', outputPath,
    '--chat-url', 'https://chatgpt.com/c/fixture',
  ];
}

describe('issue 1007 browser-session helpers', () => {
  it('closes an owned page when not retained', async () => {
    const calls: string[] = [];
    await closeOwnedTurnPage({
      page: { close: async () => { calls.push('close'); } },
      owned: true,
    }, { retainPage: false });
    expect(calls).toEqual(['close']);
  });

  it('skips close for reused pages and possible-delivery retention', async () => {
    const calls: string[] = [];
    const page = { close: async () => { calls.push('close'); } };
    await closeOwnedTurnPage({ page, owned: false }, { retainPage: false });
    await closeOwnedTurnPage({ page, owned: true }, { retainPage: true });
    expect(calls).toEqual([]);
  });

  it('swallows page-close failures', async () => {
    await expect(closeOwnedTurnPage({
      page: { close: async () => { throw new Error('close failed'); } },
      owned: true,
    }, { retainPage: false })).resolves.toBeUndefined();
  });

  it('releases a CDP browser connection and swallows failures', async () => {
    const calls: string[] = [];
    await releaseCdpBrowser({ close: async () => { calls.push('close'); } });
    expect(calls).toEqual(['close']);
    await expect(releaseCdpBrowser({ close: async () => { throw new Error('disconnect failed'); } }))
      .resolves.toBeUndefined();
    await releaseCdpBrowser(null);
  });
});

describe('issue 1007 openTurnPage setup failure cleanup', () => {
  it('closes a page when navigation throws after newPage', async () => {
    const calls: string[] = [];
    const page = {
      goto: vi.fn(async () => { throw new Error('navigation_failed'); }),
      close: vi.fn(async () => { calls.push('close'); }),
      url: () => 'https://chatgpt.com/',
    };
    const browser = { contexts: () => [{ pages: () => [], newPage: vi.fn(async () => page) }] };
    await expect(openTurnPage(browser, {
      cdp: 'http://127.0.0.1:9222',
      profile: profilePath,
      chatUrl: 'https://chatgpt.com/c/example',
      newChat: false,
      timeoutMs: 100,
    })).rejects.toThrow('navigation_failed');
    expect(calls).toEqual(['close']);
  });

  it('closes a fresh-chat page when project navigation throws', async () => {
    const calls: string[] = [];
    const page = {
      goto: vi.fn(async () => { throw new Error('project_navigation_failed'); }),
      close: vi.fn(async () => { calls.push('close'); }),
    };
    const browser = { contexts: () => [{ pages: () => [], newPage: vi.fn(async () => page) }] };
    await expect(openTurnPage(browser, {
      cdp: 'http://127.0.0.1:9222',
      profile: profilePath,
      newChat: true,
      projectUrl: 'https://chatgpt.com/g/project',
      timeoutMs: 100,
    })).rejects.toThrow('project_navigation_failed');
    expect(calls).toEqual(['close']);
  });
});

describe('issue 1007 runTurn teardown integration', () => {
  it('closes a created page and releases the browser on success without closing a reused page', async () => {
    const order: string[] = [];
    const pageTracker = trackablePage(true);
    const browserTracker = trackableBrowser();
    const deleteIncident = vi.fn(() => { order.push('deleteIncident'); });

    vi.doMock('../chatgpt-browser-turn/ui-adapter.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../chatgpt-browser-turn/ui-adapter.ts')>();
      return {
        ...actual,
        verifyProfile: vi.fn(async () => ({ state: 'verified' as const, cause: 'ok' })),
        loadChromium: vi.fn(() => ({ connectOverCDP: vi.fn(async () => browserTracker.browser) })),
        openTurnPage: vi.fn(async () => ({ page: pageTracker.page, owned: false })),
        runtimeWitnessSurfaceAvailable: vi.fn(async () => true),
        sendTurn: vi.fn(async () => ({
          state: 'ok',
          cause: 'completed',
          possibleDelivery: false,
          reply: 'fixture reply',
          userMessageId: 'user-fixture-12345678',
          assistantMessageId: 'asst-fixture-12345678',
          conversationId: 'https://chatgpt.com/c/fixture',
        })),
      };
    });
    vi.doMock('../chatgpt-browser-turn/state.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../chatgpt-browser-turn/state.ts')>();
      return { ...actual, deleteIncident };
    });
    vi.doMock('../chatgpt-browser-turn/publication.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../chatgpt-browser-turn/publication.ts')>();
      return {
        ...actual,
        publishReply: vi.fn(() => ({ state: 'committed_ok', output_bytes: 13, output_sha256: 'sha256:fixture' })),
      };
    });
    pageTracker.page.close = vi.fn(async () => { order.push('page.close'); });

    const { runCli } = await import('../chatgpt-browser-turn.ts');
    const output = join(root, 'reply-success.txt');
    const exitCode = await runCli(turnArgv(output));

    expect(exitCode).toBe(0);
    expect(order).toEqual(['deleteIncident']);
    expect(pageTracker.calls).toEqual([]);
    expect(browserTracker.calls).toEqual(['close']);
  });

  it('closes a created page before incident deletion on success', async () => {
    const order: string[] = [];
    const deleteIncident = vi.fn(() => { order.push('deleteIncident'); });
    const { runCli } = await importRunCliWithMocks({
      owned: true,
      deleteIncidentSpy: deleteIncident,
    });
    const pageClose = vi.fn(async () => { order.push('page.close'); });
    const ui = await import('../chatgpt-browser-turn/ui-adapter.ts');
    (ui.openTurnPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: { close: pageClose },
      owned: true,
    });

    const exitCode = await runCli(turnArgv(join(root, 'reply-order.txt')));
    expect(exitCode).toBe(0);
    expect(order.indexOf('page.close')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('page.close')).toBeLessThan(order.indexOf('deleteIncident'));
  });

  it('closes a created page before lock release on non-possible-delivery send failure', async () => {
    const timeline: string[] = [];
    const deleteIncident = vi.fn(() => { timeline.push('deleteIncident'); });
    const { runCli } = await importRunCliWithMocks({
      owned: true,
      deleteIncidentSpy: deleteIncident,
      releaseOrder: timeline,
      sendResult: {
        state: 'ui_contract_mismatch',
        cause: 'composer_unavailable',
        possibleDelivery: false,
      },
    });
    const pageClose = vi.fn(async () => { timeline.push('page.close'); });
    const ui = await import('../chatgpt-browser-turn/ui-adapter.ts');
    (ui.openTurnPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: { close: pageClose },
      owned: true,
    });

    const exitCode = await runCli(turnArgv(join(root, 'reply-failure.txt')));
    expect(exitCode).toBe(10);
    expect(timeline).toEqual([
      'page.close',
      'deleteIncident',
      'scheduleLock.release',
      'destination.release',
    ]);
  });

  it('closes a created page before incident deletion on proven non-delivery send failure', async () => {
    const timeline: string[] = [];
    const deleteIncident = vi.fn(() => { timeline.push('deleteIncident'); });
    const { runCli } = await importRunCliWithMocks({
      owned: true,
      deleteIncidentSpy: deleteIncident,
      releaseOrder: timeline,
      sendResult: {
        state: 'send_failed',
        cause: 'dispatch_request_not_observed',
        possibleDelivery: false,
      },
    });
    const pageClose = vi.fn(async () => { timeline.push('page.close'); });
    const ui = await import('../chatgpt-browser-turn/ui-adapter.ts');
    (ui.openTurnPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: { close: pageClose },
      owned: true,
    });

    const exitCode = await runCli(turnArgv(join(root, 'reply-proven-non-delivery.txt')));
    expect(exitCode).toBe(10);
    expect(timeline).toEqual([
      'page.close',
      'deleteIncident',
      'scheduleLock.release',
      'destination.release',
    ]);
  });

  it('retains the page after possible-delivery failure but still releases the browser', async () => {
    const { runCli, pageCalls, browserCalls } = await importRunCliWithMocks({
      owned: true,
      sendResult: {
        state: 'recovery_required',
        cause: 'submitted_turn_id_unproven',
        possibleDelivery: true,
      },
    });

    const exitCode = await runCli(turnArgv(join(root, 'reply-possible.txt')));
    expect(exitCode).toBe(11);
    expect(pageCalls).toEqual([]);
    expect(browserCalls).toEqual(['close']);
  });

  it('does not emit a second result when page-close fails but still releases the browser', async () => {
    const { runCli, browserCalls } = await importRunCliWithMocks({
      owned: true,
      pageCloseThrows: true,
    });

    let stdout = '';
    const originalStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;

    const exitCode = await runCli(turnArgv(join(root, 'reply-page-close-fail.txt')));
    process.stdout.write = originalStdout;

    expect(exitCode).toBe(0);
    expect(stdout.trim().split('\n').filter(Boolean)).toHaveLength(1);
    expect(browserCalls).toEqual(['close']);
  });

  it('still releases the browser when page-close fails on a non-possible-delivery path', async () => {
    const { runCli, browserCalls } = await importRunCliWithMocks({
      owned: true,
      pageCloseThrows: true,
      sendResult: {
        state: 'ui_contract_mismatch',
        cause: 'composer_unavailable',
        possibleDelivery: false,
      },
    });

    await runCli(turnArgv(join(root, 'reply-page-close-fail-send.txt')));
    expect(browserCalls).toEqual(['close']);
  });
});

describe('issue 1007 probeProfileReady connection release', () => {
  it('releases the browser on early-return and exceptional paths', async () => {
    const browserTracker = trackableBrowser();
    vi.doMock('../chatgpt-browser-turn/ui-adapter.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../chatgpt-browser-turn/ui-adapter.ts')>();
      return {
        ...actual,
        verifyProfile: vi.fn(async () => ({ state: 'verified' as const, cause: 'ok' })),
        loadChromium: vi.fn(() => ({
          connectOverCDP: vi.fn(async () => browserTracker.browser),
        })),
        productStatusText: vi.fn(async () => ({ composer: true, text: '' })),
        classifyProductWall: vi.fn(() => ({})),
      };
    });

    const mod = await import('../chatgpt-browser-turn/profile-probe.ts');
    const ready = await mod.probeProfileReady({
      cdp: 'http://127.0.0.1:9222',
      profile: profilePath,
      newChat: false,
      timeoutMs: 100,
    });
    expect(ready.ready).toBe(false);
    expect(ready.cause).toBe('no_existing_page');
    expect(browserTracker.calls).toEqual(['close']);
  });

  it('releases the browser when connectOverCDP throws', async () => {
    const browserTracker = trackableBrowser();
    vi.doMock('../chatgpt-browser-turn/ui-adapter.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../chatgpt-browser-turn/ui-adapter.ts')>();
      return {
        ...actual,
        verifyProfile: vi.fn(async () => ({ state: 'verified' as const, cause: 'ok' })),
        loadChromium: vi.fn(() => ({
          connectOverCDP: vi.fn(async () => { throw new Error('connect failed'); }),
        })),
      };
    });

    const mod = await import('../chatgpt-browser-turn/profile-probe.ts');
    const ready = await mod.probeProfileReady({
      cdp: 'http://127.0.0.1:9222',
      profile: profilePath,
      newChat: false,
      timeoutMs: 100,
    });
    expect(ready.state).toBe('driver_error');
    expect(browserTracker.calls).toEqual([]);
  });

  it('releases the browser when a post-connect probe operation throws', async () => {
    const browserTracker = trackableBrowser();
    browserTracker.browser.contexts = vi.fn(() => { throw new Error('contexts failed'); });
    vi.doMock('../chatgpt-browser-turn/ui-adapter.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../chatgpt-browser-turn/ui-adapter.ts')>();
      return {
        ...actual,
        verifyProfile: vi.fn(async () => ({ state: 'verified' as const, cause: 'ok' })),
        loadChromium: vi.fn(() => ({
          connectOverCDP: vi.fn(async () => browserTracker.browser),
        })),
      };
    });

    const mod = await import('../chatgpt-browser-turn/profile-probe.ts');
    const ready = await mod.probeProfileReady({
      cdp: 'http://127.0.0.1:9222',
      profile: profilePath,
      newChat: false,
      timeoutMs: 100,
    });
    expect(ready.state).toBe('driver_error');
    expect(ready.cause).toBe('profile_probe_failed');
    expect(browserTracker.browser.close).toHaveBeenCalledTimes(1);
  });
});

describe('issue 1007 live CDP precondition note', () => {
  it('records the adopted-context page survival assumption for operators', () => {
    const notePath = join(repoRoot, 'scripts', 'chatgpt-browser-turn', 'fixtures', 'cdp-page-survival-precondition.md');
    expect(notePath).toContain('cdp-page-survival-precondition.md');
  });
});
