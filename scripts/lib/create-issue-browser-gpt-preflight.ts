import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';
import { evaluateCommandRuntimePreflight } from './command-runtime-bootstrap.mjs';
import type { CreateIssueActionBinding, CreateIssueNextAction } from './create-issue-next-action.ts';
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
    | 'node_major_mismatch'
    | 'tracked_github_unavailable'
    | 'target_repository_unavailable'
    | 'authenticated_principal_unresolved'
    | 'operator_browser_config_required'
    | 'operator_browser_config_invalid';
  blocker: string;
  remedy: string;
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
    nextAction,
  };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateProjectUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? null : 'projectUrl must use http or https';
  } catch {
    return 'projectUrl must be an absolute URL';
  }
}

function validateChromeUserDataDir(value: string): string | null {
  if (!isAbsolute(value)) return 'chromeUserDataDir must be an absolute path';
  if (!existsSync(value)) return 'chromeUserDataDir does not exist';
  try {
    if (!statSync(value).isDirectory()) return 'chromeUserDataDir is not a directory';
  } catch {
    return 'chromeUserDataDir is not readable';
  }
  return null;
}

export function resolveCreateIssueBrowserOperatorConfig(input: {
  env: NodeJS.ProcessEnv;
  operatorBrowserConfig?: string;
}): { ok: true; config: CreateIssueBrowserOperatorConfig } | { ok: false; cause: CreateIssueBrowserPreflightFailure['cause']; blocker: string; remedy: string } {
  const envProjectUrl = input.env.DISCUSS_WITH_GPT_PROJECT_URL?.trim();
  const envChromeUserDataDir = input.env.DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR?.trim();
  let projectUrl: string;
  let chromeUserDataDir: string;
  let source: CreateIssueBrowserOperatorConfig['source'];
  let operatorConfigPath: string | undefined;

  if (envProjectUrl && envChromeUserDataDir) {
    projectUrl = envProjectUrl;
    chromeUserDataDir = envChromeUserDataDir;
    source = 'environment';
  } else {
    const locator = input.operatorBrowserConfig?.trim();
    if (!locator) {
      return {
        ok: false,
        cause: 'operator_browser_config_required',
        blocker: 'Browser-GPT operator configuration is unresolved: both DISCUSS_WITH_GPT_PROJECT_URL and DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR are required together, otherwise --operator-browser-config <absolute-path> is required',
        remedy: 'set both required environment variables or pass --operator-browser-config with the operator-owned local.config.json path; do not copy that file into the worker worktree',
      };
    }
    if (!isAbsolute(locator)) {
      return {
        ok: false,
        cause: 'operator_browser_config_invalid',
        blocker: '--operator-browser-config must be an absolute path',
        remedy: 'pass the absolute path to the operator-owned local.config.json; do not copy or discover it from another checkout',
      };
    }
    let raw: unknown;
    try {
      if (!statSync(locator).isFile()) throw new Error('not a regular file');
      raw = JSON.parse(readFileSync(locator, 'utf8')) as unknown;
    } catch (error) {
      return {
        ok: false,
        cause: 'operator_browser_config_invalid',
        blocker: `unable to read operator Browser-GPT config at ${locator}: ${error instanceof Error ? error.message : String(error)}`,
        remedy: 'fix the operator-owned local.config.json at the exact supplied path; do not copy it into the worktree',
      };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        ok: false,
        cause: 'operator_browser_config_invalid',
        blocker: `operator Browser-GPT config at ${locator} must be a JSON object`,
        remedy: 'provide projectUrl and chromeUserDataDir in the operator-owned config file',
      };
    }
    const record = raw as Record<string, unknown>;
    if (!nonEmpty(record.projectUrl) || !nonEmpty(record.chromeUserDataDir)) {
      return {
        ok: false,
        cause: 'operator_browser_config_invalid',
        blocker: `operator Browser-GPT config at ${locator} requires non-empty projectUrl and chromeUserDataDir`,
        remedy: 'populate both required fields in the operator-owned config file',
      };
    }
    projectUrl = record.projectUrl.trim();
    chromeUserDataDir = record.chromeUserDataDir.trim();
    source = 'operator-config';
    operatorConfigPath = locator;
  }

  const projectUrlError = validateProjectUrl(projectUrl);
  if (projectUrlError) {
    return {
      ok: false,
      cause: 'operator_browser_config_invalid',
      blocker: projectUrlError,
      remedy: 'provide a valid absolute Browser-GPT projectUrl in the selected configuration source',
    };
  }
  const profileError = validateChromeUserDataDir(chromeUserDataDir);
  if (profileError) {
    return {
      ok: false,
      cause: 'operator_browser_config_invalid',
      blocker: profileError,
      remedy: 'provide an existing absolute Chrome user-data directory in the selected configuration source',
    };
  }
  return {
    ok: true,
    config: {
      projectUrl,
      chromeUserDataDir,
      source,
      ...(operatorConfigPath ? { operatorConfigPath } : {}),
    },
  };
}

export function runCreateIssueBrowserPreflight(input: CreateIssueBrowserPreflightInput): CreateIssueBrowserPreflightResult {
  const env = input.env ?? process.env;
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 22) {
    return failure(
      'node_major_mismatch',
      `create-Issue Browser-GPT requires Node 22; current runtime is ${process.versions.node}`,
      'run the create-Issue manager carrier under the repository-authoritative Node 22 runtime',
      input,
    );
  }

  const runtime = evaluateCommandRuntimePreflight({ inheritedPath: env.PATH ?? '' });
  if (!runtime.ok || !runtime.tools?.packGh) {
    return failure(
      'tracked_github_unavailable',
      runtime.diagnostic ?? 'tracked scripts/gh transport is unavailable',
      'restore the tracked scripts/gh command-runtime prerequisite before any Browser-GPT send',
      input,
      true,
    );
  }

  const target = runProcessSync({
    command: runtime.tools.packGh,
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
    command: runtime.tools.packGh,
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

  const config = resolveCreateIssueBrowserOperatorConfig({
    env,
    operatorBrowserConfig: input.operatorBrowserConfig,
  });
  if (!config.ok) {
    return failure(config.cause, config.blocker, config.remedy, input);
  }

  return {
    ok: true,
    schema: CREATE_ISSUE_BROWSER_PREFLIGHT_SCHEMA,
    principalLogin,
    repository: observedRepository,
    config: config.config,
    childEnv: {
      DISCUSS_WITH_GPT_PROJECT_URL: config.config.projectUrl,
      DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR: config.config.chromeUserDataDir,
    },
    nextAction: null,
  };
}
