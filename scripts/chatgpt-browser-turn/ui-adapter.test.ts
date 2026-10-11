import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runProcessSync } from '../kernel/subprocess.ts';
import { __testFreshSend, __testComposerMutation } from './state-light-turn-base.ts';
import * as coordination from './coordination.ts';
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
      expect(classifyProductWall(surface)).toEqual({ wall_kind: 'none', matched_text: 'none', matched_selector: 'none' });
    } finally {
      leaveScope();
    }
  });
});


describe('Issue #2489 product-status advisory classification', () => {
  const none = { wall_kind: 'none', matched_text: 'none', matched_selector: 'none' };
  for (const record of [
    { label: 'generic error toast', text: 'Something went wrong. Please try again later.', expected: 'none' },
    { label: 'usage-remaining warning', text: 'You have 20% usage remaining', expected: 'none' },
    { label: 'unrelated reached phrase', text: "You've reached a milestone", expected: 'none' },
    { label: 'explicit exhausted quota', text: "You've reached your usage limit", expected: 'quota' },
    { label: 'rate limiting', text: 'Too many requests', expected: 'rate_limit' },
    { label: 'human challenge', text: 'Verify you are human', expected: 'challenge' },
    { label: 'login prompt', text: 'Sign in to continue', expected: 'login' },
  ] as const) {
    for (const composer of [true, false]) {
      it(record.label + ' with composer=' + composer + ' never becomes a terminal state', () => {
        const classified = classifyProductWall({ text: record.text, composer });
        expect(classified).toEqual(record.label === 'generic error toast'
          ? { wall_kind: 'none', matched_text: record.text, matched_selector: 'none' }
          : record.expected === 'none'
            ? none
            : { wall_kind: record.expected, matched_text: record.text, matched_selector: 'none' });
        expect(classified).not.toHaveProperty('state');
      });
    }
  }

  for (const { kind, text, selector, composer } of [
    { kind: 'challenge', text: 'Verify you are human', selector: '[role="dialog"]', composer: true },
    { kind: 'quota', text: "You've reached your usage limit", selector: '[data-testid*="limit"]', composer: false },
    { kind: 'rate_limit', text: 'Too many requests', selector: '[data-testid*="error"]', composer: true },
    { kind: 'login', text: 'Sign in to continue', selector: '[data-testid*="login"]', composer: false },
  ] as const) {
    it('retains the exact matched ' + kind + ' node and selector', async () => {
      const page = {
        locator: (requested: string) => ({
          count: async () => requested === COMPOSER_SELECTOR ? Number(composer) : Number(requested === selector),
          nth: () => ({ innerText: async () => text }),
        }),
      };
      const surface = await productStatusText(page);
      expect(surface).toEqual({ text, composer, parts: [{ selector, text }] });
      expect(classifyProductWall(surface)).toEqual({
        wall_kind: kind, matched_text: text, matched_selector: selector,
      });
    });
  }

  it('retains the exact generic retry alert node without a terminal state', async () => {
    const text = 'Something went wrong. Please try again later.';
    const selector = '[role="alert"]';
    const page = {
      locator: (requested: string) => ({
        count: async () => requested === COMPOSER_SELECTOR ? 1 : Number(requested === selector),
        nth: () => ({ innerText: async () => text }),
      }),
    };
    const surface = await productStatusText(page);
    expect(surface).toEqual({ text, composer: true, parts: [{ selector, text }] });
    const diagnostic = classifyProductWall(surface);
    expect(diagnostic).toEqual({ wall_kind: 'none', matched_text: text, matched_selector: selector });
    expect(diagnostic).not.toHaveProperty('state');
    expect(diagnostic).not.toHaveProperty('cause');
    expect(classifyProductWall({ ...surface, text: text + 'X'.repeat(600), parts: [{ selector, text: text + 'X'.repeat(600) }] }).matched_text)
      .toBe((text + 'X'.repeat(600)).slice(0, 500));
  });

  it('bounds the exact matched node to 500 characters while preserving its source', async () => {
    const text = `Too many requests XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`;
    const selector = '[role="alert"]';
    const page = {
      locator: (requested: string) => ({
        count: async () => Number(requested === selector || requested === COMPOSER_SELECTOR),
        nth: () => ({ innerText: async () => text }),
      }),
    };
    const surface = await productStatusText(page);
    expect(classifyProductWall(surface)).toEqual({
      wall_kind: 'rate_limit',
      matched_text: text.slice(0, 500),
      matched_selector: selector,
    });
  });

  it('keeps challenge preference across separate product-owned selectors', () => {
    expect(classifyProductWall({
      text: "You've reached your usage limit\nVerify you are human",
      composer: false,
      parts: [
        { selector: '[role="alert"]', text: "You've reached your usage limit" },
        { selector: '[role="dialog"]', text: 'Verify you are human' },
      ],
    })).toEqual({
      wall_kind: 'challenge',
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


describe('Issue #2497 fresh-send composer serialization', () => {
  it.each(['normal send', 'pre-send failure'])('queues a second send until release after %s', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fresh-send-2497-'));
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', root);
    try {
      const first = await __testFreshSend.acquireFreshSendLock('profile-2497', Date.now() + 2_000);
      let secondAcquired = false;
      const secondPending = __testFreshSend.acquireFreshSendLock('profile-2497', Date.now() + 2_000)
        .then((lock) => { secondAcquired = true; return lock; });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(secondAcquired).toBe(false);
      first!.release();
      const second = await secondPending;
      expect(secondAcquired).toBe(true);
      second!.release();
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('takes over a lock left by a dead process without waiting for its age', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fresh-send-dead-2497-'));
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', root);
    try {
      const child = runProcessSync({ command: process.execPath, args: ['--experimental-strip-types', '--input-type=module', '-e',
        `import { acquireDomainLock } from ${JSON.stringify(new URL('./coordination.ts', import.meta.url).href)}; acquireDomainLock('profile-dead-2497', 'fresh-send-composer', 0);`,
      ], env: process.env, encoding: 'utf8', timeoutMs: 5_000 });
      expect(child.exitCode, child.stderr).toBe(0);
      const lock = await __testFreshSend.acquireFreshSendLock('profile-dead-2497', Date.now() + 2_000);
      lock!.release();
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('takes over a live stuck owner after 61 seconds without releasing its successor (#2497 c2)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fresh-send-hung-2497-'));
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', root);
    vi.useFakeTimers();
    try {
      const first = await __testFreshSend.acquireFreshSendLock('profile-hung-2497', Date.now() + 300_000);
      expect(first).toBeDefined();
      expect(() => process.kill(process.pid, 0)).not.toThrow();
      vi.setSystemTime(Date.now() + 61_001);
      expect(coordination.acquireDomainLock('profile-hung-2497', 'fresh-send-composer', 0)).toBeNull();
      const second = coordination.acquireDomainLock('profile-hung-2497', 'fresh-send-composer', 0, { maxHoldMs: 61_000 });
      expect(second).not.toBeNull();
      expect(second!.nonce).not.toBe(first!.nonce);
      expect(first!.isOwned()).toBe(false);
      __testFreshSend.releaseFreshSendLock(first);
      expect(second!.isOwned()).toBe(true);
      second!.release();
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('proceeds without the slot after 61 seconds of failed acquisitions (#2497 c3)', async () => {
    const acquire = vi.spyOn(coordination, 'acquireDomainLock').mockReturnValue(null);
    vi.useFakeTimers();
    try {
      let settled = false;
      const waiter = __testFreshSend.acquireFreshSendLock('profile-wait-2497', Date.now() + 300_000)
        .then((lock) => { settled = true; return lock; });
      await vi.advanceTimersByTimeAsync(60_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(await waiter).toBeUndefined();
    } finally {
      vi.useRealTimers();
      acquire.mockRestore();
    }
  });

  it('bounds contention by the invocation deadline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fresh-send-deadline-2497-'));
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', root);
    try {
      const first = await __testFreshSend.acquireFreshSendLock('profile-deadline-2497', Date.now() + 1_000);
      try {
        await expect(__testFreshSend.acquireFreshSendLock('profile-deadline-2497', Date.now() + 50))
          .rejects.toThrow('fresh_send_lock_deadline_exhausted');
      } finally { first!.release(); }
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores editor whitespace around a backticked https URL but rejects changed content', () => {
    const payload = 'Reply OK for `https://example.com/2497`';
    expect(__testFreshSend.renderedPayloadMatches('Reply OK for ` https://example.com/2497 `', payload)).toBe(true);
    expect(__testFreshSend.renderedPayloadMatches('Reply OK for ` https://example.com/2498 `', payload)).toBe(false);
    expect(__testFreshSend.renderedPayloadMatches(undefined, payload)).toBe(false);
  });

  it('replaces a stale draft and clears a failed payload without foregrounding (#2497 d)', async () => {
    const actions: string[] = [];
    let text = 'leftover OPKTURN draft';
    const composer = {
      count: async () => 1,
      isVisible: async () => true,
      isEnabled: async () => true,
      isEditable: async () => true,
      click: async () => {},
      innerText: async () => { actions.push('read'); return text; },
      fill: async (value: string) => { actions.push('fill'); text = value; },
    };
    const page = {
      bringToFront: async () => { actions.push('front'); },
      locator: () => composer,
    };
    expect(await __testComposerMutation.mutateComposerOrCause(page, 'new draft', Date.now() + 2_000)).toBeNull();
    expect(text).toBe('new draft');
    expect(actions).toContain('fill');
    await __testFreshSend.clearFreshComposerDraft(page);
    expect(text).toBe('');
    expect(actions).not.toContain('front');
  });

  it('ignores draft-clear failures', async () => {
    await expect(__testFreshSend.clearFreshComposerDraft({
      bringToFront: async () => {},
      locator: () => ({ fill: async () => { throw new Error('closed'); } }),
    })).resolves.toBeUndefined();
  });
});
