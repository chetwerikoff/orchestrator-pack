import { describe, expect, it } from 'vitest';
import { sharedTestHelper } from './reverse-helper.test';

describe('reverse-dependent', () => {
  it('depends on changed test helper', () => {
    expect(sharedTestHelper()).toBe('reverse-helper');
  });
});
