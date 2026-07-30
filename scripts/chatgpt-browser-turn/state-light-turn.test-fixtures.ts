import type { TurnResultV1 } from './contracts.ts';
import { vi } from 'vitest';

import {
  ASSISTANT_TURN_ANCESTOR_XPATH,
  matchesAssistantTurnActionSelector,
  matchesAssistantTurnInProgressSelector,
  MESSAGE_AUTHOR_ROLE_ATTR,
} from './product-page-selectors.ts';

export function scalarLocator(overrides: Record<string, unknown> = {}) {
  const turnActionButtons = overrides.turnActionButtons === true;
  const locator: Record<string, any> = {
    count: vi.fn(async () => 0),
    first: vi.fn(function first() { return locator; }),
    nth: vi.fn(() => locator),
    locator: vi.fn((selector: string) => {
      if (turnActionButtons && matchesAssistantTurnActionSelector(selector)) {
        return scalarLocator({ count: vi.fn(async () => 1) });
      }
      return scalarLocator();
    }),
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    innerText: vi.fn(async () => ''),
    textContent: vi.fn(async () => ''),
    getAttribute: vi.fn(async () => null),
    or: vi.fn(function or() { return locator; }),
    ...overrides,
  };
  return locator;
}

export type StateLightTestMessage = {
  role: 'user' | 'assistant';
  text: string;
  finalAction?: boolean;
  finalActionInTurnContainer?: boolean;
  inProgress?: boolean;
};

export type StateLightTestSnapshot = {
  messages: StateLightTestMessage[];
  generating: boolean;
  continuation?: boolean;
};

export function messageLocator(message: StateLightTestMessage, generating = false) {
  return scalarLocator({
    count: vi.fn(async () => 1),
    getAttribute: vi.fn(async (name: string) => {
      if (name === MESSAGE_AUTHOR_ROLE_ATTR) return message.role;
      if (name === 'data-is-streaming') return generating ? 'true' : null;
      if (name === 'aria-busy') return null;
      return null;
    }),
    locator: vi.fn((selector: string) => {
      if (selector.startsWith('xpath=') || selector === ASSISTANT_TURN_ANCESTOR_XPATH || selector.includes('conversation-turn-')) {
        if (!message.finalActionInTurnContainer) return scalarLocator({ count: vi.fn(async () => 0) });
        return scalarLocator({ turnActionButtons: true, count: vi.fn(async () => 1) });
      }
      if (message.role !== 'assistant') return scalarLocator();
      if (message.finalAction && !message.finalActionInTurnContainer && matchesAssistantTurnActionSelector(selector)) {
        return scalarLocator({ count: vi.fn(async () => 1) });
      }
      if (message.inProgress && matchesAssistantTurnInProgressSelector(selector)) {
        return scalarLocator({ count: vi.fn(async () => 1) });
      }
      return scalarLocator();
    }),
    innerText: vi.fn(async () => message.text),
    textContent: vi.fn(async () => message.text),
  });
}

export function collectionLocator(messages: StateLightTestMessage[], generating = false) {
  return scalarLocator({
    count: vi.fn(async () => messages.length),
    nth: vi.fn((index: number) => messageLocator(messages[index]!, generating && index === messages.length - 1)),
  });
}

export function readyTurnObservationFrames(prompt: string, reply: string): StateLightTestMessage[][] {
  const working = [
    { role: 'user' as const, text: prompt },
    { role: 'assistant' as const, text: 'working' },
  ];
  const final = [
    { role: 'user' as const, text: prompt },
    {
      role: 'assistant' as const,
      text: reply,
      finalAction: true,
      finalActionInTurnContainer: true,
    },
  ];
  return [working, working, final, final];
}

export function stableTurnInput(prompt: string) {
  return {
    text: prompt,
    bytes: new Uint8Array([...prompt].map((char) => char.charCodeAt(0))),
    byteLength: prompt.length,
    dev: 1n,
    ino: 1n,
  };
}

export function browserFor(page: any) {
  const context = { newPage: vi.fn(async () => page) };
  return {
    browser: {
      contexts: vi.fn(() => [context]),
      isConnected: vi.fn(() => true),
      close: vi.fn(async () => undefined),
    },
    context,
  };
}

export function createBrowserSessionModuleMock(mocks: {
  cleanupOutcome: 'confirmed' | 'unconfirmed';
  releaseBrowser: ReturnType<typeof vi.fn>;
}) {
  return {
    RESOURCE_CLEANUP_BOUND_MS: 5_000,
    boundedResourceCleanup: vi.fn(async (cleanup: () => Promise<void>) => {
      if (mocks.cleanupOutcome === 'confirmed') await cleanup();
      return mocks.cleanupOutcome;
    }),
    releaseCdpBrowser: mocks.releaseBrowser,
  };
}

export function createCoordinationModuleMock() {
  return {
    destinationIdentity: vi.fn((path: string) => ({
      identity: `identity:${path}`,
      finalPath: path,
    })),
  };
}


export type StateLightUiAdapterTestMocks = {
  browserQueue: any[];
  verifyProfile: ReturnType<typeof vi.fn>;
};

export type StateLightUiAdapterTestOptions = {
  classifyProductWall?: (text: string) => object;
  normalizeConversationUrl?: (value: string) => string;
  productStatusText?: (page: any) => Promise<string> | string;
};

export function buildUiAdapterTestMock(
  actual: typeof import('./ui-adapter.ts'),
  mocks: StateLightUiAdapterTestMocks,
  options: StateLightUiAdapterTestOptions = {},
) {
  return {
    ...actual,
    classifyProductWall: vi.fn(options.classifyProductWall ?? (() => ({}))),
    loadChromium: vi.fn(() => ({
      connectOverCDP: vi.fn(async () => {
        const browser = mocks.browserQueue.shift();
        if (!browser) throw new Error('no fake browser queued');
        return browser;
      }),
    })),
    normalizeConversationUrl: options.normalizeConversationUrl
      ? vi.fn(options.normalizeConversationUrl)
      : actual.normalizeConversationUrl,
    productStatusText: vi.fn(options.productStatusText ?? (async () => '')),
    verifyProfile: mocks.verifyProfile,
  };
}

export function enqueueBrowserForTurn(mocks: { browserQueue: any[] }, page: any) {
  const harness = browserFor(page);
  mocks.browserQueue.push(harness.browser);
  return harness;
}

export type CapturedStateLightTurnResult = TurnResultV1 & {
  send_count?: number;
  poll_count?: number;
  goto_count?: number;
  new_chat_click_count?: number;
  navigation_count?: number;
  cleanup?: string;
  incidents?: string[];
  journal_write_failed?: boolean;
};

export async function runStateLightTurnWithStdoutCapture(
  runTurn: (args: string[]) => Promise<number>,
  argv: string[],
): Promise<{ code: number; result: CapturedStateLightTurnResult }> {
  const writes: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  try {
    const code = await runTurn(argv);
    return {
      code,
      result: JSON.parse(writes.at(-1) ?? '{}') as CapturedStateLightTurnResult,
    };
  } finally {
    stdout.mockRestore();
  }
}

export const STATE_LIGHT_TURN_BASE_ARGV = [
  '--profile', '/tmp/profile',
  '--cdp', 'http://127.0.0.1:9222',
  '--input', '/tmp/prompt.txt',
] as const;
