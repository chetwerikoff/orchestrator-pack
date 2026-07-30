import { describe, expect, it, vi } from 'vitest';

import {
  readAssistantTurnCompletionReady,
  readAssistantTurnGenerating,
} from './ui-adapter.ts';

function scalarLocator(overrides: Record<string, unknown> = {}) {
  const turnActionButtons = overrides.turnActionButtons === true;
  const locator: Record<string, any> = {
    count: vi.fn(async () => (typeof overrides.count === 'function' ? overrides.count() : 0)),
    first: vi.fn(function first() { return locator; }),
    nth: vi.fn(() => locator),
    locator: vi.fn((selector: string) => {
      if (turnActionButtons && (
        selector.includes('copy-turn-action-button')
        || selector.includes('good-response-turn-action-button')
        || selector.includes('bad-response-turn-action-button')
      )) {
        return scalarLocator({ count: vi.fn(async () => 1) });
      }
      return scalarLocator();
    }),
    innerText: vi.fn(async () => ''),
    getAttribute: vi.fn(async () => null),
    ...overrides,
  };
  return locator;
}

function makeTurnContainerPage(options: {
  assistantText: string;
  actionButtonsInTurn: boolean;
  generating?: boolean;
}) {
  const assistant = scalarLocator({
    count: vi.fn(async () => 1),
    getAttribute: vi.fn(async (name: string) => {
      if (name === 'data-message-author-role') return 'assistant';
      if (name === 'data-is-streaming') return options.generating ? 'true' : null;
      return null;
    }),
    innerText: vi.fn(async () => options.assistantText),
    locator: vi.fn((selector: string) => {
      if (selector.startsWith('xpath=')) {
        return options.actionButtonsInTurn
          ? scalarLocator({ turnActionButtons: true, count: vi.fn(async () => 1) })
          : scalarLocator({ count: vi.fn(async () => 0) });
      }
      return scalarLocator();
    }),
  });
  const assistants = scalarLocator({
    count: vi.fn(async () => 1),
    nth: vi.fn(() => assistant),
  });
  return {
    locator: vi.fn((selector: string) => {
      if (selector === '[data-message-author-role="assistant"]') return assistants;
      if (selector.includes('stop-button')) return scalarLocator();
      return scalarLocator();
    }),
    getByText: vi.fn(() => scalarLocator()),
  };
}

describe('state-light page observation driver', () => {
  it('treats turn-container action buttons as completion-ready even when absent from the assistant node', async () => {
    const page = makeTurnContainerPage({
      assistantText: 'RETRY-OK',
      actionButtonsInTurn: true,
    });

    await expect(readAssistantTurnGenerating(page)).resolves.toBe(false);
    await expect(readAssistantTurnCompletionReady(page)).resolves.toBe(true);
  });

  it('stays waiting when action buttons are missing from both assistant and turn container', async () => {
    const page = makeTurnContainerPage({
      assistantText: 'RETRY-OK',
      actionButtonsInTurn: false,
    });

    await expect(readAssistantTurnCompletionReady(page)).resolves.toBe(false);
  });
});
