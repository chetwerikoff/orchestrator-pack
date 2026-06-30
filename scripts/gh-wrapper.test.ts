import { describe, expect, it, vi } from 'vitest';
import { classifyArgv, hasOnlyAllowedFlags, PR_INFO_FROM_VIEW_FIELDS } from './lib/gh-inventory-match.mjs';
import {
  aggregateChecks,
  bucketForState,
  eliminateDuplicates,
  exitCodeForPrChecks,
  extractActionsRunId,
} from './lib/gh-pr-checks.mjs';
import { parseGhArgv } from './lib/gh-parse-argv.mjs';
import * as repoResolve from './lib/gh-repo-resolve.mjs';
const { applyListedJq, mapIssueStateReason, mapIssueToGhJson, mapPullState, mapPullToGhJson, resolveRepoContext } = repoResolve;
import { executeRestRoute, parsePullReference, routePrView } from './lib/gh-rest-routes.mjs';
import {
  RATE_LIMIT_REFRESH_MS,
  cacheFilePath,
  extractApiHostnameInfo,
  fetchRateLimitGraphql,
  isGraphqlPassthroughArgv,
  isPrimaryGraphqlQuotaExhaustion,
  resolveEnvTokenForHost,
  resolvePartitionKey,
  writeDegradedCache,
} from './lib/gh-graphql-degraded.mjs';
import {
  isNativeGhExecutable,
  MAX_NON_NATIVE_GH_CANDIDATES,
  resolveRealGhBinary,
} from './lib/gh-resolve-real-binary.mjs';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

  it('routes detectPR head list with number,url and limit 1 (Issue #443)', () => {
    const { route } = classifyArgv([
      'pr', 'list', '--repo', 'chetwerikoff/orchestrator-pack',
      '--head', 'feat/issue-443', '--json', 'number,url', '--limit', '1',
    ]);
    expect(route?.id).toBe('pr-list-head');
    expect(route?.branch).toBe('feat/issue-443');
  });

  it('passthrough detectPR shape without limit', () => {
    const { route } = classifyArgv([
      'pr', 'list', '--head', 'feat/x', '--json', 'number,url',
    ]);
    expect(route).toBeNull();
  });

  it('routes issue view state,stateReason via REST inventory', () => {
    const { route } = classifyArgv([
      'issue', 'view', '458', '--repo', 'chetwerikoff/orchestrator-pack',
      '--json', 'state,stateReason',
    ]);
    expect(route?.id).toBe('issue-view-json');
    expect(route?.prNumber).toBe(458);
  });
  it('routes pr view merge-verify state,mergedAt via REST inventory (Issue #501)', () => {
    const { route } = classifyArgv([
      'pr', 'view', '491', '--json', 'state,mergedAt',
    ]);
    expect(route?.id).toBe('pr-view');
    expect(route?.prNumber).toBe(491);
  });

  it('routes getPRState state-only pr view via REST inventory (Issue #538)', () => {
    for (const argv of [
      ['pr', 'view', '527', '--json', 'state'],
      ['pr', 'view', '527', '--repo', 'chetwerikoff/orchestrator-pack', '--json', 'state'],
    ] as const) {
      const { route } = classifyArgv([...argv]);
      expect(route?.id).toBe('pr-view');
      expect(route?.prNumber).toBe(527);
    }
  });

  it('routes RCA issue view state,title,body,closedAt via REST inventory (Issue #520)', () => {
    const { route } = classifyArgv([
      'issue', 'view', '520', '--repo', 'chetwerikoff/orchestrator-pack',
      '--json', 'state,title,body,closedAt',
    ]);
    expect(route?.id).toBe('issue-view-json');
    expect(route?.prNumber).toBe(520);
  });

  it('routes RCA merged-PR closure lookup via REST inventory (Issue #520)', () => {
    const { route } = classifyArgv([
      'pr', 'list', '--repo', 'chetwerikoff/orchestrator-pack',
      '--state', 'merged', '--search', 'closes #431',
      '--json', 'number,title,state,mergedAt', '--limit', '10',
    ]);
    expect(route?.id).toBe('pr-list-merged-closes');
    expect(route?.prNumber).toBe(431);
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

  it('maps pr checks exit codes per native gh parity', () => {
    expect(exitCodeForPrChecks([{ bucket: 'pass' }])).toBe(0);
    expect(exitCodeForPrChecks([{ bucket: 'skipping' }, { bucket: 'cancel' }])).toBe(0);
    expect(exitCodeForPrChecks([{ bucket: 'fail' }])).toBe(1);
    expect(exitCodeForPrChecks([{ bucket: 'pending' }])).toBe(8);
    expect(exitCodeForPrChecks([{ bucket: 'fail' }, { bucket: 'pending' }])).toBe(1);
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

  it('maps REST merged_at to gh mergedAt key (Issue #501)', () => {
    const mapped = mapPullToGhJson(
      { state: 'closed', merged_at: '2026-06-28T05:01:44Z' },
      ['state', 'mergedAt'],
    );
    expect(mapped).toEqual({ state: 'MERGED', mergedAt: '2026-06-28T05:01:44Z' });
  });

  it('maps state-only pull view output for getPRState fallback (Issue #538)', () => {
    expect(mapPullToGhJson({ state: 'open', merged_at: null }, ['state'])).toEqual({ state: 'OPEN' });
    expect(mapPullToGhJson(
      { state: 'closed', merged_at: '2026-06-28T05:01:44Z' },
      ['state'],
    )).toEqual({ state: 'MERGED' });
  });

});

describe('gh issue state reason mapping', () => {
  it('maps REST state_reason to gh stateReason enum', () => {
    expect(mapIssueStateReason({ state: 'closed', state_reason: 'completed' })).toBe('COMPLETED');
    expect(mapIssueStateReason({ state: 'closed', state_reason: 'not_planned' })).toBe('NOT_PLANNED');
    expect(mapIssueStateReason({ state: 'closed', state_reason: 'reopened' })).toBe('REOPENED');
    expect(mapIssueStateReason({ state: 'closed', state_reason: 'duplicate' })).toBe('DUPLICATE');
    expect(mapIssueStateReason({ state: 'open', state_reason: null })).toBeNull();
    expect(mapIssueStateReason({ state: 'open' })).toBeNull();
    expect(mapIssueStateReason({ state: 'closed', state_reason: 'unknown' })).toBeNull();
  });

  it('includes mapped stateReason in spawn field-set output', () => {
    const mapped = mapIssueToGhJson(
      { number: 458, state: 'closed', state_reason: 'completed', title: 't', body: 'b', html_url: 'https://example.com/458', labels: [], assignees: [] },
      ['state', 'stateReason'],
    );
    expect(mapped).toEqual({ state: 'CLOSED', stateReason: 'COMPLETED' });
  });

  it('maps REST closed_at to gh closedAt key (Issue #520)', () => {
    const mapped = mapIssueToGhJson(
      {
        number: 431,
        state: 'closed',
        title: 'Closed issue',
        body: 'body',
        closed_at: '2026-06-28T05:01:44Z',
        labels: [],
        assignees: [],
      },
      ['state', 'title', 'body', 'closedAt'],
    );
    expect(mapped).toEqual({
      state: 'CLOSED',
      title: 'Closed issue',
      body: 'body',
      closedAt: '2026-06-28T05:01:44Z',
    });
  });
});

describe('gh recursion guard', () => {
  it('resolveRealGhBinary does not return pack wrapper path', () => {
    const wrapperPath = join(import.meta.dirname, 'gh');
    const real = resolveRealGhBinary(wrapperPath);
    expect(real).not.toBe(wrapperPath);
  });

  it('resolveRealGhBinary returns a native gh executable', () => {
    const wrapperPath = join(import.meta.dirname, 'gh');
    const real = resolveRealGhBinary(wrapperPath);
    expect(isNativeGhExecutable(real)).toBe(true);
  });
});

const AO_WRAPPER_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
ao_bin_dir="$(cd "$(dirname "$0")" && pwd)"
clean_path="$(echo "$PATH" | tr ':' '\\n' | grep -Fxv "$ao_bin_dir" | grep . | tr '\\n' ':')"
clean_path="\${clean_path%:}"
real_gh="$(PATH="$clean_path" command -v gh 2>/dev/null || true)"
if [[ -z "$real_gh" ]]; then
  echo "fixture-ao-wrapper: gh not found" >&2
  exit 127
fi
exec "$real_gh" "$@"
`;

function writeExecutable(path: string, content: string) {
  writeFileSync(path, content, { mode: 0o755 });
  chmodSync(path, 0o755);
}


function graphqlExhaustedFakeGh(root: string) {
  const audit = join(root, 'audit.log');
  const fakeGh = join(root, 'fake-gh');
  writeExecutable(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
audit="${audit}"
printf '%s\n' "$*" >>"$audit"
joined="$*"
if [[ "$joined" == *graphql* ]] || [[ "$joined" == *"pr view"* ]]; then
  echo 'GraphQL quota exhausted (https://api.github.com/graphql)' >&2
  exit 1
fi
case "$joined" in
  *"api repos/o/r/pulls/527"*)
    echo '{"number":527,"state":"open","merged_at":null}'
    ;;
  *"api repos/o/r/pulls/491"*)
    echo '{"number":491,"state":"closed","merged_at":"2026-06-28T05:01:44Z"}'
    ;;
  *)
    echo "fake-gh: unhandled argv: $joined" >&2
    exit 1
    ;;
esac
`);
  return { fakeGh, audit };
}

