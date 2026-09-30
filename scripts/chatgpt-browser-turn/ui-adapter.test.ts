import { describe, expect, it } from 'vitest';
import {
  classifyProductWall,
  createFreshIdentityRetention,
  enterExecutionRecoveryProductWallScope,
  observeFreshConversationUrl,
  productStatusText,
  promoteFreshCanonicalIdentity,
} from './ui-adapter.ts';
import { generateOwnedPromptMarker, wrapOwnedPromptPayload } from './owned-prompt-marker.ts';
import {
  ASSISTANT_MESSAGE_SELECTOR,
  COMPOSER_SELECTOR,
  CONVERSATION_TURN_SECTION_SELECTOR,
  MESSAGE_AUTHOR_ROLE_ATTR,
  MESSAGE_NODE_SELECTOR,
  REGENERATE_THREAD_ERROR_BUTTON_SELECTOR,
  PRODUCT_STATUS_PROBE_SELECTORS,
} from './product-page-selectors.ts';

const TIMEOUT_TEXT = 'Message delivery timed out. Please try again.';

function recoveryPage(options: { generationActive: boolean; laterUser?: boolean; statusReadDelayMs?: number }) {
  const marker = generateOwnedPromptMarker(() => new Uint8Array(16).fill(0x11));
  const turns = ['conversation-turn-1', 'conversation-turn-2'];
  const section = (key: string) => ({ getAttribute: (name: string) => name === 'data-turn-key' ? key : null });
  const userTurn = section(turns[0]!);
  const assistantTurn = section(turns[1]!);
  const retry = { innerText: 'Retry' };
  const roleMarker = (style: string) => ({
    getAttribute: (name: string) => name === MESSAGE_AUTHOR_ROLE_ATTR ? style : null,
  });
  const user = {
    getAttribute: () => null,
    innerText: wrapOwnedPromptPayload(marker, 'PROMPT'),
    closest: () => userTurn,
    querySelector: (selector: string) => selector === `[${MESSAGE_AUTHOR_ROLE_ATTR}]` ? roleMarker('user-message') : null,
  };
  const assistant = {
    getAttribute: () => null,
    innerText: `${TIMEOUT_TEXT}\nRetry`,
    closest: () => assistantTurn,
    querySelectorAll: (selector: string) => selector === 'p' ? [{ innerText: TIMEOUT_TEXT }] : [],
    querySelector: (selector: string) => selector === `[${MESSAGE_AUTHOR_ROLE_ATTR}]`
      ? roleMarker('assistant-message')
      : selector === REGENERATE_THREAD_ERROR_BUTTON_SELECTOR ? retry : null,
  };
  const elements = options.laterUser ? [user, assistant, {
    getAttribute: () => null,
    innerText: 'a newer user turn',
    closest: () => section('conversation-turn-3'),
    querySelector: (selector: string) => selector === `[${MESSAGE_AUTHOR_ROLE_ATTR}]` ? roleMarker('user-message') : null,
  }] : [user, assistant];
  let reads = 0;
  const page = {
    waitForTimeout: async () => undefined,
    locator: (selector: string) => {
      if (selector === COMPOSER_SELECTOR) return { count: async () => 1 };
      if (selector === MESSAGE_NODE_SELECTOR) return {
        evaluateAll: (callback: (nodes: Element[], args: unknown) => unknown, args: unknown) => {
          reads++;
          for (const element of elements) Object.assign(element, { getBoundingClientRect: () => ({ height: 1 }) });
          const prior = (globalThis as { document?: unknown }).document;
          (globalThis as { document?: unknown }).document = {
            querySelectorAll: (query: string) => {
              if (query === CONVERSATION_TURN_SECTION_SELECTOR) return options.laterUser
                ? [...turns.map(section), section('conversation-turn-3')]
                : turns.map(section);
              if (query === ASSISTANT_MESSAGE_SELECTOR) return [assistant];
              return [];
            },
            querySelector: (query: string) => options.generationActive && query.includes('stop-button')
              ? {}
              : options.generationActive && query.includes('aria-busy') ? {} : null,
          };
          try {
            return callback(elements as unknown as Element[], args);
          } finally {
            if (prior === undefined) delete (globalThis as { document?: unknown }).document;
            else (globalThis as { document?: unknown }).document = prior;
          }
        },
      };
      if (selector === PRODUCT_STATUS_PROBE_SELECTORS[0] && options.statusReadDelayMs) return {
        count: async () => 1,
        nth: () => ({
          innerText: async () => {
            await new Promise((resolve) => setTimeout(resolve, options.statusReadDelayMs));
            return TIMEOUT_TEXT;
          },
        }),
      };
      return { count: async () => 0, nth: () => ({ innerText: async () => '' }) };
    },
  };
  return { page, getReads: () => reads };
}

describe('owned-turn product recovery confirmation', () => {
  it('confirms the exact timeout banner in two reads even when the generation selector is stale', async () => {
    const fake = recoveryPage({ generationActive: true, statusReadDelayMs: 600 });
    const leaveScope = enterExecutionRecoveryProductWallScope();
    try {
      const surface = await productStatusText(fake.page, 2_000);
      expect(fake.getReads()).toBe(2);
      expect(classifyProductWall(surface)).toEqual({
        state: 'recovery_required',
        cause: 'message_delivery_timed_out',
      });
    } finally {
      leaveScope();
    }
  });

  it('keeps the newer-user-turn ownership gate when the same banner and Retry remain visible', async () => {
    const fake = recoveryPage({ generationActive: true, laterUser: true });
    const leaveScope = enterExecutionRecoveryProductWallScope();
    try {
      const surface = await productStatusText(fake.page, 2_000);
      expect(fake.getReads()).toBe(1);
      expect(classifyProductWall(surface)).toEqual({});
    } finally {
      leaveScope();
    }
  });
});


describe('fresh project conversation identity', () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-6a1920e1c1608191bef6089396d947b4-orchestrator-pack/project';
  const conversationUuid = '6ab8cb78-4e14-83ec-92ff-3e7b67611185';
  const conversationUrl = 'https://chatgpt.com/g/g-p-6a1920e1c1608191bef6089396d947b4-orchestrator-pack/c/6ab8cb78-4e14-83ec-92ff-3e7b67611185';

  it('retains only same-project observed conversation URLs', () => {
    const retention = createFreshIdentityRetention();

    observeFreshConversationUrl(retention, conversationUrl, projectUrl);
    observeFreshConversationUrl(
      retention,
      'https://chatgpt.com/g/g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-other/c/6ab8cb78-4e14-83ec-92ff-3e7b67611185',
      projectUrl,
    );

    expect(retention.observedConversationUrls).toEqual([conversationUrl]);
  });

  it('builds the canonical conversation URL from the project identity root, not /project', () => {
    const userMessageId = 'user-message-2174';
    const retention = createFreshIdentityRetention();
    const network = {
      messages: [{ id: userMessageId, role: 'user', conversationId: conversationUuid }],
      serviceSubmittedUserIds: new Set([userMessageId]),
    };

    const canonical = promoteFreshCanonicalIdentity(
      retention,
      {
        cdp: 'http://127.0.0.1:9222',
        profile: 'test-profile',
        projectUrl,
        newChat: true,
        timeoutMs: 30_000,
      },
      network as any,
      userMessageId,
    );

    expect(canonical).toBe(conversationUrl);
  });
});
