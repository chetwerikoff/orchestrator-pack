import { describe, expect, it, vi } from 'vitest';
import {
  buildBrowserTurnCancellationReceipt,
  cancelOwnedGenerationFromReceipt,
  isSupportedChatGptConversationUrl,
  stopOwnedGeneration,
} from './state-light-cancellation.ts';

const marker = `OPKTURNV1${'12'.repeat(16)}`;
const ownedUrl = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
const foreignUrl = 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222';

describe('Issue #1283 receipt-bound cancellation', () => {
  it('accepts only closed ChatGPT conversation origins and UUID paths', () => {
    expect(isSupportedChatGptConversationUrl(ownedUrl)).toBe(true);
    expect(isSupportedChatGptConversationUrl(ownedUrl + '?model=auto#x')).toBe(true);
    expect(isSupportedChatGptConversationUrl('https://evil.example/c/11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(isSupportedChatGptConversationUrl('https://chatgpt.com/not-c/11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(isSupportedChatGptConversationUrl('https://chatgpt.com/c/not-a-uuid')).toBe(false);
  });

  it('treats missing Stop control as unconfirmed rather than completed', async () => {
    const page = {
      isClosed: () => false,
      locator: () => ({ count: vi.fn(async () => 0) }),
    };
    await expect(stopOwnedGeneration(page)).resolves.toBe('unconfirmed');
  });

  it('stops exactly the one page proven by exact URL and exact marker, without close', async () => {
    const owned = { url: () => ownedUrl, close: vi.fn() };
    const foreign = { url: () => foreignUrl, close: vi.fn() };
    const stop = vi.fn(async (page: unknown) => {
      expect(page).toBe(owned);
      return 'confirmed' as const;
    });
    const receipt = buildBrowserTurnCancellationReceipt({
      invocationId: 'inv-1283',
      profileKey: 'profile-1283',
      conversationUrl: ownedUrl,
      marker,
      sendCount: 1,
    });
    expect(receipt).not.toBeNull();
    const result = await cancelOwnedGenerationFromReceipt(receipt!, 'http://127.0.0.1:9222', {
      connect: vi.fn(async () => ({})),
      releaseBrowser: vi.fn(async () => undefined),
      enumeratePages: vi.fn(async () => [foreign, owned]),
      readUserMessages: vi.fn(async (page) => ({
        messages: page === owned
          ? [{ role: 'user' as const, text: `${marker}\n\nprompt` }]
          : [{ role: 'user' as const, text: 'foreign prompt' }],
        incomplete: false,
      })),
      stop,
    });
    expect(result).toMatchObject({
      state: 'no_reply',
      cause: 'child_stdout_eof_timeout_generation_stopped',
      sendCount: 1,
      stopOutcome: 'confirmed',
      identityProven: true,
      conversationUrl: ownedUrl,
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(owned);
    expect(owned.close).not.toHaveBeenCalled();
    expect(foreign.close).not.toHaveBeenCalled();
  });

  it('fails closed without Stop when marker proof is absent or ambiguous', async () => {
    const page = { url: () => ownedUrl, close: vi.fn() };
    const stop = vi.fn(async () => 'confirmed' as const);
    const receipt = buildBrowserTurnCancellationReceipt({
      invocationId: 'inv-1283',
      profileKey: 'profile-1283',
      conversationUrl: ownedUrl,
      marker,
      sendCount: 1,
    })!;
    const absent = await cancelOwnedGenerationFromReceipt(receipt, 'cdp', {
      connect: vi.fn(async () => ({})),
      releaseBrowser: vi.fn(async () => undefined),
      enumeratePages: vi.fn(async () => [page]),
      readUserMessages: vi.fn(async () => ({ messages: [], incomplete: false })),
      stop,
    });
    expect(absent.identityProven).toBe(false);
    expect(stop).not.toHaveBeenCalled();

    const ambiguous = await cancelOwnedGenerationFromReceipt(receipt, 'cdp', {
      connect: vi.fn(async () => ({})),
      releaseBrowser: vi.fn(async () => undefined),
      enumeratePages: vi.fn(async () => [page]),
      readUserMessages: vi.fn(async () => ({
        messages: [{ role: 'user' as const, text: `${marker} ${marker}` }],
        incomplete: false,
      })),
      stop,
    });
    expect(ambiguous.cause).toContain('identity_ambiguous');
    expect(stop).not.toHaveBeenCalled();
    expect(page.close).not.toHaveBeenCalled();
  });
});