describe('gh pr view state-only REST execution (Issue #538)', () => {
  it('executes state-only pr view via REST without graphql under exhausted harness', () => {
    const root = mkdtempSync(join(tmpdir(), 'gh-state-only-'));
    try {
      const { fakeGh, audit } = graphqlExhaustedFakeGh(root);
      const openArgv = ['pr', 'view', '527', '--repo', 'o/r', '--json', 'state'];
      const openParsed = parseGhArgv(openArgv);
      const open = executeRestRoute('pr-view', {
        realGh: fakeGh,
        parsed: openParsed,
        route: { id: 'pr-view', prNumber: 527 },
        cwd: root,
      });
      expect(open).toEqual({ state: 'OPEN' });

      const mergedArgv = ['pr', 'view', '491', '--repo', 'o/r', '--json', 'state'];
      const mergedParsed = parseGhArgv(mergedArgv);
      const merged = executeRestRoute('pr-view', {
        realGh: fakeGh,
        parsed: mergedParsed,
        route: { id: 'pr-view', prNumber: 491 },
        cwd: root,
      });
      expect(merged).toEqual({ state: 'MERGED' });

      const auditLog = readFileSync(audit, 'utf8');
      expect(auditLog).not.toMatch(/graphql/i);
      expect(auditLog).toMatch(/api repos\/o\/r\/pulls\/527/);
      expect(auditLog).toMatch(/api repos\/o\/r\/pulls\/491/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function twoWrapperPathFixture(order: 'ao-first' | 'pack-first') {
  const root = mkdtempSync(join(tmpdir(), 'gh-two-wrapper-'));
  const aoDir = join(root, 'ao-bin');
  const packScripts = join(import.meta.dirname);
  const packGh = join(packScripts, 'gh');
  mkdirSync(aoDir, { recursive: true });
  writeExecutable(join(aoDir, 'gh'), AO_WRAPPER_SCRIPT);

  const pathParts = order === 'ao-first'
    ? [aoDir, packScripts]
    : [packScripts, aoDir];
  const pathValue = [...pathParts, process.env.PATH ?? ''].filter(Boolean).join(':');

  return {
    root,
    packGh,
    env: {
      ...process.env,
      PATH: pathValue,
      GH_WRAPPER_ACTIVE: undefined,
      GH_REAL_BINARY: undefined,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** detectPR argv — AO branch→PR lookup (Issue #443 inventory; #442 terminality). */
const DETECT_PR_ARGV = [
  'pr', 'list', '--repo', 'chetwerikoff/orchestrator-pack',
  '--head', 'feat/issue-442', '--json', 'number,url', '--limit', '1',
];

describe('gh mutual-recursion terminality (Issue #442)', () => {
  it('classifies detectPR multi-field argv as pr-list-head REST route (Issue #443)', () => {
    const { route } = classifyArgv(DETECT_PR_ARGV);
    expect(route?.id).toBe('pr-list-head');
    expect(route?.branch).toBe('feat/issue-442');
  });

  it('resolveRealGhBinary skips AO bash wrapper on PATH (ao before pack)', () => {
    const fixture = twoWrapperPathFixture('ao-first');
    try {
      const prevPath = process.env.PATH;
      process.env.PATH = fixture.env.PATH;
      delete process.env.GH_REAL_BINARY;
      const wrapperPath = join(import.meta.dirname, 'gh');
      const real = resolveRealGhBinary(wrapperPath);
      expect(isNativeGhExecutable(real)).toBe(true);
      expect(real).not.toBe(join(fixture.root, 'ao-bin', 'gh'));
      expect(real).not.toBe(wrapperPath);
      process.env.PATH = prevPath;
    } finally {
      fixture.cleanup();
    }
  });

  it('resolveRealGhBinary skips AO bash wrapper on PATH (pack before ao)', () => {
    const fixture = twoWrapperPathFixture('pack-first');
    try {
      const prevPath = process.env.PATH;
      process.env.PATH = fixture.env.PATH;
      delete process.env.GH_REAL_BINARY;
      const wrapperPath = join(import.meta.dirname, 'gh');
      const real = resolveRealGhBinary(wrapperPath);
      expect(isNativeGhExecutable(real)).toBe(true);
      process.env.PATH = prevPath;
    } finally {
      fixture.cleanup();
    }
  });

  it('passthrough smoke completes without hang under two-wrapper PATH (ao first)', () => {
    const fixture = twoWrapperPathFixture('ao-first');
    try {
      const result = spawnSync(fixture.packGh, DETECT_PR_ARGV, {
        env: fixture.env,
        encoding: 'utf8',
        timeout: 15_000,
      });
      expect((result.error as NodeJS.ErrnoException | undefined)?.code).not.toBe('ETIMEDOUT');
      expect([0, 1, 2, 4]).toContain(result.status ?? -1);
    } finally {
      fixture.cleanup();
    }
  });

  it('passthrough smoke completes without hang under two-wrapper PATH (pack first)', () => {
    const fixture = twoWrapperPathFixture('pack-first');
    try {
      const result = spawnSync(fixture.packGh, DETECT_PR_ARGV, {
        env: fixture.env,
        encoding: 'utf8',
        timeout: 15_000,
      });
      expect((result.error as NodeJS.ErrnoException | undefined)?.code).not.toBe('ETIMEDOUT');
      expect([0, 1, 2, 4]).toContain(result.status ?? -1);
    } finally {
      fixture.cleanup();
    }
  });

  it('terminality holds when GH_WRAPPER_ACTIVE is set (guard alone insufficient)', () => {
    const fixture = twoWrapperPathFixture('ao-first');
    try {
      const env = { ...fixture.env, GH_WRAPPER_ACTIVE: '1' };
      const result = spawnSync(fixture.packGh, DETECT_PR_ARGV, {
        env,
        encoding: 'utf8',
        timeout: 15_000,
      });
      expect((result.error as NodeJS.ErrnoException | undefined)?.code).not.toBe('ETIMEDOUT');
      expect([0, 1, 2, 4]).toContain(result.status ?? -1);
    } finally {
      fixture.cleanup();
    }
  });

  it('repeated passthrough invocations stay within bounded wrapper process growth', () => {
    const fixture = twoWrapperPathFixture('ao-first');
    try {
      const maxPeakDelta = 12;
      for (let i = 0; i < 5; i += 1) {
        const before = spawnSync('pgrep', ['-c', '-f', 'gh-two-wrapper-'], { encoding: 'utf8' });
        const beforeCount = Number.parseInt(String(before.stdout).trim(), 10) || 0;
        const result = spawnSync(fixture.packGh, DETECT_PR_ARGV, {
          env: fixture.env,
          encoding: 'utf8',
          timeout: 15_000,
        });
        expect((result.error as NodeJS.ErrnoException | undefined)?.code).not.toBe('ETIMEDOUT');
        const after = spawnSync('pgrep', ['-c', '-f', 'gh-two-wrapper-'], { encoding: 'utf8' });
        const afterCount = Number.parseInt(String(after.stdout).trim(), 10) || 0;
        expect(afterCount - beforeCount).toBeLessThanOrEqual(maxPeakDelta);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('fail-closed when PATH has only wrapper shims (hop budget)', () => {
    const root = mkdtempSync(join(tmpdir(), 'gh-wrapper-only-'));
    const shimA = join(root, 'a');
    const shimB = join(root, 'b');
    mkdirSync(shimA, { recursive: true });
    mkdirSync(shimB, { recursive: true });
    writeExecutable(join(shimA, 'gh'), AO_WRAPPER_SCRIPT);
    writeExecutable(join(shimB, 'gh'), AO_WRAPPER_SCRIPT);
    const prevPath = process.env.PATH;
    const prevReal = process.env.GH_REAL_BINARY;
    const prevMax = process.env.GH_RESOLVE_MAX_NON_NATIVE;
    delete process.env.GH_REAL_BINARY;
    process.env.GH_RESOLVE_MAX_NON_NATIVE = '2';
    process.env.PATH = `${shimA}:${shimB}`;
    try {
      expect(() => resolveRealGhBinary(join(import.meta.dirname, 'gh'))).toThrow(
        /wrapper hop budget exceeded/,
      );
    } finally {
      process.env.PATH = prevPath;
      if (prevMax === undefined) {
        delete process.env.GH_RESOLVE_MAX_NON_NATIVE;
      } else {
        process.env.GH_RESOLVE_MAX_NON_NATIVE = prevMax;
      }
      if (prevReal === undefined) {
        delete process.env.GH_REAL_BINARY;
      } else {
        process.env.GH_REAL_BINARY = prevReal;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('isNativeGhExecutable rejects bash wrapper and accepts system gh', () => {
    const fixture = twoWrapperPathFixture('ao-first');
    try {
      expect(isNativeGhExecutable(join(fixture.root, 'ao-bin', 'gh'))).toBe(false);
      expect(isNativeGhExecutable(join(import.meta.dirname, 'gh'))).toBe(false);
      const real = resolveRealGhBinary(join(import.meta.dirname, 'gh'));
      expect(isNativeGhExecutable(real)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('exports a bounded hop budget constant for defense-in-depth', () => {
    expect(MAX_NON_NATIVE_GH_CANDIDATES).toBeGreaterThan(0);
    expect(MAX_NON_NATIVE_GH_CANDIDATES).toBeLessThanOrEqual(128);
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

const SAMPLE_REST_PULL = {
  number: 530,
  title: 'REST-route scm-github resolvePR',
  html_url: 'https://github.com/chetwerikoff/orchestrator-pack/pull/530',
  head: { ref: 'feat/530', sha: 'deadbeef' },
  base: { ref: 'main' },
  draft: true,
  state: 'open',
};

const PR_INFO_FROM_VIEW_JSON = PR_INFO_FROM_VIEW_FIELDS.join(',');

/** resolvePR argv — AO claim-pr (Issue #530). */
const RESOLVE_PR_ARGV = [
  'pr', 'view', '530', '--repo', 'chetwerikoff/orchestrator-pack',
  '--json', PR_INFO_FROM_VIEW_JSON,
];

/** detectPR argv — full six-field prInfoFromView set (Issue #530). */
const DETECT_PR_SIX_FIELD_ARGV = [
  'pr', 'list', '--repo', 'chetwerikoff/orchestrator-pack',
  '--head', 'feat/530', '--json', PR_INFO_FROM_VIEW_JSON, '--limit', '1',
];

function expectPrInfoFromViewFields(value: Record<string, unknown>) {
  for (const field of PR_INFO_FROM_VIEW_FIELDS) {
    expect(value).toHaveProperty(field);
  }
  expect(value).not.toHaveProperty('html_url');
  expect(value).not.toHaveProperty('draft');
}

function mockGhApiJsonForPrInfoFromView() {
  const ghApiJsonSpy = repoResolve.ghApiJson as (
    realGh: string,
    endpoint: string,
    options?: { hostname?: string | null; cwd?: string },
  ) => unknown;
  return vi.spyOn(repoResolve, 'ghApiJson').mockImplementation((_realGh, endpoint) => {
    if (endpoint.includes('/pulls/530')) {
      return SAMPLE_REST_PULL;
    }
    if (endpoint.includes('pulls?state=open')) {
      return [SAMPLE_REST_PULL];
    }
    throw new Error(`unexpected gh api endpoint: ${endpoint}`);
  });
}

function wrapperStdoutForArgv(argv: string[]) {
  const { parsed, route } = classifyArgv(argv);
  if (!route) {
    throw new Error('expected inventory route');
  }
  const result = executeRestRoute(route.id, {
    realGh: 'gh',
    parsed,
    route,
    cwd: process.cwd(),
  });
  return `${JSON.stringify(result)}\n`;
}

describe('prInfoFromView REST inventory (Issue #530)', () => {
  it('classifies resolvePR argv as pr-view REST route', () => {
    const { route } = classifyArgv(RESOLVE_PR_ARGV);
    expect(route?.id).toBe('pr-view');
    expect(route?.prRef).toBe('530');
    expect(route?.prNumber).toBeUndefined();
  });

  it('classifies resolvePR argv with --repo before subcommand', () => {
    const argv = [
      '--repo', 'chetwerikoff/orchestrator-pack',
      'pr', 'view', '530', '--json', PR_INFO_FROM_VIEW_JSON,
    ];
    const { route } = classifyArgv(argv);
    expect(route?.id).toBe('pr-view');
    expect(route?.prRef).toBe('530');
  });

  it('classifies detectPR six-field argv as pr-list-head REST route', () => {
    const { route } = classifyArgv(DETECT_PR_SIX_FIELD_ARGV);
    expect(route?.id).toBe('pr-list-head');
    expect(route?.branch).toBe('feat/530');
  });

  it('maps REST pull fields to gh-CLI prInfoFromView names', () => {
    const mapped = mapPullToGhJson(SAMPLE_REST_PULL, [...PR_INFO_FROM_VIEW_FIELDS]);
    expectPrInfoFromViewFields(mapped);
    expect(mapped).toEqual({
      number: 530,
      url: 'https://github.com/chetwerikoff/orchestrator-pack/pull/530',
      title: 'REST-route scm-github resolvePR',
      headRefName: 'feat/530',
      baseRefName: 'main',
      isDraft: true,
    });
  });
});

describe('prInfoFromView wrapper integration (Issue #530)', () => {
  it('resolvePR argv stdout exposes gh-CLI field names via REST (GraphQL stub fails)', () => {
    const apiSpy = mockGhApiJsonForPrInfoFromView();
    try {
      const stdout = wrapperStdoutForArgv(RESOLVE_PR_ARGV);
      const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
      expectPrInfoFromViewFields(parsed);
      expect(parsed.number).toBe(530);
      expect(parsed.headRefName).toBe('feat/530');
      expect(parsed.isDraft).toBe(true);
      expect(apiSpy).toHaveBeenCalled();
    } finally {
      apiSpy.mockRestore();
    }
  });

  it('detectPR six-field argv stdout is REST array with gh-CLI field names', () => {
    const apiSpy = mockGhApiJsonForPrInfoFromView();
    try {
      const stdout = wrapperStdoutForArgv(DETECT_PR_SIX_FIELD_ARGV);
      const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>[];
      expect(parsed.length).toBeLessThanOrEqual(1);
      expect(parsed).toHaveLength(1);
      expectPrInfoFromViewFields(parsed[0]);
      expect(parsed[0].url).toBe('https://github.com/chetwerikoff/orchestrator-pack/pull/530');
      expect(apiSpy).toHaveBeenCalled();
    } finally {
      apiSpy.mockRestore();
    }
  });


  it('parsePullReference preserves owner/repo and host from full PR URLs (review #531)', () => {
    expect(parsePullReference('https://github.com/other-owner/other-repo/pull/123')).toEqual({
      prNumber: 123,
      slug: 'other-owner/other-repo',
      host: 'github.com',
    });
    expect(parsePullReference('https://ghe.example.com/acme/widget/pull/99')).toEqual({
      prNumber: 99,
      slug: 'acme/widget',
      host: 'ghe.example.com',
    });
    expect(parsePullReference('123')).toEqual({ prNumber: 123 });
    expect(parsePullReference('feat/branch')).toBeNull();
  });

  it('routePrView uses URL owner/repo instead of ambient --repo (review #531)', () => {
    const apiSpy = vi.spyOn(repoResolve, 'ghApiJson').mockImplementation((_realGh, endpoint, options) => {
      expect(endpoint).toBe('repos/other-owner/other-repo/pulls/123');
      expect(options?.hostname).toBe('github.com');
      return SAMPLE_REST_PULL;
    });
    try {
      const result = routePrView(
        'gh',
        { slug: 'chetwerikoff/orchestrator-pack', host: 'github.com' },
        'https://github.com/other-owner/other-repo/pull/123',
        [...PR_INFO_FROM_VIEW_FIELDS],
        null,
        process.cwd(),
      );
      expect(result).toMatchObject({ number: 530 });
      expect(apiSpy).toHaveBeenCalledOnce();
    } finally {
      apiSpy.mockRestore();
    }
  });

  it('classifies resolvePR argv with full PR URL as pr-view REST route', () => {
    const { route } = classifyArgv([
      'pr', 'view', 'https://github.com/other-owner/other-repo/pull/123',
      '--repo', 'chetwerikoff/orchestrator-pack',
      '--json', PR_INFO_FROM_VIEW_JSON,
    ]);
    expect(route?.id).toBe('pr-view');
    expect(route?.prRef).toBe('https://github.com/other-owner/other-repo/pull/123');
  });
  it('keeps both argv classes off GraphQL passthrough when quota is exhausted', () => {
    expect(classifyArgv(RESOLVE_PR_ARGV).route).not.toBeNull();
    expect(classifyArgv(DETECT_PR_SIX_FIELD_ARGV).route).not.toBeNull();
    expect(classifyArgv([
      'pr', 'view', '530', '--repo', 'chetwerikoff/orchestrator-pack',
      '--json', 'number,url,title,headRefName,baseRefName,isDraft,commits',
    ]).route).toBeNull();
  });
});

describe('gh api graphql degraded fail-fast (Issue #540)', () => {
  const GRAPHQL_QUERY_ARGV = ['api', 'graphql', '-f', 'query={viewer{login}}'];
  const wrapperDir = import.meta.dirname;

  function buildGraphqlDegradedHarness(options: {
    token?: string;
    nowMs?: number;
    initialRemaining?: number;
    resetOffsetSec?: number;
    forceGraphqlQuotaError?: boolean;
  } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'gh-graphql-degraded-'));
    const audit = join(root, 'audit.log');
    const cacheDir = join(root, 'cache');
    const statePath = join(root, 'state.json');
    const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
    const resetAt = nowSec + (options.resetOffsetSec ?? 3600);
    writeFileSync(statePath, JSON.stringify({
      remaining: options.initialRemaining ?? 1,
      reset: resetAt,
      graphqlCalls: 0,
      forceGraphqlQuotaError: options.forceGraphqlQuotaError ?? false,
    }));
    const fakeGh = join(root, 'fake-gh');
    writeExecutable(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
audit="${audit}"
state="${statePath}"
printf '%s\n' "$*" >>"$audit"
joined="$*"
if [[ "$1" == "auth" && "$2" == "token" ]]; then
  printf '%s' "\${GH_TOKEN:-token-a}"
  exit 0
fi
if [[ "$joined" == *"api rate_limit"* ]]; then
  node -e "const s=require(process.argv[1]); process.stdout.write(JSON.stringify({resources:{graphql:{limit:5000,remaining:s.remaining,reset:s.reset,used:5000-s.remaining}}}));" "$state"
  exit 0
fi
if [[ "$joined" == *graphql* ]]; then
  if [[ "\${SCENARIO:-}" == "secondary" ]]; then
    echo 'secondary_rate_limit exceeded' >&2; exit 1
  fi
  if [[ "\${SCENARIO:-}" == "auth" ]]; then
    echo 'HTTP 401 Bad credentials' >&2; exit 1
  fi
  if [[ "\${SCENARIO:-}" == "validation" ]]; then
    echo "Field 'bogus' doesn't exist on type 'Query'" >&2; exit 1
  fi
  node -e "const fs=require('fs'); const p=process.argv[1]; const s=JSON.parse(fs.readFileSync(p,'utf8')); s.graphqlCalls+=1; fs.writeFileSync(p, JSON.stringify(s)); if (s.forceGraphqlQuotaError || s.remaining<=0) { console.error('gh: HTTP 403: API rate limit exceeded for user (graphql_rate_limit)'); process.exit(1); } console.log('{"data":{"viewer":{"login":"fixture"}}}');" "$state"
  exit 0
fi
echo "fake-gh: unhandled argv: $joined" >&2
exit 1
`);
    const env = {
      ...process.env,
      GH_TOKEN: options.token ?? 'token-a',
      GH_GRAPHQL_DEGRADED_CACHE_DIR: cacheDir,
      GH_GRAPHQL_DEGRADED_NOW_MS: String(options.nowMs ?? Date.now()),
    };
    return {
      root,
      audit,
      cacheDir,
      statePath,
      fakeGh,
      env,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  }

  function spawnGraphqlPassthrough(fakeGh: string, argv: string[], env: NodeJS.ProcessEnv) {
    const script = `import { tryGraphqlDegradedPassthrough } from './lib/gh-graphql-degraded.mjs';
const argv = ${JSON.stringify(argv)};
const fakeGh = ${JSON.stringify(fakeGh)};
tryGraphqlDegradedPassthrough(argv, fakeGh, { env: process.env });`;
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: wrapperDir,
      env,
      encoding: 'utf8',
      timeout: 15_000,
    });
  }

  function auditLines(auditPath: string) {
    if (!existsSync(auditPath)) {
      return [];
    }
    return readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean);
  }

  it('arms from live primary-quota failure and suppresses a second subprocess without network GraphQL', () => {
    const harness = buildGraphqlDegradedHarness({ initialRemaining: 5000, forceGraphqlQuotaError: true });
    try {
      const first = spawnGraphqlPassthrough(harness.fakeGh, GRAPHQL_QUERY_ARGV, harness.env);
      expect(first.status).not.toBe(0);
      expect(first.stderr).toMatch(/graphql_rate_limit|primary quota exhausted/i);

      const second = spawnGraphqlPassthrough(harness.fakeGh, GRAPHQL_QUERY_ARGV, harness.env);
      expect(second.status).not.toBe(0);
      expect(second.stderr).toMatch(/graphql_degraded_fail_fast/);
      expect(second.stderr).toMatch(/primary quota exhausted/i);

      const audit = auditLines(harness.audit).join('\n');
      expect(audit.match(/graphql/gi)?.length ?? 0).toBe(1);
    } finally {
      harness.cleanup();
    }
  });

  it('allows passthrough after resources.graphql.reset elapses', () => {
    const nowMs = 1_700_000_000_000;
    const harness = buildGraphqlDegradedHarness({
      nowMs,
      initialRemaining: 0,
      resetOffsetSec: -10,
    });
    try {
      writeFileSync(harness.statePath, JSON.stringify({
        remaining: 1,
        reset: Math.floor(nowMs / 1000) + 3600,
        graphqlCalls: 0,
      }));
      const result = spawnGraphqlPassthrough(harness.fakeGh, GRAPHQL_QUERY_ARGV, harness.env);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/fixture/);
      expect(auditLines(harness.audit).some((line) => line.includes('graphql'))).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it('does not arm degraded mode for non-trigger failures', () => {
    const harness = buildGraphqlDegradedHarness({ initialRemaining: 1 });
    try {
      for (const scenario of ['secondary', 'auth', 'validation']) {
        rmSync(harness.cacheDir, { recursive: true, force: true });
        writeFileSync(harness.audit, '');
        const env = { ...harness.env, SCENARIO: scenario };
        const first = spawnGraphqlPassthrough(harness.fakeGh, GRAPHQL_QUERY_ARGV, env);
        expect(first.status).not.toBe(0);
        expect(first.stderr).not.toMatch(/graphql_degraded_fail_fast/);
        const second = spawnGraphqlPassthrough(harness.fakeGh, GRAPHQL_QUERY_ARGV, env);
        expect(second.stderr).not.toMatch(/graphql_degraded_fail_fast/);
        expect(auditLines(harness.audit).filter((line) => line.includes('graphql')).length).toBeGreaterThanOrEqual(2);
      }
    } finally {
      harness.cleanup();
    }
  });

  it('shares one rate_limit refresh across suppressed subprocesses within 60s', () => {
    const nowMs = 1_700_000_100_000;
    const harness = buildGraphqlDegradedHarness({
      nowMs,
      initialRemaining: 0,
      resetOffsetSec: 3600,
    });
    try {
      for (let i = 0; i < 3; i += 1) {
        const result = spawnGraphqlPassthrough(harness.fakeGh, GRAPHQL_QUERY_ARGV, harness.env);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/graphql_degraded_fail_fast/);
      }
      const rateLimitCalls = auditLines(harness.audit).filter((line) => line.includes('rate_limit')).length;
      expect(rateLimitCalls).toBeLessThanOrEqual(1);
      expect(auditLines(harness.audit).filter((line) => line.includes('graphql')).length).toBe(0);
    } finally {
      harness.cleanup();
    }
  });

  it('discards malformed cache and re-arms only from a fresh qualifying trigger', () => {
    const harness = buildGraphqlDegradedHarness({ initialRemaining: 5000, forceGraphqlQuotaError: true });
    try {
      mkdirSync(harness.cacheDir, { recursive: true });
      const partition = resolvePartitionKey(harness.fakeGh, GRAPHQL_QUERY_ARGV, harness.env);
      writeFileSync(cacheFilePath(harness.cacheDir, partition), '{not-json');
      const first = spawnGraphqlPassthrough(harness.fakeGh, GRAPHQL_QUERY_ARGV, harness.env);
      expect(first.status).not.toBe(0);
      expect(auditLines(harness.audit).filter((line) => line.includes('graphql')).length).toBe(1);
      const second = spawnGraphqlPassthrough(harness.fakeGh, GRAPHQL_QUERY_ARGV, harness.env);
      expect(second.stderr).toMatch(/graphql_degraded_fail_fast/);
    } finally {
      harness.cleanup();
    }
  });

  it('isolates exhausted partitions by credential fingerprint', () => {
    const nowMs = 1_700_000_200_000;
    const harnessA = buildGraphqlDegradedHarness({
      nowMs,
      token: 'token-a',
      initialRemaining: 0,
      resetOffsetSec: 3600,
    });
    const harnessB = buildGraphqlDegradedHarness({
      nowMs,
      token: 'token-b',
      initialRemaining: 1,
      resetOffsetSec: 3600,
    });
    try {
      const suppressedA = spawnGraphqlPassthrough(harnessA.fakeGh, GRAPHQL_QUERY_ARGV, harnessA.env);
      expect(suppressedA.stderr).toMatch(/graphql_degraded_fail_fast/);

      const allowedB = spawnGraphqlPassthrough(harnessB.fakeGh, GRAPHQL_QUERY_ARGV, harnessB.env);
      expect(allowedB.status).toBe(0);
      expect(allowedB.stderr).not.toMatch(/graphql_degraded_fail_fast/);
    } finally {
      harnessA.cleanup();
      harnessB.cleanup();
    }
  });

  it('never returns synthetic GraphQL success for suppressed invocations', () => {
    const harness = buildGraphqlDegradedHarness({ initialRemaining: 0, resetOffsetSec: 3600 });
    try {
      const result = spawnGraphqlPassthrough(harness.fakeGh, GRAPHQL_QUERY_ARGV, harness.env);
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toMatch(/"data"/);
      expect(result.stderr).toMatch(/primary quota exhausted/i);
    } finally {
      harness.cleanup();
    }
  });

  it('detects graphql passthrough argv shapes', () => {
    expect(isGraphqlPassthroughArgv(['api', 'graphql'])).toBe(true);
    expect(isGraphqlPassthroughArgv(['api', '--hostname', 'ghe.example', 'graphql'])).toBe(true);
    expect(isGraphqlPassthroughArgv(['api', '--method', 'POST', 'graphql', '-f', 'query={viewer{login}}'])).toBe(true);
    expect(isGraphqlPassthroughArgv(['api', '-H', 'Accept: application/json', 'graphql'])).toBe(true);
    expect(isGraphqlPassthroughArgv(['api', '-i', 'graphql'])).toBe(true);
    expect(isGraphqlPassthroughArgv(['api', '--include', 'graphql'])).toBe(true);
    expect(isGraphqlPassthroughArgv(['api', '-X', 'POST', 'graphql', '-f', 'query={viewer{login}}'])).toBe(true);
    expect(isGraphqlPassthroughArgv(['api', '-q', '.data', 'graphql'])).toBe(true);
    expect(isGraphqlPassthroughArgv(['api', '-p', 'corsair', 'graphql'])).toBe(true);
    expect(isGraphqlPassthroughArgv(['api', '--method', 'GET', 'rate_limit'])).toBe(false);
    expect(isGraphqlPassthroughArgv(['api', 'rate_limit'])).toBe(false);
  });

  it('applies degraded fail-fast to graphql argv with leading api flags', () => {
    const harness = buildGraphqlDegradedHarness({ initialRemaining: 0, resetOffsetSec: 3600 });
    try {
      const argv = ['api', '--method', 'POST', 'graphql', '-f', 'query={viewer{login}}'];
      const result = spawnGraphqlPassthrough(harness.fakeGh, argv, harness.env);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/graphql_degraded_fail_fast|primary quota exhausted/i);
    } finally {
      harness.cleanup();
    }
  });

  function parseFakeGhHostname(argv: string[]) {
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === '--hostname' && argv[i + 1]) {
        return argv[i + 1];
      }
      if (argv[i].startsWith('--hostname=')) {
        return argv[i].slice('--hostname='.length);
      }
    }
    return 'github.com';
  }

  function buildMultiHostGraphqlHarness(hostQuotas: Record<string, { remaining: number; resetOffsetSec?: number }>) {
    const root = mkdtempSync(join(tmpdir(), 'gh-graphql-multi-host-'));
    const audit = join(root, 'audit.log');
    const cacheDir = join(root, 'cache');
    const statePath = join(root, 'state.json');
    const nowSec = Math.floor(Date.now() / 1000);
    const hosts: Record<string, { remaining: number; reset: number }> = {};
    for (const [host, quota] of Object.entries(hostQuotas)) {
      hosts[host] = {
        remaining: quota.remaining,
        reset: nowSec + (quota.resetOffsetSec ?? 3600),
      };
    }
    writeFileSync(statePath, JSON.stringify({ hosts, graphqlCalls: 0 }));
    const fakeGh = join(root, 'fake-gh');
    writeExecutable(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
audit="${audit}"
state="${statePath}"
printf '%s\n' "$*" >>"$audit"
joined="$*"
args=("$@")
host="github.com"
explicit_host=false
for ((i=0; i<\${#args[@]}; i++)); do
  if [[ "\${args[i]}" == "--hostname" && $((i+1)) -lt \${#args[@]} ]]; then
    host="\${args[$((i+1))]}"
    explicit_host=true
  fi
done
if [[ "$explicit_host" == false && -n "\${GH_HOST:-}" ]]; then
  host="\$GH_HOST"
fi
if [[ "$1" == "auth" && "$2" == "token" ]]; then
  case "$host" in
    ghe.example) printf 'token-ghe' ;;
    *) printf 'token-dotcom' ;;
  esac
  exit 0
fi
if [[ "$joined" == *"api rate_limit"* ]] || [[ "$joined" == *"api --hostname"* && "$joined" == *"rate_limit"* ]]; then
  node -e "const fs=require('fs'); const [statePath, host]=process.argv.slice(1); const s=JSON.parse(fs.readFileSync(statePath,'utf8')); const h=s.hosts[host]||s.hosts['github.com']; process.stdout.write(JSON.stringify({resources:{graphql:{limit:5000,remaining:h.remaining,reset:h.reset,used:5000-h.remaining}}}));" "$state" "$host"
  exit 0
fi
if [[ "$joined" == *graphql* ]]; then
  node -e "const fs=require('fs'); const [statePath, host]=process.argv.slice(1); const p=statePath; const s=JSON.parse(fs.readFileSync(p,'utf8')); s.graphqlCalls+=1; fs.writeFileSync(p, JSON.stringify(s)); const h=s.hosts[host]||s.hosts['github.com']; if (h.remaining<=0) { console.error('gh: HTTP 403: API rate limit exceeded for user (graphql_rate_limit)'); process.exit(1); } console.log('{\"data\":{\"viewer\":{\"login\":\"fixture\"}}}');" "$state" "$host"
  exit 0
fi
echo "fake-gh: unhandled argv: $joined" >&2
exit 1
`);
    const env = {
      ...process.env,
      GH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      GH_GRAPHQL_DEGRADED_CACHE_DIR: cacheDir,
    };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    return {
      root,
      audit,
      cacheDir,
      statePath,
      fakeGh,
      env,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  }

  it('fingerprints credentials per explicit hostname instead of default auth context', () => {
    const harness = buildMultiHostGraphqlHarness({
      'ghe.example': { remaining: 0 },
      'github.com': { remaining: 5 },
    });
    try {
      const gheArgv = ['api', '--hostname', 'ghe.example', 'graphql', '-f', 'query={viewer{login}}'];
      const dotcomArgv = ['api', '--hostname', 'github.com', 'graphql', '-f', 'query={viewer{login}}'];

      const suppressedGhe = spawnGraphqlPassthrough(harness.fakeGh, gheArgv, harness.env);
      expect(suppressedGhe.stderr).toMatch(/graphql_degraded_fail_fast|primary quota exhausted/i);

      const allowedDotcom = spawnGraphqlPassthrough(harness.fakeGh, dotcomArgv, harness.env);
      expect(allowedDotcom.status).toBe(0);
      expect(allowedDotcom.stderr).not.toMatch(/graphql_degraded_fail_fast/);

      const audit = auditLines(harness.audit).join('\n');
      expect(audit).toMatch(/auth token --hostname ghe\.example/);
      expect(audit).toMatch(/auth token --hostname github\.com/);
    } finally {
      harness.cleanup();
    }
  });

  it('queries rate_limit on explicitly supplied github.com even when GH_HOST points elsewhere', () => {
    const harness = buildMultiHostGraphqlHarness({
      'ghe.example': { remaining: 0 },
      'github.com': { remaining: 5 },
    });
    try {
      const argv = ['api', '--hostname', 'github.com', 'graphql', '-f', 'query={viewer{login}}'];
      const env = { ...harness.env, GH_HOST: 'ghe.example' };
      const result = spawnGraphqlPassthrough(harness.fakeGh, argv, env);
      expect(result.status).toBe(0);
      expect(result.stderr).not.toMatch(/graphql_degraded_fail_fast/);
      expect(auditLines(harness.audit).some((line) => line.includes('--hostname github.com') && line.includes('rate_limit'))).toBe(true);
      expect(fetchRateLimitGraphql(harness.fakeGh, argv, env).ok).toBe(true);
      expect(extractApiHostnameInfo(argv)).toEqual({ host: 'github.com', explicit: true });
    } finally {
      harness.cleanup();
    }
  });

  it('builds explicit-host rate_limit argv as gh api --hostname <host> rate_limit', () => {
    const harness = buildMultiHostGraphqlHarness({
      'github.com': { remaining: 5 },
    });
    try {
      const argv = ['api', '--hostname', 'github.com', 'graphql', '-f', 'query={viewer{login}}'];
      const env = { ...harness.env, GH_HOST: 'ghe.example' };
      expect(fetchRateLimitGraphql(harness.fakeGh, argv, env).ok).toBe(true);
      const rateLimitLine = auditLines(harness.audit).find((line) => line.includes('rate_limit'));
      expect(rateLimitLine).toBeDefined();
      expect(rateLimitLine).toMatch(/^api --hostname github\.com rate_limit/);
      expect(rateLimitLine).not.toMatch(/^--hostname/);
    } finally {
      harness.cleanup();
    }
  });

  it('bounds parallel rate_limit refresh with a per-partition lease', async () => {
    const nowMs = 1_700_000_500_000;
    const harness = buildGraphqlDegradedHarness({
      nowMs,
      initialRemaining: 0,
      resetOffsetSec: 3600,
    });
    try {
      const script = `import { tryGraphqlDegradedPassthrough } from './lib/gh-graphql-degraded.mjs';
tryGraphqlDegradedPassthrough(${JSON.stringify(['api', 'graphql', '-f', 'query={viewer{login}}'])}, ${JSON.stringify(harness.fakeGh)}, { env: process.env });`;
      const env = {
        ...harness.env,
        GH_GRAPHQL_DEGRADED_NOW_MS: String(nowMs),
      };
      await Promise.all(Array.from({ length: 5 }, () => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
          cwd: wrapperDir,
          env,
        });
        child.on('error', reject);
        child.on('close', resolve);
      })));
      const rateLimitCalls = auditLines(harness.audit).filter((line) => line.includes('rate_limit')).length;
      expect(rateLimitCalls).toBeLessThanOrEqual(1);
    } finally {
      harness.cleanup();
    }
  });

  it('refreshes rate_limit while degraded and clears suppression when remaining returns', () => {
    const nowMs = 1_700_000_300_000;
    const harness = buildGraphqlDegradedHarness({ initialRemaining: 0, resetOffsetSec: 3600 });
    try {
      const partition = resolvePartitionKey(harness.fakeGh, GRAPHQL_QUERY_ARGV, harness.env);
      mkdirSync(harness.cacheDir, { recursive: true });
      writeDegradedCache(harness.cacheDir, partition, {
        degraded: true,
        graphqlResetAt: Math.floor(nowMs / 1000) + 3600,
        graphqlRemaining: 0,
        lastRateLimitFetchMs: nowMs - RATE_LIMIT_REFRESH_MS - 1,
      });
      writeFileSync(harness.statePath, JSON.stringify({
        remaining: 5,
        reset: Math.floor(nowMs / 1000) + 3600,
        graphqlCalls: 0,
      }));
      const env = {
        ...harness.env,
        GH_GRAPHQL_DEGRADED_NOW_MS: String(nowMs),
      };
      const result = spawnGraphqlPassthrough(harness.fakeGh, GRAPHQL_QUERY_ARGV, env);
      expect(result.status).toBe(0);
      expect(result.stderr).not.toMatch(/graphql_degraded_fail_fast/);
      expect(auditLines(harness.audit).some((line) => line.includes('rate_limit'))).toBe(true);
      expect(auditLines(harness.audit).some((line) => line.includes('graphql'))).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it('partitions degraded cache by GH_HOST when no explicit --hostname', () => {
    const harness = buildMultiHostGraphqlHarness({
      'ghe.example': { remaining: 0 },
      'github.com': { remaining: 5 },
    });
    try {
      const gheEnv = { ...harness.env, GH_HOST: 'ghe.example' };
      const dotcomEnv = { ...harness.env };
      delete dotcomEnv.GH_HOST;

      expect(extractApiHostnameInfo(GRAPHQL_QUERY_ARGV, gheEnv)).toEqual({
        host: 'ghe.example',
        explicit: false,
      });
      expect(resolvePartitionKey(harness.fakeGh, GRAPHQL_QUERY_ARGV, gheEnv)).not.toBe(
        resolvePartitionKey(harness.fakeGh, GRAPHQL_QUERY_ARGV, dotcomEnv),
      );

      const suppressedGhe = spawnGraphqlPassthrough(harness.fakeGh, GRAPHQL_QUERY_ARGV, gheEnv);
      expect(suppressedGhe.stderr).toMatch(/graphql_degraded_fail_fast|primary quota exhausted/i);

      const allowedDotcom = spawnGraphqlPassthrough(harness.fakeGh, GRAPHQL_QUERY_ARGV, dotcomEnv);
      expect(allowedDotcom.status).toBe(0);
      expect(allowedDotcom.stderr).not.toMatch(/graphql_degraded_fail_fast/);
    } finally {
      harness.cleanup();
    }
  });

  it('passthroughs graphql when degraded cache dir is unwritable', () => {
    const harness = buildGraphqlDegradedHarness({ initialRemaining: 5 });
    try {
      const blocked = join(harness.root, 'blocked-cache-path');
      writeFileSync(blocked, 'not-a-directory');
      const env = {
        ...harness.env,
        GH_GRAPHQL_DEGRADED_CACHE_DIR: blocked,
      };
      const result = spawnGraphqlPassthrough(harness.fakeGh, GRAPHQL_QUERY_ARGV, env);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/fixture/);
      expect(result.stderr).toMatch(/graphql_degraded_cache_io_failed/);
      expect(auditLines(harness.audit).some((line) => line.includes('graphql'))).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it('fingerprints enterprise hosts from GH_ENTERPRISE_TOKEN instead of GH_TOKEN', () => {
    const gheArgv = ['api', '--hostname', 'ghe.example', 'graphql', '-f', 'query={viewer{login}}'];
    const keyA = resolvePartitionKey('fake-gh', gheArgv, {
      GH_TOKEN: 'shared-dotcom',
      GHE_TOKEN: 'enterprise-a',
    } as NodeJS.ProcessEnv);
    const keyB = resolvePartitionKey('fake-gh', gheArgv, {
      GH_TOKEN: 'shared-dotcom',
      GHE_TOKEN: 'enterprise-b',
    } as NodeJS.ProcessEnv);
    expect(keyA).not.toBe(keyB);
    expect(resolveEnvTokenForHost({ GH_TOKEN: 'dotcom', GHE_TOKEN: 'ent' } as NodeJS.ProcessEnv, 'ghe.example')).toBe('ent');
    expect(resolveEnvTokenForHost({ GH_TOKEN: 'dotcom', GHE_TOKEN: 'ent' } as NodeJS.ProcessEnv, 'github.com')).toBe('dotcom');
  });

  it('classifies primary GraphQL quota exhaustion separately from non-triggers', () => {
    expect(isPrimaryGraphqlQuotaExhaustion({ stderr: 'graphql_rate_limit', stdout: '', exitCode: 1 })).toBe(true);
    expect(isPrimaryGraphqlQuotaExhaustion({ stderr: 'secondary_rate_limit', stdout: '', exitCode: 1 })).toBe(false);
    expect(isPrimaryGraphqlQuotaExhaustion({ stderr: 'HTTP 401 Bad credentials', stdout: '', exitCode: 1 })).toBe(false);
  });
});

