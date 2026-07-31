import { COMPOSER_SELECTOR, SEND_BUTTON_SELECTOR } from '../product-page-selectors.ts';
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
      if (selector === COMPOSER_SELECTOR) {
        return {
          count: async () => (base.composer ?? true) ? 1 : 0,
          click: async (options?: { timeout?: number }) => {
            const timeoutMs = options?.timeout ?? 30_000;
            const delayMs = base.composerClickDelayMs ?? 0;
            if (delayMs > 0) {
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(Object.assign(new Error('Timeout 100ms exceeded'), { name: 'TimeoutError' })), timeoutMs);
                setTimeout(() => {
                  clearTimeout(timer);
                  composerClicked = true;
                  resolve();
                }, delayMs);
              });
            } else {
              composerClicked = true;
            }
          },
          fill: async (text: string, options?: { timeout?: number }) => {
            const timeoutMs = options?.timeout ?? 30_000;
            const delayMs = base.insertTextDelayMs ?? 0;
            if (delayMs > 0) {
              let cancelled = false;
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                  cancelled = true;
                  reject(Object.assign(new Error('Timeout 100ms exceeded'), { name: 'TimeoutError' }));
                }, timeoutMs);
                setTimeout(() => {
                  clearTimeout(timer);
                  if (!cancelled && composerClicked) insertedText = text;
                  resolve();
                }, delayMs);
              });
            } else if (composerClicked) {
              insertedText = text;
            }
          },
        };
      }
      if (selector === SEND_BUTTON_SELECTOR) {
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
      if (selector === COMPOSER_SELECTOR) {
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
