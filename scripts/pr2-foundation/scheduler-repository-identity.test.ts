import { describe, expect, it } from 'vitest';
import {
  repositorySlugFromRemote,
  resolveRepositoryFromRepoRoot,
} from './scheduler.ts';

describe('scheduler repository identity', () => {
  it('normalizes observed GitHub remotes', () => {
    expect(repositorySlugFromRemote('git@github.com:chetwerikoff/orchestrator-pack.git'))
      .toBe('chetwerikoff/orchestrator-pack');
    expect(repositorySlugFromRemote('https://github.com/chetwerikoff/orchestrator-pack'))
      .toBe('chetwerikoff/orchestrator-pack');
    expect(() => repositorySlugFromRemote('file:///tmp/orchestrator-pack'))
      .toThrow('scheduler_repository_identity_unresolved');
  });

  it('resolves the checked-out repository from its origin', async () => {
    await expect(resolveRepositoryFromRepoRoot(process.cwd()))
      .resolves.toBe('chetwerikoff/orchestrator-pack');
  });
});
