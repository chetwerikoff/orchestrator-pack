// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcessSync } from './kernel/subprocess.ts';
import { bindPublishIssueTarget } from './publish-issue-body-sync.ts';
import { syncPublishIssueBody } from './lib/publish-issue-body-sync.ts';
import { manualPackReviewRequiredCiGreen, requiredStatusChecksEndpoint, resolveCurrentPrHead, startPackReview } from './pack-review-runner.ts';
import { parseArgs as parseRunPackReviewArgs } from './run-pack-review-gpt.ts';
import { parseReviewArgs } from '../plugins/codex-pr-reviewer/lib/review_cli.ts';
import { parsePackWorkerReportArgs } from './pack-worker-report.ts';
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
const ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'OPK_PROJECT_ID', 'OPK_CREATE_ISSUE_DRAFT_STATE_ROOT', 'OPK_VITEST_HARNESS', 'VITEST'] as const;

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
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, 'config') };
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
  it('drives the real publication and canonical PR-read seams through either selected card', async () => {
    const fixture = twoTargetFixture();
    const issuePrNumber = 77;
    const draftContent = '# Target routing\n\ncard-routed body';
    for (const spec of fixture.specs) {
      const env = { ...fixture.env, OPK_PROJECT_ID: spec.projectId };
      const publish = { mode: 'edit' as const, draftPath: 'draft.md', repo: '', json: false };
      expect(bindPublishIssueTarget(publish, env)).toEqual({
        projectId: spec.projectId,
        repository: spec.repository,
        defaultBranch: spec.defaultBranch,
      });
      const selected = resolveTargetContext({ projectId: spec.projectId, env });
      expect(publish.repo).toBe(selected.repository);

      const bodyFilePath = join(fixture.root, `${spec.projectId}-issue-body.md`);
      const ghCalls: string[][] = [];
      const publication = syncPublishIssueBody({
        runGh(argv) {
          ghCalls.push([...argv]);
          if (argv[1] === 'issue' && argv[2] === 'edit') return { exitCode: 0, stdout: '', stderr: '' };
          if (argv[1] === 'api') return { exitCode: 0, stdout: 'card-routed body', stderr: '' };
          return { exitCode: 1, stdout: '', stderr: `unexpected argv: ${argv.join(' ')}` };
        },
        writeBodyFile() { return bodyFilePath; },
        emitAudit() {},
        validateTierGateGuard: () => ({ ok: true, message: 'fixture' }),
        validateStageCompletenessGuard: () => ({ ok: true, message: 'fixture' }),
        validateFindingLedgerGuard: () => ({ ok: true, message: 'fixture' }),
      }, {
        mode: 'edit',
        draftPath: publish.draftPath,
        draftContent,
        repo: publish.repo,
        issueNumber: issuePrNumber,
      });
      expect(publication).toMatchObject({ ok: true, issueNumber: issuePrNumber });
      expect(ghCalls).toEqual([
        ['gh', 'issue', 'edit', '--repo', selected.repository, '--body-file', bodyFilePath, String(issuePrNumber)],
        ['gh', 'api', `repos/${selected.repository}/issues/${issuePrNumber}`, '--jq', '.body'],
      ]);

      const prCalls: Array<{ args?: readonly string[]; cwd?: string }> = [];
      const expectedHead = spec.projectId === 'alpha' ? 'a'.repeat(40) : 'b'.repeat(40);
      const resolvedHead = await resolveCurrentPrHead(
        selected.primaryRoot,
        selected.repository,
        issuePrNumber,
        async (request) => {
          prCalls.push(request);
          return {
            outcome: 'exit',
            ok: true,
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({ state: 'OPEN', head: { sha: expectedHead } }),
            stderr: '',
            timedOut: false,
            cancelled: false,
          };
        },
      );
      expect(resolvedHead).toBe(expectedHead);
      expect(prCalls).toHaveLength(1);
      expect(prCalls[0]).toMatchObject({
        cwd: selected.primaryRoot,
        args: ['api', `repos/${selected.repository}/pulls/${issuePrNumber}`],
      });
    }
  });

  it('binds target review checkouts and comparison bases to the selected card', async () => {
    const fixture = twoTargetFixture();
    process.env.HOME = fixture.env.HOME;
    process.env.XDG_CONFIG_HOME = fixture.env.XDG_CONFIG_HOME;
    process.env.OPK_PROJECT_ID = 'alpha';
    process.env.OPK_VITEST_HARNESS = '1';
    const alphaRoot = join(fixture.root, 'alpha');
    expect(parseReviewArgs(['--repo-root', alphaRoot]).baseRef).toBe('origin/trunk');
    expect(() => parseReviewArgs(['--repo-root', join(fixture.root, 'beta')]))
      .toThrow(/does not match selected target example\/alpha/u);
    expect(() => parseReviewArgs(['--repo-root', alphaRoot, '--base', 'origin/main']))
      .toThrow(/does not match selected target base origin\/trunk/u);
    expect(() => parseRunPackReviewArgs(['--base', 'origin/main']))
      .toThrow(/does not match selected target base origin\/trunk/u);
    await expect(startPackReview({ baseRef: 'origin/main' }))
      .rejects.toThrow(/does not match selected target base origin\/trunk/u);
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

  it('authorizes selected target reads and supported mutations before gh transport', () => {
    const alpha = { repository: 'example/alpha' };
    for (const input of [
      {
        argv: ['pr', 'view', '12'],
        env: { OPK_PROJECT_ID: 'alpha', GH_WRAPPER_ACTIVE: '1' },
      },
      {
        argv: ['issue', 'comment', '12', '--repo', 'example/alpha', '--body', 'ok'],
        env: { OPK_PROJECT_ID: 'alpha' },
      },
      {
        argv: ['issue', 'comment', '12', '--repo', 'example/alpha', '--body', 'https://example.com'],
        env: { OPK_PROJECT_ID: 'alpha' },
      },
      {
        argv: ['issue', 'comment', '12', '-Rexample/alpha', '--body', 'ok'],
        env: { OPK_PROJECT_ID: 'alpha' },
      },
      {
        argv: ['issue', 'comment', '12', '-R=example/alpha', '--body', 'ok'],
        env: { OPK_PROJECT_ID: 'alpha' },
      },
      {
        argv: ['issue', 'transfer', '12', 'example/alpha'],
        env: { OPK_PROJECT_ID: 'alpha' },
      },
      {
        argv: ['api', 'repos/example/alpha/issues/12', '-X', 'PATCH', '-f', 'title=ok'],
        env: { OPK_PROJECT_ID: 'alpha' },
      },
    ]) {
      expect(authorizeTargetGhInvocation({
        context: alpha,
        argv: input.argv,
        env: input.env,
      })).toEqual({ repository: 'example/alpha', host: 'github.com' });
    }
    expect(authorizeTargetGhInvocation({
      context: { repository: 'chetwerikoff/orchestrator-pack' },
      argv: ['pr', 'view', '12', '--repo', 'chetwerikoff/orchestrator-pack'],
      env: { OPK_PROJECT_ID: 'pack' },
    })).toEqual({ repository: 'chetwerikoff/orchestrator-pack', host: 'github.com' });
  });

  it('rejects every audited cross-target repo/host ingress before gh transport', () => {
    const alpha = { repository: 'example/alpha' };
    const rejectCode = (run: () => unknown, code: string) => {
      try {
        run();
        throw new Error('expected rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(TargetGhAuthorizationError);
        expect((error as TargetGhAuthorizationError).code).toBe(code);
      }
    };

    for (const argv of [
      ['pr', 'view', '12', '--repo', 'example/beta'],
      ['pr', 'view', '12', '-R', 'example/beta'],
      ['pr', 'view', '12', '-Rexample/beta'],
      ['pr', 'view', '12', '-R=example/beta'],
      ['issue', 'transfer', '12', 'example/beta'],
      ['issue', 'transfer', '12', '--repo', 'example/alpha', 'example/beta'],
      ['api', 'repos/example/beta/pulls/12'],
      ['pr', 'view', 'https://github.com/example/beta/pull/12'],
      ['issue', 'view', 'https://github.com/example/beta/issues/12'],
      ['api', 'repos/example/beta/issues/12', '-X', 'PATCH', '-f', 'title=nope'],
    ]) {
      rejectCode(() => authorizeTargetGhInvocation({
        context: alpha,
        argv,
        env: { OPK_PROJECT_ID: 'alpha', GH_WRAPPER_ACTIVE: '1' },
      }), 'target-gh-repository-mismatch');
    }

    rejectCode(() => authorizeTargetGhInvocation({
      context: alpha,
      argv: ['pr', 'view', '12'],
      env: { OPK_PROJECT_ID: 'alpha', GH_REPO: 'example/beta' },
    }), 'target-gh-repository-mismatch');

    rejectCode(() => authorizeTargetGhInvocation({
      context: alpha,
      argv: ['pr', 'view', '12'],
      env: { OPK_PROJECT_ID: 'alpha', GH_HOST: 'ghe.example.test' },
    }), 'target-gh-host-mismatch');

    rejectCode(() => authorizeTargetGhInvocation({
      context: alpha,
      argv: ['pr', 'view', '12', '--hostname', 'ghe.example.test'],
      env: { OPK_PROJECT_ID: 'alpha' },
    }), 'target-gh-host-mismatch');

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

    rejectCode(() => authorizeTargetGhInvocation({
      context: { repository: 'example/bad slug' },
      argv: ['pr', 'view', '12'],
      env: { OPK_PROJECT_ID: 'alpha' },
    }), 'target-gh-repository-invalid');
  });

  it('stops mismatched attached repo and issue-transfer selectors before native gh', () => {
    if (process.platform === 'win32') return;
    const fixture = twoTargetFixture();
    const bin = join(fixture.root, 'native-bin');
    const audit = join(fixture.root, 'native-gh.log');
    mkdirSync(bin, { recursive: true });
    const fakeGh = join(bin, 'gh');
    writeFileSync(fakeGh, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >>"$OPK_NATIVE_GH_AUDIT"\n', 'utf8');
    chmodSync(fakeGh, 0o755);
    for (const args of [
      ['issue', 'comment', '12', '-Rexample/beta', '--body', 'x'],
      ['issue', 'comment', '12', '-R=example/beta', '--body', 'x'],
      ['issue', 'transfer', '12', 'example/beta'],
      ['issue', 'transfer', '12', '--repo', 'example/alpha', 'example/beta'],
    ]) {
      const result = runProcessSync({
        command: join(process.cwd(), 'scripts', 'gh'),
        args,
        cwd: join(fixture.root, 'alpha'),
        env: {
          ...process.env,
          PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: fixture.env.HOME,
          XDG_CONFIG_HOME: fixture.env.XDG_CONFIG_HOME,
          OPK_PROJECT_ID: 'alpha',
          OPK_NATIVE_GH_AUDIT: audit,
          GH_REAL_BINARY: fakeGh,
          GH_WRAPPER_ACTIVE: '',
        },
      });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('target-gh-repository-mismatch');
    }
    expect(existsSync(audit)).toBe(false);
  });

  it('uses the live target base for required-CI policy lookup, including non-main branches', async () => {
    expect(requiredStatusChecksEndpoint('example/alpha', 'trunk'))
      .toBe('repos/example/alpha/branches/trunk/protection/required_status_checks');
    expect(requiredStatusChecksEndpoint('example/alpha', 'release/2026'))
      .toBe('repos/example/alpha/branches/release%2F2026/protection/required_status_checks');

    const fixture = twoTargetFixture();
    process.env.OPK_VITEST_HARNESS = '1';
    const headSha = 'c'.repeat(40);
    await expect(manualPackReviewRequiredCiGreen({
      startInput: {
        fixtureRequiredCiPolicy: { contexts: ['orchestrator-pack/pack-review'] },
        fixtureRequiredCiChecks: [],
        fixtureRequiredCiHeadAfterGate: headSha,
      },
      target: {
        prNumber: 77,
        headSha,
        repoSlug: 'example/alpha',
        sourceRepoRoot: join(fixture.root, 'alpha'),
        prBaseRef: 'trunk',
      },
    })).resolves.toBe(true);
  });

  it('keeps the target-mode operator-unblock PR read on the authorized repository', () => {
    if (process.platform === 'win32') return;
    const fixture = twoTargetFixture();
    const bin = join(fixture.root, 'fake-bin');
    mkdirSync(bin, { recursive: true });
    const audit = join(fixture.root, 'native-gh.log');
    const fakeGh = join(bin, 'gh-native');
    const fakeNode = join(bin, 'node');
    writeFileSync(fakeGh, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" >>"\${OPK_GH_AUDIT}"\nprintf '%s\\n' '{"number":12,"head":{"ref":"topic"},"base":{"ref":"trunk"},"draft":false}'\n`, 'utf8');
    writeFileSync(fakeNode, `#!/usr/bin/env bash\nset -euo pipefail\njoined="$*"\ncase "$joined" in\n  *gh-target-authorization.ts*) printf '%s\\n' "\${OPK_EXPECTED_TARGET_REPO}" ;;\n  *gh-resolve-real-binary.mjs*) printf '%s\\n' "\${OPK_FAKE_GH}" ;;\n  *) exec "\${OPK_REAL_NODE}" "$@" ;;\nesac\n`, 'utf8');
    chmodSync(fakeGh, 0o755);
    chmodSync(fakeNode, 0o755);
    const result = runProcessSync({
      command: join(process.cwd(), 'scripts', 'gh'),
      args: ['pr', 'view', '12', '--json', 'number,headRefName,isDraft'],
      cwd: fixture.root,
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        GH_WRAPPER_ACTIVE: '',
        OPK_PROJECT_ID: 'alpha',
        OPK_EXPECTED_TARGET_REPO: 'example/alpha',
        OPK_FAKE_GH: fakeGh,
        OPK_GH_AUDIT: audit,
        OPK_REAL_NODE: process.execPath,
      },
    });
    expect(result.ok, result.stderr || result.error).toBe(true);
    expect(readFileSync(audit, 'utf8')).toContain('api repos/example/alpha/pulls/12');
  });

  it('requires selected context on target-classified review and report entrypoints outside test harnesses', () => {
    const fixture = twoTargetFixture();
    process.env.HOME = fixture.env.HOME;
    process.env.XDG_CONFIG_HOME = fixture.env.XDG_CONFIG_HOME;
    delete process.env.OPK_PROJECT_ID;
    delete process.env.OPK_VITEST_HARNESS;
    delete process.env.VITEST;
    const codeOf = (run: () => unknown) => {
      try {
        run();
        return 'no-error';
      } catch (error) {
        return typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code?: unknown }).code ?? '')
          : '';
      }
    };
    expect(codeOf(() => parseRunPackReviewArgs([]))).toBe('missing-selection');
    expect(codeOf(() => parseReviewArgs([]))).toBe('missing-selection');
    expect(codeOf(() => parsePackWorkerReportArgs(['ready_for_review'], fixture.env))).toBe('missing-selection');
  });

  it('fails the production publication target binding with typed missing-selection before transport', () => {
    const fixture = twoTargetFixture();
    const env = { ...fixture.env };
    delete env.OPK_PROJECT_ID;
    const publish = { mode: 'edit' as const, draftPath: 'draft.md', repo: '', json: false };
    try {
      bindPublishIssueTarget(publish, env);
      throw new Error('expected missing-selection');
    } catch (error) {
      expect(error).toMatchObject({ code: 'missing-selection' });
    }
  });
});
