import { describe, expect, it } from 'vitest';
import { classifyArgv, hasOnlyAllowedFlags } from './lib/gh-inventory-match.mjs';
import {
  aggregateChecks,
  bucketForState,
  eliminateDuplicates,
  exitCodeForPrChecks,
  extractActionsRunId,
} from './lib/gh-pr-checks.mjs';
import { parseGhArgv } from './lib/gh-parse-argv.mjs';
import { applyListedJq, mapIssueStateReason, mapIssueToGhJson, mapPullState, resolveRepoContext } from './lib/gh-repo-resolve.mjs';
import {
  isNativeGhExecutable,
  MAX_NON_NATIVE_GH_CANDIDATES,
  resolveRealGhBinary,
} from './lib/gh-resolve-real-binary.mjs';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
