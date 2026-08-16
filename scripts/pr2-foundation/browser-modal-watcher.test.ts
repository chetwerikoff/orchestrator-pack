import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { MODAL_PROBE_EXPRESSION } from './browser-modal-watcher.ts';

type FakeElement = {
  readonly innerText: string;
  readonly buttons: readonly FakeElement[];
  clicked: boolean;
  querySelectorAll(selector: string): readonly FakeElement[];
  click(): void;
};

function element(innerText: string, buttons: readonly FakeElement[] = []): FakeElement {
  const value: FakeElement = {
    innerText,
    buttons,
    clicked: false,
    querySelectorAll: (selector) => selector === 'button' ? value.buttons : [],
    click: () => {
      value.clicked = true;
    },
  };
  return value;
}

function evaluate(nodes: readonly FakeElement[]): string {
  const document = { querySelectorAll: () => nodes };
  return runInNewContext(MODAL_PROBE_EXPRESSION, { document }) as string;
}

describe('ChatGPT rate-limit modal detector', () => {
  it('clicks a matching plain div even when it has no dialog role', () => {
    const button = element('Got it');
    const modal = element('Making requests too quickly', [button]);

    expect(evaluate([modal])).toContain('"clicked":true');
    expect(button.clicked).toBe(true);
  });

  it('accepts the exact OK button text and rejects unrelated buttons', () => {
    const wrong = element('Okay, thanks');
    const modal = element('Too many requests', [wrong]);

    expect(evaluate([modal])).toBe('');
    expect(wrong.clicked).toBe(false);
  });

  it('ignores long matching containers', () => {
    const button = element('OK');
    const modal = element(`temporarily limited ${'x'.repeat(600)}`, [button]);

    expect(evaluate([modal])).toBe('');
    expect(button.clicked).toBe(false);
  });
});
