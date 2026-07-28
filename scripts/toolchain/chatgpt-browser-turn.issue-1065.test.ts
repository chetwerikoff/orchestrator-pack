import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserOperationTimeoutError } from '../chatgpt-browser-turn/ui-adapter.ts';
import {
  classifyPreDispatchProductWall,
  classifyProductWall,
  openTurnPage,
  productStatusText,
  type BrowserConfig,
} from '../chatgpt-browser-turn/ui-adapter.ts';
import { readDriverDiagnostic } from '../chatgpt-browser-turn/diagnostics.ts';
import { configuredProfileKey } from '../chatgpt-browser-turn/storage-common.ts';

let root = '';
const cdp = 'http://127.0.0.1:9222';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opk-1065-'));
  process.env.CHATGPT_BROWSER_TURN_STATE_DIR = join(root, 'state');
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
  if (root) rmSync(root, { recursive: true, force: true });
});

function productStatusPage(elements: Array<{ text: string; testId?: string; role?: string }>, composer = false): any {
  return {
    locator: (selector: string) => {
      if (selector === '#prompt-textarea') {
        return { count: async () => composer ? 1 : 0 };
      }
      const matches = elements.filter((element) => {
        if (selector === '[role="alert"]') return element.role === 'alert';
        if (selector === '[role="dialog"]') return element.role === 'dialog';
        if (selector === '[data-testid*="limit"]') return element.testId?.includes('limit');
        if (selector === '[data-testid*="quota"]') return element.testId?.includes('quota');
        if (selector === '[data-testid*="challenge"]') return element.testId?.includes('challenge');
        if (selector === '[data-testid*="login"]') return element.testId?.includes('login');
        if (selector === '[data-testid*="auth"]') return element.testId?.includes('auth');
        if (selector === '[data-testid*="error"]') return element.testId?.includes('error');
        return false;
      });
      return {
        count: async () => matches.length,
        nth: (index: number) => ({
          innerText: async () => matches[index]?.text ?? '',
          getAttribute: async (name: string) => name === 'data-testid' ? matches[index]?.testId ?? null : null,
        }),
      };
    },
  };
}

async function importRunCliWithConnectDegraded(): Promise<typeof import('../chatgpt-browser-turn.ts')> {
  vi.doMock('../chatgpt-browser-turn/ui-adapter.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../chatgpt-browser-turn/ui-adapter.ts')>();
    return {
      ...actual,
      verifyProfile: vi.fn(async () => ({ state: 'verified' as const, cause: 'verified', evidence: 'verified' })),
      loadChromium: vi.fn(() => ({
        connectOverCDP: vi.fn(async () => { throw new BrowserOperationTimeoutError('connect_over_cdp'); }),
      })),
    };
  });
  return import('../chatgpt-browser-turn.ts');
}

async function importRunCliWithGateBMock(): Promise<typeof import('../chatgpt-browser-turn.ts')> {
  vi.doMock('../chatgpt-browser-turn/ui-adapter.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../chatgpt-browser-turn/ui-adapter.ts')>();
    return {
      ...actual,
      loadChromium: vi.fn(() => ({
        connectOverCDP: vi.fn(async () => ({
          contexts: () => [{ pages: () => [] }],
          version: () => 'fixture',
          close: async () => {},
        })),
      })),
      openGateBCharacterizationPage: vi.fn(async () => ({
        page: { locator: () => ({ count: async () => 0 }) },
        owned: false,
      })),
    };
  });
  vi.doMock('../chatgpt-browser-turn/dispatch-observation.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../chatgpt-browser-turn/dispatch-observation.ts')>();
    return {
      ...actual,
      runGateBCharacterization: vi.fn(async () => []),
    };
  });
  return import('../chatgpt-browser-turn.ts');
}

