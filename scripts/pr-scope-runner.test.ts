import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcessSync } from './kernel/subprocess.ts';
import { PR_SCOPE_DECLARATION_SCHEMA } from './pr-scope-declaration.ts';
import {
  RUNTIME_HISTORY_DELIVERY_BRANCH,
  RUNTIME_HISTORY_DELIVERY_PATH,
  TERMINAL_ZERO_ESTATE_DELETION_ONLY_PATHS,
  acquirePrScopeDiff,
  type PrScopeCheckInput,
  type PrScopeDiffResult,
} from './pr-scope-check.ts';
import {
  OPERATOR_ADOPTION_MIGRATION_PATH,
  OPERATOR_ADOPTION_TRIGGER_PATHS,
  OPERATOR_ADOPTION_WAIVER,
  checkOperatorAdoption,
  runPrScopeRunner,
  type PrScopeRunnerDependencies,
  type RunnerPublishResult,
} from './pr-scope-runner.ts';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY = 'chetwerikoff/orchestrator-pack';
const ISSUE_NUMBER = 42;
const PR_NUMBER = 77;
const roots: string[] = [];

function buildIssueBody(blockDeclarationArtifacts: boolean): string {
  const denylist = [
    'credentials/**',
    'packages/core/**',
    'secrets/**',
    'vendor/**',
  ];
  if (blockDeclarationArtifacts) denylist.push('docs/declarations/**');
  const allowedRoots = blockDeclarationArtifacts
    ? ['scripts/**']
    : ['docs/declarations/**', 'scripts/**'];
  return [
    ['```denylist', ...denylist, '```'].join('\n'),
    ['```allowed-roots', ...allowedRoots, '```'].join('\n'),
  ].join('\n');
}

const implementationIssueBody = buildIssueBody(false);
const declarationFreeIssueBody = buildIssueBody(true);

