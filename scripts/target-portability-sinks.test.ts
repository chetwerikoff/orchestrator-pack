// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcessSync } from './kernel/subprocess.ts';
import { bindPublishIssueTarget } from './publish-issue-body-sync.ts';
import { resolvePackReviewSelectedRepository } from './pack-review-runner.ts';
import {
  defaultWorkdir,
  listPendingEvents,
  persistCycleId,
  readPersistedCycleId,
  resolveJournalWorkdir,
  writePendingEvent,
} from './lib/create-issue-stage-record-gh.ts';
import {
  TargetGhAuthorizationError,
  authorizeTargetGhInvocation,
} from './lib/gh-target-authorization.ts';
import { projectCardPath, resolveTargetContext } from './lib/target-context.ts';

const roots: string[] = [];
const savedEnv = new Map<string, string | undefined>();
const ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'OPK_PROJECT_ID', 'OPK_CREATE_ISSUE_DRAFT_STATE_ROOT'] as const;

function rememberEnv(): void {
  for (const key of ENV_KEYS) if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
}

function git(root: string, ...args: string[]): void {
  const result = runProcessSync({ command: 'git', args, cwd: root, inheritParentEnv: true });
  if (!result.ok) throw new Error(`git fixture failed: ${result.stderr || result.error || result.exitCode}`);
}

function twoTargetFixture() {
  rememberEnv();
  const root = mkdtempSync(join(tmpdir(), 'opk-target-sinks-'));
  roots.push(root);
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, 'config') };
  const specs = [
    { projectId: 'alpha', repository: 'example/alpha', defaultBranch: 'trunk' },
    { projectId: 'beta', repository: 'example/beta', defaultBranch: 'stable' },
  ] as const;
  for (const spec of specs) {
    const primaryRoot = join(root, spec.projectId);
    mkdirSync(primaryRoot, { recursive: true });
    git(primaryRoot, 'init');
    git(primaryRoot, 'remote', 'add', 'origin', `https://github.com/${spec.repository}.git`);
    const cardPath = projectCardPath(spec.projectId, env);
    mkdirSync(join(env.XDG_CONFIG_HOME!, 'orchestrator-pack', 'projects'), { recursive: true });
    writeFileSync(cardPath, JSON.stringify({
      ...spec,
      primaryRoot,
      orcaWorkspacePattern: `orca/workspaces/${spec.projectId}/`,
      orchestratorTitlePattern: `${spec.projectId}.*orchestrator`,
      browserGpt: { projectUrl: `https://chatgpt.com/g/${spec.projectId}/project` },
      verification: { local: ['true'] },
    }), 'utf8');
  }
  return { root, env, specs };
}

afterEach(() => {
  restoreEnv();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Issue #2188 target portability sinks', () => {
  it('routes production publication and pack-review repository binding through either selected card', async () => {
    const fixture = twoTargetFixture();
    for (const spec of fixture.specs) {
      const env = { ...fixture.env, OPK_PROJECT_ID: spec.projectId };
      const publish = { mode: 'edit' as const, draftPath: 'draft.md', repo: '', json: false };
      expect(bindPublishIssueTarget(publish, env)).toEqual({
        projectId: spec.projectId,
        repository: spec.repository,
        defaultBranch: spec.defaultBranch,
      });
      expect(publish.repo).toBe(spec.repository);

      const selected = resolveTargetContext({ projectId: spec.projectId, env });
      const observed: string[] = [];
      await expect(resolvePackReviewSelectedRepository({
        sourceRepoRoot: selected.primaryRoot,
        selectedTarget: selected,
        resolveRepository: async (root) => {
          observed.push(root);
          return spec.repository;
        },
      })).resolves.toBe(spec.repository);
      expect(observed).toEqual([selected.primaryRoot]);
    }
  });

  it('keeps same-number create-Issue journals project-disjoint and rejects cross-project replay', () => {
    const fixture = twoTargetFixture();
    process.env.HOME = fixture.env.HOME;
    process.env.XDG_CONFIG_HOME = fixture.env.XDG_CONFIG_HOME;

    process.env.OPK_PROJECT_ID = 'alpha';
    const alpha = defaultWorkdir(77);
    expect(alpha).toContain('/create-issue-draft/alpha/77/journal');
    writePendingEvent(alpha, {
      schema: 'create-issue-pending/v1',
      eventKey: 'same-event',
      body: 'alpha-only',
      createdAt: '2026-10-01T00:00:00.000Z',
    });
    persistCycleId(alpha, 'alpha-cycle');

    process.env.OPK_PROJECT_ID = 'beta';
    const beta = defaultWorkdir(77);
    expect(beta).toContain('/create-issue-draft/beta/77/journal');
    expect(beta).not.toBe(alpha);
    expect(listPendingEvents(beta)).toEqual([]);
    expect(readPersistedCycleId(beta)).toBeNull();
    writePendingEvent(beta, {
      schema: 'create-issue-pending/v1',
      eventKey: 'same-event',
      body: 'beta-only',
      createdAt: '2026-10-01T00:00:00.000Z',
    });
    persistCycleId(beta, 'beta-cycle');
    expect(listPendingEvents(beta).map((event) => event.body)).toEqual(['beta-only']);
    expect(readPersistedCycleId(beta)).toBe('beta-cycle');

    process.env.OPK_PROJECT_ID = 'alpha';
    expect(listPendingEvents(alpha).map((event) => event.body)).toEqual(['alpha-only']);
    expect(readPersistedCycleId(alpha)).toBe('alpha-cycle');

    process.env.OPK_PROJECT_ID = 'beta';
    expect(() => resolveJournalWorkdir(77, alpha))
      .toThrow(/create_issue_journal_workdir_override_untrusted/u);
  });

  it('rejects cross-target repo and host ingress before gh transport, including recursion-shaped invocations', () => {
    const alpha = { repository: 'example/alpha' };
    expect(authorizeTargetGhInvocation({
      context: alpha,
      argv: ['pr', 'view', '12'],
      env: { OPK_PROJECT_ID: 'alpha', GH_WRAPPER_ACTIVE: '1' },
    })).toEqual({ repository: 'example/alpha', host: 'github.com' });

    const rejectCode = (run: () => unknown, code: string) => {
      try {
        run();
        throw new Error('expected rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(TargetGhAuthorizationError);
        expect((error as TargetGhAuthorizationError).code).toBe(code);
      }
    };
    rejectCode(() => authorizeTargetGhInvocation({
      context: alpha,
      argv: ['api', 'repos/example/beta/pulls/12'],
      env: { OPK_PROJECT_ID: 'alpha', GH_WRAPPER_ACTIVE: '1' },
    }), 'target-gh-repository-mismatch');
    rejectCode(() => authorizeTargetGhInvocation({
      context: alpha,
      argv: ['pr', 'view', 'https://ghe.example.test/example/alpha/pull/12'],
      env: { OPK_PROJECT_ID: 'alpha' },
    }), 'target-gh-host-mismatch');
    rejectCode(() => authorizeTargetGhInvocation({
      context: alpha,
      argv: ['api', 'graphql', '-f', 'query={viewer{login}}'],
      env: { OPK_PROJECT_ID: 'alpha' },
    }), 'target-gh-graphql-unsupported');
  });
});
