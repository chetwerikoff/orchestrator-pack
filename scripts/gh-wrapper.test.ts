import { describe, expect, it } from 'vitest';
import { classifyArgv, hasOnlyAllowedFlags } from './lib/gh-inventory-match.mjs';
import {
  aggregateChecks,
  bucketForState,
  eliminateDuplicates,
  extractActionsRunId,
} from './lib/gh-pr-checks.mjs';
import { parseGhArgv } from './lib/gh-parse-argv.mjs';
import { applyListedJq, mapPullState, resolveRepoContext } from './lib/gh-repo-resolve.mjs';
import { resolveRealGhBinary } from './lib/gh-resolve-real-binary.mjs';
import { join } from 'node:path';

describe('gh inventory matcher', () => {
  it('routes open pr list with listed json fields', () => {
    const { route } = classifyArgv([
      'pr', 'list', '--state', 'open', '--json', 'number,headRefOid,baseRefName', '--limit', '200',
    ]);
    expect(route?.id).toBe('pr-list-open');
  });

  it('passthrough near-miss with extra json field', () => {
    const { route } = classifyArgv([
      'pr', 'list', '--state', 'open', '--json', 'number,headRefOid,commits', '--limit', '200',
    ]);
    expect(route).toBeNull();
  });

  it('passthrough pr list with unsupported native filter flags', () => {
    const { route } = classifyArgv([
      'pr', 'list', '--state', 'open', '--base', 'main', '--json', 'number,headRefOid',
    ]);
    expect(route).toBeNull();
  });

  it('passthrough pr list with unsupported limit alias', () => {
    const { route } = classifyArgv([
      'pr', 'list', '--state', 'open', '-L', '5', '--json', 'number,headRefOid',
    ]);
    expect(route).toBeNull();
  });

  it('passthrough pr checks with --required flag', () => {
    const { route } = classifyArgv([
      'pr', 'checks', '42', '--required', '--json',
      'name,state,bucket,link,startedAt,completedAt,workflow,description',
    ]);
    expect(route).toBeNull();
  });

  it('routes pr checks inventory shape', () => {
    const { route } = classifyArgv([
      'pr', 'checks', '42', '--json',
      'name,state,bucket,link,startedAt,completedAt,workflow,description',
    ]);
    expect(route?.id).toBe('pr-checks');
    expect(route?.prNumber).toBe(42);
  });

  it('passthrough gh api unchanged', () => {
    const { route } = classifyArgv(['api', 'rate_limit']);
    expect(route).toBeNull();
  });

  it('routes pr diff name-only', () => {
    const { route } = classifyArgv(['pr', 'diff', '9', '--name-only']);
    expect(route?.id).toBe('pr-diff-name-only');
  });

  it('routes pr diff when --name-only precedes the PR number', () => {
    const { route } = classifyArgv(['pr', 'diff', '--name-only', '9']);
    expect(route?.id).toBe('pr-diff-name-only');
    expect(route?.prNumber).toBe(9);
  });

  it('routes reviewer jq shape', () => {
    const { route } = classifyArgv([
      'pr', 'view', '12', '--json', 'number,body', '--jq', '{number: .number, body: .body}',
    ]);
    expect(route?.id).toBe('pr-view');
  });
});