describe('issue 1065 browser-surface classification', () => {
  it('AC1: names the observed conversation-history quota wall before dispatch', async () => {
    const page = productStatusPage([
      {
        role: 'dialog',
        testId: 'modal-conversation-history-rate-limit',
        text: 'Please wait a few minutes before trying again.',
      },
    ], true);
    const surface = await productStatusText(page);
    expect(classifyPreDispatchProductWall(surface)).toEqual({
      state: 'quota',
      cause: 'conversation_history_quota',
    });
  });

  it('AC2: unknown blocking dialogs fail closed; visible non-blocking product status is ignored', async () => {
    const blocking = productStatusPage([
      { role: 'dialog', testId: 'modal-unknown-product-wall', text: 'Unexpected product blocker' },
    ], false);
    expect(classifyPreDispatchProductWall(await productStatusText(blocking))).toEqual({
      state: 'ui_contract_mismatch',
      cause: 'unclassified_blocking_dialog:modal-unknown-product-wall',
    });

    const nonBlocking = productStatusPage([
      { role: 'alert', text: 'benign product notice' },
    ], true);
    expect(classifyPreDispatchProductWall(await productStatusText(nonBlocking))).toEqual({});
    expect(classifyProductWall(await productStatusText(nonBlocking))).toEqual({});
  });

  it('AC3: duplicate tabs expose bounded match diagnostics without auto-closing tabs', async () => {
    const page = (url: string) => ({ url: () => url, bringToFront: async () => {} });
    const browser = {
      contexts: () => [{
        pages: () => [
          page('https://chatgpt.com/c/a'),
          page('https://chatgpt.com/c/a'),
        ],
      }],
    };
    await expect(openTurnPage(browser, {
      cdp,
      profile: join(root, 'profile'),
      chatUrl: 'https://chatgpt.com/c/a',
      newChat: false,
      timeoutMs: 100,
    } as BrowserConfig)).rejects.toThrow(
      'ui_contract_mismatch:duplicate_tabs:count=2:url=https://chatgpt.com/c/a;url=https://chatgpt.com/c/a',
    );
    expect(browser.contexts()[0].pages().length).toBe(2);
  });

  it('AC4: Gate-B characterization control results use gate-b-characterization operation', async () => {
    const profile = join(root, 'profile');
    const { runCli } = await importRunCliWithGateBMock();
    let stdout = '';
    const originalStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    const exitCode = await runCli([
      'gate-b-characterization',
      '--profile', profile,
      '--cdp', cdp,
    ]);
    process.stdout.write = originalStdout;
    expect(exitCode).toBe(10);
    const body = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(body.operation).toBe('gate-b-characterization');
    expect(body.schema).toBe('control-result/v1');
  });

  it('AC5: bounded connectOverCDP degradation reports cdp_degraded with diagnostics', async () => {
    const profile = join(root, 'profile');
    const profileKey = configuredProfileKey(profile, cdp);
    const input = join(root, 'message.txt');
    const output = join(root, 'reply.txt');
    writeFileSync(input, 'payload\n');
    const { runCli } = await importRunCliWithConnectDegraded();
    let stdout = '';
    const originalStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    const exitCode = await runCli([
      'turn',
      '--profile', profile,
      '--cdp', cdp,
      '--input', input,
      '--output', output,
      '--chat-url', 'https://chatgpt.com/c/example',
    ]);
    process.stdout.write = originalStdout;
    expect(exitCode).toBe(13);
    const body = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(body.cause).toBe('cdp_degraded');
    expect(body.driver_diagnostic_id).toBeTruthy();
    const diagnostic = readDriverDiagnostic(profileKey, String(body.driver_diagnostic_id));
    expect(diagnostic?.cause).toBe('cdp_degraded');
  });

  it('AC6: unknown CLI options preserve argument cause and emit Usage on stderr', async () => {
    const { runCli } = await import('../chatgpt-browser-turn.ts');
    const profile = join(root, 'profile');
    let stdout = '';
    let stderr = '';
    const originalStdout = process.stdout.write.bind(process.stdout);
    const originalStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    const exitCode = await runCli([
      'status/list',
      '--profile', profile,
      '--cdp', cdp,
      '--bogus-flag', 'value',
    ]);
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    expect(exitCode).toBe(22);
    const body = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(body.cause).toBe('argument_unknown:bogus-flag');
    expect(stderr).toContain('Usage:');
  });
});
