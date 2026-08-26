import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProcessSync } from './kernel/subprocess.ts';
import {
  extractAmbientGhExecutableSelections,
  scanFileForViolations,
} from './lib/gh-inventory-static-guard.mjs';
import {
  resolveHeadSha as resolveGptHeadSha,
  resolveRepositorySlug,
} from './lib/pack-gpt-reviewer.ts';
import { createPackGptSourceCommentTransport } from './lib/pack-gpt-source-comment.ts';
import { createGithubReviewTransport } from './lib/github-review-reconciliation.ts';
import { resolveCurrentPrHead } from './pack-review-runner.ts';
import { fetchIssueBodyFromGitHub } from './invoke-reviewer-contract-mapping.ts';
import { resolveIssueNumber } from '../plugins/codex-pr-reviewer/lib/scope_context.ts';
import { runSmokeGhSync } from './worker-smoke-run.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'chetwerikoff/orchestrator-pack';
const PR_NUMBER = 1698;
const ISSUE_NUMBER = 1623;
const HEAD_SHA = 'a'.repeat(40);
const tempRoots: string[] = [];
const originalEnv = { ...process.env };

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function commandResult(command: string, args: readonly string[], cwd: string) {
  return runProcessSync({
    command,
    args,
    cwd,
    inheritParentEnv: true,
  });
}

