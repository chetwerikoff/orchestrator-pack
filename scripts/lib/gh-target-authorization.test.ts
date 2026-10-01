import { describe, expect, it } from 'vitest';
import {
  TargetGhAuthorizationError,
  authorizeTargetGhInvocation,
} from './gh-target-authorization.ts';

const context = { repository: 'alpha/example' };

function authorize(argv: string[], env: NodeJS.ProcessEnv = {}) {
  return authorizeTargetGhInvocation({ context, argv, env });
}

function expectCode(run: () => unknown, code: string) {
  try {
    run();
    throw new Error('expected authorization failure');
  } catch (error) {
    expect(error).toBeInstanceOf(TargetGhAuthorizationError);
    expect((error as TargetGhAuthorizationError).code).toBe(code);
  }
}

describe('target gh authorization', () => {
  it('binds absent repository ingress to the selected card repository', () => {
    expect(authorize(['pr', 'view', '17'])).toEqual({ repository: 'alpha/example', host: 'github.com' });
  });

  it('accepts matching repo-bearing forms', () => {
    expect(authorize(['issue', 'view', '17', '--repo', 'ALPHA/EXAMPLE'])).toEqual({ repository: 'alpha/example', host: 'github.com' });
    expect(authorize(['api', 'repos/alpha/example/pulls/17'])).toEqual({ repository: 'alpha/example', host: 'github.com' });
    expect(authorize(['pr', 'view', 'https://github.com/alpha/example/pull/17'])).toEqual({ repository: 'alpha/example', host: 'github.com' });
  });

  it('rejects explicit repository mismatches from flags, environment, endpoints, and URLs', () => {
    expectCode(() => authorize(['pr', 'view', '17', '--repo', 'beta/other']), 'target-gh-repository-mismatch');
    expectCode(() => authorize(['pr', 'view', '17'], { GH_REPO: 'beta/other' }), 'target-gh-repository-mismatch');
    expectCode(() => authorize(['api', 'repos/beta/other/pulls/17']), 'target-gh-repository-mismatch');
    expectCode(() => authorize(['pr', 'view', 'https://github.com/beta/other/pull/17']), 'target-gh-repository-mismatch');
  });

  it('rejects non-github.com host ingress before transport', () => {
    expectCode(() => authorize(['pr', 'view', '17'], { GH_HOST: 'ghe.example.com' }), 'target-gh-host-mismatch');
    expectCode(() => authorize(['pr', 'view', '17', '--hostname', 'ghe.example.com']), 'target-gh-host-mismatch');
    expectCode(() => authorize(['pr', 'view', 'https://ghe.example.com/alpha/example/pull/17']), 'target-gh-host-mismatch');
  });

  it('rejects arbitrary graphql in target mode', () => {
    expectCode(() => authorize(['api', 'graphql', '-f', 'query={viewer{login}}']), 'target-gh-graphql-unsupported');
  });
});
