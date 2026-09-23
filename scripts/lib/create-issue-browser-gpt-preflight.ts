import { runProcessSync } from '../kernel/subprocess.ts';
import {
  evaluateManagerBrowserEnvironmentPreflight,
  resolveManagerBrowserOperatorConfig,
} from './command-runtime-bootstrap.mjs';
import type {
  CreateIssueActionBinding,
  CreateIssueExternalPauseCause,
  CreateIssueNextAction,
} from './create-issue-next-action.ts';
import { createIssueNextAction } from './create-issue-next-action.ts';

export const CREATE_ISSUE_BROWSER_PREFLIGHT_SCHEMA = 'create-issue-browser-gpt-preflight/v1' as const;

export interface CreateIssueBrowserOperatorConfig {
  projectUrl: string;
  chromeUserDataDir: string;
  source: 'environment' | 'operator-config';
  operatorConfigPath?: string;
}

export interface CreateIssueBrowserPreflightSuccess {
  ok: true;
  schema: typeof CREATE_ISSUE_BROWSER_PREFLIGHT_SCHEMA;
  principalLogin: string;
  repository: string;
  config: CreateIssueBrowserOperatorConfig;
  childEnv: Record<string, string>;
  nextAction: null;
}

export interface CreateIssueBrowserPreflightFailure {
  ok: false;
  schema: typeof CREATE_ISSUE_BROWSER_PREFLIGHT_SCHEMA;
  cause:
    | 'tracked_github_unavailable'
    | 'workspace_dependencies_unavailable'
    | 'workspace_dependency_resolved_outside_worktree'
    | 'target_repository_unavailable'
    | 'authenticated_principal_unresolved'
    | 'operator_browser_config_required'
    | 'operator_browser_config_invalid';
  blocker: string;
  remedy: string;
  evidence: string;
  externalPauseCause?: CreateIssueExternalPauseCause;
  nextAction: CreateIssueNextAction | null;
}

export type CreateIssueBrowserPreflightResult =
  | CreateIssueBrowserPreflightSuccess
  | CreateIssueBrowserPreflightFailure;

export interface CreateIssueBrowserPreflightInput {
  repository: string;
  cwd: string;
  operatorBrowserConfig?: string;
  env?: NodeJS.ProcessEnv;
  binding?: CreateIssueActionBinding;
  retryArgv?: readonly string[];
}

function failure(
  cause: CreateIssueBrowserPreflightFailure['cause'],
  blocker: string,
  remedy: string,
  input: CreateIssueBrowserPreflightInput,
  retryable = false,
  evidence = blocker,
  externalPauseCause?: CreateIssueExternalPauseCause,
): CreateIssueBrowserPreflightFailure {
  let nextAction: CreateIssueNextAction | null = null;
  if (retryable && input.binding && input.retryArgv && input.retryArgv.length > 0) {
    nextAction = createIssueNextAction({
      kind: 'retry-create-issue-browser-preflight',
      binding: input.binding,
      argv: input.retryArgv,
    });
  }
  return {
    ok: false,
    schema: CREATE_ISSUE_BROWSER_PREFLIGHT_SCHEMA,
    cause,
    blocker,
    remedy,
    evidence,
    ...(externalPauseCause ? { externalPauseCause } : {}),
    nextAction,
  };
}

export function resolveCreateIssueBrowserOperatorConfig(input: {
  env: NodeJS.ProcessEnv;
  operatorBrowserConfig?: string;
}): { ok: true; config: CreateIssueBrowserOperatorConfig } | { ok: false; cause: CreateIssueBrowserPreflightFailure['cause']; blocker: string; remedy: string } {
  const resolved = resolveManagerBrowserOperatorConfig(input);
  if (!resolved.ok) {
    return {
      ok: false,
      cause: resolved.reason === 'operator_browser_config_required'
        ? 'operator_browser_config_required'
        : 'operator_browser_config_invalid',
      blocker: resolved.evidence,
      remedy: resolved.remedy,
    };
  }
  return {
    ok: true,
    config: resolved.config as CreateIssueBrowserOperatorConfig,
  };
}

export function runCreateIssueBrowserPreflight(input: CreateIssueBrowserPreflightInput): CreateIssueBrowserPreflightResult {
  const env = input.env ?? process.env;
  const environment = evaluateManagerBrowserEnvironmentPreflight({
    packRoot: input.cwd,
    env,
    effectivePath: env.PATH ?? '',
    operatorBrowserConfig: input.operatorBrowserConfig,
  });

  if (!environment.ok) {
    const cause: CreateIssueBrowserPreflightFailure['cause'] =
      environment.reason === 'workspace_dependencies_unavailable'
        ? 'workspace_dependencies_unavailable'
        : environment.reason === 'workspace_dependency_resolved_outside_worktree'
          ? 'workspace_dependency_resolved_outside_worktree'
          : environment.reason === 'operator_browser_config_required'
            ? 'operator_browser_config_required'
            : environment.reason === 'operator_browser_config_invalid'
              ? 'operator_browser_config_invalid'
              : 'tracked_github_unavailable';
    const externalPauseCause: CreateIssueExternalPauseCause =
      cause === 'tracked_github_unavailable'
        ? 'external:github_unavailable'
        : cause === 'operator_browser_config_required' || cause === 'operator_browser_config_invalid'
          ? 'external:chrome_not_running'
          : 'external:permission_denied';
    return failure(
      cause,
      environment.evidence,
      environment.remedy,
      input,
      false,
      `${environment.probe}: ${environment.evidence}`,
      externalPauseCause,
    );
  }

  const runtime = environment.runtime as {
    tools?: { packGh?: string };
  };
  const packGh = runtime.tools?.packGh;
  if (!packGh) {
    return failure(
      'tracked_github_unavailable',
      'manager environment preflight passed without a tracked scripts/gh path',
      'put tracked scripts/gh first on PATH before retrying manager admission',
      input,
      false,
      'tracked_gh_path: missing packGh after successful environment evaluation',
      'external:github_unavailable',
    );
  }

  const target = runProcessSync({
    command: packGh,
    args: ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    cwd: input.cwd,
    env,
    inheritParentEnv: true,
    timeoutMs: 10_000,
  });
  const observedRepository = target.stdout.trim();
  if (!target.ok || observedRepository.toLowerCase() !== input.repository.toLowerCase()) {
    return failure(
      'target_repository_unavailable',
      `tracked GitHub transport did not prove target repository ${input.repository} from ${input.cwd}${observedRepository ? `; observed ${observedRepository}` : ''}`,
      'run from the intended target-repository worktree with the tracked scripts/gh transport usable',
      input,
      true,
    );
  }

  const principal = runProcessSync({
    command: packGh,
    args: ['api', 'user', '--jq', '.login'],
    cwd: input.cwd,
    env,
    inheritParentEnv: true,
    timeoutMs: 10_000,
  });
  const principalLogin = principal.stdout.trim();
  if (!principal.ok || !principalLogin) {
    return failure(
      'authenticated_principal_unresolved',
      'tracked GitHub GET /user principal read failed or returned an empty login',
      'restore authenticated tracked scripts/gh access; do not substitute repository-owner or author-association inference',
      input,
      true,
    );
  }


  return {
    ok: true,
    schema: CREATE_ISSUE_BROWSER_PREFLIGHT_SCHEMA,
    principalLogin,
    repository: observedRepository,
    config: environment.config as CreateIssueBrowserOperatorConfig,
    childEnv: {
      DISCUSS_WITH_GPT_PROJECT_URL: environment.config.projectUrl,
      DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR: environment.config.chromeUserDataDir,
    },
    nextAction: null,
  };
}
