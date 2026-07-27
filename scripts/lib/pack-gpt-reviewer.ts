import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emitTerminalVerdictPayload,
  parseTerminalVerdictPayload,
  toAoFindings,
} from '../../plugins/ao-codex-pr-reviewer/lib/emit.ts';
import { parseCodexOutput } from '../../plugins/ao-codex-pr-reviewer/lib/parse_output.ts';
import {
  resolveIssueNumber,
  resolveScopeContext,
} from '../../plugins/ao-codex-pr-reviewer/lib/scope_context.ts';
import { runProcess, type ProcessResult } from '../kernel/subprocess.ts';
import { buildGptReviewPrompt, resolvePackRepoRoot } from './pack-pr-review-contract.ts';

export interface GptBrowserTurnConfig {
  profile: string;
  cdpUrl: string;
  chatUrl?: string;
  projectUrl?: string;
  newChat?: boolean;
}

export interface GptReviewRequest {
  repoRoot: string;
  repoSlug: string;
  prNumber: number;
  headSha: string;
  issueNumber?: number;
  baseRef?: string;
}

export interface GptReviewDependencies {
  resolveBrowserConfig: (env: NodeJS.ProcessEnv) => GptBrowserTurnConfig;
  runBrowserTurn: (options: {
    packRoot: string;
    inputPath: string;
    outputPath: string;
    config: GptBrowserTurnConfig;
  }) => Promise<ProcessResult>;
  resolvePrUrl: (repoSlug: string, prNumber: number) => string;
}

function trim(value: unknown): string {
  return String(value ?? '').trim();
}

export function resolveGptBrowserConfig(env: NodeJS.ProcessEnv = process.env): GptBrowserTurnConfig {
  const profile = trim(env.PACK_GPT_BROWSER_PROFILE);
  const cdpUrl = trim(env.PACK_GPT_BROWSER_CDP) || 'http://127.0.0.1:9222';
  const chatUrl = trim(env.PACK_GPT_BROWSER_CHAT_URL);
  const projectUrl = trim(env.PACK_GPT_BROWSER_PROJECT_URL);
  if (!profile) {
    throw new Error('PACK_GPT_BROWSER_PROFILE is required for PACK_REVIEWER=gpt');
  }
  if (chatUrl) {
    return { profile, cdpUrl, chatUrl };
  }
  if (projectUrl) {
    return { profile, cdpUrl, projectUrl, newChat: true };
  }
  throw new Error('PACK_GPT_BROWSER_CHAT_URL or PACK_GPT_BROWSER_PROJECT_URL is required for PACK_REVIEWER=gpt');
}

export function defaultResolvePrUrl(repoSlug: string, prNumber: number): string {
  return `https://github.com/${repoSlug}/pull/${prNumber}`;
}

export async function defaultRunBrowserTurn(options: {
  packRoot: string;
  inputPath: string;
  outputPath: string;
  config: GptBrowserTurnConfig;
}): Promise<ProcessResult> {
  const args = [
    'run',
    'chatgpt-browser-turn',
    '--',
    'turn',
    '--profile', options.config.profile,
    '--cdp', options.config.cdpUrl,
    '--input', options.inputPath,
    '--output', options.outputPath,
  ];
  if (options.config.chatUrl) {
    args.push('--chat-url', options.config.chatUrl);
  } else if (options.config.projectUrl) {
    args.push('--new-chat', '--project-url', options.config.projectUrl);
  }
  return runProcess({
    command: 'npm',
    args,
    cwd: options.packRoot,
    inheritParentEnv: true,
    allowEmptyStdout: true,
    timeoutMs: 45 * 60 * 1_000,
  });
}

const defaultDependencies: GptReviewDependencies = {
  resolveBrowserConfig: resolveGptBrowserConfig,
  runBrowserTurn: defaultRunBrowserTurn,
  resolvePrUrl: defaultResolvePrUrl,
};

