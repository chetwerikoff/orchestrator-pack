import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { executeReview, type ReviewOptions } from '../plugins/ao-codex-pr-reviewer/lib/review_core.js';
import {
  parseTerminalVerdictPayload,
  type TerminalVerdictPayload,
} from '../plugins/ao-codex-pr-reviewer/lib/emit.js';
import {
  HARNESS_NESTED_BUDGET_ENV,
  containsProseSubmitMarkers,
} from '../docs/harness-review-bridge.mjs';

export const HARNESS_BRIDGE_KILL_SWITCH = 'PACK_HARNESS_BRIDGE_DISABLED';

export interface HarnessBridgeOptions {
  runId: string;
  sessionId?: string;
  repoRoot: string;
  baseRef: string;
  issueNumber?: number;
  prNumber?: number;
  prBodyFile?: string;
  model?: string;
  source?: 'codex-local' | 'codex-github-action';
  fixtureStdout?: string;
  fixtureProcessJsonl?: string;
  fixtureSessionJsonl?: string;
  fixtureTimedOut?: boolean;
  trustedPackRoot?: string;
}

export interface HarnessBridgeResult {
  ok: boolean;
  reason: string;
  exitCode: number;
  submitSkipped?: boolean;
  submitStatus?: number | null;
  reviewExitCode?: number;
  payload?: TerminalVerdictPayload;
  trustedPaths?: ReturnType<typeof resolveHarnessTrustedPaths>;
}

function repoRelative(root: string, path: string): string {
  const rel = relative(root, path).replaceAll(sep, '/');
  if (!rel || rel.startsWith('..') || rel.includes('/../')) {
    throw new Error(`trusted path escapes pack root: ${path}`);
  }
  return rel;
}

export function resolveHarnessTrustedPaths(packRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))) {
  const root = resolve(packRoot);
  const prompt = resolve(root, 'prompts/codex_review_prompt.md');
  const bridge = resolve(root, 'scripts/harness-review-bridge.ts');
  const mapper = resolve(root, 'plugins/ao-codex-pr-reviewer/lib/review_jsonl.ts');
  const expected = {
    prompt: 'prompts/codex_review_prompt.md',
    bridge: 'scripts/harness-review-bridge.ts',
    mapper: 'plugins/ao-codex-pr-reviewer/lib/review_jsonl.ts',
  };
  const actual = {
    prompt: repoRelative(root, prompt),
    bridge: repoRelative(root, bridge),
    mapper: repoRelative(root, mapper),
  };
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (actual[key] !== expected[key]) {
      throw new Error(`trusted ${key} path mismatch: ${actual[key]}`);
    }
  }
  return { packRoot: root, prompt, bridge, mapper };
}

function isEnabledEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function assertMapperFindingTitle(title: string): void {
  if (/^\[P[0-3]\]\s+\S/i.test(title)) {
    return;
  }
  if (/^\[scope-violation\]/i.test(title)) {
    return;
  }
  throw new Error(`mapper-normalized finding title missing [P0]-[P3] prefix: ${title}`);
}

export function buildHarnessSubmitPayload(aoStdout: string): TerminalVerdictPayload {
  const trimmed = String(aoStdout ?? '').trim();
  if (!trimmed) {
    throw new Error('mapper output was empty');
  }
  if (containsProseSubmitMarkers(trimmed)) {
    throw new Error('mapper output contains prose submit markers');
  }
  const parsed = parseTerminalVerdictPayload(trimmed);
  if (!parsed) {
    throw new Error('reviewer stdout was not terminal verdict JSON');
  }
  if (parsed.verdict === 'clean') {
    if (parsed.findingCount !== 0) {
      throw new Error('clean verdict requires findingCount 0');
    }
    return parsed;
  }
  for (const finding of parsed.findings) {
    assertMapperFindingTitle(finding.title);
    if (!/\bseverity:\s*(blocking|non-blocking)\b/i.test(finding.body)) {
      throw new Error(`finding body missing architecture F severity: ${finding.title}`);
    }
  }
  return parsed;
}

function submitReview(
  runId: string,
  sessionId: string,
  payload: TerminalVerdictPayload,
): { status: number | null } {
  const captureFile = process.env.AO_HARNESS_REVIEW_SUBMIT_CAPTURE_FILE;
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  if (captureFile) {
    writeFileSync(captureFile, JSON.stringify({ runId, sessionId, payload }, null, 2), 'utf8');
    return { status: 0 };
  }

  const verdict = payload.verdict === 'clean' && payload.findingCount === 0 ? 'approved' : 'changes_requested';
  const command = process.env.AO_HARNESS_REVIEW_SUBMIT_BIN || 'ao';
  const result = spawnSync(
    command,
    ['review', 'submit', sessionId, '--run', runId, '--session', sessionId, '--verdict', verdict, '--body', '-'],
    {
      input: body,
      encoding: 'utf8',
      stdio: ['pipe', 'inherit', 'inherit'],
    },
  );
  return { status: result.status ?? 1 };
}

