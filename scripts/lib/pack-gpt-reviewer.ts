import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  emitTerminalVerdictPayload,
  toRuntimeFindings,
} from '../../plugins/codex-pr-reviewer/lib/emit.ts';
import {
  resolveIssueNumber,
  resolveScopeContext,
  type ResolvedScopeContext,
} from '../../plugins/codex-pr-reviewer/lib/scope_context.ts';
import { parseCodexOutput } from '../../plugins/codex-pr-reviewer/lib/parse_output.ts';
import { runProcess, type ProcessResult } from '../kernel/subprocess.ts';
import { buildGptReviewPrompt, resolvePackRepoRoot } from './pack-pr-review-contract.ts';
import { packReviewLogsDir, resolvePackReviewRunStoreRoot } from './pack-review-run-store.ts';
import { resolveNameWithOwner } from './gh-repo-resolve.mjs';
import { resolveTrackedGhWrapper } from './gh-resolve-real-binary.mjs';
import {
  normalizePackGptSourceIdentity,
  type PackGptSourceIdentity,
} from './pack-gpt-source-comment-contract.ts';

const GPT_BROWSER_SOURCE = 'gpt-browser';
const VALID_GPT_SEVERITIES = new Set(['blocking', 'non-blocking']);
const FORBIDDEN_VERDICT_ERROR = 'GPT must not return pre-mapped terminal verdict JSON';

export type GptReviewHarvestClass = 'harvest_failed' | 'no_reply' | 'forbidden_verdict_envelope';

export interface GptReviewEvidencePaths {
  adapterPromptPath: string;
  terminalReplyPath: string;
  mappingErrorPath?: string;
  adapterStdoutPath: string;
}

export function assertGptHarnessFixtureAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (env.OPK_VITEST_HARNESS === '1') {
    return;
  }
  throw new Error('PACK_GPT_* fixture env vars are only allowed when OPK_VITEST_HARNESS=1');
}

function assertGptFixtureBinding(
  env: NodeJS.ProcessEnv,
  request: Pick<GptReviewRequest, 'repoSlug' | 'prNumber' | 'headSha'>,
): void {
  const fixturePr = Number(env.PACK_GPT_FIXTURE_PR_NUMBER ?? 0);
  const fixtureHead = trim(env.PACK_GPT_FIXTURE_HEAD_SHA).toLowerCase();
  const fixtureSlug = trim(env.PACK_GPT_FIXTURE_REPO_SLUG);
  if (fixturePr > 0 && fixturePr !== request.prNumber) {
    throw new Error(`PACK_GPT fixture PR binding mismatch: fixture #${fixturePr}, request #${request.prNumber}`);
  }
  if (fixtureHead && fixtureHead !== request.headSha.toLowerCase()) {
    throw new Error('PACK_GPT fixture head binding mismatch');
  }
  if (fixtureSlug && fixtureSlug !== request.repoSlug) {
    throw new Error('PACK_GPT fixture repo binding mismatch');
  }
}

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
  frozenScope?: ResolvedScopeContext;
}

export interface GptTurnResultV1 {
  schema: 'turn-result/v1';
  state: string;
  scope: string;
  cause: string;
  invocation_id: string;
  send_count: number;
  [key: string]: unknown;
}

export interface GptMappedReviewPayload {
  verdict: 'clean' | 'findings';
  findingCount: number;
  findings: ReturnType<typeof toRuntimeFindings>;
}

export function extractLastGptTurnResult(stdout: string): GptTurnResultV1 | null {
  const rows = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const row of rows.reverse()) {
    try {
      const parsed = JSON.parse(row) as Partial<GptTurnResultV1>;
      if (parsed.schema !== 'turn-result/v1'
        || typeof parsed.state !== 'string'
        || typeof parsed.scope !== 'string'
        || typeof parsed.cause !== 'string'
        || typeof parsed.invocation_id !== 'string'
        || !Number.isInteger(parsed.send_count)) continue;
      const {
        review_evidence: _reviewEvidence,
        review_harvest_class: _reviewHarvestClass,
        ...terminal
      } = parsed as GptTurnResultV1;
      return terminal as GptTurnResultV1;
    } catch {
      // Heartbeats and diagnostic text are not terminal turn results.
    }
  }
  return null;
}