function makeRepo(withDeclaration = false): string {
  const root = mkdtempSync(join(tmpdir(), 'opk-pr-scope-runner-'));
  roots.push(root);
  if (withDeclaration) {
    const declarationDir = join(root, 'docs', 'declarations');
    mkdirSync(declarationDir, { recursive: true });
    writeFileSync(
      join(declarationDir, `${ISSUE_NUMBER}.pr-scope.json`),
      `${JSON.stringify(
        {
          schema_version: PR_SCOPE_DECLARATION_SCHEMA,
          issue_number: ISSUE_NUMBER,
          declared_paths: ['scripts/allowed.ts'],
          denylist: [
            'credentials/',
            'packages/core/',
            'secrets/',
            'vendor/',
          ],
          allowed_roots: ['docs/declarations/', 'scripts/'],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
  return root;
}

function runnerEnv(root: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PR_NUMBER: String(PR_NUMBER),
    GITHUB_REPOSITORY: REPOSITORY,
    PR_SCOPE_REPO_ROOT: root,
    PR_BASE_SHA: '0'.repeat(40),
    PR_HEAD_SHA: '1'.repeat(40),
    PR_HEAD_REPO_FORK: 'false',
    PR_HEAD_REF: 'feature/test',
    PR_HEAD_REPO_SAME: 'true',
    ...overrides,
  };
}

function fixedDiff(
  scopePaths: string[],
  operatorAdoptionPaths: string[] = scopePaths,
): PrScopeDiffResult {
  return { ok: true, diff: { scopePaths, operatorAdoptionPaths } };
}

function fakeDependencies(options: {
  prBody: string;
  issueBody?: string;
  issueReadOk?: boolean;
  diff: PrScopeDiffResult;
  publication?: RunnerPublishResult;
}) {
  const comments: string[] = [];
  let issueReads = 0;
  const deps: PrScopeRunnerDependencies = {
    readPrBody: () => ({ ok: true, body: options.prBody }),
    readIssueBody: () => {
      issueReads += 1;
      return options.issueReadOk === false
        ? { ok: false, reason: 'fixture issue read failed' }
        : { ok: true, body: options.issueBody ?? implementationIssueBody };
    },
    publishComment: (_repo, _pr, body) => {
      comments.push(body);
      return options.publication ?? { ok: true };
    },
    acquireDiff: () => options.diff,
  };
  return { deps, comments, issueReads: () => issueReads };
}

function git(root: string, args: string[]): string {
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
}

function renameDiff(fromPath: string, toPath: string): PrScopeDiffResult {
  const root = makeRepo();
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'opk-test']);
  git(root, ['config', 'user.email', 'opk-test@example.invalid']);
  mkdirSync(dirname(join(root, fromPath)), { recursive: true });
  writeFileSync(join(root, fromPath), 'fixture\n', 'utf8');
  git(root, ['add', fromPath]);
  git(root, ['commit', '--quiet', '-m', 'base']);
  const baseSha = git(root, ['rev-parse', 'HEAD']);
  mkdirSync(dirname(join(root, toPath)), { recursive: true });
  git(root, ['mv', fromPath, toPath]);
  git(root, ['commit', '--quiet', '-m', 'rename']);
  const headSha = git(root, ['rev-parse', 'HEAD']);
  const input: PrScopeCheckInput = {
    repoRoot: root,
    prBody: '',
    issueBody: null,
    prPaths: [],
    degradedMode: false,
    forkPr: false,
    baseSha,
    headSha,
  };
  return acquirePrScopeDiff(input);
}

function statusDiff(
  path: string,
  status: 'A' | 'M' | 'D',
): PrScopeDiffResult {
  const root = makeRepo();
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'opk-test']);
  git(root, ['config', 'user.email', 'opk-test@example.invalid']);

  if (status === 'A') {
    writeFileSync(join(root, 'README.md'), 'base\n', 'utf8');
    git(root, ['add', 'README.md']);
  } else {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), 'base\n', 'utf8');
    git(root, ['add', path]);
  }
  git(root, ['commit', '--quiet', '-m', 'base']);
  const baseSha = git(root, ['rev-parse', 'HEAD']);

  if (status === 'D') {
    rmSync(join(root, path));
  } else {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      status === 'M' ? 'changed\n' : 'added\n',
      'utf8',
    );
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', status]);
  const headSha = git(root, ['rev-parse', 'HEAD']);

  const input: PrScopeCheckInput = {
    repoRoot: root,
    prBody: '',
    issueBody: null,
    prPaths: [],
    degradedMode: false,
    forkPr: false,
    baseSha,
    headSha,
  };
  return acquirePrScopeDiff(input);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('trusted PR scope runner', () => {
  it('preserves declaration-backed and declaration-free implementation passes', () => {
    const declaredRoot = makeRepo(true);
    const declared = fakeDependencies({
      prBody: `Closes #${ISSUE_NUMBER}`,
      issueBody: implementationIssueBody,
      diff: fixedDiff(['scripts/allowed.ts']),
    });
    const declaredOutcome = runPrScopeRunner(runnerEnv(declaredRoot), declared.deps);
    expect(declaredOutcome.result).toMatchObject({
      ok: true,
      mode: 'implementation',
      scopeSource: 'declaration',
    });
    expect(declared.comments).toHaveLength(1);
    expect(declared.comments[0]).toContain('## Scope guard — passed');

    const liveRoot = makeRepo();
    const live = fakeDependencies({
      prBody: `Closes #${ISSUE_NUMBER}`,
      issueBody: declarationFreeIssueBody,
      diff: fixedDiff(['scripts/live.ts']),
    });
    expect(runPrScopeRunner(runnerEnv(liveRoot), live.deps).result).toMatchObject({
      ok: true,
      mode: 'implementation',
      scopeSource: 'live-issue',
    });
  });

  it('fails declaration-backed out-of-scope paths', () => {
    const root = makeRepo(true);
    const fixture = fakeDependencies({
      prBody: `Closes #${ISSUE_NUMBER}`,
      issueBody: implementationIssueBody,
      diff: fixedDiff(['scripts/not-declared.ts']),
    });
    const outcome = runPrScopeRunner(runnerEnv(root), fixture.deps);
    expect(outcome.result).toMatchObject({ ok: false, reason: 'scope_violation' });
    expect(outcome.exitCode).toBe(1);
  });

  it.each(['', 'Closes not-a-number'])(
    'fails missing or malformed implementation binding: %j',
    (prBody) => {
      const root = makeRepo();
      const fixture = fakeDependencies({
        prBody,
        diff: fixedDiff(['scripts/code.ts']),
      });
      const outcome = runPrScopeRunner(runnerEnv(root), fixture.deps);
      expect(outcome.result).toMatchObject({ ok: false, reason: 'missing_issue_link' });
      expect(fixture.issueReads()).toBe(0);
    },
  );

  it('fails closed on malformed repository binding before decision reads', () => {
    const root = makeRepo();
    const comments: string[] = [];
    const deps: PrScopeRunnerDependencies = {
      readPrBody: () => {
        throw new Error('malformed binding must fail before PR read');
      },
      readIssueBody: () => {
        throw new Error('malformed binding must fail before Issue read');
      },
      publishComment: (_repo, _pr, body) => {
        comments.push(body);
        return { ok: true };
      },
      acquireDiff: () => {
        throw new Error('malformed binding must fail before diff acquisition');
      },
    };
    const outcome = runPrScopeRunner(
      runnerEnv(root, { PR_HEAD_REPO_FORK: 'not-a-boolean' }),
      deps,
    );
    expect(outcome.result).toMatchObject({ ok: false, reason: 'runner_configuration' });
    expect(outcome.exitCode).toBe(2);
    expect(comments).toHaveLength(1);
  });

  it('keeps linked Issue read failure fail-closed and degraded input inert', () => {
    const root = makeRepo(true);
    const fixture = fakeDependencies({
      prBody: `Closes #${ISSUE_NUMBER}`,
      issueReadOk: false,
      diff: fixedDiff(['scripts/allowed.ts']),
    });
    const outcome = runPrScopeRunner(
      runnerEnv(root, {
        SCOPE_GUARD_DEGRADED_LABEL: 'true',
        PR_HEAD_REPO_FORK: 'true',
      }),
      fixture.deps,
    );
    expect(outcome.result).toMatchObject({ ok: false, reason: 'issue_unreadable' });
    expect(fixture.issueReads()).toBe(1);
  });

  it('preserves spec-only and no-ceremony modes without inventing Issue reads', () => {
    const specRoot = makeRepo();
    const spec = fakeDependencies({
      prBody: `<!-- pr-type: spec-only -->\n\nRefs #${ISSUE_NUMBER}`,
      issueBody: 'fixture issue',
      diff: fixedDiff(['docs/issues_drafts/example.json']),
    });
    expect(runPrScopeRunner(runnerEnv(specRoot), spec.deps).result).toMatchObject({
      ok: true,
      mode: 'spec-only',
    });
    expect(spec.issueReads()).toBe(1);

    const docsRoot = makeRepo();
    const docs = fakeDependencies({
      prBody: 'Documentation only',
      diff: fixedDiff(['docs/architecture.md']),
    });
    expect(runPrScopeRunner(runnerEnv(docsRoot), docs.deps).result).toMatchObject({
      ok: true,
      mode: 'no-ceremony',
    });
    expect(docs.issueReads()).toBe(0);
  });

  it('preserves runtime-history exact identity and rejects wrong branch or fork', () => {
    const root = makeRepo();
    const pass = fakeDependencies({
      prBody: '',
      diff: fixedDiff([RUNTIME_HISTORY_DELIVERY_PATH]),
    });
    expect(
      runPrScopeRunner(
        runnerEnv(root, { PR_HEAD_REF: RUNTIME_HISTORY_DELIVERY_BRANCH }),
        pass.deps,
      ).result,
    ).toMatchObject({ ok: true, mode: 'runtime-history-delivery' });

    for (const overrides of [
      { PR_HEAD_REF: 'feature/wrong' },
      {
        PR_HEAD_REF: RUNTIME_HISTORY_DELIVERY_BRANCH,
        PR_HEAD_REPO_FORK: 'true',
      },
    ]) {
      const denied = fakeDependencies({
        prBody: '',
        diff: fixedDiff([RUNTIME_HISTORY_DELIVERY_PATH]),
      });
      expect(runPrScopeRunner(runnerEnv(root, overrides), denied.deps).result).toMatchObject({
        ok: false,
        reason: 'missing_issue_link',
      });
    }
  });

  it('ports the operator-adoption predicate exactly', () => {
    const trigger = OPERATOR_ADOPTION_TRIGGER_PATHS[0];
    expect(checkOperatorAdoption([trigger, OPERATOR_ADOPTION_MIGRATION_PATH], '')).toEqual({ ok: true });
    expect(checkOperatorAdoption([trigger], `x\n${OPERATOR_ADOPTION_WAIVER}\ny`)).toEqual({ ok: true });
    expect(checkOperatorAdoption([trigger], ` ${OPERATOR_ADOPTION_WAIVER}`)).toMatchObject({
      ok: false,
      triggeredPaths: [trigger],
    });
    expect(checkOperatorAdoption([trigger], '')).toMatchObject({
      ok: false,
      triggeredPaths: [trigger],
    });
  });

  it('admits only exact terminal zero-estate deletions', () => {
    const exactPath = TERMINAL_ZERO_ESTATE_DELETION_ONLY_PATHS[0];

    expect(statusDiff(exactPath, 'D')).toEqual({
      ok: true,
      diff: {
        scopePaths: [],
        operatorAdoptionPaths: [exactPath],
      },
    });

    for (const status of ['A', 'M'] as const) {
      expect(statusDiff(exactPath, status)).toEqual({
        ok: true,
        diff: {
          scopePaths: [exactPath],
          operatorAdoptionPaths: [exactPath],
        },
      });
    }

    const unrelatedPath = 'tests/powershell/not-authorized.Tests.ps1';
    expect(statusDiff(unrelatedPath, 'D')).toEqual({
      ok: true,
      diff: {
        scopePaths: [unrelatedPath],
        operatorAdoptionPaths: [unrelatedPath],
      },
    });

    const renamed = renameDiff(exactPath, 'scripts/terminal-zero-estate-renamed.ts');
    expect(renamed).toEqual({
      ok: true,
      diff: {
        scopePaths: [exactPath, 'scripts/terminal-zero-estate-renamed.ts'],
        operatorAdoptionPaths: ['scripts/terminal-zero-estate-renamed.ts'],
      },
    });
  });

  it('uses destination-only adoption projection for rename-away and rename-into', () => {
    const trigger = OPERATOR_ADOPTION_TRIGGER_PATHS[0];
    const awayTarget = 'scripts/runtime/registry-renamed.ts';
    const away = renameDiff(trigger, awayTarget);
    expect(away).toEqual({
      ok: true,
      diff: {
        scopePaths: [trigger, awayTarget],
        operatorAdoptionPaths: [awayTarget],
      },
    });
    if (away.ok) {
      expect(checkOperatorAdoption(away.diff.operatorAdoptionPaths, '')).toEqual({ ok: true });
    }

    const intoSource = 'scripts/runtime/registry-old.ts';
    const into = renameDiff(intoSource, trigger);
    expect(into).toEqual({
      ok: true,
      diff: {
        scopePaths: [intoSource, trigger],
        operatorAdoptionPaths: [trigger],
      },
    });
    if (into.ok) {
      expect(checkOperatorAdoption(into.diff.operatorAdoptionPaths, '')).toMatchObject({
        ok: false,
        triggeredPaths: [trigger],
      });
    }
  });

  it('fails closed on decision-critical PR transport failure and comments at most once', () => {
    const root = makeRepo();
    const comments: string[] = [];
    const deps: PrScopeRunnerDependencies = {
      readPrBody: () => ({ ok: false, reason: 'fixture transport failure' }),
      readIssueBody: () => {
        throw new Error('must not read Issue after PR read failure');
      },
      publishComment: (_repo, _pr, body) => {
        comments.push(body);
        return { ok: true };
      },
      acquireDiff: () => {
        throw new Error('must not acquire diff after PR read failure');
      },
    };
    const outcome = runPrScopeRunner(runnerEnv(root), deps);
    expect(outcome.result).toMatchObject({ ok: false, reason: 'pr_unreadable' });
    expect(outcome.exitCode).toBe(1);
    expect(comments).toHaveLength(1);
  });

  it('keeps comment-write failure non-authoritative', () => {
    const root = makeRepo();
    const fixture = fakeDependencies({
      prBody: 'Documentation only',
      diff: fixedDiff(['docs/architecture.md']),
      publication: { ok: false, diagnostic: 'fixture comment failure' },
    });
    const outcome = runPrScopeRunner(runnerEnv(root), fixture.deps);
    expect(outcome.result).toMatchObject({ ok: true, mode: 'no-ceremony' });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.commentAttempted).toBe(true);
    expect(outcome.commentPublished).toBe(false);
    expect(outcome.commentDiagnostic).toBe('fixture comment failure');
    expect(fixture.comments).toHaveLength(1);
  });

  it('keeps bootstrap/degraded policy out of the runner and retired wrapper surface', () => {
    const runner = readFileSync(join(SCRIPT_DIR, 'pr-scope-runner.ts'), 'utf8');
    const workflow = readFileSync(join(SCRIPT_DIR, '..', '.github', 'workflows', 'scope-guard.yml'), 'utf8');
    expect(runner).not.toContain('1305');
    expect(runner).not.toContain('scope-guard-bootstrap');
    expect(runner).not.toContain('collaborators/');
    expect(runner).not.toContain('scope-guard-degraded');
    expect(runner).toContain('runGhJsonCommand');
    expect(runner).toContain("join(TRUSTED_ROOT, 'scripts', 'gh')");

    expect(existsSync(join(SCRIPT_DIR, 'pr-scope-check.ps1'))).toBe(false);
    expect(workflow).toContain('trusted_runner="$trusted_root/scripts/pr-scope-runner.ts"');
    expect(workflow).toContain('node --experimental-strip-types "$trusted_runner"');
    expect(workflow).not.toContain('$GITHUB_WORKSPACE/scripts/gh');
  });
});