function controlledPath(nativeBin: string): string {
  const candidates = [
    nativeBin,
    dirname(process.execPath),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  return [...new Set(candidates)].join(delimiter);
}

function parseNativeCalls(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createTrackedGhRuntimeFixture(): {
  checkout: string;
  nativeBin: string;
  nativeGh: string;
  nativeCallsFile: string;
  pathValue: string;
} {
  const checkout = tempRoot('opk-1623-tracked-gh-runtime-');
  const nativeBin = join(checkout, 'native-bin');
  const nativeCallsFile = join(checkout, 'native-calls.jsonl');
  mkdirSync(nativeBin, { recursive: true });

  expect(commandResult('git', ['init', '--quiet', checkout], checkout).ok).toBe(true);
  expect(commandResult(
    'git',
    ['-C', checkout, 'remote', 'add', 'origin', `https://github.com/${REPOSITORY}.git`],
    checkout,
  ).ok).toBe(true);

  const nativeGh = join(nativeBin, 'gh');
  symlinkSync(process.execPath, nativeGh);

  writeFileSync(join(checkout, 'repo'), `
const { appendFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(nativeCallsFile)}, JSON.stringify({
  kind: 'repo-view',
  args: process.argv.slice(2),
  wrapperActive: process.env.GH_WRAPPER_ACTIVE ?? '',
}) + '\\n', 'utf8');
process.stderr.write('GraphQL: API rate limit exceeded for user\\n');
process.exitCode = 1;
`, 'utf8');

  const issueBody = [
    '```allowed-roots',
    'scripts/',
    '```',
  ].join('\\n');
  writeFileSync(join(checkout, 'api'), `
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const endpoint = args.find((value) => value === 'user' || value.startsWith('repos/')) ?? '';
appendFileSync(${JSON.stringify(nativeCallsFile)}, JSON.stringify({
  kind: 'api',
  endpoint,
  args,
  wrapperActive: process.env.GH_WRAPPER_ACTIVE ?? '',
}) + '\\n', 'utf8');
if (endpoint === 'user') {
  process.stdout.write(JSON.stringify({ login: 'pack-reviewer' }));
} else if (endpoint === 'repos/${REPOSITORY}/pulls/${PR_NUMBER}') {
  process.stdout.write(JSON.stringify({
    number: ${PR_NUMBER},
    body: 'Closes #${ISSUE_NUMBER}',
    html_url: 'https://github.com/${REPOSITORY}/pull/${PR_NUMBER}',
    state: 'open',
    draft: false,
    head: { sha: '${HEAD_SHA}', ref: 'issue-1623-tracked-gh-binding' },
    base: { ref: 'main' },
    merged_at: null,
  }));
} else if (endpoint === 'repos/${REPOSITORY}/issues/${ISSUE_NUMBER}') {
  process.stdout.write(JSON.stringify({
    number: ${ISSUE_NUMBER},
    body: ${JSON.stringify(issueBody)},
    html_url: 'https://github.com/${REPOSITORY}/issues/${ISSUE_NUMBER}',
    state: 'open',
    state_reason: null,
    labels: [],
    assignees: [],
  }));
} else if (endpoint === 'repos/${REPOSITORY}/issues/${PR_NUMBER}/comments') {
  process.stdout.write(JSON.stringify([[
    {
      id: 77,
      body: 'fixture comment',
      html_url: 'https://github.com/${REPOSITORY}/pull/${PR_NUMBER}#issuecomment-77',
      issue_url: 'https://api.github.com/repos/${REPOSITORY}/issues/${PR_NUMBER}',
      user: { login: 'pack-reviewer' },
      created_at: '2026-08-26T00:00:00Z',
      updated_at: '2026-08-26T00:00:00Z',
    },
  ]]));
} else if (endpoint === 'repos/${REPOSITORY}/pulls/${PR_NUMBER}/reviews') {
  process.stdout.write(JSON.stringify([[]]));
} else {
  process.stderr.write('unexpected endpoint: ' + endpoint + '\\n');
  process.exitCode = 2;
}
`, 'utf8');

  return {
    checkout,
    nativeBin,
    nativeGh,
    nativeCallsFile,
    pathValue: controlledPath(nativeBin),
  };
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.doUnmock('./lib/gh-resolve-real-binary.mjs');
  vi.resetModules();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Issue #1623 ambient gh static recurrence guard', () => {
  it.each([
    ['runProcess command', "runProcess({\\n  command:\\n    'gh',\\n  args: ['pr', 'view', '1'],\\n});", "command: 'gh'"],
    ['execFileSync', "execFileSync(\\n  'gh',\\n  ['pr', 'view', '1'],\\n);", "execFileSync( 'gh'"],
    ['execFile', "execFile(\\n  'gh',\\n  ['pr', 'view', '1'],\\n);", "execFile( 'gh'"],
    ['spawnSync', "spawnSync(\\n  'gh',\\n  ['pr', 'view', '1'],\\n);", "spawnSync( 'gh'"],
    ['spawn', "spawn(\\n  'gh',\\n  ['pr', 'view', '1'],\\n);", "spawn( 'gh'"],
    ['ghApiJson', "ghApiJson(\\n  'gh',\\n  'repos/o/r/pulls/1',\\n);", "ghApiJson( 'gh'"],
  ])('rejects multiline %s executable selection', (_label, source, expected) => {
    expect(extractAmbientGhExecutableSelections(source)).toEqual([expected]);
  });

  it('keeps semantic gh argv legal when the executable is already tracked', () => {
    const source = [
      "const argv = ['gh', 'pr', 'view', '1'];",
      'runProcess({',
      '  command: resolveTrackedGhWrapper(),',
      '  args: argv.slice(1),',
      '});',
    ].join('\n');
    expect(extractAmbientGhExecutableSelections(source)).toEqual([]);
  });

  it('scans the full source while retaining useful source location evidence', () => {
    const root = tempRoot('opk-1623-static-guard-');
    const fixture = join(root, 'multiline.ts');
    writeFileSync(fixture, [
      'runProcess({',
      '  command:',
      "    'gh',",
      "  args: ['pr', 'view', '1'],",
      '});',
    ].join('\n'), 'utf8');
    const violations = scanFileForViolations(fixture, 'transport');
    expect(violations).toHaveLength(1);
    expect(violations[0]?.command).toBe("command: 'gh'");
    expect(violations[0]?.line).toContain('line 2');
  });

  it('keeps every bounded already-safe control in the PowerShell transport root set', () => {
    const script = readFileSync(join(repoRoot, 'scripts', 'check-gh-inventory-static.ps1'), 'utf8');
    for (const requiredPath of [
      'scripts/lib/create-issue-stage-record-gh.ts',
      'scripts/publish-issue-body-sync.ts',
      'scripts/pr2-foundation/post-review-smoke.ts',
    ]) {
      expect(script).toContain(requiredPath);
    }
  });
});

describe('Issue #1623 focused tracked-wrapper runtime harness', () => {
  it('routes every measured read class through tracked scripts/gh under hostile PATH', async () => {
    if (process.platform === 'win32') return;
    const fixture = createTrackedGhRuntimeFixture();
    process.env.PATH = fixture.pathValue;
    process.env.GH_REAL_BINARY = fixture.nativeGh;
    process.env.GH_HOST = 'github.com';
    delete process.env.OPK_VITEST_HARNESS;

    const slug = await resolveRepositorySlug(fixture.checkout);
    expect(slug).toBe(REPOSITORY);
    expect(parseNativeCalls(fixture.nativeCallsFile)).toEqual([]);

    expect(await resolveGptHeadSha(fixture.checkout, PR_NUMBER, REPOSITORY)).toBe(HEAD_SHA);
    expect(await resolveCurrentPrHead(fixture.checkout, REPOSITORY, PR_NUMBER)).toBe(HEAD_SHA);

    const sourceTransport = createPackGptSourceCommentTransport({
      repoRoot: fixture.checkout,
      repoSlug: REPOSITORY,
      prNumber: PR_NUMBER,
    });
    expect(await sourceTransport.resolveActorLogin()).toBe('pack-reviewer');
    expect(await sourceTransport.listComments()).toHaveLength(1);
    expect((await sourceTransport.getComment(77)).id).toBe(77);

    const reviewTransport = createGithubReviewTransport({
      repoRoot: fixture.checkout,
      repoSlug: REPOSITORY,
      prNumber: PR_NUMBER,
    });
    expect(await reviewTransport.resolveActorLogin()).toBe('pack-reviewer');
    expect(await reviewTransport.listReviews()).toEqual([]);

    expect(fetchIssueBodyFromGitHub(ISSUE_NUMBER, fixture.checkout)).toContain('scripts/');

    const vitestValue = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(resolveIssueNumber({
        repoRoot: fixture.checkout,
        prNumber: PR_NUMBER,
      })).toBe(ISSUE_NUMBER);
    } finally {
      if (vitestValue === undefined) delete process.env.VITEST;
      else process.env.VITEST = vitestValue;
    }

    const smoke = runSmokeGhSync(
      ['issue', 'view', String(ISSUE_NUMBER), '--json', 'body'],
      fixture.checkout,
      {
        PATH: fixture.pathValue,
        GH_REAL_BINARY: fixture.nativeGh,
        GH_HOST: 'github.com',
      },
    );
    expect(smoke.ok).toBe(true);

    const nativeCalls = parseNativeCalls(fixture.nativeCallsFile);
    expect(nativeCalls.length).toBeGreaterThan(0);
    expect(nativeCalls.some((call) => call.kind === 'repo-view')).toBe(false);
    expect(nativeCalls.every((call) => call.wrapperActive === '1')).toBe(true);
  });

  it('fails the real worker-smoke read path closed on a missing tracked wrapper before native gh runs', async () => {
    if (process.platform === 'win32') return;
    const fixture = createTrackedGhRuntimeFixture();
    const missingWrapper = join(fixture.checkout, 'missing-pack-scripts', 'gh');
    process.env.PATH = fixture.pathValue;
    process.env.GH_REAL_BINARY = fixture.nativeGh;
    process.env.GH_HOST = 'github.com';

    vi.resetModules();
    vi.doMock('./lib/gh-resolve-real-binary.mjs', async () => {
      const actual = await vi.importActual<typeof import('./lib/gh-resolve-real-binary.mjs')>(
        './lib/gh-resolve-real-binary.mjs',
      );
      return {
        ...actual,
        resolveTrackedGhWrapper: () => actual.resolveTrackedGhWrapper(missingWrapper),
      };
    });

    const isolatedWorkerSmoke = await import('./worker-smoke-run.ts');
    expect(() => isolatedWorkerSmoke.runSmokeGhSync(
      ['issue', 'view', String(ISSUE_NUMBER), '--json', 'body'],
      fixture.checkout,
      {
        PATH: fixture.pathValue,
        GH_REAL_BINARY: fixture.nativeGh,
      },
    )).toThrow('command-runtime-bootstrap: missing or unusable tracked GitHub transport scripts/gh');
    expect(parseNativeCalls(fixture.nativeCallsFile)).toEqual([]);
  });
});