export interface GptReviewDependencies {
  resolveBrowserConfig: (env: NodeJS.ProcessEnv) => GptBrowserTurnConfig;
  runBrowserTurn: (options: {
    packRoot: string;
    inputPath: string;
    outputPath: string;
    config: GptBrowserTurnConfig;
    invocationId?: string;
  }) => Promise<ProcessResult>;
  resolvePrUrl: (repoSlug: string, prNumber: number) => string;
}

function trim(value: unknown): string {
  return String(value ?? '').trim();
}

function resolveBoundSourceIdentity(
  request: GptReviewRequest,
  env: NodeJS.ProcessEnv,
): PackGptSourceIdentity | undefined {
  const runId = trim(env.PACK_REVIEW_RUN_ID);
  const slotId = trim(env.PACK_REVIEW_GPT_SOURCE_SLOT);
  const invocationId = trim(env.PACK_REVIEW_GPT_INVOCATION_ID);
  const present = [runId, slotId, invocationId].filter(Boolean).length;
  if (present === 0) return undefined;
  if (present !== 3) {
    throw new Error('runner-bound GPT source publication requires run, slot, and invocation identity');
  }
  return normalizePackGptSourceIdentity({
    repository: request.repoSlug,
    prNumber: request.prNumber,
    headSha: request.headSha,
    runId,
    slotId,
    invocationId,
  });
}

function safeEvidenceSegment(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function resolveGptEvidenceDir(request: GptReviewRequest, env: NodeJS.ProcessEnv): string {
  const explicit = trim(env.PACK_GPT_BROWSER_EVIDENCE_DIR);
  const runId = trim(env.PACK_REVIEW_RUN_ID);
  const sourceSlot = trim(env.PACK_REVIEW_GPT_SOURCE_SLOT);
  if (explicit && !runId && !sourceSlot) return resolve(explicit);

  const root = explicit
    ? resolve(explicit)
    : join(packReviewLogsDir(resolvePackReviewRunStoreRoot({
        projectId: trim(env.PACK_REVIEW_PROJECT_ID) || undefined,
      })), 'gpt-evidence');
  const runSegment = safeEvidenceSegment(
    runId,
    `standalone-pr-${request.prNumber}-${request.headSha.toLowerCase()}`,
  );
  const slotSegment = safeEvidenceSegment(sourceSlot, 'source-01');
  return join(root, runSegment, slotSegment);
}

function persistGptEvidence(options: {
  request: GptReviewRequest;
  env: NodeJS.ProcessEnv;
  inputPath: string;
  outputPath: string;
}): { paths: GptReviewEvidencePaths; replyBytes: Buffer | null } {
  const evidenceDir = resolveGptEvidenceDir(options.request, options.env);
  mkdirSync(evidenceDir, { recursive: true });
  const adapterPromptPath = join(evidenceDir, 'adapter-prompt.txt');
  const terminalReplyPath = join(evidenceDir, 'terminal-reply.txt');
  const adapterStdoutPath = join(evidenceDir, 'adapter-stdout.json');
  writeFileSync(adapterPromptPath, readFileSync(options.inputPath));

  const replyBytes = existsSync(options.outputPath) ? readFileSync(options.outputPath) : null;
  writeFileSync(terminalReplyPath, replyBytes ?? Buffer.alloc(0));
  return {
    paths: {
      adapterPromptPath,
      terminalReplyPath,
      adapterStdoutPath,
    },
    replyBytes,
  };
}

function persistMappingError(paths: GptReviewEvidencePaths, message: string): GptReviewEvidencePaths {
  const mappingErrorPath = join(dirname(paths.adapterPromptPath), 'mapping-error.txt');
  writeFileSync(mappingErrorPath, message, 'utf8');
  return { ...paths, mappingErrorPath };
}

function terminalWithEvidence(
  terminal: GptTurnResultV1,
  paths: GptReviewEvidencePaths,
  harvestClass?: GptReviewHarvestClass,
): GptTurnResultV1 {
  return {
    ...terminal,
    review_evidence: paths,
    ...(harvestClass ? { review_harvest_class: harvestClass } : {}),
  };
}

function classifyHarvestFailure(replyText: string, message: string): GptReviewHarvestClass {
  if (!replyText.trim()) return 'no_reply';
  if (message === FORBIDDEN_VERDICT_ERROR) return 'forbidden_verdict_envelope';
  return 'harvest_failed';
}

function normalizeMissingGptSources(replyText: string): string {
  const trimmed = replyText.trim();
  if (!trimmed.startsWith('{')) return replyText;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return replyText;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return replyText;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.findings)) return replyText;
  let changed = false;
  const findings = record.findings.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const finding = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(finding, 'source')) return value;
    changed = true;
    return { ...finding, source: GPT_BROWSER_SOURCE };
  });
  return changed ? JSON.stringify({ ...record, findings }) : replyText;
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
  invocationId?: string;
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
  if (options.invocationId) args.push('--invocation-id', options.invocationId);
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

