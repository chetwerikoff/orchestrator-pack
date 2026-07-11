import { describe, expect, it } from 'vitest';

export function sharedTestHelper() {
  return 'reverse-helper';
}

describe('reverse-helper', () => {
  it('exports shared helper', () => {
    expect(sharedTestHelper()).toBe('reverse-helper');
  });
});
