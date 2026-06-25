import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  buildReviewerBudgetSpawnEnv,
  createReviewerBudgetLedger,
  type ReviewerBudgetLedger,
} from './reviewer_budget.js';
import type { ReviewSource } from './types.js';

export interface RunCodexReviewOptions {
  repoRoot: string;
  baseRef: string;
  prompt: string;
  model?: string;
  source?: ReviewSource;
  /** When set, skip Codex and use this as last-message output (tests). */
  fixtureStdout?: string;
  /** When set with fixtureStdout, supplies Codex `--json` process stdout (tests). */
  fixtureProcessJsonl?: string;
  /** When set with fixtureStdout, supplies persisted session JSONL (tests). */
  fixtureSessionJsonl?: string;
  /** When set, simulates a hard-timeout kill with no verdict (tests). */
  fixtureTimedOut?: boolean;
  budgetLedger?: ReviewerBudgetLedger;
}

export interface RunCodexReviewResult {
  exitCode: number;
  /** Codex `--json` process stdout (JSONL events). */
  processJsonl: string;
  /** Final message from `--output-last-message` (fallback/diagnostic channel). */
  lastMessage: string;
  stderr: string;
  /** @deprecated Use {@link lastMessage}. */
  stdout: string;
  timedOut?: boolean;
  budgetLedger: ReviewerBudgetLedger;
}

const CODEX_SPAWN_ENV_STRIP = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'CODEX_AUTH_JSON',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
] as const;

/** Config override enabling outbound network for workspace-write sandbox (Codex CLI). */
export const CODEX_WORKSPACE_WRITE_NETWORK_CONFIG = 'sandbox_workspace_write.network_access=true';

function readOutputFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function isCiOrActionsSignal(env: NodeJS.ProcessEnv): boolean {
  if (env.GITHUB_ACTIONS === 'true') {
    return true;
  }
  const ci = env.CI?.trim().toLowerCase();
  return ci === 'true' || ci === '1' || ci === 'yes';
}

/**
 * Fail-closed trust for local PR review: coworker-capable sandbox only when
 * `--source codex-local` was passed explicitly (not env-derived), with no
 * CI/Actions signal and no PR_REPO_ROOT.
 */
export function isTrustedLocalReviewContext(
  source: ReviewSource | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (source !== 'codex-local') {
    return false;
  }
  if (isCiOrActionsSignal(env)) {
    return false;
  }
  if (env.PR_REPO_ROOT?.trim()) {
    return false;
  }
  return true;
}

function resolveCommandGuardDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'bin', 'command-guard');
}

export function buildCodexSpawnEnv(
  source?: ReviewSource,
  env: NodeJS.ProcessEnv = process.env,
  budgetLedger?: ReviewerBudgetLedger,
): NodeJS.ProcessEnv {
  const childEnv = budgetLedger ? buildReviewerBudgetSpawnEnv(budgetLedger, env) : { ...env };
  // Always strip exfiltratable tokens — trusted local review grants network access
  // and reviews attacker-controlled PR diffs; Codex auth uses ~/.codex on disk.
  for (const key of CODEX_SPAWN_ENV_STRIP) {
    delete childEnv[key];
  }
  if (isTrustedLocalReviewContext(source, childEnv)) {
    const guardDir = resolveCommandGuardDir();
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
    const existingPath = childEnv[pathKey] ?? env[pathKey] ?? '';
    // Windows resolves npm/pwsh/etc. via .cmd/.ps1 shims in the same directory.
    childEnv[pathKey] = existingPath ? `${guardDir}${delimiter}${existingPath}` : guardDir;
  }
  return childEnv;
}

/**
 * Codex CLI 0.13x treats `--base` and a custom [PROMPT] as mutually exclusive.
 * Pack review uses stdin prompt mode (includes base-ref scope in the prompt text).
 */
export function buildCodexExecReviewArgs(options: {
  outputFile: string;
  model?: string;
  source?: ReviewSource;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const env = options.env ?? process.env;
  const trusted = isTrustedLocalReviewContext(options.source, env);

  const args = ['exec'];
  if (trusted) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--sandbox', 'read-only');
  }
  args.push('review');

  if (options.model) {
    args.push('-m', options.model);
  }
  args.push('--json', '--output-last-message', options.outputFile, '-');
  return args;
}

export function runCodexReview(options: RunCodexReviewOptions): RunCodexReviewResult {
  const budgetLedger = options.budgetLedger ?? createReviewerBudgetLedger();

  if (options.fixtureTimedOut) {
    return {
      exitCode: 1,
      processJsonl: options.fixtureProcessJsonl ?? '',
      lastMessage: options.fixtureStdout ?? '',
      stdout: options.fixtureStdout ?? '',
      stderr: 'reviewer timeout before verdict',
      timedOut: true,
      budgetLedger,
    };
  }

  if (options.fixtureStdout !== undefined) {
    const lastMessage = options.fixtureStdout;
    return {
      exitCode: 0,
      processJsonl: options.fixtureProcessJsonl ?? '',
      lastMessage,
      stdout: lastMessage,
      stderr: '',
      budgetLedger,
    };
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'ao-codex-review-'));
  const outputFile = join(tempDir, 'last-message.txt');

  try {
    const args = buildCodexExecReviewArgs({
      outputFile,
      model: options.model,
      source: options.source,
    });

    const spawnOptions = {
      cwd: options.repoRoot,
      input: options.prompt,
      encoding: 'utf8' as const,
      maxBuffer: 8 * 1024 * 1024,
      timeout: budgetLedger.effectiveBudgetMs,
      env: buildCodexSpawnEnv(options.source, process.env, budgetLedger),
    };

    let result: ReturnType<typeof spawnSync>;
    if (process.platform === 'win32') {
      result = spawnSync(
        'cmd.exe',
        ['/c', 'codex', ...args],
        { ...spawnOptions, shell: false },
      );
    } else {
      result = spawnSync('codex', args, spawnOptions);
    }

    const stderr = (result.stderr ?? '').toString();
    const processJsonl = (result.stdout ?? '').toString();
    const fromFile = readOutputFile(outputFile);
    const lastMessage = (fromFile ?? '').trim();
    const timedOut =
      (result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT') ||
      result.signal === 'SIGTERM';

    return {
      exitCode: timedOut ? 1 : (result.status ?? 1),
      processJsonl,
      lastMessage,
      stdout: lastMessage,
      stderr,
      timedOut,
      budgetLedger,
    };
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}