function validateGptStructuredFindings(findings: ReturnType<typeof parseCodexOutput> & { kind: 'findings' }): void {
  for (const [index, finding] of findings.findings.entries()) {
    if (finding.source !== GPT_BROWSER_SOURCE) {
      throw new Error(`GPT finding ${index + 1} source must be ${GPT_BROWSER_SOURCE}`);
    }
    if (!VALID_GPT_SEVERITIES.has(String(finding.severity))) {
      throw new Error(`GPT finding ${index + 1} severity must be blocking or non-blocking`);
    }
  }
}

export function mapGptReplyToReviewPayload(replyText: string): GptMappedReviewPayload {
  const trimmed = replyText.trim();
  if (/^\{[\s\S]*"verdict"\s*:/.test(trimmed)) {
    throw new Error(FORBIDDEN_VERDICT_ERROR);
  }

  const parsed = parseCodexOutput(normalizeMissingGptSources(replyText));
  if (parsed.kind === 'clean') {
    return { verdict: 'clean', findingCount: 0, findings: [] };
  }
  if (parsed.kind === 'findings') {
    validateGptStructuredFindings(parsed);
    const findings = toRuntimeFindings(parsed.findings);
    return { verdict: 'findings', findingCount: findings.length, findings };
  }
  throw new Error(parsed.message);
}

export function mapGptReplyToTerminalStdout(replyText: string): string {
  const payload = mapGptReplyToReviewPayload(replyText);
  return emitTerminalVerdictPayload({ verdict: payload.verdict, findings: payload.findings });
}

export async function runGptPackReview(
  request: GptReviewRequest,
  deps: Partial<GptReviewDependencies> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const merged = { ...defaultDependencies, ...deps };
  const fixtureReply = trim(env.PACK_GPT_REVIEWER_FIXTURE_REPLY);
  if (fixtureReply) {
    assertGptHarnessFixtureAllowed(env);
    try {
      assertGptFixtureBinding(env, request);
      return { stdout: mapGptReplyToTerminalStdout(fixtureReply), stderr: '', exitCode: 0 };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { stdout: '', stderr: message, exitCode: 1 };
    }
  }

  const packRoot = resolvePackRepoRoot();
  const issueNumber = request.frozenScope?.issueNumber ?? request.issueNumber ?? resolveIssueNumber({
    repoRoot: request.repoRoot,
    prNumber: request.prNumber,
    explicitIssue: undefined,
  });
  if (request.frozenScope
    && request.issueNumber !== undefined
    && request.frozenScope.issueNumber !== request.issueNumber) {
    return {
      stdout: '',
      stderr: `frozen scope Issue binding mismatch: scope #${String(request.frozenScope.issueNumber)}, request #${request.issueNumber}`,
      exitCode: 1,
    };
  }
  const scope = request.frozenScope ?? resolveScopeContext({
    repoRoot: request.repoRoot,
    issueNumber,
  });
  const sourceIdentity = resolveBoundSourceIdentity(request, env);
  const prUrl = merged.resolvePrUrl(request.repoSlug, request.prNumber);
  const prompt = buildGptReviewPrompt({
    prUrl,
    headSha: request.headSha,
    scope,
    sourceIdentity,
    packRoot,
  });

  if (prompt.includes('git diff') && !prompt.includes('Do **not** rely on a pasted diff')) {
    throw new Error('GPT review prompt must not instruct diff paste');
  }
  if (/\b(create|post|submit|publish)\b[^.\n]{0,80}\bgithub\s+review/i.test(prompt)
    && !/do \*\*not\*\* create github reviews/i.test(prompt)) {
    throw new Error('GPT review prompt must not request GitHub Review submission');
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
      invocationId: sourceIdentity?.invocationId,
    });
    const terminal = extractLastGptTurnResult(turn.stdout);

    if (turn.timedOut) {
      let timedOutTerminal = terminal;
      if (terminal && terminal.send_count >= 1) {
        const evidence = persistGptEvidence({ request, env, inputPath, outputPath });
        timedOutTerminal = terminalWithEvidence(terminal, evidence.paths);
      }
      return {
        stdout: timedOutTerminal ? `${JSON.stringify(timedOutTerminal)}\n` : '',
        stderr: 'GPT browser turn timed out',
        exitCode: 124,
      };
    }
    if (!turn.ok) {
      let failedTerminal = terminal;
      let detail = trim(turn.stderr || turn.error)
        || (terminal ? `${terminal.state}:${terminal.cause}` : trim(turn.stdout))
        || 'GPT browser turn failed';
      if (terminal && terminal.send_count >= 1) {
        const evidence = persistGptEvidence({ request, env, inputPath, outputPath });
        if (terminal.state === 'no_reply') {
          detail = 'GPT browser turn completed without a reviewer reply';
          const paths = persistMappingError(evidence.paths, detail);
          failedTerminal = terminalWithEvidence(terminal, paths, 'no_reply');
          writeFileSync(paths.adapterStdoutPath, `${JSON.stringify(failedTerminal)}\n`, 'utf8');
        } else {
          failedTerminal = terminalWithEvidence(terminal, evidence.paths);
          writeFileSync(evidence.paths.adapterStdoutPath, `${JSON.stringify(failedTerminal)}\n`, 'utf8');
        }
      }
      return {
        stdout: failedTerminal ? `${JSON.stringify(failedTerminal)}\n` : '',
        stderr: detail,
        exitCode: turn.exitCode ?? 1,
      };
    }
    if (!terminal) {
      return {
        stdout: '',
        stderr: 'GPT browser turn completed without terminal turn-result/v1 evidence',
        exitCode: 1,
      };
    }
    if (terminal.send_count < 1) {
      return {
        stdout: `${JSON.stringify(terminal)}\n`,
        stderr: `GPT browser turn completed without a successful send (send_count=${terminal.send_count})`,
        exitCode: 1,
      };
    }

    const evidence = persistGptEvidence({ request, env, inputPath, outputPath });
    const reply = evidence.replyBytes?.toString('utf8') ?? '';
    try {
      const mapped = mapGptReplyToTerminalStdout(reply);
      const terminalEvidence = terminalWithEvidence(terminal, evidence.paths);
      const stdout = `${JSON.stringify(terminalEvidence)}\n${mapped}`;
      writeFileSync(evidence.paths.adapterStdoutPath, `${stdout}\n`, 'utf8');
      return { stdout, stderr: '', exitCode: 0 };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const harvestClass = classifyHarvestFailure(reply, message);
      const paths = persistMappingError(evidence.paths, message);
      const terminalEvidence = terminalWithEvidence(terminal, paths, harvestClass);
      const stdout = `${JSON.stringify(terminalEvidence)}\n`;
      writeFileSync(paths.adapterStdoutPath, stdout, 'utf8');
      return { stdout, stderr: message, exitCode: 1 };
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export async function resolveRepositorySlug(repoRoot: string): Promise<string> {
  const slug = trim(resolveNameWithOwner({
    cwd: repoRoot,
    realGh: resolveTrackedGhWrapper(),
    hostname: trim(process.env.GH_HOST) || 'github.com',
  }));
  if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) {
    throw new Error(`local repository context returned invalid repository slug '${slug}'`);
  }
  return slug;
}

export async function resolveHeadSha(repoRoot: string, prNumber: number, repoSlug: string): Promise<string> {
  const result = await runProcess({
    command: resolveTrackedGhWrapper(),
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
