import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PR_SCOPE_DECLARATION_SCHEMA,
  producePrScopeDeclaration,
  selectDeclarationArtifact,
  validatePrScopeDeclaration,
} from './pr-scope-declaration.ts';
import { checkPrScope } from './pr-scope-check.ts';

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

  it('does not treat an unavailable diff as an empty successful diff', () => {
    expect(
      checkPrScope({
        repoRoot: process.cwd(),
        prBody: 'Closes #42',
        issueBody,
        prPaths: [],
        degradedMode: false,
        forkPr: false,
      }),
    ).toMatchObject({ ok: false, reason: 'diff-incomplete' });
  });

  it('runs the real producer-to-required-check contract', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-pr-scope-'));
    roots.push(root);
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

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
