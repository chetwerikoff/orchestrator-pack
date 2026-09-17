import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertCreateIssueActionCurrent,
  createIssueNextAction,
  createIssueRecoverableResult,
  createIssueTerminalResult,
  validateCreateIssueNextAction,
  type CreateIssueActionBinding,
} from './lib/create-issue-next-action.ts';
import { resolveCreateIssueBrowserOperatorConfig } from './lib/create-issue-browser-gpt-preflight.ts';
import {
  selectPrincipalOwnedCanonicalArtifact,
  sameGithubPrincipal,
  type PrincipalOwnedIssueComment,
} from './lib/create-issue-github-artifact-authority.ts';

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'opk-create-issue-convergence-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const binding: CreateIssueActionBinding = {
  repository: 'chetwerikoff/orchestrator-pack',
  issueNumber: 1935,
  sourceRevision: 'r03',
  stage: 'architectural-review',
  stageAttemptId: 'attempt-1935',
};

describe('create-Issue nextAction contract', () => {
  it('uses one validated argv-bearing action shape and terminal null shape', () => {
    const action = createIssueNextAction({
      kind: 'reconcile-stage',
      binding,
      argv: ['node', 'scripts/create-issue-stage-finalize.ts', 'reconcile-stage'],
    });
    expect(validateCreateIssueNextAction(action)).toEqual([]);
    expect(createIssueRecoverableResult({ cause: 'observation_lost', nextAction: action })).toMatchObject({
      ok: false,
      cause: 'observation_lost',
      nextAction: action,
    });
    expect(createIssueTerminalResult({ ok: false, cause: 'external_prerequisite' })).toEqual({
      ok: false,
      cause: 'external_prerequisite',
      nextAction: null,
    });
  });

  it('returns canonical stale_next_action when any state binding moves', () => {
    const action = createIssueNextAction({
      kind: 'reconcile-stage',
      binding,
      argv: ['node', 'scripts/create-issue-stage-finalize.ts', 'reconcile-stage'],
    });
    expect(assertCreateIssueActionCurrent({
      action,
      observed: { ...binding, sourceRevision: 'r04' },
    })).toMatchObject({
      ok: false,
      schema: 'create-issue-stale-next-action/v1',
      cause: 'stale_next_action',
      binding,
      observed: { sourceRevision: 'r04' },
      nextAction: null,
    });
  });
});

describe('principal-owned reviewer artifact authority', () => {
  const comment = (id: number, userLogin: string | null, body: string): PrincipalOwnedIssueComment => ({
    id,
    body,
    createdAt: '2026-09-17T00:00:00Z',
    updatedAt: '2026-09-17T00:00:00Z',
    userLogin,
    htmlUrl: `https://github.com/chetwerikoff/orchestrator-pack/issues/1935#issuecomment-${id}`,
  });

  it('matches authenticated login case-insensitively before uniqueness', () => {
    expect(sameGithubPrincipal('ChetWerikoff', 'chetwerikoff')).toBe(true);
    const selected = selectPrincipalOwnedCanonicalArtifact(
      [comment(1, 'other', 'match'), comment(2, 'CHETWERIKOFF', 'match')],
      'chetwerikoff',
      (candidate) => candidate.body === 'match',
    );
    expect(selected).toMatchObject({ ok: true, principalLogin: 'chetwerikoff', comment: { id: 2 } });
  });

  it('fails closed on duplicate principal-owned canonical matches even when bytes are identical', () => {
    const selected = selectPrincipalOwnedCanonicalArtifact(
      [comment(1, 'chetwerikoff', 'same'), comment(2, 'CHETWERIKOFF', 'same')],
      'chetwerikoff',
      (candidate) => candidate.body === 'same',
    );
    expect(selected).toMatchObject({ ok: false, cause: 'duplicate_principal_owned_match' });
  });

  it('reports wrong publisher rather than treating foreign canonical publication as principal authority', () => {
    const selected = selectPrincipalOwnedCanonicalArtifact(
      [comment(3, 'foreign-reviewer', 'canonical')],
      'chetwerikoff',
      (candidate) => candidate.body === 'canonical',
    );
    expect(selected).toMatchObject({ ok: false, cause: 'wrong_publisher' });
  });
});

describe('create-Issue Browser-GPT operator config', () => {
  it('accepts the two required environment values without a local config copy', () => {
    const root = tempRoot();
    const profile = join(root, 'chrome-profile');
    mkdirSync(profile);
    const result = resolveCreateIssueBrowserOperatorConfig({
      env: {
        DISCUSS_WITH_GPT_PROJECT_URL: 'https://chatgpt.com/g/g-test/project',
        DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR: profile,
      },
    });
    expect(result).toEqual({
      ok: true,
      config: {
        projectUrl: 'https://chatgpt.com/g/g-test/project',
        chromeUserDataDir: profile,
        source: 'environment',
      },
    });
  });

  it('requires one explicit absolute operator-owned config locator when the env pair is incomplete', () => {
    const result = resolveCreateIssueBrowserOperatorConfig({
      env: { DISCUSS_WITH_GPT_PROJECT_URL: 'https://chatgpt.com/g/g-test/project' },
    });
    expect(result).toMatchObject({
      ok: false,
      cause: 'operator_browser_config_required',
    });
  });

  it('reads only the exact caller-supplied operator config path', () => {
    const root = tempRoot();
    const profile = join(root, 'chrome-profile');
    mkdirSync(profile);
    const configPath = join(root, 'operator-local.config.json');
    writeFileSync(configPath, JSON.stringify({
      projectUrl: 'https://chatgpt.com/g/g-test/project',
      chromeUserDataDir: profile,
    }));
    const result = resolveCreateIssueBrowserOperatorConfig({ env: {}, operatorBrowserConfig: configPath });
    expect(result).toEqual({
      ok: true,
      config: {
        projectUrl: 'https://chatgpt.com/g/g-test/project',
        chromeUserDataDir: profile,
        source: 'operator-config',
        operatorConfigPath: configPath,
      },
    });
  });
});

describe('create-Issue send-boundary adoption', () => {
  it('runs inline preflight before detached Browser-GPT launch', () => {
    const source = readFileSync(join(process.cwd(), 'scripts', 'flow-manager-browser-gpt-long-run.ts'), 'utf8');
    const preflight = source.indexOf('runCreateIssueBrowserPreflight({');
    const launch = source.indexOf('spawnDetachedLauncher(launcherArgs, browserChildEnv)');
    expect(preflight).toBeGreaterThan(-1);
    expect(launch).toBeGreaterThan(preflight);
    expect(source).toContain("options.get('operator-browser-config')");
  });

  it('inventories exactly the canonical tracked GET /user principal read for Issue 1935', () => {
    const inventory = JSON.parse(readFileSync(join(process.cwd(), 'scripts', 'lib', 'graphql-quota-github-read-inventory.json'), 'utf8')) as {
      rows: Array<{ id?: string; ownerClass?: string; pattern?: string; ownerIssue?: number }>;
    };
    const rows = inventory.rows.filter((row) => row.ownerIssue === 1935);
    expect(rows).toEqual([{
      id: 'rest-authenticated-principal-login',
      ownerClass: 'rest_direct',
      pattern: '^gh api user --jq \\.login$',
      ownerIssue: 1935,
    }]);
  });
});