export function mapGptReplyToTerminalStdout(replyText: string): string {
  const direct = parseTerminalVerdictPayload(replyText);
  if (direct) {
    if (direct.findingCount !== direct.findings.length) {
      throw new Error('GPT terminal payload findingCount does not match findings length');
    }
    return JSON.stringify(direct);
  }

  const parsed = parseCodexOutput(replyText);
  if (parsed.kind === 'clean') {
    return emitTerminalVerdictPayload({ verdict: 'clean', findings: [] });
  }
  if (parsed.kind === 'findings') {
    const findings = toAoFindings(parsed.findings);
    return emitTerminalVerdictPayload({ verdict: 'findings', findings });
  }
  throw new Error(parsed.message);
}

export async function runGptPackReview(
  request: GptReviewRequest,
  deps: Partial<GptReviewDependencies> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const merged = { ...defaultDependencies, ...deps };
  const fixtureReply = trim(env.PACK_GPT_REVIEWER_FIXTURE_REPLY);
  if (fixtureReply) {
    try {
      return { stdout: mapGptReplyToTerminalStdout(fixtureReply), stderr: '', exitCode: 0 };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { stdout: '', stderr: message, exitCode: 1 };
    }
  }

  const packRoot = resolvePackRepoRoot();
  const issueNumber = request.issueNumber ?? resolveIssueNumber({
    repoRoot: request.repoRoot,
    prNumber: request.prNumber,
    explicitIssue: undefined,
  });
  const scope = resolveScopeContext({
    repoRoot: request.repoRoot,
    issueNumber,
    prNumber: request.prNumber,
  });
  const prUrl = merged.resolvePrUrl(request.repoSlug, request.prNumber);
  const prompt = buildGptReviewPrompt({
    prUrl,
    headSha: request.headSha,
    scope,
    packRoot,
  });

  if (prompt.includes('git diff') && !prompt.includes('Do **not** rely on a pasted diff')) {
    throw new Error('GPT review prompt must not instruct diff paste');
  }
  if (/\b(create|post|submit|publish)\b[^.\n]{0,80}\bgithub\s+review/i.test(prompt)
    && !/do \*\*not\*\* create github reviews/i.test(prompt)) {
    throw new Error('GPT review prompt must not request GitHub mutation');
  }

  const browserConfig = merged.resolveBrowserConfig(env);
  const workDir = mkdtempSync(join(tmpdir(), 'opk-gpt-review-'));
  const inputPath = join(workDir, 'prompt.txt');
  const outputPath = join(workDir, 'reply.txt');
  writeFileSync(inputPath, prompt, 'utf8');

  try {
    const turn = await merged.runBrowserTurn({
      packRoot,
      inputPath,
      outputPath,
      config: browserConfig,
    });
    if (turn.timedOut) {
      return { stdout: '', stderr: 'GPT browser turn timed out', exitCode: 124 };
    }
    if (!turn.ok) {
      const detail = trim(turn.stderr || turn.stdout || turn.error) || 'GPT browser turn failed';
      return { stdout: '', stderr: detail, exitCode: turn.exitCode ?? 1 };
    }
    const reply = readFileSync(outputPath, 'utf8');
    try {
      return { stdout: mapGptReplyToTerminalStdout(reply), stderr: '', exitCode: 0 };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { stdout: '', stderr: message, exitCode: 1 };
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export async function resolveRepositorySlug(repoRoot: string): Promise<string> {
  const result = await runProcess({
    command: 'gh',
    args: ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 30_000,
  });
  if (!result.ok) {
    throw new Error(`gh repo view failed: ${trim(result.stderr || result.error)}`);
  }
  const slug = trim(result.stdout);
  if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) {
    throw new Error(`gh repo view returned invalid repository slug '${slug}'`);
  }
  return slug;
}

export async function resolveHeadSha(repoRoot: string, prNumber: number, repoSlug: string): Promise<string> {
  const result = await runProcess({
    command: 'gh',
    args: ['pr', 'view', String(prNumber), '--repo', repoSlug, '--json', 'headRefOid', '--jq', '.headRefOid'],
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 30_000,
  });
  if (!result.ok) {
    throw new Error(`gh pr view failed: ${trim(result.stderr || result.error)}`);
  }
  const headSha = trim(result.stdout).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error(`PR #${prNumber} returned invalid head SHA`);
  }
  return headSha;
}
