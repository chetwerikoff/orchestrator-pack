import { describe, expect, it } from 'vitest';
import { featureA } from './feature-a';

describe('light-only', () => {
  it('stays light', () => {
    expect(featureA()).toBe('feature-a');
  });
});