export function runHarnessReviewBridge(options: HarnessBridgeOptions): HarnessBridgeResult {
  const trustedPaths = resolveHarnessTrustedPaths(options.trustedPackRoot);
  if (isEnabledEnv(process.env[HARNESS_BRIDGE_KILL_SWITCH])) {
    return { ok: false, reason: 'harness_bridge_kill_switch', exitCode: 42, submitSkipped: true, trustedPaths };
  }
  if (process.env[HARNESS_NESTED_BUDGET_ENV] === '1') {
    return {
      ok: false,
      reason: 'nested_review_budget_exceeded',
      exitCode: 42,
      submitSkipped: true,
      trustedPaths,
    };
  }

  process.env.AO_CODEX_REVIEW_PROMPT_FILE = trustedPaths.prompt;
  process.env[HARNESS_NESTED_BUDGET_ENV] = '1';

  const reviewOptions: ReviewOptions = {
    repoRoot: options.repoRoot,
    baseRef: options.baseRef,
    issueNumber: options.issueNumber,
    prNumber: options.prNumber,
    prBodyFile: options.prBodyFile,
    model: options.model,
    source: options.source,
    fixtureStdout: options.fixtureStdout,
    fixtureProcessJsonl: options.fixtureProcessJsonl,
    fixtureSessionJsonl: options.fixtureSessionJsonl,
    fixtureTimedOut: options.fixtureTimedOut,
  };

  let review;
  try {
    review = executeReview(reviewOptions);
  } finally {
    delete process.env[HARNESS_NESTED_BUDGET_ENV];
  }

  if (review.exitCode !== 0) {
    const reason = review.logLines.some((line) => /timeout/i.test(line))
      ? 'timeout_no_verdict'
      : review.logLines.at(-1) || 'mapper_pipeline_failed';
    return {
      ok: false,
      reason,
      exitCode: review.exitCode || 1,
      reviewExitCode: review.exitCode,
      submitSkipped: true,
      trustedPaths,
    };
  }

  let payload: TerminalVerdictPayload;
  try {
    payload = buildHarnessSubmitPayload(review.aoStdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: message,
      exitCode: 1,
      submitSkipped: true,
      trustedPaths,
    };
  }

  const sessionId = options.sessionId?.trim() || options.runId;
  const submit = submitReview(options.runId, sessionId, payload);
  if (submit.status !== 0) {
    return {
      ok: false,
      reason: 'submit_failed',
      exitCode: submit.status || 1,
      submitStatus: submit.status,
      payload,
      trustedPaths,
    };
  }
  return {
    ok: true,
    reason: payload.verdict === 'clean' ? 'NO_FINDINGS' : 'submitted_findings',
    exitCode: 0,
    submitStatus: 0,
    payload,
    trustedPaths,
  };
}

function parsePositiveInt(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseHarnessBridgeArgs(argv: string[]): HarnessBridgeOptions {
  const options: HarnessBridgeOptions = {
    runId: '',
    repoRoot: process.cwd(),
    baseRef: 'origin/main',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--run-id':
        options.runId = argv[++index] ?? '';
        break;
      case '--session-id':
        options.sessionId = argv[++index] ?? '';
        break;
      case '--repo-root':
        options.repoRoot = resolve(argv[++index] ?? options.repoRoot);
        break;
      case '--trusted-pack-root':
        options.trustedPackRoot = resolve(argv[++index] ?? options.trustedPackRoot ?? '');
        break;
      case '--base':
        options.baseRef = argv[++index] ?? options.baseRef;
        break;
      case '--issue':
        options.issueNumber = parsePositiveInt(argv[++index]);
        break;
      case '--pr-number':
        options.prNumber = parsePositiveInt(argv[++index]);
        break;
      case '--pr-body-file':
        options.prBodyFile = argv[++index];
        break;
      case '--model':
        options.model = argv[++index];
        break;
      case '--source': {
        const source = argv[++index];
        if (source === 'codex-local' || source === 'codex-github-action') options.source = source;
        else throw new Error(`unsupported --source ${source}`);
        break;
      }
      case '--fixture-stdout':
        options.fixtureStdout = argv[++index] ?? '';
        break;
      case '--fixture-process-jsonl':
        options.fixtureProcessJsonl = readFileSync(argv[++index] ?? '', 'utf8');
        break;
      case '--fixture-session-jsonl':
        options.fixtureSessionJsonl = readFileSync(argv[++index] ?? '', 'utf8');
        break;
      case '--fixture-timed-out':
        options.fixtureTimedOut = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.runId.trim()) {
    throw new Error('--run-id is required');
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runHarnessReviewBridge(parseHarnessBridgeArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.exitCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(2);
  }
}
