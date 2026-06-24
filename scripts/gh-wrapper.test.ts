import { describe, expect, it } from 'vitest';
import { classifyArgv } from './lib/gh-inventory-match.mjs';
import {
  aggregateChecks,
  bucketForState,
  eliminateDuplicates,
  extractActionsRunId,
} from './lib/gh-pr-checks.mjs';
import { parseGhArgv } from './lib/gh-parse-argv.mjs';
import { applyListedJq, mapPullState } from './lib/gh-repo-resolve.mjs';
import { resolveRealGhBinary, WRAPPER_PATH } from './lib/gh-resolve-real-binary.mjs';

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
    const mk = (startedAt, conclusion) => ({
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
    const real = resolveRealGhBinary(WRAPPER_PATH);
    expect(real).not.toBe(WRAPPER_PATH);
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
