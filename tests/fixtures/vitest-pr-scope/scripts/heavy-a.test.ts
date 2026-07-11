import { describe, expect, it } from 'vitest';
import { featureA } from './feature-a';

describe('heavy-a', () => {
  it('uses feature a', () => {
    expect(featureA()).toBe('feature-a');
  });
});
