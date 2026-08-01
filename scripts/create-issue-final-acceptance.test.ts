import { describe, expect, it } from 'vitest';
import { FINAL_ACCEPTANCE_CONTRACT_VERSION } from './lib/create-issue-final-acceptance-contract.ts';

describe('create-issue-final-acceptance CLI', () => {
  it('exports the shared contract version', () => {
    expect(FINAL_ACCEPTANCE_CONTRACT_VERSION).toBe('create-issue-final-acceptance-contract/v1');
  });
});
