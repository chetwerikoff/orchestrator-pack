import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeOwnedTurnPage,
  releaseCdpBrowser,
} from '../chatgpt-browser-turn/browser-session.ts';
import { configuredProfileKey } from '../chatgpt-browser-turn/storage-common.ts';
import { openTurnPage } from '../chatgpt-browser-turn/ui-adapter.ts';
import { probeProfileReady } from '../chatgpt-browser-turn/profile-probe.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let root = '';
let profilePath = '';
let profileKey = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opk-1007-'));
  process.env.CHATGPT_BROWSER_TURN_STATE_DIR = join(root, 'state');
  profilePath = join(root, 'profile');
  profileKey = configuredProfileKey(profilePath, 'http://127.0.0.1:9222');
});

afterEach(() => {
  delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
  vi.resetModules();
  vi.doUnmock('../chatgpt-browser-turn/ui-adapter.ts');
  vi.doUnmock('../chatgpt-browser-turn/state.ts');
  vi.doUnmock('../chatgpt-browser-turn/publication.ts');
  if (root) rmSync(root, { recursive: true, force: true });
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
}): Promise<{
  readonly runCli: typeof import('../chatgpt-browser-turn.ts').runCli;
  readonly pageCalls: string[];
  readonly browserCalls: string[];
  readonly deleteIncident: ReturnType<typeof vi.fn>;
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

  const mod = await import('../chatgpt-browser-turn.ts');
  return {
    runCli: mod.runCli,
    pageCalls: pageTracker.calls,
    browserCalls: browserTracker.calls,
    deleteIncident,
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
    const order: string[] = [];
    const deleteIncident = vi.fn(() => { order.push('deleteIncident'); });
    const { runCli } = await importRunCliWithMocks({
      owned: true,
      deleteIncidentSpy: deleteIncident,
      sendResult: {
        state: 'ui_contract_mismatch',
        cause: 'composer_unavailable',
        possibleDelivery: false,
      },
    });
    const pageClose = vi.fn(async () => { order.push('page.close'); });
    const ui = await import('../chatgpt-browser-turn/ui-adapter.ts');
    (ui.openTurnPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: { close: pageClose },
      owned: true,
    });

    const exitCode = await runCli(turnArgv(join(root, 'reply-failure.txt')));
    expect(exitCode).toBe(10);
    expect(order).toEqual(['page.close', 'deleteIncident']);
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
});

describe('issue 1007 live CDP precondition note', () => {
  it('records the adopted-context page survival assumption for operators', () => {
    const notePath = join(repoRoot, 'scripts', 'chatgpt-browser-turn', 'fixtures', 'cdp-page-survival-precondition.md');
    expect(notePath).toContain('cdp-page-survival-precondition.md');
  });
});
