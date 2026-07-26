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
