import { describe, expect, it } from 'vitest';
import { featureB } from './feature-b';

describe('heavy-b', () => {
  it('uses feature b', () => {
    expect(featureB()).toBe('feature-b');
  });
});
