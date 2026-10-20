import { existsSync, mkdirSync, mkdtempSync as rawMkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseIssueBody } from '@orchestrator-pack/shared/lib/issue_parser.js';
import {
  PR_SCOPE_DECLARATION_SCHEMA,
  canonicalizeEntry,
  REPOSITORY_ALLOWED_ROOTS,
  normalizeRepositoryPath,
  pathMatchesEntries,
  producePrScopeDeclaration,
  resolvePrScopeGuardApplicability,
  selectDeclarationArtifact,
  selectLiveIssueScope,
  validatePrScopeDeclaration,
} from './pr-scope-declaration.ts';
import { runProcessSync } from './kernel/subprocess.ts';
import { WRAPPER_PATH } from './lib/gh-resolve-real-binary.mjs';
import { checkPrScope } from './pr-scope-check.ts';
import { normalizeIssueConstraints } from '../plugins/task-declaration/lib/validate.ts';

const mockedIssueRead = vi.hoisted(() => ({
  body: null as string | null,
  calls: [] as Array<{
    command: string;
    args: readonly string[];
    cwd?: string;
    inheritParentEnv?: boolean;
  }>,
}));

vi.mock('./kernel/subprocess.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./kernel/subprocess.ts')>();
  return {
    ...actual,
    runProcessSync: (options: Parameters<typeof actual.runProcessSync>[0]): ReturnType<typeof actual.runProcessSync> => {
      if (mockedIssueRead.body !== null
        && options.args?.[0] === 'issue'
        && options.args?.[1] === 'view') {
        mockedIssueRead.calls.push({
          command: options.command,
          args: [...(options.args ?? [])],
          cwd: options.cwd,
          inheritParentEnv: options.inheritParentEnv,
        });
        return {
          outcome: 'exit',
          ok: true,
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({ body: mockedIssueRead.body }),
          stderr: '',
          timedOut: false,
          cancelled: false,
        };
      }
      return actual.runProcessSync(options);
    },
  };
});

const issueBody = [
  '```denylist',
  'vendor/**',
  'packages/core/**',
  'secrets/**',
  'credentials/**',
  '```',
  '```allowed-roots',
  'scripts/**',
  'docs/declarations/**',
  '```',
].join('\n');

const declarationFreeIssueBody = [
  '```denylist',
  'vendor/**',
  'packages/core/**',
  'secrets/**',
  'credentials/**',
  'docs/declarations/**',
  '```',
  '```allowed-roots',
  'scripts/**',
  '```',
].join('\n');

const filePatternLiveIssueBody = [
  '```denylist',
  'docs/declarations/**',
  'plugins/**/tests/secret*.test.ts',
  'scripts/foo-secret.test.ts',
  '```',
  '```allowed-roots',
  'plugins/**/tests/*.test.ts',
  'scripts/foo*.test.ts',
  '```',
].join('\n');

const supportedLiveIssueBody = filePatternLiveIssueBody
  .replace('plugins/**/tests/secret*.test.ts', 'plugins/scope-guard/tests/secret*')
  .replace('plugins/**/tests/*.test.ts', 'plugins/scope-guard/tests/**')
  .replace('scripts/foo*.test.ts', 'scripts/**');

const filePatternDeclarationIssueBody = [
  '```denylist',
  'vendor/**',
  'packages/core/**',
  'secrets/**',
  'credentials/**',
  '```',
  '```allowed-roots',
  'plugins/**/tests/*.test.ts',
  'scripts/foo*.test.ts',
  '```',
].join('\n');

const supportedDeclarationIssueBody = filePatternDeclarationIssueBody
  .replace('plugins/**/tests/*.test.ts', 'plugins/scope-guard/tests/**')
  .replace('scripts/foo*.test.ts', 'scripts/**');

const firstPartySurfaceIssueBody = [
  '```denylist',
  'vendor/**',
  'packages/core/**',
  '```',
  '```allowed-roots',
  '.claude/skills/**',
  '.cursor/skills/**',
  'plugins/**',
  'tests/external-output-references/**',
  'prompts/**',
  '```',
].join('\n');

const issue1352PowerShellPaths = [
  'tests/powershell/Issue748.RefreshConcurrency.Tests.ps1',
  'tests/powershell/Issue748.WorkerStatusPopulation.Tests.ps1',
  'tests/powershell/Issue771.PowerShellDependencyScope.Tests.ps1',
  'tests/powershell/Lint-SelfArchitect.Tests.ps1',
];

const issue1352ActiveTestPaths = [
  'tests/README.md',
  'tests/issue854-worker-status-binding-cache.mjs',
  ...issue1352PowerShellPaths,
  'tests/powershell/Issue748.UnknownSnapshotExpiry.Tests.ps1',
  'tests/worker-status-store-live-rca.ts',
].sort((left, right) => left.localeCompare(right));

const bootstrapAllowedPaths = [
  'scripts/pr-scope-check.ts',
  'scripts/pr-scope-check.ps1',
  'scripts/pr-scope-declaration.ts',
  'scripts/pr-scope-declaration.test.ts',
  '.github/workflows/scope-guard.yml',
];
const bootstrapHeadSha = '0123456789abcdef0123456789abcdef01234567';

const activeScopeGuardWorkflow = [
  'name: scope-guard',
  'on:',
  '  pull_request:',
  '    types: [opened, synchronize]',
  'jobs:',
  '  pr-scope-guard:',
  '    steps:',
  '      - name: Run pack scope guard',
  '        run: node --experimental-strip-types scripts/pr-scope-runner.ts',
].join('\n');