describe('gh pr checks dedupe (gh v2.93.0 parity)', () => {
  it('dedupes legacy statuses by context keeping newest', () => {
    const out = eliminateDuplicates([
      { context: 'ci/build', startedAt: '2026-01-01T00:00:00Z', state: 'SUCCESS' },
      { context: 'ci/build', startedAt: '2026-01-02T00:00:00Z', state: 'FAILURE' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].state).toBe('FAILURE');
  });

  it('dedupes check runs by name/workflow/event', () => {
    const mk = (startedAt: string, conclusion: string) => ({
      name: 'test',
      startedAt,
      status: 'COMPLETED',
      conclusion,
      checkSuite: { workflowRun: { workflow: { name: 'wf' }, event: 'pull_request' } },
    });
    const out = eliminateDuplicates([mk('2026-01-02T00:00:00Z', 'success'), mk('2026-01-01T00:00:00Z', 'failure')]);
    expect(out).toHaveLength(1);
    expect(out[0].conclusion).toBe('success');
  });

  it('maps bucket states per inventory table', () => {
    expect(bucketForState('SUCCESS')).toBe('pass');
    expect(bucketForState('SKIPPED')).toBe('skipping');
    expect(bucketForState('FAILURE')).toBe('fail');
    expect(bucketForState('CANCELLED')).toBe('cancel');
    expect(bucketForState('IN_PROGRESS')).toBe('pending');
  });

  it('extracts actions run id from details url', () => {
    expect(
      extractActionsRunId('https://github.com/o/r/actions/runs/123/job/456'),
    ).toBe('123');
  });

  it('aggregates zero-check contexts to empty array before route error', () => {
    expect(aggregateChecks([])).toEqual([]);
  });
});

describe('gh jq listed patterns', () => {
  it('applies compact object jq', () => {
    const out = applyListedJq({ number: 1, body: 'x' }, '{number: .number, body: .body}');
    expect(out).toEqual({ number: 1, body: 'x' });
  });

  it('applies first element number jq', () => {
    expect(applyListedJq([{ number: 9 }], '.[0].number')).toBe(9);
  });

  it('applies nameWithOwner jq as plain slug string', () => {
    expect(applyListedJq({ nameWithOwner: 'owner/repo' }, '.nameWithOwner')).toBe('owner/repo');
  });
});

describe('gh repo resolution precedence', () => {
  it('honors explicit --repo over ambient checkout', () => {
    const realGh = resolveRealGhBinary(join(import.meta.dirname, 'gh'));
    const ctx = resolveRepoContext({
      realGh,
      repoFlag: 'other-owner/other-repo',
      cwd: process.cwd(),
    });
    expect(ctx.slug).toBe('other-owner/other-repo');
  });

  it('honors GH_REPO over ambient checkout when no --repo flag', () => {
    const realGh = resolveRealGhBinary(join(import.meta.dirname, 'gh'));
    const prev = process.env.GH_REPO;
    process.env.GH_REPO = 'env-owner/env-repo';
    try {
      const ctx = resolveRepoContext({ realGh, cwd: process.cwd() });
      expect(ctx.slug).toBe('env-owner/env-repo');
    } finally {
      if (prev === undefined) {
        delete process.env.GH_REPO;
      } else {
        process.env.GH_REPO = prev;
      }
    }
  });
});

describe('gh pull state mapping', () => {
  it('maps merged pulls', () => {
    expect(mapPullState({ state: 'closed', merged_at: '2026-01-01' })).toBe('MERGED');
    expect(mapPullState({ state: 'closed', merged_at: null })).toBe('CLOSED');
    expect(mapPullState({ state: 'open' })).toBe('OPEN');
  });
});

describe('gh recursion guard', () => {
  it('resolveRealGhBinary does not return pack wrapper path', () => {
    const wrapperPath = join(import.meta.dirname, 'gh');
    const real = resolveRealGhBinary(wrapperPath);
    expect(real).not.toBe(wrapperPath);
  });
});

describe('gh flag allowlists', () => {
  it('rejects unknown flags for open pr list', () => {
    const parsed = parseGhArgv([
      'pr', 'list', '--state', 'open', '--author', 'octocat', '--json', 'number',
    ]);
    expect(hasOnlyAllowedFlags(parsed, ['--state', '--limit'])).toBe(false);
    expect(classifyArgv(parsed.raw).route).toBeNull();
  });

  it('allows only inventory flags for open pr list', () => {
    const parsed = parseGhArgv([
      'pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,headRefOid',
    ]);
    expect(hasOnlyAllowedFlags(parsed, ['--state', '--limit'])).toBe(true);
    expect(classifyArgv(parsed.raw).route?.id).toBe('pr-list-open');
  });
});
describe('argv flag permutations', () => {
  it('accepts --repo before subcommand', () => {
    const parsed = parseGhArgv(['--repo', 'o/r', 'pr', 'view', '3', '--json', 'body']);
    expect(parsed.repo).toBe('o/r');
    const { route } = classifyArgv(['--repo', 'o/r', 'pr', 'view', '3', '--json', 'body']);
    expect(route?.id).toBe('pr-view');
  });
});
