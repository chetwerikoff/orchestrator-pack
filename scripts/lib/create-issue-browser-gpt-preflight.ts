import { runProcessSync } from '../kernel/subprocess.ts';
import { resolveTargetContext, TargetContextError } from './target-context.ts';
import {
  evaluateManagerBrowserEnvironmentPreflight,
  resolveManagerBrowserOperatorConfig,
} from './command-runtime-bootstrap.mjs';
import type {
  CreateIssueActionBinding,
  CreateIssueNextAction,
} from './create-issue-next-action.ts';
import { createIssueNextAction } from './create-issue-next-action.ts';

export const CREATE_ISSUE_BROWSER_PREFLIGHT_SCHEMA = 'create-issue-browser-gpt-preflight/v1' as const;

export interface CreateIssueBrowserOperatorConfig {
  projectId: string;
  projectUrl: string;
  cardPath: string;
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
    | 'operator_browser_config_invalid'
    | 'target_context_invalid';
  blocker: string;
  remedy: string;
  evidence: string;
  nextAction: CreateIssueNextAction | null;
}

export type CreateIssueBrowserPreflightResult =
  | CreateIssueBrowserPreflightSuccess
  | CreateIssueBrowserPreflightFailure;

export interface CreateIssueBrowserPreflightInput {
  repository: string;
  cwd: string;
  operatorBrowserConfig?: string;
  projectId?: string;
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
    nextAction,
  };
}

export function resolveCreateIssueBrowserOperatorConfig(input: {
  env: NodeJS.ProcessEnv;
  operatorBrowserConfig?: string;
  projectId?: string;
}): { ok: true; config: CreateIssueBrowserOperatorConfig } | { ok: false; cause: CreateIssueBrowserPreflightFailure['cause']; blocker: string; remedy: string } {
  let target;
  try {
    target = resolveTargetContext({ projectId: input.projectId, env: input.env });
  } catch (error) {
    const cardPath = error instanceof TargetContextError ? error.cardPath : undefined;
    return {
      ok: false,
      cause: 'target_context_invalid',
      blocker: error instanceof Error ? error.message : String(error),
      remedy: cardPath
        ? `fix the selected project card at ${cardPath}`
        : 'select --project <id> or OPK_PROJECT_ID and provide a valid project card',
    };
  }
  const resolved = resolveManagerBrowserOperatorConfig({
    env: input.env,
    operatorBrowserConfig: input.operatorBrowserConfig,
    targetProjectUrl: target.browserGpt.projectUrl,
    targetCardPath: target.cardPath,
  });
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
    config: {
      ...(resolved.config as Omit<CreateIssueBrowserOperatorConfig, 'projectId'>),
      projectId: target.projectId,
    },
  };
}

export function runCreateIssueBrowserPreflight(input: CreateIssueBrowserPreflightInput): CreateIssueBrowserPreflightResult {
  const env = input.env ?? process.env;
  let targetContext;
  try {
    targetContext = resolveTargetContext({ projectId: input.projectId, env });
  } catch (error) {
    const cardPath = error instanceof TargetContextError ? error.cardPath : undefined;
    return failure(
      'target_context_invalid',
      error instanceof Error ? error.message : String(error),
      cardPath ? `fix the selected project card at ${cardPath}` : 'select --project <id> or OPK_PROJECT_ID and provide a valid project card',
      input,
      false,
      `target_context: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (input.repository.trim().toLowerCase() !== targetContext.repository.toLowerCase()) {
    return failure(
      'target_repository_unavailable',
      `explicit repository ${input.repository} disagrees with selected project card repository ${targetContext.repository}`,
      `use repository ${targetContext.repository} from ${targetContext.cardPath}`,
      input,
      false,
    );
  }

  const environment = evaluateManagerBrowserEnvironmentPreflight({
    packRoot: targetContext.packRoot,
    env,
    effectivePath: env.PATH ?? '',
    operatorBrowserConfig: input.operatorBrowserConfig,
    targetProjectUrl: targetContext.browserGpt.projectUrl,
    targetCardPath: targetContext.cardPath,
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
              : environment.reason === 'target_context_required'
                ? 'target_context_invalid'
                : 'tracked_github_unavailable';
    return failure(
      cause,
      environment.evidence,
      environment.remedy,
      input,
      false,
      `${environment.probe}: ${environment.evidence}`,
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
    );
  }

  const target = runProcessSync({
    command: packGh,
    args: ['repo', 'view', targetContext.repository, '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    cwd: input.cwd,
    env,
    inheritParentEnv: true,
    timeoutMs: 10_000,
  });
  const observedRepository = target.stdout.trim();
  if (!target.ok || observedRepository.toLowerCase() !== targetContext.repository.toLowerCase()) {
    return failure(
      'target_repository_unavailable',
      `tracked GitHub transport did not prove selected target repository ${targetContext.repository}${observedRepository ? `; observed ${observedRepository}` : ''}`,
      'restore tracked scripts/gh access for the explicit card repository; cwd is not target authority',
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
    repository: targetContext.repository,
    config: {
      ...(environment.config as Omit<CreateIssueBrowserOperatorConfig, 'projectId'>),
      projectId: targetContext.projectId,
    },
    childEnv: {
      OPK_PROJECT_ID: targetContext.projectId,
      DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR: environment.config.chromeUserDataDir,
    },
    nextAction: null,
  };
}
