import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { parseIssueBody } from '@orchestrator-pack/shared/lib/issue_parser.js';
import {
  PR_SCOPE_DECLARATION_SCHEMA,
  canonicalizeEntry,
  REPOSITORY_ALLOWED_ROOTS,
  normalizeRepositoryPath,
  pathMatchesEntries,
  producePrScopeDeclaration,
  selectDeclarationArtifact,
  selectLiveIssueScope,
  validatePrScopeDeclaration,
} from './pr-scope-declaration.ts';
import { runProcessSync } from './kernel/subprocess.ts';
import { checkPrScope } from './pr-scope-check.ts';
import { normalizeIssueConstraints } from '../plugins/task-declaration/lib/validate.ts';

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
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(root, '.cursor', 'skills'), { recursive: true });
    mkdirSync(join(root, 'plugins'), { recursive: true });
    mkdirSync(join(root, 'docs', 'declarations'), { recursive: true });
    writeFileSync(join(root, '.claude', 'skills', 'fixture.md'), 'claude fixture\n');
    writeFileSync(join(root, '.cursor', 'skills', 'fixture.md'), 'cursor fixture\n');
    writeFileSync(join(root, 'plugins', 'fixture.ts'), 'export const fixture = true;\n');
    git(['add', '.claude', '.cursor', 'plugins']);
    git(['commit', '--quiet', '-m', 'base']);
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
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'docs', 'declarations'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'allowed.ts'), 'export const allowed = "base";\n');
    git(['add', 'scripts/allowed.ts']);
    git(['commit', '--quiet', '-m', 'base']);
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
