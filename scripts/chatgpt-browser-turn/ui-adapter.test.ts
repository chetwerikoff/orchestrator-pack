import { describe, expect, it } from 'vitest';
import {
  classifyProductWall,
  createFreshIdentityRetention,
  enterExecutionRecoveryProductWallScope,
  observeFreshConversationUrl,
  productStatusText,
  promoteFreshCanonicalIdentity,
  projectConversationUrlMatchesProject,
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


describe('Issue #2489 product-wall classification', () => {
  for (const [label, text, composer] of [
    ['generic error toast', 'Something went wrong. Please try again later.', true],
    ['usage-remaining warning', 'You have 20% usage remaining', true],
    ['percentage warning without composer', "You've reached 80% of your usage limit", false],
    ['exhausted usage with live composer', "You've reached your usage limit", true],
    ['unrelated reached phrase', "You've reached a milestone", false],
  ] as const) {
    it(`does not classify ${label} as a product wall`, () => {
      expect(classifyProductWall({ text, composer })).toEqual({});
    });
  }

  it('classifies explicit exhausted usage only when the composer is blocked', () => {
    expect(classifyProductWall({ text: "You've reached your usage limit", composer: false }))
      .toEqual({ state: 'quota', cause: 'quota_detected' });
    expect(classifyProductWall({ text: 'reached the current usage', composer: false }))
      .toEqual({ state: 'quota', cause: 'quota_detected' });
  });

  it('keeps challenge, rate-limit, and login precedence/conditions', () => {
    expect(classifyProductWall({ text: 'Verify you are human; usage limit', composer: false }))
      .toEqual({ state: 'challenge', cause: 'challenge_detected' });
    expect(classifyProductWall({ text: 'Too many requests', composer: true }))
      .toEqual({ state: 'rate_limit', cause: 'rate_limit_detected' });
    expect(classifyProductWall({ text: 'Sign in to continue', composer: true })).toEqual({});
    expect(classifyProductWall({ text: 'Sign in to continue', composer: false }))
      .toEqual({ state: 'login', cause: 'login_required' });
    expect(classifyProductWall({
      text: 'Your access is temporarily limited because you have reached your usage limit',
      composer: true,
    })).toEqual({ state: 'rate_limit', cause: 'rate_limit_detected' });
  });

  for (const { state, cause, text, selector, composer } of [
    { state: 'challenge', cause: 'challenge_detected', text: 'Verify you are human', selector: '[role="dialog"]', composer: true },
    { state: 'quota', cause: 'quota_detected', text: "You've reached your usage limit", selector: '[data-testid*="limit"]', composer: false },
    { state: 'rate_limit', cause: 'rate_limit_detected', text: 'Too many requests', selector: '[data-testid*="error"]', composer: true },
    { state: 'login', cause: 'login_required', text: 'Sign in to continue', selector: '[data-testid*="login"]', composer: false },
  ] as const) {
    it(`retains the exact matched ${state} node and selector`, async () => {
      const page = {
        locator: (requested: string) => ({
          count: async () => requested === COMPOSER_SELECTOR ? Number(composer) : Number(requested === selector),
          nth: () => ({ innerText: async () => text }),
        }),
      };
      const surface = await productStatusText(page);
      expect(surface).toEqual({ text, composer, parts: [{ selector, text }] });
      expect(classifyProductWall(surface)).toEqual({
        state, cause, matched_text: text, matched_selector: selector,
      });
    });
  }

  it('bounds reported evidence at 500 characters without changing classification', async () => {
    const text = `Too many requests ${'X'.repeat(700)}`;
    const selector = '[role="alert"]';
    const page = {
      locator: (requested: string) => ({
        count: async () => Number(requested === selector || requested === COMPOSER_SELECTOR),
        nth: () => ({ innerText: async () => text }),
      }),
    };
    const surface = await productStatusText(page);
    expect(classifyProductWall(surface)).toEqual({
      state: 'rate_limit',
      cause: 'rate_limit_detected',
      matched_text: text.slice(0, 500),
      matched_selector: selector,
    });
  });

  it('retains challenge priority across distinct product-status selectors', () => {
    expect(classifyProductWall({
      text: "You've reached your usage limit\nVerify you are human",
      composer: false,
      parts: [
        { selector: '[role="alert"]', text: "You've reached your usage limit" },
        { selector: '[role="dialog"]', text: 'Verify you are human' },
      ],
    })).toEqual({
      state: 'challenge',
      cause: 'challenge_detected',
      matched_text: 'Verify you are human',
      matched_selector: '[role="dialog"]',
    });
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
  it('accepts stable-id slug/unslugged canonical aliases, but not a foreign id or root /c', () => {
    const stableProject = 'https://chatgpt.com/g/g-p-6a1920e1c1608191bef6089396d947b4';
    const sameId = `${stableProject}/c/${conversationUuid}`;
    const foreignId = 'https://chatgpt.com/g/g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/c/' + conversationUuid;
    expect(projectConversationUrlMatchesProject(conversationUrl, stableProject)).toBe(true);
    expect(projectConversationUrlMatchesProject(sameId, projectUrl)).toBe(true);
    expect(projectConversationUrlMatchesProject(foreignId, projectUrl)).toBe(false);
    expect(projectConversationUrlMatchesProject('https://chatgpt.com/c/' + conversationUuid, projectUrl)).toBe(false);
    expect(projectConversationUrlMatchesProject(sameId.replace('6ab8cb78-', 'xxxxxxxx-'), projectUrl)).toBe(false);
    expect(projectConversationUrlMatchesProject(sameId.replace('chatgpt.com', 'example.com'), projectUrl)).toBe(false);
    expect(projectConversationUrlMatchesProject(sameId.replace('chatgpt.com', 'chatgpt.com:8443'), projectUrl)).toBe(false);
  });

  it('rejects an unrelated nested route on the selected stable project', () => {
    const project = 'https://chatgpt.com/g/g-p-6a1920e1c1608191bef6089396d947b4';
    expect(projectConversationUrlMatchesProject(project + '/other-route/c/' + conversationUuid, projectUrl)).toBe(false);
    expect(projectConversationUrlMatchesProject(project + '/c/' + conversationUuid + '/other-route', projectUrl)).toBe(false);
  });

});
