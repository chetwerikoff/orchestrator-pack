import type { FakeTurnPageOptions } from './fake-turn-page.ts';

export interface DelayedComposerOptions extends FakeTurnPageOptions {
  readonly composerClickDelayMs?: number;
  readonly insertTextDelayMs?: number;
}

export function delayedComposerFakePage(options: DelayedComposerOptions = {}) {
  let composerClicked = false;
  let insertedText = '';
  const base = options;
  const page = {
    __fakeTurnPage: true,
    context: () => ({
      newCDPSession: async () => ({
        send: async () => {},
        on: () => {},
      }),
    }),
    on: () => {},
    url: () => 'https://chatgpt.com/c/example',
    locator: (selector: string) => {
      if (selector === '#prompt-textarea') {
        return {
          count: async () => (base.composer ?? true) ? 1 : 0,
          click: async () => {
            if (base.composerClickDelayMs) {
              await new Promise((resolve) => { setTimeout(resolve, base.composerClickDelayMs); });
            }
            composerClicked = true;
          },
        };
      }
      if (selector === '[data-testid="send-button"]') {
        return { count: async () => 1, click: async () => {} };
      }
      return { count: async () => 0, nth: () => ({ count: async () => 0 }) };
    },
    keyboard: {
      press: async () => {},
      insertText: async (text: string) => {
        if (base.insertTextDelayMs) {
          await new Promise((resolve) => { setTimeout(resolve, base.insertTextDelayMs); });
        }
        if (composerClicked) insertedText = text;
      },
    },
    waitForTimeout: async (ms: number) => {
      await new Promise((resolve) => { setTimeout(resolve, ms); });
    },
    getSendClicks: () => 0,
    getComposerClicked: () => composerClicked,
    getInsertedText: () => insertedText,
  };
  return { page };
}

export function neverSettlingCountPage(): { page: any } {
  const page = {
    __fakeTurnPage: true,
    locator: (selector: string) => {
      if (selector === '#prompt-textarea') {
        return {
          count: () => new Promise<number>(() => {}),
        };
      }
      return { count: async () => 0 };
    },
    on: () => {},
    url: () => 'https://chatgpt.com/c/example',
    keyboard: { press: async () => {}, insertText: async () => {} },
    waitForTimeout: async (ms: number) => {
      await new Promise((resolve) => { setTimeout(resolve, ms); });
    },
  };
  return { page };
}
