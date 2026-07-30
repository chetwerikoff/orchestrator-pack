import { vi } from 'vitest';

export function scalarLocator(overrides: Record<string, unknown> = {}) {
  const turnActionButtons = overrides.turnActionButtons === true;
  const locator: Record<string, any> = {
    count: vi.fn(async () => 0),
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
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    innerText: vi.fn(async () => ''),
    textContent: vi.fn(async () => ''),
    getAttribute: vi.fn(async () => null),
    ...overrides,
  };
  return locator;
}