function fixtureGit(root: string, args: string[]): string {
  const result = runProcessSync({ command: 'git', args, cwd: root, inheritParentEnv: true });
  if (!result.ok) throw new Error(result.stderr || result.error || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function initializeDefaultWorkflow(
  root: string,
  workflow: string = activeScopeGuardWorkflow,
  repository = 'fixture/target',
): void {
  const gitDir = runProcessSync({ command: 'git', args: ['rev-parse', '--git-dir'], cwd: root, inheritParentEnv: true });
  if (!gitDir.ok) {
    fixtureGit(root, ['init', '--quiet']);
    fixtureGit(root, ['config', 'user.name', 'opk-test']);
    fixtureGit(root, ['config', 'user.email', 'opk-test@example.invalid']);
  }
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.github', 'workflows', 'scope-guard.yml'), workflow, 'utf8');
  fixtureGit(root, ['add', '.github/workflows/scope-guard.yml']);
  if (fixtureGit(root, ['status', '--porcelain'])) fixtureGit(root, ['commit', '--quiet', '-m', 'guard workflow']);
  const remoteUrl = 'https://github.com/' + repository + '.git';
  const remote = runProcessSync({ command: 'git', args: ['remote', 'get-url', 'origin'], cwd: root, inheritParentEnv: true });
  if (!remote.ok) fixtureGit(root, ['remote', 'add', 'origin', remoteUrl]);
  const bareRemote = join(root, '.git', 'fixture-origin.git');
  if (!existsSync(bareRemote)) {
    fixtureGit(root, ['init', '--bare', '--quiet', bareRemote]);
    fixtureGit(root, ['--git-dir', bareRemote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  fixtureGit(root, ['config', 'url.' + pathToFileURL(bareRemote).href + '.insteadOf', remoteUrl]);
  syncDefaultBranch(root);
}

function syncDefaultBranch(root: string): void {
  fixtureGit(root, ['push', '--quiet', '--force', 'origin', 'HEAD:refs/heads/main']);
  fixtureGit(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  fixtureGit(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
}

// Concurrent main-line producer regressions use bare temp roots. Supply those
// guarded-mode fixtures with real authoritative workflow/remote configuration.
function mkdtempSync(prefix: string): string {
  const root = rawMkdtempSync(prefix);
  if (prefix.includes('opk-deny-star-') || prefix.includes('opk-live-grammar-')) {
    initializeDefaultWorkflow(root);
  }
  return root;
}

type BootstrapIssueOptions = {
  markerRevision?: string;
  bootstrapRevision?: string;
  bootstrapHeadSha?: string;
  allowedImplementationPaths?: string[];
  allowedRoots?: string[];
  duplicateBootstrap?: boolean;
  duplicateMarker?: boolean;
  malformedBootstrap?: boolean;
};

function bootstrapIssueBody(options: BootstrapIssueOptions = {}): string {
  const markerRevision = options.markerRevision ?? 'r05';
  const bootstrap = {
    schema: 'scope-guard-bootstrap/v1',
    issueNumber: 1314,
    sourceRevision: options.bootstrapRevision ?? markerRevision,
    prNumber: 1316,
    headSha: options.bootstrapHeadSha ?? bootstrapHeadSha,
    workflowPath: '.github/workflows/scope-guard.yml',
    allowedImplementationPaths:
      options.allowedImplementationPaths ?? bootstrapAllowedPaths,
    declarationArtifactsAllowed: false,
    expiresOnMismatch: true,
  };
  const bootstrapFence = options.malformedBootstrap
    ? ['```scope-guard-bootstrap/v1', '{not-json', '```'].join('\n')
    : [
        '```scope-guard-bootstrap/v1',
        JSON.stringify(bootstrap, null, 2),
        '```',
      ].join('\n');
  return [
    `<!-- source-revision: ${markerRevision} -->`,
    ...(options.duplicateMarker
      ? [`<!-- source-revision: ${markerRevision} -->`]
      : []),
    bootstrapFence,
    ...(options.duplicateBootstrap ? [bootstrapFence] : []),
    '```denylist',
    'vendor/**',
    'packages/core/**',
    '```',
    '```allowed-roots',
    ...(options.allowedRoots ?? bootstrapAllowedPaths),
    '```',
  ].join('\n');
}

function selectBootstrapScope(
  body: string,
  binding: { issueNumber?: number; prNumber?: number; headSha?: string } = {},
) {
  return selectLiveIssueScope(
    body,
    normalizeIssueConstraints(parseIssueBody(body)),
    {
      issueNumber: 1314,
      prNumber: 1316,
      headSha: bootstrapHeadSha,
      ...binding,
    },
  );
}

function declaration(issueNumber = 42): Record<string, unknown> {
  return {
    schema_version: PR_SCOPE_DECLARATION_SCHEMA,
    issue_number: issueNumber,
    declared_paths: ['scripts/allowed.ts'],
    denylist: [
      'credentials/',
      'packages/core/',
      'secrets/',
      'vendor/',
    ],
    allowed_roots: ['docs/declarations/', 'scripts/'],
  };
}

describe('AO-free PR scope declaration contract', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses only the target origin default-branch workflow to identify the guard', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-guard-applicability-'));
    roots.push(root);
    initializeDefaultWorkflow(root);
    writeFileSync(
      join(root, '.github', 'workflows', 'scope-guard.yml'),
      'name: scope-guard\non:\n  push:\n    branches: [main]\njobs:\n  build:\n    steps:\n      - run: echo inert\n',
      'utf8',
    );
    expect(resolvePrScopeGuardApplicability(root)).toEqual({
      status: 'guarded',
      repository: 'fixture/target',
    });
  });


  it('gets authoritative remote default without refs/remotes/origin/HEAD or a trusted local cache', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-guard-no-symbolic-'));
    roots.push(root);
    initializeDefaultWorkflow(root, [
      'on:', '  push:', 'jobs:', '  build:', '    steps:', '      - run: echo not-a-guard',
    ].join('\n'), 'fixture/no-symbolic');
    fixtureGit(root, ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
    fixtureGit(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    expect(resolvePrScopeGuardApplicability(root)).toEqual({
      status: 'guard-free', repository: 'fixture/no-symbolic',
    });
  });

  it('uses the observed remote PR base, not remote default or stale tracking refs', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-guard-base-'));
    roots.push(root);
    initializeDefaultWorkflow(root);
    fixtureGit(root, ['push', '--quiet', 'origin', 'HEAD:refs/heads/release']);
    writeFileSync(join(root, '.github', 'workflows', 'scope-guard.yml'), [
      'on:', '  push:', 'jobs:', '  build:', '    steps:', '      - run: echo no-guard',
    ].join('\n'), 'utf8');
    fixtureGit(root, ['add', '.github/workflows/scope-guard.yml']);
    fixtureGit(root, ['commit', '--quiet', '-m', 'remove guard on main']);
    syncDefaultBranch(root);
    // A stale symbolic tracking ref pointing at release must not override the live default.
    fixtureGit(root, ['update-ref', 'refs/remotes/origin/release', 'HEAD~1']);
    fixtureGit(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release']);
    expect(resolvePrScopeGuardApplicability(root)).toMatchObject({ status: 'guard-free' });
    expect(resolvePrScopeGuardApplicability(root, { baseRef: 'origin/release' })).toEqual({
      status: 'guarded', repository: 'fixture/target',
    });
    expect(resolvePrScopeGuardApplicability(root, { baseRef: 'refs/heads/absent' }))
      .toMatchObject({ status: 'unverified' });
  });

  it('recognizes active inline and four-space YAML guard configurations', () => {
    const workflows = [
      [
        'on: { pull_request: { types: [opened, synchronize] } }',
        'jobs:', '    pr-scope-guard:', '        steps:',
        '            - run: node scripts/pr-scope-runner.ts',
      ].join('\n'),
      [
        'on:', '    pull_request:', '        types:', '            - opened', '            - synchronize',
        'jobs:', '    pr-scope-guard:', '        steps:',
        '            - name: Guard', '              run: node scripts/pr-scope-check.ts',
      ].join('\n'),
      [
        'on: [push, pull_request]', 'jobs:', '  pr-scope-guard:',
        "    if: github.event_name == 'pull_request'",
        '    steps:', '      - run: node scripts/pr-scope-runner.ts',
      ].join('\n'),
    ];
    for (const [index, yaml] of workflows.entries()) {
      const root = mkdtempSync(join(tmpdir(), 'opk-guard-yaml-'));
      roots.push(root);
      initializeDefaultWorkflow(root, yaml, 'fixture/yaml-' + index);
      expect(resolvePrScopeGuardApplicability(root)).toEqual({
        status: 'guarded', repository: 'fixture/yaml-' + index,
      });
    }
  });

  it('rejects closed-only PR events, PR-inert jobs, and disabled guard steps', () => {
    const workflows = [
      [
        'on: {pull_request: {types: [closed]}}', 'jobs:', '  pr-scope-guard:',
        '    steps:', '      - run: node scripts/pr-scope-runner.ts',
      ].join('\n'),
      [
        'on: pull_request', 'jobs:', '  pr-scope-guard:',
        "    if: github.event_name == 'push'",
        '    steps:', '      - run: node scripts/pr-scope-runner.ts',
      ].join('\n'),
      [
        'on: pull_request', 'jobs:', '  pr-scope-guard:',
        '    steps:', '      - if: false', '        run: node scripts/pr-scope-runner.ts',
      ].join('\n'),
      [
        'on: pull_request', 'jobs:', '  pr-scope-guard:',
        '    steps:', '      - run: echo safe',
        '      - if: false', '        run: node scripts/pr-scope-runner.ts',
      ].join('\n'),
    ];
    for (const [index, yaml] of workflows.entries()) {
      const root = mkdtempSync(join(tmpdir(), 'opk-guard-inert-yaml-'));
      roots.push(root);
      initializeDefaultWorkflow(root, yaml, 'fixture/inert-yaml-' + index);
      expect(resolvePrScopeGuardApplicability(root)).toEqual({
        status: 'guard-free', repository: 'fixture/inert-yaml-' + index,
      });
    }
  });

  it('returns unverified instead of guessing on conditional or partial PR guard activity', () => {
    const workflows = [
      [
        'on: pull_request', 'jobs:', '  pr-scope-guard:',
        "    if: github.ref == 'refs/heads/main'",
        '    steps:', '      - run: node scripts/pr-scope-runner.ts',
      ].join('\n'),
      [
        'on: {pull_request: {types: [opened]}}', 'jobs:', '  pr-scope-guard:',
        '    steps:', '      - run: node scripts/pr-scope-runner.ts',
      ].join('\n'),
    ];
    for (const yaml of workflows) {
      const root = mkdtempSync(join(tmpdir(), 'opk-guard-ambiguous-'));
      roots.push(root);
      initializeDefaultWorkflow(root, yaml, 'fixture/ambiguous');
      expect(resolvePrScopeGuardApplicability(root)).toMatchObject({ status: 'unverified' });
    }
  });


  it('reads a guarded target Issue through the pack wrapper with target cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-guard-target-gh-'));
    roots.push(root);
    initializeDefaultWorkflow(root);
    expect(resolvePrScopeGuardApplicability(root)).toMatchObject({ status: 'guarded' });
    expect(existsSync(join(root, 'scripts', 'gh'))).toBe(false);

    mockedIssueRead.body = issueBody;
    mockedIssueRead.calls.length = 0;
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      const generated = producePrScopeDeclaration([
        '--issue', '42',
        '--declared-paths', 'scripts/allowed.ts',
        '--repo-root', root,
      ]);
      expect(generated).toMatchObject({
        schema_version: PR_SCOPE_DECLARATION_SCHEMA,
        issue_number: 42,
        declared_paths: ['scripts/allowed.ts'],
      });
      expect(mockedIssueRead.calls).toEqual([{
        command: WRAPPER_PATH,
        args: ['issue', 'view', '42', '--json', 'body'],
        cwd: root,
        inheritParentEnv: true,
      }]);
      expect(JSON.parse(
        readFileSync(join(root, 'docs', 'declarations', '42.pr-scope.json'), 'utf8'),
      )).toEqual(generated);
    } finally {
      stdout.mockRestore();
      mockedIssueRead.body = null;
      mockedIssueRead.calls.length = 0;
    }
  });

  it('does not require declarations for confirmed guard-free targets and leaves history untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-guard-free-'));
    roots.push(root);
    initializeDefaultWorkflow(root, [
      'name: scope-guard',
      'on:',
      '  push:',
      '    branches: [main]',
      'jobs:',
      '  build:',
      '    steps:',
      '      - run: echo inert',
    ].join('\n'), 'fixture/unguarded');
    expect(resolvePrScopeGuardApplicability(root)).toEqual({
      status: 'guard-free',
      repository: 'fixture/unguarded',
    });
    const historicalDir = join(root, 'docs', 'declarations');
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      expect(producePrScopeDeclaration([
        '--issue', '42',
        '--declared-paths', 'scripts/allowed.ts',
        '--issue-body-file', join(root, 'missing-issue-body.md'),
        '--repo-root', root,
      ])).toBeNull();
      expect(existsSync(historicalDir)).toBe(false);
      mkdirSync(historicalDir, { recursive: true });
      const historicalPath = join(historicalDir, '42.pr-scope.json');
      writeFileSync(historicalPath, '{malformed historical bytes}\n');
      expect(producePrScopeDeclaration([
        '--issue', '42',
        '--declared-paths', 'scripts/allowed.ts',
        '--issue-body-file', join(root, 'missing-issue-body.md'),
        '--repo-root', root,
      ])).toBeNull();
      expect(readFileSync(historicalPath, 'utf8')).toBe('{malformed historical bytes}\n');
      expect(stdout).toHaveBeenCalledTimes(2);
      expect(stdout).toHaveBeenLastCalledWith(
        'no PR scope guard in fixture/unguarded; the Issue fences are the scope\n',
      );
    } finally {
      stdout.mockRestore();
    }
    expect(existsSync(join(historicalDir, '42.alternate.json'))).toBe(false);
  });

  it('fails closed when the selected repository default-branch config is unresolved', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-guard-unverified-'));
    roots.push(root);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      expect(() => producePrScopeDeclaration([
        '--issue', '42',
        '--declared-paths', 'scripts/allowed.ts',
        '--issue-body-file', join(root, 'missing-issue-body.md'),
        '--repo-root', root,
      ])).toThrow(/applicability is unverified/);
    } finally {
      stdout.mockRestore();
    }
    expect(existsSync(join(root, 'docs', 'declarations'))).toBe(false);
  });

  it('does not count an unrelated PR workflow or placeholder guard job', () => {
    const workflows = [
      'name: scope-guard\non:\n  pull_request:\n    types: [opened, synchronize]\njobs:\n  build:\n    steps:\n      - run: echo test\n',
      'name: scope-guard\non:\n  pull_request:\n    types: [opened, synchronize]\njobs:\n  pr-scope-guard:\n    steps:\n      - run: echo placeholder\n',
    ];
    for (const [index, workflow] of workflows.entries()) {
      const root = mkdtempSync(join(tmpdir(), `opk-guard-inert-${index}-`));
      roots.push(root);
      initializeDefaultWorkflow(root, workflow, `fixture/inert-${index}`);
      expect(resolvePrScopeGuardApplicability(root)).toEqual({
        status: 'guard-free',
        repository: `fixture/inert-${index}`,
      });
    }
  });

  it('rejects legacy snapshots and non-canonical paths', () => {
    expect(
      validatePrScopeDeclaration({
        issue_number: 42,
        iteration_id: 'ao-era',
      }),
    ).toMatchObject({ ok: false, kind: 'unsupported-schema' });

    expect(
      validatePrScopeDeclaration({
        ...declaration(),
        declared_paths: ['./scripts/allowed.ts'],
      }),
    ).toMatchObject({ ok: false, kind: 'invalid-normalization' });

    expect(
      validatePrScopeDeclaration({
        ...declaration(),
        declared_paths: ['scripts/allowed '],
      }),
    ).toMatchObject({ ok: false, kind: 'invalid-normalization' });

    expect(
      validatePrScopeDeclaration({
        ...declaration(),
        declared_paths: ['scripts/foo-public.test.ts'],
        allowed_roots: ['scripts/foo*.test.ts'],
      }),
    ).toMatchObject({ ok: false, kind: 'invalid-normalization' });
  });


  it('accepts terminal file stars for declared paths and denylist but never allowed roots', () => {
    const valid = {
      ...declaration(),
      declared_paths: ['scripts/.env.*'],
      allowed_roots: ['scripts/'],
    };
    expect(validatePrScopeDeclaration(valid, 42)).toMatchObject({ ok: true });

    expect(pathMatchesEntries('.env.fixture', ['.env.*'])).toBe(true);
    expect(pathMatchesEntries('.env', ['.env.*'])).toBe(false);
    expect(pathMatchesEntries('.env.fixture/child', ['.env.*'])).toBe(false);
    expect(pathMatchesEntries('scripts/.env.fixture', ['scripts/.env.*'])).toBe(true);
    expect(pathMatchesEntries('scripts/.env.fixture/child', ['scripts/.env.*'])).toBe(false);
    // Syntax recognition is not permission to widen the pack's repository root ceiling.
    expect(
      validatePrScopeDeclaration({ ...declaration(), declared_paths: ['.env.*'] }, 42),
    ).toMatchObject({ ok: false, kind: 'policy-violation' });

    for (const pattern of [
      '*',
      'scripts/*',
      'scripts/*.ts',
      'scripts/foo*bar',
      'scripts/foo**',
      'scripts/**/file.*',
      'scripts/file?.ts',
      'scripts/[ab].ts',
      'scripts/{one,two}.ts',
      'scripts/@(one|two).ts',
      'scripts/!(private).ts',
    ]) {
      expect(
        validatePrScopeDeclaration({ ...valid, declared_paths: [pattern] }, 42),
      ).toMatchObject({ ok: false, kind: 'invalid-normalization' });
    }
    expect(
      validatePrScopeDeclaration({ ...valid, allowed_roots: ['scripts/.env.*'] }, 42),
    ).toMatchObject({ ok: false, kind: 'invalid-normalization' });
    for (const badDeny of [
      'scripts/*.ts',
      'scripts/foo*bar',
      'scripts/foo**',
      'scripts/**/file.*',
      'scripts/*/secret/**',
      '**/credentials/**',
      'secrets/*.pem',
    ]) {
      expect(
        validatePrScopeDeclaration({
          ...valid,
          denylist: [...(valid.denylist as string[]), badDeny],
        }, 42),
      ).toMatchObject({ ok: false, kind: 'invalid-normalization' });
    }
    for (const changedPath of [
      'scripts/.env.*',
      'scripts/file?.ts',
      'scripts/[ab].ts',
      'scripts/{one,two}.ts',
      'scripts/@(one|two).ts',
    ]) {
      expect(normalizeRepositoryPath(changedPath)).toMatchObject({ ok: false });
    }
    const denylist = [
      ...(valid.denylist as string[]),
      'scripts/.env.private',
    ].sort((left, right) => left.localeCompare(right));
    expect(
      validatePrScopeDeclaration({ ...valid, denylist }, 42),
    ).toMatchObject({ ok: false, kind: 'policy-violation' });
  });

  it('generates bounded file patterns and guards the selected default declaration', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-file-star-'));
    roots.push(root);
    initializeDefaultWorkflow(root);
    const fixtureIssue = [
      '```denylist',
      'vendor/**',
      'packages/core/**',
      'secrets/**',
      'credentials/**',
      '```',
      '```allowed-roots',
      'scripts/**',
      '```',
    ].join('\n');
    const issueBodyFile = join(root, 'issue-body.md');
    writeFileSync(issueBodyFile, fixtureIssue);
    const output = producePrScopeDeclaration([
      '--issue', '42',
      '--declared-paths', 'scripts/.env.*',
      '--issue-body-file', issueBodyFile,
      '--repo-root', root,
    ]);
    if (!output) throw new Error('guarded producer should return a declaration');
    expect(output.declared_paths).toEqual(['scripts/.env.*']);
    expect(output.allowed_roots).toEqual(['scripts/']);
    const selectedPath = 'docs/declarations/42.pr-scope.json';
    const artifact = JSON.parse(readFileSync(join(root, selectedPath), 'utf8')) as unknown;
    expect(validatePrScopeDeclaration(artifact, 42)).toMatchObject({ ok: true });
    expect(artifact).toEqual(output);

    const paths = [selectedPath, 'scripts/.env.fixture'];
    const base = {
      repoRoot: root,
      prBody: 'Closes #42',
      issueBody: fixtureIssue,
      prPaths: paths,
      degradedMode: false,
      forkPr: false,
    };
    expect(checkPrScope(base)).toMatchObject({
      ok: true,
      mode: 'implementation',
      scopeSource: 'declaration',
      declarationPath: selectedPath,
      checkedPaths: paths,
      skippedControlArtifacts: [selectedPath],
    });

    for (const [badPath, reason] of [
      ['scripts/other.env', 'scope_violation'],
      ['scripts/.env.*', 'invalid_path'],
      ['vendor/secret.ts', 'scope_violation'],
      ['packages/core/index.ts', 'scope_violation'],
      ['docs/declarations/42.extra.txt', 'scope_violation'],
    ]) {
      expect(
        checkPrScope({ ...base, prPaths: [selectedPath, badPath] }),
      ).toMatchObject({ ok: false, reason });
    }

    const alternatePath = join(root, 'docs/declarations/42.alternate.json');
    writeFileSync(alternatePath, JSON.stringify(output));
    expect(checkPrScope(base)).toMatchObject({
      ok: false,
      reason: 'declaration-selection-failed',
    });
    rmSync(alternatePath);

    writeFileSync(
      issueBodyFile,
      fixtureIssue.replace('credentials/**', 'credentials/**\nscripts/.env.private'),
    );
    expect(() => producePrScopeDeclaration([
      '--issue', '42',
      '--declared-paths', 'scripts/.env.*',
      '--issue-body-file', issueBodyFile,
      '--repo-root', root,
    ])).toThrow(/denylisted by repository policy/);
  });

  it('accepts denylist filename suffixes through producer, selector and real guard matching', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-deny-star-'));
    roots.push(root);
    const body = issueBody.replace(
      'credentials/**\n',
      'credentials/**\n.env*\n.env.*\nsecrets/key*\nscripts/private*\n',
    );
    const bodyPath = join(root, 'issue-body.md');
    writeFileSync(bodyPath, body);
    const produced = producePrScopeDeclaration([
      '--issue', '42', '--declared-paths', 'scripts/public.ts',
      '--issue-body-file', bodyPath, '--repo-root', root,
    ]);
    expect(produced.denylist).toEqual([...produced.denylist].sort((a, b) => a.localeCompare(b)));
    for (const name of ['.env*', '.env.*', 'secrets/key*', 'scripts/private*']) {
      expect(produced.denylist).toContain(name);
    }
    const artifactPath = 'docs/declarations/42.pr-scope.json';
    expect(selectDeclarationArtifact(root, 42)).toMatchObject({ ok: true, path: artifactPath });
    expect(validatePrScopeDeclaration(
      JSON.parse(readFileSync(join(root, artifactPath), 'utf8')) as unknown, 42,
    )).toMatchObject({ ok: true });
    const live = selectLiveIssueScope(body, parseIssueBody(body));
    expect(live).toMatchObject({ ok: true });
    if (!live.ok) throw new Error(live.message);
    expect(live.denylist).toContain('scripts/private*');

    const base = {
      repoRoot: root, prBody: 'Closes #42', issueBody: body,
      prPaths: [artifactPath, 'scripts/public.ts'],
      degradedMode: false, forkPr: false,
    };
    expect(checkPrScope(base)).toMatchObject({
      ok: true, scopeSource: 'declaration', checkedPaths: base.prPaths,
    });
    for (const deniedPath of [
      'scripts/private.key', 'vendor/safe.ts', 'packages/core/allowed.ts',
    ]) {
      const denied = checkPrScope({ ...base, prPaths: [artifactPath, deniedPath] });
      expect(denied).toMatchObject({ ok: false, reason: 'scope_violation' });
      if (denied.ok) throw new Error('expected denylist match');
      expect(denied.violations?.denied).toEqual([deniedPath]);
    }
  });

  it('admits the exact .gitignore root without widening the root-file family', () => {
    expect(REPOSITORY_ALLOWED_ROOTS).toContain('.gitignore');
    expect(
      validatePrScopeDeclaration({
        ...declaration(),
        declared_paths: ['.gitignore'],
        allowed_roots: ['.gitignore'],
      }),
    ).toMatchObject({ ok: true });
  });
  it('enforces repository denylist precedence and root ceiling', () => {
    expect(
      validatePrScopeDeclaration({
        ...declaration(),
        declared_paths: ['vendor/secret.ts'],
      }),
    ).toMatchObject({ ok: false, kind: 'policy-violation' });

    expect(
      validatePrScopeDeclaration({
        ...declaration(),
        allowed_roots: ['README.md'],
      }),
    ).toMatchObject({ ok: false, kind: 'policy-violation' });
  });

  it('rejects the retired Issue 1352 PowerShell test surfaces', () => {
    for (const retiredPath of [
      ...issue1352PowerShellPaths,
      'tests/powershell/Issue748.UnknownSnapshotExpiry.Tests.ps1',
    ]) {
      expect(REPOSITORY_ALLOWED_ROOTS).not.toContain(retiredPath);
      expect(
        validatePrScopeDeclaration(
          {
            ...declaration(1352),
            declared_paths: [retiredPath],
            allowed_roots: [retiredPath],
          },
          1352,
        ),
      ).toMatchObject({ ok: false, kind: 'policy-violation' });
    }
    expect(REPOSITORY_ALLOWED_ROOTS).not.toContain('tests/powershell/**');
    expect(REPOSITORY_ALLOWED_ROOTS).not.toContain('tests/**');
  });

  it('admits only the exact surviving Issue 1352 active test surfaces', () => {
    const survivingPaths = issue1352ActiveTestPaths.filter(
      (path) => !path.endsWith('.ps1'),
    );
    expect(REPOSITORY_ALLOWED_ROOTS).toEqual(
      expect.arrayContaining(survivingPaths),
    );
    expect(REPOSITORY_ALLOWED_ROOTS).not.toEqual(
      expect.arrayContaining(issue1352PowerShellPaths),
    );

    const exactDeclaration = {
      ...declaration(1352),
      declared_paths: [...survivingPaths],
      allowed_roots: [...survivingPaths],
    };
    expect(validatePrScopeDeclaration(exactDeclaration, 1352)).toMatchObject({
      ok: true,
    });

    for (const unrelatedPath of [
      'tests/Unrelated.test.ts',
      'tests/powershell/Unrelated.Tests.ps1',
    ]) {
      const unrelatedPaths = [...survivingPaths, unrelatedPath].sort((left, right) =>
        left.localeCompare(right),
      );
      expect(
        validatePrScopeDeclaration(
          {
            ...declaration(1352),
            declared_paths: unrelatedPaths,
            allowed_roots: unrelatedPaths,
          },
          1352,
        ),
      ).toMatchObject({ ok: false, kind: 'policy-violation' });
    }
  });

  it('admits the tracked root Node pin and no other root version file', () => {
    expect(REPOSITORY_ALLOWED_ROOTS).toContain('.mise.toml');
    expect(
      validatePrScopeDeclaration(
        {
          ...declaration(1907),
          declared_paths: ['.mise.toml'],
          allowed_roots: ['.mise.toml'],
        },
        1907,
      ),
    ).toMatchObject({ ok: true });

    for (const unadmittedPin of ['.node-version', '.nvmrc', 'mise.toml']) {
      expect(REPOSITORY_ALLOWED_ROOTS).not.toContain(unadmittedPin);
      expect(
        validatePrScopeDeclaration(
          {
            ...declaration(1907),
            declared_paths: [unadmittedPin],
            allowed_roots: [unadmittedPin],
          },
          1907,
        ),
      ).toMatchObject({ ok: false, kind: 'policy-violation' });
    }
  });

  it('produces and verifies skills-fenced first-party declarations', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-pr-scope-'));
    roots.push(root);
    const git = (args: string[]) => {
      const result = runProcessSync({
        command: 'git',
        args,
        cwd: root,
        inheritParentEnv: true,
      });
      if (!result.ok) {
        throw new Error(result.stderr || result.error || `git ${args.join(' ')} failed`);
      }
      return result.stdout.trim();
    };

    git(['init', '--quiet']);
    git(['config', 'user.name', 'opk-test']);
    git(['config', 'user.email', 'opk-test@example.invalid']);
    initializeDefaultWorkflow(root);
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(root, '.cursor', 'skills'), { recursive: true });
    mkdirSync(join(root, 'plugins'), { recursive: true });
    mkdirSync(join(root, 'docs', 'declarations'), { recursive: true });
    writeFileSync(join(root, '.claude', 'skills', 'fixture.md'), 'claude fixture\n');
    writeFileSync(join(root, '.cursor', 'skills', 'fixture.md'), 'cursor fixture\n');
    writeFileSync(join(root, 'plugins', 'fixture.ts'), 'export const fixture = true;\n');
    git(['add', '.claude', '.cursor', 'plugins']);
    git(['commit', '--quiet', '-m', 'base']);
    syncDefaultBranch(root);
    const baseSha = git(['rev-parse', 'HEAD']);

    const issueBodyFile = join(root, 'issue-body.md');
    writeFileSync(issueBodyFile, firstPartySurfaceIssueBody, 'utf8');
    producePrScopeDeclaration([
      '--issue',
      '1228',
      '--declared-paths',
      '.claude/skills/fixture.md,.cursor/skills/fixture.md,plugins/fixture.ts',
      '--issue-body-file',
      issueBodyFile,
      '--repo-root',
      root,
    ]);
    git(['add', 'docs/declarations/1228.pr-scope.json']);
    git(['commit', '--quiet', '-m', 'head']);
    const headSha = git(['rev-parse', 'HEAD']);

    expect(
      checkPrScope({
        repoRoot: root,
        prBody: 'Closes #1228',
        issueBody: firstPartySurfaceIssueBody,
        prPaths: [],
        degradedMode: false,
        forkPr: false,
        baseSha,
        headSha,
      }),
    ).toMatchObject({ ok: true, mode: 'implementation' });

    for (const path of ['vendor/**', 'packages/core/**', '.claude/settings/**']) {
      expect(
        validatePrScopeDeclaration({
          ...declaration(1228),
          allowed_roots: [path.replace('/**', '/')],
          declared_paths: [path.replace('/**', '/secret.ts')],
        }),
      ).toMatchObject({ ok: false, kind: 'policy-violation' });
    }
  });

  it('requires exactly one current-Issue new-schema candidate', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-pr-scope-'));
    roots.push(root);
    mkdirSync(join(root, 'docs', 'declarations'), { recursive: true });
    const path = join(root, 'docs', 'declarations', '42.pr-scope.json');
    writeFileSync(path, `${JSON.stringify(declaration())}\n`, 'utf8');

    expect(selectDeclarationArtifact(root, 42)).toMatchObject({
      ok: true,
      path: 'docs/declarations/42.pr-scope.json',
    });

    writeFileSync(
      join(root, 'docs', 'declarations', '42.ao-era.json'),
      JSON.stringify({ issue_number: 42, iteration_id: 'legacy' }),
      'utf8',
    );
    expect(selectDeclarationArtifact(root, 42)).toMatchObject({
      ok: false,
      reason: 'unsupported-schema',
    });
  });

  it('closes missing, malformed, duplicate, conflicting, and wrong-Issue states', () => {
    const missing = mkdtempSync(join(tmpdir(), 'opk-pr-scope-'));
    roots.push(missing);
    expect(selectDeclarationArtifact(missing, 42)).toMatchObject({
      ok: false,
      reason: 'missing',
    });

    const malformed = mkdtempSync(join(tmpdir(), 'opk-pr-scope-'));
    roots.push(malformed);
    mkdirSync(join(malformed, 'docs', 'declarations'), { recursive: true });
    writeFileSync(
      join(malformed, 'docs', 'declarations', '42.bad.json'),
      '{not-json',
      'utf8',
    );
    expect(selectDeclarationArtifact(malformed, 42)).toMatchObject({
      ok: false,
      reason: 'malformed',
    });

    const duplicate = mkdtempSync(join(tmpdir(), 'opk-pr-scope-'));
    roots.push(duplicate);
    mkdirSync(join(duplicate, 'docs', 'declarations'), { recursive: true });
    for (const suffix of ['a', 'b']) {
      writeFileSync(
        join(duplicate, 'docs', 'declarations', `42.${suffix}.json`),
        `${JSON.stringify(declaration())}\n`,
        'utf8',
      );
    }
    expect(selectDeclarationArtifact(duplicate, 42)).toMatchObject({
      ok: false,
      reason: 'duplicate',
    });
  });

  it('closes conflicting, wrong-Issue, and discovery-error states', () => {
    const conflicting = mkdtempSync(join(tmpdir(), 'opk-pr-scope-'));
    roots.push(conflicting);
    mkdirSync(join(conflicting, 'docs', 'declarations'), { recursive: true });
    for (const [suffix, path] of [['a', 'scripts/a.ts'], ['b', 'scripts/b.ts']]) {
      writeFileSync(
        join(conflicting, 'docs', 'declarations', `42.${suffix}.json`),
        `${JSON.stringify({ ...declaration(), declared_paths: [path] })}\n`,
        'utf8',
      );
    }
    expect(selectDeclarationArtifact(conflicting, 42)).toMatchObject({
      ok: false,
      reason: 'conflicting',
    });

    const wrongIssue = mkdtempSync(join(tmpdir(), 'opk-pr-scope-'));
    roots.push(wrongIssue);
    mkdirSync(join(wrongIssue, 'docs', 'declarations'), { recursive: true });
    writeFileSync(
      join(wrongIssue, 'docs', 'declarations', 'unknown.json'),
      `${JSON.stringify(declaration())}\n`,
      'utf8',
    );
    expect(selectDeclarationArtifact(wrongIssue, 42)).toMatchObject({
      ok: false,
      reason: 'wrong-Issue',
    });

    const discoveryError = mkdtempSync(join(tmpdir(), 'opk-pr-scope-'));
    roots.push(discoveryError);
    mkdirSync(join(discoveryError, 'docs'), { recursive: true });
    writeFileSync(join(discoveryError, 'docs', 'declarations'), 'not a directory', 'utf8');
    expect(selectDeclarationArtifact(discoveryError, 42)).toMatchObject({
      ok: false,
      reason: 'candidate-discovery-error',
    });
  });

  it('shares fence syntax but keeps guarded multiplicity, grammar and root ceilings strict', () => {
    const valid = [
      '```denylist', 'vendor/**', 'packages/core/**', '```',
      '```allowed-roots', 'scripts/**', '```',
    ].join('\n');
    const scope = parseIssueBody(valid);
    expect(selectLiveIssueScope(valid, scope)).toMatchObject({ ok: true });
    const repeated = valid + '\n```denylist\nsecrets/**\n```';
    expect(parseIssueBody(repeated).denylist).toContain('secrets/**');
    expect(selectLiveIssueScope(repeated, parseIssueBody(repeated))).toMatchObject({
      ok: false, message: expect.stringContaining('exactly one denylist'),
    });
    for (const invalid of [
      valid.replace('```allowed-roots\nscripts/**\n```', ''),
      valid.replace('allowed-roots\nscripts/**', 'allowed-roots\n# empty'),
      valid.replace('allowed-roots\nscripts/**', 'allowed-roots\nscripts/*.ts'),
      valid.replace('allowed-roots\nscripts/**', 'allowed-roots\nscripts/**\nscripts/**'),
      valid.replace('allowed-roots\nscripts/**', 'allowed-roots\nother/**'),
      valid.replace('allowed-roots\nscripts/**', 'allowed-roots\n../scripts/**'),
    ]) {
      expect(selectLiveIssueScope(invalid, parseIssueBody(invalid)).ok, invalid).toBe(false);
    }
  });

  it('uses one explicit live-Issue scope only when no declaration candidate exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-pr-scope-'));
    roots.push(root);
    const inScopePaths = Array.from(
      { length: 8 },
      (_, index) => `scripts/allowed-${index}.ts`,
    );

    const base = {
      repoRoot: root,
      prBody: 'Closes #42',
      issueBody: declarationFreeIssueBody,
      prPaths: inScopePaths,
      degradedMode: false,
      forkPr: false,
    };

    expect(checkPrScope(base)).toMatchObject({
      ok: true,
      mode: 'implementation',
      scopeSource: 'live-issue',
      issueNumber: 42,
      checkedPaths: inScopePaths,
    });

    const ninthPath = checkPrScope({
      ...base,
      prPaths: [...inScopePaths, 'README.md'],
    });
    expect(ninthPath).toMatchObject({
      ok: false,
      reason: 'scope_violation',
    });
    if (ninthPath.ok) throw new Error('expected the ninth path to fail closed');
    expect(ninthPath.violations?.outOfScope).toEqual([
      expect.stringContaining('README.md'),
    ]);

    expect(
      checkPrScope({
        ...base,
        issueBody: `${declarationFreeIssueBody}\n\`\`\`allowed-roots\nscripts/**\n\`\`\`\n`,
      }),
    ).toMatchObject({
      ok: false,
      reason: 'declaration-selection-failed',
    });
  });

  it('selects full-grammar live-Issue policy without rejecting deny overlap', () => {
    // Historically allowed nested/file-star Issue roots now fail closed.
    expect(selectLiveIssueScope(
      filePatternLiveIssueBody, parseIssueBody(filePatternLiveIssueBody),
    )).toMatchObject({
      ok: false, message: expect.stringContaining('allowed_roots[0]'),
    });

    expect(selectLiveIssueScope(
      supportedLiveIssueBody, parseIssueBody(supportedLiveIssueBody),
    )).toEqual({
      ok: true,
      allowed_roots: ['plugins/scope-guard/tests/**', 'scripts/**'],
      denylist: [
        'docs/declarations/**',
        'plugins/scope-guard/tests/secret*',
        'scripts/foo-secret.test.ts',
      ],
    });

    const outsideCeiling = supportedLiveIssueBody.replace('scripts/**', 'outside/**');
    expect(selectLiveIssueScope(outsideCeiling, parseIssueBody(outsideCeiling)))
      .toMatchObject({ ok: false });

    const malformed = supportedLiveIssueBody.replace('scripts/**', 'scripts/*/foo.test.ts');
    expect(selectLiveIssueScope(malformed, parseIssueBody(malformed))).toMatchObject({
      ok: false, message: expect.stringContaining('allowed_roots[1]'),
    });
  });

  it('checks final-segment and nested file-pattern roots on the live-Issue route', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-pr-scope-'));
    roots.push(root);
    const base = {
      repoRoot: root,
      prBody: 'Closes #42',
      issueBody: filePatternLiveIssueBody,
      degradedMode: false,
      forkPr: false,
    };
    expect(checkPrScope({ ...base, prPaths: ['scripts/foo-public.test.ts'] })).toMatchObject({
      ok: false, reason: 'declaration-selection-failed',
      message: expect.stringContaining('allowed_roots[0]'),
    });

    // Exact file roots and terminal directory prefixes retain their original behavior.
    const supported = { ...base, issueBody: supportedLiveIssueBody };
    const allowedPaths = [
      'plugins/scope-guard/tests/check.test.ts',
      'plugins/scope-guard/tests/sub/nested.test.ts',
      'scripts/foo-public.test.ts',
    ];
    expect(checkPrScope({ ...supported, prPaths: allowedPaths })).toMatchObject({
      ok: true, scopeSource: 'live-issue', checkedPaths: allowedPaths,
    });
    for (const deniedPath of [
      'plugins/scope-guard/tests/secret-access.test.ts',
      'scripts/foo-secret.test.ts',
    ]) {
      const denied = checkPrScope({ ...supported, prPaths: [deniedPath] });
      expect(denied).toMatchObject({ ok: false, reason: 'scope_violation' });
      if (denied.ok) throw new Error('expected denylist priority to fail');
      expect(denied.violations?.denied).toEqual([deniedPath]);
    }
    const outside = checkPrScope({
      ...supported, prPaths: ['plugins/scope-guard/lib/check.test.ts'],
    });
    expect(outside).toMatchObject({ ok: false, reason: 'scope_violation' });
    if (outside.ok) throw new Error('expected outside path to fail');
    expect(outside.violations?.outOfScope).toEqual([
      expect.stringContaining('plugins/scope-guard/lib/check.test.ts'),
    ]);
  });

  it('compares declaration artifacts against full-grammar Issue roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-pr-scope-'));
    roots.push(root);
    mkdirSync(join(root, 'docs', 'declarations'), { recursive: true });
    const artifactPath = join(root, 'docs', 'declarations', '42.pr-scope.json');
    const allowedDeclaration = {
      schema_version: PR_SCOPE_DECLARATION_SCHEMA,
      issue_number: 42,
      declared_paths: [
        'plugins/scope-guard/tests/check.test.ts',
        'scripts/foo-public.test.ts',
      ],
      denylist: ['credentials/', 'packages/core/', 'secrets/', 'vendor/'],
      allowed_roots: [
        'plugins/scope-guard/tests/check.test.ts',
        'scripts/foo-public.test.ts',
      ],
    };
    writeFileSync(artifactPath, JSON.stringify(allowedDeclaration) + '\n', 'utf8');
    const base = {
      repoRoot: root,
      prBody: 'Closes #42',
      issueBody: filePatternDeclarationIssueBody,
      degradedMode: false,
      forkPr: false,
    };
    const declarationPath = 'docs/declarations/42.pr-scope.json';
    const allowedPaths = [
      declarationPath,
      'plugins/scope-guard/tests/check.test.ts',
      'scripts/foo-public.test.ts',
    ];
    expect(checkPrScope({ ...base, prPaths: allowedPaths })).toMatchObject({
      ok: false, reason: 'declaration-selection-failed',
      message: expect.stringContaining('allowed_roots[0]'),
    });

    const supported = { ...base, issueBody: supportedDeclarationIssueBody };
    expect(checkPrScope({ ...supported, prPaths: allowedPaths })).toMatchObject({
      ok: true, scopeSource: 'declaration', declarationPath,
    });
    const denied = checkPrScope({
      ...supported, prPaths: [declarationPath, 'vendor/secret.ts'],
    });
    expect(denied).toMatchObject({ ok: false, reason: 'scope_violation' });
    if (denied.ok) throw new Error('expected declaration denylist to fail');
    expect(denied.violations?.denied).toEqual(['vendor/secret.ts']);

    const outside = checkPrScope({
      ...supported, prPaths: [declarationPath, 'plugins/scope-guard/lib/check.test.ts'],
    });
    expect(outside).toMatchObject({ ok: false, reason: 'scope_violation' });
    if (outside.ok) throw new Error('expected declaration outside path to fail');
    expect(outside.violations?.outOfScope).toEqual([
      expect.stringContaining('plugins/scope-guard/lib/check.test.ts'),
    ]);

    const outsideIssuePolicy = {
      ...allowedDeclaration,
      declared_paths: ['plugins/scope-guard/lib/check.test.ts'],
      allowed_roots: ['plugins/scope-guard/lib/check.test.ts'],
    };
    writeFileSync(artifactPath, JSON.stringify(outsideIssuePolicy) + '\n', 'utf8');
    expect(checkPrScope({
      ...supported, prPaths: [declarationPath, 'plugins/scope-guard/lib/check.test.ts'],
    })).toMatchObject({
      ok: false, reason: 'declaration-selection-failed',
    });
  });

  it('rejects malformed field-specific live Issue syntax before a valid declaration can mask it', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-live-grammar-'));
    roots.push(root);
    mkdirSync(join(root, 'docs', 'declarations'), { recursive: true });
    const artifactPath = 'docs/declarations/42.pr-scope.json';
    const artifact = {
      ...declaration(),
      declared_paths: ['scripts/public.ts'],
      allowed_roots: ['scripts/public.ts'],
    };
    writeFileSync(join(root, artifactPath), JSON.stringify(artifact) + '\n');
    const bodyPath = join(root, 'issue-body.md');
    const input = {
      repoRoot: root, prBody: 'Closes #42', issueBody,
      prPaths: [artifactPath, 'scripts/public.ts'],
      degradedMode: false, forkPr: false,
    };
    expect(checkPrScope(input)).toMatchObject({ ok: true, scopeSource: 'declaration' });

    const cases: Array<{ field: 'allowed_roots' | 'denylist'; pattern: string }> = [
      { field: 'allowed_roots', pattern: 'src/*.py' },
      { field: 'allowed_roots', pattern: 'scripts/*.ts' },
      { field: 'allowed_roots', pattern: 'plugins/**/tests/*.test.ts' },
      { field: 'allowed_roots', pattern: 'scripts/*/secret/**' },
      { field: 'denylist', pattern: 'scripts/*/secret/**' },
      { field: 'denylist', pattern: '**/credentials/**' },
      { field: 'denylist', pattern: '**/secrets/**' },
      { field: 'denylist', pattern: 'secrets/*.pem' },
      { field: 'denylist', pattern: 'scripts/foo*bar' },
      { field: 'denylist', pattern: 'scripts/foo**' },
      { field: 'denylist', pattern: 'scripts/*' },
      { field: 'denylist', pattern: 'scripts/*.ts' },
    ];
    for (const { field, pattern } of cases) {
      const index = field === 'denylist' ? 4 : 1;
      const canonical = canonicalizeEntry(pattern, field, index);
      expect(canonical.ok).toBe(false);
      if (canonical.ok) throw new Error('expected invalid grammar');

      const malformedBody = field === 'denylist'
        ? issueBody.replace('credentials/**\n', 'credentials/**\n' + pattern + '\n')
        : issueBody.replace('scripts/**\n', 'scripts/**\n' + pattern + '\n');
      const selected = selectLiveIssueScope(malformedBody, parseIssueBody(malformedBody));
      expect(selected).toMatchObject({
        ok: false, message: expect.stringContaining(canonical.error),
      });
      writeFileSync(bodyPath, malformedBody);
      expect(() => producePrScopeDeclaration([
        '--issue', '42', '--declared-paths', 'scripts/public.ts',
        '--issue-body-file', bodyPath, '--repo-root', root,
      ])).toThrow(canonical.error);

      const validation = validatePrScopeDeclaration({
        ...artifact,
        [field]: field === 'denylist'
          ? [...(artifact.denylist as string[]), pattern]
          : ['scripts/public.ts', pattern],
      }, 42);
      expect(validation).toMatchObject({
        ok: false, kind: 'invalid-normalization',
        errors: expect.arrayContaining([canonical.error]),
      });

      const refused = checkPrScope({ ...input, issueBody: malformedBody });
      expect(refused).toMatchObject({
        ok: false, reason: 'declaration-selection-failed',
        message: expect.stringContaining(canonical.error),
        violations: { declarationErrors: expect.arrayContaining([canonical.error]) },
      });
    }

    // Repository defaults must not shift the diagnostic index from the Issue fence.
    const shortBody = [
      '```denylist', 'vendor/**', 'packages/core/**', 'secrets/*.pem', '```',
      '```allowed-roots', 'scripts/**', '```',
    ].join('\n');
    const indexed = canonicalizeEntry('secrets/*.pem', 'denylist', 2);
    if (indexed.ok) throw new Error('expected invalid denylist suffix');
    writeFileSync(bodyPath, shortBody);
    expect(() => producePrScopeDeclaration([
      '--issue', '42', '--declared-paths', 'scripts/public.ts',
      '--issue-body-file', bodyPath, '--repo-root', root,
    ])).toThrow(indexed.error);
    expect(selectLiveIssueScope(shortBody, parseIssueBody(shortBody))).toMatchObject({
      ok: false, message: expect.stringContaining(indexed.error),
    });
    expect(checkPrScope({ ...input, issueBody: shortBody })).toMatchObject({
      ok: false, message: expect.stringContaining(indexed.error),
    });
  });

  it('keeps a missing declaration fail-closed when the Issue permits declaration artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-pr-scope-'));
    roots.push(root);

    expect(
      checkPrScope({
        repoRoot: root,
        prBody: 'Closes #42',
        issueBody,
        prPaths: ['scripts/allowed.ts'],
        degradedMode: false,
        forkPr: false,
      }),
    ).toMatchObject({
      ok: false,
      reason: 'declaration-selection-failed',
      message: expect.stringContaining('fresh-declaration'),
    });
  });

  it('rejects multiple and duplicate closing links on the declaration-free path', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-pr-scope-'));
    roots.push(root);
    const base = {
      repoRoot: root,
      issueBody: declarationFreeIssueBody,
      prPaths: ['scripts/allowed.ts'],
      degradedMode: false,
      forkPr: false,
    };

    for (const prBody of [
      'Closes #41\nCloses #42',
      'Closes #42\nFixes #42',
    ]) {
      expect(checkPrScope({ ...base, prBody })).toMatchObject({
        ok: false,
        reason: 'declaration-selection-failed',
        message: expect.stringContaining('exactly one closing Issue reference'),
      });
    }
  });

  it('accepts a valid bootstrap-bound live scope', () => {
    expect(selectBootstrapScope(bootstrapIssueBody())).toEqual({
      ok: true,
      allowed_roots: bootstrapAllowedPaths,
      denylist: ['vendor/**', 'packages/core/**'],
    });
  });

  it('fails closed on stale bootstrap head or source revision', () => {
    expect(
      selectBootstrapScope(bootstrapIssueBody(), {
        headSha: 'fedcba9876543210fedcba9876543210fedcba98',
      }),
    ).toMatchObject({ ok: false });
    expect(
      selectBootstrapScope(
        bootstrapIssueBody({ bootstrapRevision: 'r04' }),
      ),
    ).toMatchObject({ ok: false });
  });

  it('fails closed on substituted or mismatched bootstrap paths', () => {
    expect(
      selectBootstrapScope(
        bootstrapIssueBody({
          allowedImplementationPaths: [
            ...bootstrapAllowedPaths.slice(0, -1),
            'scripts/substituted.ts',
          ],
        }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      selectBootstrapScope(
        bootstrapIssueBody({
          allowedRoots: [
            ...bootstrapAllowedPaths.slice(0, -1),
            'scripts/substituted.ts',
          ],
        }),
      ),
    ).toMatchObject({ ok: false });
  });

  it('fails closed on missing context and malformed or duplicate bindings', () => {
    expect(
      selectBootstrapScope(bootstrapIssueBody(), {
        issueNumber: undefined,
      }),
    ).toMatchObject({ ok: false });
    expect(
      selectBootstrapScope(bootstrapIssueBody({ malformedBootstrap: true })),
    ).toMatchObject({ ok: false });
    expect(
      selectBootstrapScope(bootstrapIssueBody({ duplicateBootstrap: true })),
    ).toMatchObject({ ok: false });
    expect(
      selectBootstrapScope(bootstrapIssueBody({ duplicateMarker: true })),
    ).toMatchObject({ ok: false });
  });

  it('does not execute a substituted PR-head GitHub wrapper before bootstrap admission', () => {
    const workflow = readFileSync(
      join(process.cwd(), '.github', 'workflows', 'scope-guard.yml'),
      'utf8',
    );

    expect(workflow).toContain('trusted_root="$GITHUB_WORKSPACE/trusted-scope-guard"');
    expect(workflow).toContain('trusted_runner="$trusted_root/scripts/pr-scope-runner.ts"');
    expect(workflow).toContain('node --experimental-strip-types "$trusted_runner"');
    expect(workflow).not.toContain('$GITHUB_WORKSPACE/scripts/gh');
    expect(workflow).not.toContain('scope guard bootstrap:');
    const trustedRunnerStep = workflow.slice(
      workflow.indexOf('trusted_runner="$trusted_root/scripts/pr-scope-runner.ts"'),
    );
    expect(trustedRunnerStep).not.toContain('$GITHUB_WORKSPACE/scripts/gh');
  });

  it('does not let malformed current-Issue candidates use the live-Issue path', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-pr-scope-'));
    roots.push(root);
    mkdirSync(join(root, 'docs', 'declarations'), { recursive: true });
    writeFileSync(
      join(root, 'docs', 'declarations', '42.bad.json'),
      '{not-json',
      'utf8',
    );

    expect(
      checkPrScope({
        repoRoot: root,
        prBody: 'Closes #42',
        issueBody: declarationFreeIssueBody,
        prPaths: ['scripts/allowed.ts'],
        degradedMode: false,
        forkPr: false,
      }),
    ).toMatchObject({
      ok: false,
      reason: 'declaration-selection-failed',
    });
  });

  it('does not let duplicate current-Issue candidates use the live-Issue path', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-pr-scope-'));
    roots.push(root);
    mkdirSync(join(root, 'docs', 'declarations'), { recursive: true });
    for (const suffix of ['a', 'b']) {
      writeFileSync(
        join(root, 'docs', 'declarations', `42.${suffix}.json`),
        `${JSON.stringify(declaration())}\n`,
        'utf8',
      );
    }

    expect(
      checkPrScope({
        repoRoot: root,
        prBody: 'Closes #42',
        issueBody: declarationFreeIssueBody,
        prPaths: ['scripts/allowed.ts'],
        degradedMode: false,
        forkPr: false,
      }),
    ).toMatchObject({
      ok: false,
      reason: 'declaration-selection-failed',
    });
  });

  it('does not treat an unavailable diff as an empty successful diff', () => {
    expect(
      checkPrScope({
        repoRoot: process.cwd(),
        prBody: 'Closes #42',
        issueBody: declarationFreeIssueBody,
        prPaths: [],
        degradedMode: false,
        forkPr: false,
      }),
    ).toMatchObject({ ok: false, reason: 'diff-incomplete' });
  });

  it('runs the real producer-to-required-check contract', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-pr-scope-'));
    roots.push(root);
    const git = (args: string[]) => {
      const result = runProcessSync({
        command: 'git',
        args,
        cwd: root,
        inheritParentEnv: true,
      });
      if (!result.ok) {
        throw new Error(result.stderr || result.error || `git ${args.join(' ')} failed`);
      }
      return result.stdout.trim();
    };

    git(['init', '--quiet']);
    git(['config', 'user.name', 'opk-test']);
    git(['config', 'user.email', 'opk-test@example.invalid']);
    initializeDefaultWorkflow(root);
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'docs', 'declarations'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'allowed.ts'), 'export const allowed = "base";\n');
    git(['add', 'scripts/allowed.ts']);
    git(['commit', '--quiet', '-m', 'base']);
    syncDefaultBranch(root);
    const baseSha = git(['rev-parse', 'HEAD']);

    writeFileSync(join(root, 'scripts', 'allowed.ts'), 'export const allowed = "head";\n');
    const issueBodyFile = join(root, 'issue-body.md');
    writeFileSync(issueBodyFile, issueBody, 'utf8');
    producePrScopeDeclaration([
      '--issue',
      '42',
      '--declared-paths',
      'scripts/allowed.ts',
      '--issue-body-file',
      issueBodyFile,
      '--repo-root',
      root,
    ]);
    git(['add', 'scripts/allowed.ts', 'docs/declarations/42.pr-scope.json']);
    git(['commit', '--quiet', '-m', 'head']);
    const headSha = git(['rev-parse', 'HEAD']);

    const base = {
      repoRoot: root,
      prBody: 'Closes #42',
      issueBody,
      prPaths: [],
      degradedMode: false,
      forkPr: false,
      baseSha,
      headSha,
    };
    expect(checkPrScope(base)).toMatchObject({ ok: true, mode: 'implementation' });

    const manualPaths = { ...base, baseSha: undefined, headSha: undefined };
    expect(
      checkPrScope({ ...manualPaths, prPaths: ['scripts/other.ts'] }),
    ).toMatchObject({ ok: false, reason: 'scope_violation' });
    expect(
      checkPrScope({ ...manualPaths, prPaths: ['README.md'] }),
    ).toMatchObject({ ok: false, reason: 'scope_violation' });
    expect(
      checkPrScope({ ...manualPaths, prPaths: ['vendor/secret.ts'] }),
    ).toMatchObject({ ok: false, reason: 'scope_violation' });
  });
});
