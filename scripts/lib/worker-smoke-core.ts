import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseKeyValueBlock } from '../markdown-key-value.mjs';
import {
  checkSmokeTestPlan,
  parseSmokeTestPlan,
  resolveSmokeRequirement,
} from '../draft-discipline.mjs';

export { checkSmokeTestPlan, parseSmokeTestPlan, resolveSmokeRequirement };

export type SmokeResult = 'PASS' | 'FAIL' | 'BLOCKED';

export interface SmokeScenario {
  action: string;
  expected: string;
  observed?: string;
  outcome?: 'pass' | 'fail' | 'skipped' | 'blocked';
  skipReason?: string;
}

export type SmokeRequirement = 'required' | 'not-applicable' | 'legacy-exempt' | 'unknown';

export interface SmokeTestPlan {
  requirement: SmokeRequirement;
  reason?: string;
  scenarios: SmokeScenario[];
}

export interface SmokeReport {
  result: SmokeResult;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  scenarios: SmokeScenario[];
  limitations: string[];
  trackedFilesUnmodified: boolean;
  terminalCleanup: string;
  environmentNotes: string[];
  producer?: string;
  orcaExecutable?: string;
  terminalHandle?: string;
  nonPassCause?: SmokeNonPassCause;
}

export const SMOKE_REPORT_MARKER = 'pack-worker-smoke-report/v1';
export const SMOKE_REPORT_PRODUCER = 'orchestrator-pack/worker-smoke-run/v1';

const FENCE_PATTERN = /```([a-z0-9-]+)\s*\r?\n([\s\S]*?)```/gi;
const SMOKE_REPORT_BLOCK = /```worker-smoke-report\s*\r?\n([\s\S]*?)```/i;
const SMOKE_REPORT_HEADING = /^## Worker smoke report\b/im;

const FORBIDDEN_SMOKE_AGENT_ACTIONS = [
  /\bcommit\b/i,
  /\bpush\b/i,
  /\bmerge\b/i,
  /\bpack-worker-report\b/i,
  /\bready_for_review\b/i,
  /\bREVIEW_COMMAND\b/i,
  /\bPACK_REVIEWER\b/i,
  /\bedit(?:ing)?\s+(?:the\s+)?(?:issue|task spec)\b/i,
] as const;

export interface SmokeRunBinding {
  runId: string;
  artifactDir: string;
}

export const SMOKE_RUN_ARTIFACT_ROOT = '.orca-worker-smoke/runs';

export function createSmokeRunIdentity(): string {
  return randomUUID();
}

export function resolveSmokeRunArtifactDir(repoRoot: string, runId: string): string {
  return join(repoRoot, SMOKE_RUN_ARTIFACT_ROOT, runId);
}

export function smokeDeliverySealedPath(artifactDir: string): string {
  return join(artifactDir, 'delivery.sealed.json');
}

export function smokeCompletionBodyPath(artifactDir: string): string {
  return join(artifactDir, 'completion.body');
}

export function smokeCompletionSealPath(artifactDir: string, generation = 1): string {
  return generation <= 1
    ? join(artifactDir, 'completion.sealed.json')
    : join(artifactDir, `completion.sealed-${generation}.json`);
}

export function ensureSmokeRunArtifactDir(artifactDir: string): void {
  mkdirSync(artifactDir, { recursive: true });
}

export function buildSmokeAgentPrompt(input: {
  issueNumber: number;
  issueBody: string;
  prNumber: number;
  headSha: string;
  plan: SmokeTestPlan;
  runBinding?: SmokeRunBinding;
}): string {
  const scenarioLines = input.plan.scenarios
    .map((scenario, index) => `${index + 1}. action: ${scenario.action}\n   expected: ${scenario.expected}`)
    .join('\n');

  const durableLines = input.runBinding
    ? [
      '',
      'Durable smoke-run binding (authoritative for delivery and completion):',
      `run-id: ${input.runBinding.runId}`,
      `artifact-dir: ${input.runBinding.artifactDir}`,
      'After you accept this prompt, write delivery evidence:',
      `  ${smokeDeliverySealedPath(input.runBinding.artifactDir)}`,
      '  contents: {"runId":"<run-id>"}',
      'Completion is accepted only after publish-complete sealing:',
      `  1. write report text to ${smokeCompletionBodyPath(input.runBinding.artifactDir)}`,
      `  2. write seal to ${smokeCompletionSealPath(input.runBinding.artifactDir)}`,
      '  seal contents: {"runId":"<run-id>","generation":1}',
      'Do not seal until the report body is final. A second seal is a duplicate terminalization.',
      'Terminal scrollback is not completion evidence; only the sealed artifact counts.',
    ]
    : [];

  return [
    'You are an independent smoke verifier for orchestrator-pack.',
    'Execute only the smoke scenarios below against the current worktree.',
    'Do not edit tracked implementation files, commit, push, merge, alter the Issue, invoke pack review, or call pack-worker-report.',
    'When finished, emit exactly one fenced block:',
    '',
    '```worker-smoke-report',
    'result: PASS|FAIL|BLOCKED',
    'tracked-files-unmodified: true|false',
    'environment-notes: <optional>',
    'limitations: <optional comma-separated>',
    'scenarios:',
    '  - action: <what you ran> | expected: <from plan> | observed: <what happened> | outcome: pass|fail|skipped|blocked',
    '```',
    ...durableLines,
    '',
    `Issue: #${input.issueNumber}`,
    `PR: #${input.prNumber}`,
    `Head SHA: ${input.headSha}`,
    '',
    'Smoke scenarios:',
    scenarioLines || '(none — report BLOCKED with concrete reason)',
    '',
    'Issue body for context:',
    input.issueBody,
  ].join('\n');
}

export function smokePromptForbidsWorkerActions(prompt: string): string[] {
  const violations: string[] = [];
  for (const pattern of FORBIDDEN_SMOKE_AGENT_ACTIONS) {
    if (pattern.test(prompt) && !/must not|do not|cannot/i.test(prompt)) {
      violations.push(pattern.source);
    }
  }
  return violations;
}

function applyScenarioField(scenario: SmokeScenario, key: string, value: string): void {
  const normalized = key.trim().toLowerCase();
  const trimmed = value.trim();
  if (normalized === 'action') {
    scenario.action = trimmed;
  } else if (normalized === 'expected') {
    scenario.expected = trimmed;
  } else if (normalized === 'observed') {
    scenario.observed = trimmed;
  } else if (normalized === 'outcome') {
    const outcome = trimmed.toLowerCase().match(/^(pass|fail|skipped|blocked)\b/u)?.[1];
    if (outcome) {
      scenario.outcome = outcome as SmokeScenario['outcome'];
    }
  } else if (normalized === 'skip-reason') {
    scenario.skipReason = trimmed;
  }
}

function parseScenarioFieldToken(token: string, scenario: SmokeScenario): void {
  const match = token.match(/^([a-z-]+):\s*(.*)$/i);
  if (!match) {
    return;
  }
  applyScenarioField(scenario, match[1], match[2]);
}

function parseSmokeScenarioBlock(block: string): SmokeScenario[] {
  const scenarios: SmokeScenario[] = [];
  let current: SmokeScenario | null = null;
  let inScenarios = false;

  for (const rawLine of block.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }
    if (/^scenarios:\s*$/i.test(trimmed)) {
      inScenarios = true;
      continue;
    }
    if (!inScenarios) {
      continue;
    }
    if (trimmed.startsWith('-')) {
      if (current && (current.action || current.expected || current.observed)) {
        scenarios.push(current);
      }
      current = { action: '', expected: '' };
      const content = trimmed.replace(/^-\s*/, '');
      for (const part of content.split('|')) {
        parseScenarioFieldToken(part.trim(), current);
      }
      if (!content.includes('|')) {
        parseScenarioFieldToken(content, current);
      }
      continue;
    }
    if (current && /^\s{2,}/.test(rawLine)) {
      parseScenarioFieldToken(trimmed, current);
    }
  }

  if (current && (current.action || current.expected || current.observed)) {
    scenarios.push(current);
  }
  return scenarios;
}

export function stripLeadingSmokeAgentPrompt(text: string, sentPrompt: string): string {
  let remainder = text;
  const prompt = sentPrompt.trim();
  while (prompt && remainder.startsWith(prompt)) {
    remainder = remainder.slice(prompt.length);
  }
  if (prompt && prompt.startsWith(remainder.trim())) {
    return '';
  }
  return remainder;
}


function trimOrcaTerminalUiTail(body: string): string {
  const markers = ['\n→ ', '\nComposer 2.', '\nRun Everything', '\n~/'];
  let end = body.length;
  for (const marker of markers) {
    const index = body.indexOf(marker);
    if (index >= 0) {
      end = Math.min(end, index);
    }
  }
  return body.slice(0, end);
}

function normalizeOrcaWrappedSmokeReportBody(body: string): string {
  const lines = body.split(/\r?\n/u);
  const out: string[] = [];
  for (const rawLine of lines) {
    const trimmed = rawLine.trimStart();
    if (!trimmed) {
      continue;
    }
    const isTopLevelField = /^(result|tracked-files-unmodified|environment-notes|limitations|scenarios|producer|orca-executable|terminal-handle|terminal-cleanup|non-pass-cause):/iu
      .test(trimmed);
    const isScenario = /^-\s/.test(trimmed);
    if (out.length === 0 || isTopLevelField || isScenario) {
      out.push(trimmed);
      continue;
    }
    out[out.length - 1] = `${out[out.length - 1]} ${trimmed}`;
  }
  return out.join('\n');
}

function findUnfencedSmokeReportBody(text: string): string | null {
  const lines = text.split(/\r?\n/u);
  let lastStart = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.trim().match(/^result:\s*(PASS|FAIL|BLOCKED)\s*$/iu);
    if (!match || match[1]?.includes('|')) {
      continue;
    }
    lastStart = index;
  }
  if (lastStart < 0) {
    return null;
  }

  const bodyLines: string[] = [];
  for (let index = lastStart; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (
      /^→/.test(line)
      || /^Composer 2\.\d/.test(line)
      || /^Run Everything/.test(line)
      || /^~\//.test(line)
      || /^\[Pasted text/.test(line)
    ) {
      break;
    }
    if (index > lastStart && /^```/.test(line)) {
      break;
    }
    bodyLines.push(line);
  }
  const body = trimOrcaTerminalUiTail(normalizeOrcaWrappedSmokeReportBody(bodyLines.map((line) => line.trimStart()).join('\n')));
  if (!/tracked-files-unmodified:/iu.test(body) || !/scenarios:/iu.test(body)) {
    return null;
  }
  return body;
}

function parseSmokeAgentReportBody(body: string): Partial<SmokeReport> | null {
  const fields = parseKeyValueBlock(body);
  const result = String(fields.result ?? '').trim().toUpperCase();
  if (result !== 'PASS' && result !== 'FAIL' && result !== 'BLOCKED') {
    return null;
  }

  const scenarios = parseSmokeScenarioBlock(body);
  if (scenarios.length === 0) {
    for (const line of body.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('-')) {
        continue;
      }
      const action = trimmed.match(/action:\s*([^|]+)/i)?.[1]?.trim() ?? '';
      const expected = trimmed.match(/expected:\s*([^|]+)/i)?.[1]?.trim() ?? '';
      const observed = trimmed.match(/observed:\s*([^|]+)/i)?.[1]?.trim() ?? '';
      const outcome = trimmed.match(/outcome:\s*([a-z]+)/i)?.[1]?.trim().toLowerCase() as SmokeScenario['outcome'];
      const skipReason = trimmed.match(/skip-reason:\s*(.+)$/i)?.[1]?.trim();
      if (action || expected || observed) {
        scenarios.push({ action, expected, observed, outcome, skipReason });
      }
    }
  }

  const trackedRaw = String(fields['tracked-files-unmodified'] ?? fields['tracked-files'] ?? '').toLowerCase();
  const limitations = String(fields.limitations ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const environmentNotes = String(fields['environment-notes'] ?? fields.environment ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return {
    result: result as SmokeResult,
    scenarios,
    trackedFilesUnmodified: trackedRaw === 'true' || trackedRaw === 'yes',
    limitations,
    environmentNotes,
    terminalCleanup: String(fields['terminal-cleanup'] ?? '').trim(),
    producer: String(fields.producer ?? '').trim() || undefined,
    orcaExecutable: String(fields['orca-executable'] ?? fields['orca-cli'] ?? '').trim() || undefined,
    terminalHandle: String(fields['terminal-handle'] ?? '').trim() || undefined,
  };
}

export function parseSmokeAgentReport(text: string): Partial<SmokeReport> | null {
  const fenced = text.match(SMOKE_REPORT_BLOCK);
  if (fenced) {
    const parsed = parseSmokeAgentReportBody(fenced[1]);
    if (parsed) {
      return parsed;
    }
  }
  const unfenced = findUnfencedSmokeReportBody(text);
  if (unfenced) {
    return parseSmokeAgentReportBody(unfenced);
  }
  return null;
}

export function normalizeSmokeReport(
  partial: Partial<SmokeReport>,
  binding: { issueNumber: number; prNumber: number; headSha: string },
): { ok: true; report: SmokeReport } | { ok: false; reason: string } {
  if (!partial.result || !['PASS', 'FAIL', 'BLOCKED'].includes(partial.result)) {
    return { ok: false, reason: 'missing_result' };
  }
  if (!binding.headSha || binding.headSha.length !== 40) {
    return { ok: false, reason: 'invalid_head_sha' };
  }
  if (!Number.isInteger(binding.issueNumber) || binding.issueNumber <= 0) {
    return { ok: false, reason: 'invalid_issue_number' };
  }
  if (!Number.isInteger(binding.prNumber) || binding.prNumber <= 0) {
    return { ok: false, reason: 'invalid_pr_number' };
  }
  if (partial.result === 'PASS' && partial.trackedFilesUnmodified !== true) {
    return { ok: false, reason: 'pass_requires_unmodified_tracked_files' };
  }
  if (!Array.isArray(partial.scenarios) || partial.scenarios.length === 0) {
    return { ok: false, reason: 'missing_scenarios' };
  }
  if (partial.result === 'PASS') {
    for (const [index, scenario] of partial.scenarios.entries()) {
      if (!scenario.action?.trim() || !scenario.expected?.trim() || !scenario.observed?.trim()) {
        return { ok: false, reason: `pass_scenario_${index + 1}_incomplete` };
      }
      if (!scenario.outcome) {
        return { ok: false, reason: `pass_scenario_${index + 1}_missing_outcome` };
      }
      if (scenario.outcome !== 'pass') {
        return { ok: false, reason: `pass_scenario_${index + 1}_not_pass` };
      }
    }
    if (partial.terminalCleanup && partial.terminalCleanup !== 'closed_owned_handle') {
      return { ok: false, reason: 'pass_requires_terminal_cleanup' };
    }
    if (partial.producer !== SMOKE_REPORT_PRODUCER) {
      return { ok: false, reason: 'pass_missing_producer' };
    }
    if (!partial.terminalHandle?.trim()) {
      return { ok: false, reason: 'pass_missing_terminal_handle' };
    }
    if (!partial.orcaExecutable?.trim()) {
      return { ok: false, reason: 'pass_missing_orca_executable' };
    }
  }

  return {
    ok: true,
    report: {
      result: partial.result,
      issueNumber: binding.issueNumber,
      prNumber: binding.prNumber,
      headSha: binding.headSha,
      scenarios: partial.scenarios,
      limitations: partial.limitations ?? [],
      trackedFilesUnmodified: partial.trackedFilesUnmodified === true,
      terminalCleanup: partial.terminalCleanup ?? 'not_recorded',
      environmentNotes: partial.environmentNotes ?? [],
      producer: partial.producer,
      orcaExecutable: partial.orcaExecutable,
      terminalHandle: partial.terminalHandle,
    },
  };
}

export function formatSmokeReportComment(report: SmokeReport): string {
  const scenarioLines = report.scenarios.map((scenario) => {
    const parts = [
      `- action: ${scenario.action}`,
      `expected: ${scenario.expected}`,
      `observed: ${scenario.observed ?? '(not recorded)'}`,
      `outcome: ${scenario.outcome ?? 'unknown'}`,
    ];
    if (scenario.skipReason) {
      parts.push(`skip-reason: ${scenario.skipReason}`);
    }
    return parts.join(' | ');
  });

  const machineScenarioLines = report.scenarios.map((scenario) => {
    const parts = [
      `action: ${scenario.action}`,
      `expected: ${scenario.expected}`,
      `observed: ${scenario.observed ?? ''}`,
      `outcome: ${scenario.outcome ?? 'unknown'}`,
    ];
    if (scenario.skipReason) {
      parts.push(`skip-reason: ${scenario.skipReason}`);
    }
    return `  - ${parts.join(' | ')}`;
  });

  const machineBlock = [
    '```worker-smoke-report',
    `result: ${report.result}`,
    `producer: ${report.producer ?? SMOKE_REPORT_PRODUCER}`,
    `orca-executable: ${report.orcaExecutable ?? ''}`,
    `terminal-handle: ${report.terminalHandle ?? ''}`,
    `tracked-files-unmodified: ${report.trackedFilesUnmodified ? 'true' : 'false'}`,
    `terminal-cleanup: ${report.terminalCleanup}`,
    'nonPassCause' in report && report.nonPassCause
      ? `non-pass-cause: ${String(report.nonPassCause)}`
      : '',
    report.environmentNotes.length > 0 ? `environment-notes: ${report.environmentNotes.join('; ')}` : '',
    report.limitations.length > 0 ? `limitations: ${report.limitations.join('; ')}` : '',
    'scenarios:',
    ...machineScenarioLines,
    '```',
  ].filter(Boolean).join('\n');

  return [
    `<!-- ${SMOKE_REPORT_MARKER} -->`,
    '## Worker smoke report',
    '',
    `- result: **${report.result}**`,
    `- issue: #${report.issueNumber}`,
    `- pr: #${report.prNumber}`,
    `- head-sha: \`${report.headSha}\``,
    `- tracked-implementation-files-unmodified: ${report.trackedFilesUnmodified ? 'yes' : 'no'}`,
    `- orca-terminal-cleanup: ${report.terminalCleanup}`,
    report.environmentNotes.length > 0 ? `- environment-notes: ${report.environmentNotes.join('; ')}` : '',
    report.limitations.length > 0 ? `- limitations/skips: ${report.limitations.join('; ')}` : '',
    '',
    '### Scenarios',
    ...scenarioLines,
    '',
    'The smoke agent did not modify tracked implementation files through the supported protocol.',
    '',
    machineBlock,
  ].filter(Boolean).join('\n');
}

export function extractSmokeReportsFromComments(comments: readonly { body?: string; createdAt?: string }[]): SmokeReport[] {
  const reports: SmokeReport[] = [];
  for (const comment of comments) {
    const body = comment.body ?? '';
    if (!SMOKE_REPORT_BLOCK.test(body)) {
      continue;
    }
    const partial = parseSmokeAgentReport(body);
    if (!partial?.result) {
      continue;
    }
    const issueNumber = Number(body.match(/issue:\s*#(\d+)/i)?.[1] ?? partial.issueNumber ?? 0);
    const prNumber = Number(body.match(/pr:\s*#(\d+)/i)?.[1] ?? partial.prNumber ?? 0);
    const headSha = body.match(/head-sha:\s*`?([0-9a-f]{40})`?/i)?.[1]
      ?? body.match(/head sha:\s*([0-9a-f]{40})/i)?.[1]
      ?? '';
    const normalized = normalizeSmokeReport(partial, { issueNumber, prNumber, headSha });
    if (normalized.ok) {
      reports.push(normalized.report);
    }
  }
  return reports;
}



export function verifySmokeHeadBinding(input: {
  requestedHeadSha: string;
  orcaHeadSha?: string;
  gitHeadSha?: string;
}): { ok: true } | { ok: false; reason: string; observed: string } {
  const requested = input.requestedHeadSha.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(requested)) {
    return { ok: false, reason: 'invalid_requested_head', observed: requested };
  }
  const orca = input.orcaHeadSha?.trim().toLowerCase() ?? '';
  const git = input.gitHeadSha?.trim().toLowerCase() ?? '';
  if (!orca || orca !== requested) {
    return { ok: false, reason: 'orca_head_mismatch', observed: orca || 'missing' };
  }
  if (!git || git !== requested) {
    return { ok: false, reason: 'git_head_mismatch', observed: git || 'missing' };
  }
  return { ok: true };
}

export function smokeReportCoversPlan(report: SmokeReport, plan: SmokeTestPlan): boolean {
  if (plan.scenarios.length === 0) {
    return true;
  }
  for (const [index, required] of plan.scenarios.entries()) {
    const match = report.scenarios.find((scenario) => (
      scenario.action.trim() === required.action.trim()
      && scenario.expected.trim() === required.expected.trim()
      && scenario.outcome === 'pass'
    ));
    if (!match) {
      return false;
    }
    void index;
  }
  return true;
}

export function findLatestSmokeReportForHead(
  comments: readonly { body?: string }[],
  prNumber: number,
  headSha: string,
  issueNumber?: number,
): SmokeReport | null {
  const normalizedHead = headSha.trim().toLowerCase();
  const reports = extractSmokeReportsFromComments(comments)
    .filter((report) => report.prNumber === prNumber
      && report.headSha.toLowerCase() === normalizedHead
      && (!issueNumber || issueNumber <= 0 || report.issueNumber === issueNumber));
  return reports.at(-1) ?? null;
}

export function findCurrentHeadSmokePass(
  comments: readonly { body?: string }[],
  prNumber: number,
  headSha: string,
  issueNumber?: number,
): SmokeReport | null {
  const latest = findLatestSmokeReportForHead(comments, prNumber, headSha, issueNumber);
  if (!latest || latest.result !== 'PASS') {
    return null;
  }
  if (latest.terminalCleanup !== 'closed_owned_handle') {
    return null;
  }
  return latest;
}

export function ownedSmokeTerminalClosedFromReports(
  comments: readonly { body?: string }[],
  prNumber: number,
  headSha: string,
  issueNumber?: number,
): boolean {
  const latest = findLatestSmokeReportForHead(comments, prNumber, headSha, issueNumber);
  return latest?.terminalCleanup === 'closed_owned_handle';
}


export function smokeTerminalHandleLooksValid(handle: string | undefined): boolean {
  const trimmed = String(handle ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,}$/.test(trimmed);
}

export function smokeReportHasPackProducer(report: SmokeReport): boolean {
  return report.producer === SMOKE_REPORT_PRODUCER
    && smokeTerminalHandleLooksValid(report.terminalHandle)
    && Boolean(report.orcaExecutable?.trim());
}

export interface WorkerSmokeGateInput {
  issueBody: string;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  prComments: readonly { body?: string }[];
  ciGreen: boolean;
  orcaWorktreeOk: boolean;
  ownedTerminalClosed: boolean;
  terminalProvenanceOk: boolean;
}

export interface WorkerSmokeGateDecision {
  allowed: boolean;
  reason: string;
  smokeRequired: boolean;
}

export function evaluateWorkerSmokeGate(input: WorkerSmokeGateInput): WorkerSmokeGateDecision {
  const plan = resolveSmokeRequirement(input.issueBody);
  if (plan.requirement === 'unknown') {
    return { allowed: false, reason: 'issue_body_unavailable', smokeRequired: true };
  }
  if (plan.requirement === 'legacy-exempt' || plan.requirement === 'not-applicable') {
    if (!input.ciGreen) {
      return { allowed: false, reason: 'required_ci_not_green', smokeRequired: false };
    }
    return { allowed: true, reason: 'smoke_not_required', smokeRequired: false };
  }
  if (plan.requirement === 'required' && plan.scenarios.length === 0) {
    return { allowed: false, reason: 'missing_smoke_plan', smokeRequired: true };
  }

  if (!input.orcaWorktreeOk) {
    return { allowed: false, reason: 'orca_worktree_unresolved', smokeRequired: true };
  }

  const latest = findLatestSmokeReportForHead(
    input.prComments,
    input.prNumber,
    input.headSha,
    input.issueNumber,
  );
  const ownedTerminalClosed = input.ownedTerminalClosed
    || ownedSmokeTerminalClosedFromReports(
      input.prComments,
      input.prNumber,
      input.headSha,
      input.issueNumber,
    );
  if (!ownedTerminalClosed) {
    return { allowed: false, reason: 'owned_smoke_terminal_uncleaned', smokeRequired: true };
  }

  if (latest && (latest.result === 'FAIL' || latest.result === 'BLOCKED')) {
    return { allowed: false, reason: `smoke_${latest.result.toLowerCase()}`, smokeRequired: true };
  }

  const pass = findCurrentHeadSmokePass(
    input.prComments,
    input.prNumber,
    input.headSha,
    input.issueNumber,
  );
  if (!pass) {
    const reports = extractSmokeReportsFromComments(input.prComments)
      .filter((report) => report.prNumber === input.prNumber);
    const latestAnyHead = reports.at(-1);
    if (latestAnyHead && latestAnyHead.headSha.toLowerCase() !== input.headSha.trim().toLowerCase()) {
      return { allowed: false, reason: 'stale_smoke_pass_for_older_head', smokeRequired: true };
    }
    return { allowed: false, reason: 'missing_smoke_pass', smokeRequired: true };
  }

  if (!input.ciGreen) {
    return { allowed: false, reason: 'required_ci_not_green', smokeRequired: true };
  }

  if (!smokeReportCoversPlan(pass, plan)) {
    return { allowed: false, reason: 'smoke_plan_not_fully_covered', smokeRequired: true };
  }

  if (!input.terminalProvenanceOk) {
    return { allowed: false, reason: 'smoke_terminal_provenance_unverified', smokeRequired: true };
  }

  return { allowed: true, reason: 'smoke_pass_and_ci_green', smokeRequired: true };
}

export function evaluateReadyForReviewCombinations(input: {
  smokePass: boolean;
  ciGreen: boolean;
}): boolean {
  return input.smokePass && input.ciGreen;
}

export function trackedPorcelainPaths(lines: readonly string[]): string[] {
  return lines
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 3 && !line.startsWith('??'))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

export function hasPreexistingTrackedDirtiness(lines: readonly string[]): boolean {
  return trackedPorcelainPaths(lines).length > 0;
}

export function detectTrackedImplementationMutation(
  before: readonly string[],
  after: readonly string[],
  beforeHashes?: Readonly<Record<string, string>>,
  afterHashes?: Readonly<Record<string, string>>,
): boolean {
  const normalize = (lines: readonly string[]) => new Set(
    lines
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('??')),
  );
  const beforeSet = normalize(before);
  const afterSet = normalize(after);
  if (afterSet.size > beforeSet.size) {
    return true;
  }
  for (const line of afterSet) {
    if (!beforeSet.has(line)) {
      return true;
    }
  }
  if (beforeHashes && afterHashes) {
    const paths = new Set([...trackedPorcelainPaths(before), ...trackedPorcelainPaths(after)]);
    for (const path of paths) {
      const beforeHash = beforeHashes[path];
      const afterHash = afterHashes[path];
      if (beforeHash && afterHash && beforeHash !== afterHash) {
        return true;
      }
    }
  }
  return false;
}

/** Parent env carriers forwarded only to smoke-owned `gh` children (not full parent inheritance). */
export const SMOKE_GH_AUTH_ENV_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GHE_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'HOME',
  'USERPROFILE',
] as const;

export type SmokeGhAuthEnvKey = (typeof SMOKE_GH_AUTH_ENV_KEYS)[number];

export const SMOKE_GH_SECRET_ENV_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GHE_TOKEN',
] as const;

export function buildSmokeGhChildEnv(parentEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const forwarded: NodeJS.ProcessEnv = {};
  for (const key of SMOKE_GH_AUTH_ENV_KEYS) {
    const value = parentEnv[key];
    if (value !== undefined && value !== '') {
      forwarded[key] = value;
    }
  }
  return forwarded;
}


export type SmokeChildWaitNonPassCause =
  | 'prompt_delivery_unconfirmed'
  | 'agent_report_unfenced'
  | 'agent_report_timeout'
  | 'agent_exited_without_report'
  | 'agent_idle_without_report'
  | 'agent_report_duplicate'
  | 'agent_wait_self_handle'
  | 'agent_wait_unowned_handle';

export type SmokeControlPlaneCause =
  | 'channel_stale_handle'
  | 'channel_lookup_empty'
  | 'channel_control_unavailable'
  | 'channel_control_overwritten';

export type SmokeChannelBindingCause = SmokeChildWaitNonPassCause | SmokeControlPlaneCause;

export function isSmokeControlPlaneCause(value: string): value is SmokeControlPlaneCause {
  return value === 'channel_stale_handle'
    || value === 'channel_lookup_empty'
    || value === 'channel_control_unavailable'
    || value === 'channel_control_overwritten';
}

export interface SmokeSealRecord {
  runId: string;
  generation?: number;
}

export type SmokeCompletionPublicationState =
  | 'none'
  | 'partial'
  | 'publish_complete_single'
  | 'publish_complete_duplicate'
  | 'publish_complete_unfenced';

export interface SmokeCompletionEvidenceObservation {
  publicationState: SmokeCompletionPublicationState;
  sealedRunId?: string;
  reportBody?: string;
  parsedReport?: Partial<SmokeReport> | null;
  wrongRunBinding: boolean;
}

export interface SmokeChildStateWitness {
  exited?: boolean;
  idle?: boolean;
}

export interface SmokeChannelBindingInput {
  supervisedHandle: string;
  ownedChildHandle: string;
  supervisorHandle?: string;
}

export function classifySmokeChannelBinding(
  input: SmokeChannelBindingInput,
): SmokeChildWaitNonPassCause | undefined {
  const supervised = input.supervisedHandle.trim();
  const owned = input.ownedChildHandle.trim();
  const supervisor = input.supervisorHandle?.trim();
  if (supervisor && supervised === supervisor) {
    return 'agent_wait_self_handle';
  }
  if (supervised !== owned) {
    return 'agent_wait_unowned_handle';
  }
  return undefined;
}

function readJsonFile(path: string): unknown | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function parseSmokeSealRecord(raw: unknown): SmokeSealRecord | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const runId = String((raw as { runId?: unknown }).runId ?? '').trim();
  if (!runId) {
    return undefined;
  }
  const generationRaw = (raw as { generation?: unknown }).generation;
  const generation = typeof generationRaw === 'number' && Number.isFinite(generationRaw)
    ? generationRaw
    : undefined;
  return { runId, generation };
}

function listCompletionSealGenerations(artifactDir: string): number[] {
  if (!existsSync(artifactDir)) {
    return [];
  }
  const generations: number[] = [];
  for (const entry of readdirSync(artifactDir)) {
    if (entry === 'completion.sealed.json') {
      generations.push(1);
      continue;
    }
    const match = /^completion\.sealed-(\d+)\.json$/u.exec(entry);
    if (match) {
      generations.push(Number(match[1]));
    }
  }
  return generations.sort((left, right) => left - right);
}

export function observeSmokeDeliveryEstablished(
  runBinding: SmokeRunBinding,
): boolean {
  const sealed = parseSmokeSealRecord(readJsonFile(smokeDeliverySealedPath(runBinding.artifactDir)));
  return sealed?.runId === runBinding.runId;
}

export function observeSmokeCompletionEvidence(
  runBinding: SmokeRunBinding,
): SmokeCompletionEvidenceObservation {
  const bodyPath = smokeCompletionBodyPath(runBinding.artifactDir);
  const bodyExists = existsSync(bodyPath);
  const sealGenerations = listCompletionSealGenerations(runBinding.artifactDir);
  if (sealGenerations.length === 0) {
    return {
      publicationState: bodyExists ? 'partial' : 'none',
      wrongRunBinding: false,
    };
  }
  if (sealGenerations.length > 1) {
    return {
      publicationState: 'publish_complete_duplicate',
      wrongRunBinding: false,
    };
  }
  const generation = sealGenerations[0]!;
  const seal = parseSmokeSealRecord(readJsonFile(smokeCompletionSealPath(runBinding.artifactDir, generation)));
  const wrongRunBinding = Boolean(seal && seal.runId !== runBinding.runId);
  if (wrongRunBinding) {
    return {
      publicationState: 'none',
      sealedRunId: seal?.runId,
      wrongRunBinding: true,
    };
  }
  const reportBody = bodyExists ? readFileSync(bodyPath, 'utf8') : '';
  const parsedReport = reportBody ? parseSmokeAgentReport(reportBody) : null;
  if (!parsedReport) {
    return {
      publicationState: 'publish_complete_unfenced',
      sealedRunId: seal?.runId,
      reportBody,
      parsedReport: null,
      wrongRunBinding: false,
    };
  }
  return {
    publicationState: 'publish_complete_single',
    sealedRunId: seal?.runId,
    reportBody,
    parsedReport,
    wrongRunBinding: false,
  };
}

export type SmokeChildWaitOutcome =
  | { status: 'pending' }
  | { status: 'completed'; partial: Partial<SmokeReport> }
  | { status: 'non_pass'; cause: SmokeChildWaitNonPassCause }
  | { status: 'control_plane'; cause: SmokeControlPlaneCause };

export function classifySmokeChildWaitObservation(input: {
  completion: SmokeCompletionEvidenceObservation;
  childState?: SmokeChildStateWitness;
  deadlineReached: boolean;
}): SmokeChildWaitOutcome {
  const { completion, childState, deadlineReached } = input;
  if (completion.publicationState === 'partial' || completion.publicationState === 'none') {
    if (childState?.exited) {
      return { status: 'non_pass', cause: 'agent_exited_without_report' };
    }
    if (childState?.idle) {
      return { status: 'non_pass', cause: 'agent_idle_without_report' };
    }
    if (deadlineReached) {
      return { status: 'non_pass', cause: 'agent_report_timeout' };
    }
    return { status: 'pending' };
  }
  if (completion.publicationState === 'publish_complete_duplicate') {
    return { status: 'non_pass', cause: 'agent_report_duplicate' };
  }
  if (completion.publicationState === 'publish_complete_unfenced') {
    return { status: 'non_pass', cause: 'agent_report_unfenced' };
  }
  if (completion.publicationState === 'publish_complete_single' && completion.parsedReport) {
    return { status: 'completed', partial: completion.parsedReport };
  }
  if (deadlineReached) {
    return { status: 'non_pass', cause: 'agent_report_timeout' };
  }
  return { status: 'pending' };
}

export function mapOrcaErrorToControlPlaneCause(
  code: string | undefined,
  message: string | undefined,
): SmokeControlPlaneCause | undefined {
  const haystack = `${code ?? ''} ${message ?? ''}`.toLowerCase();
  if (haystack.includes('stale') && haystack.includes('handle')) {
    return 'channel_stale_handle';
  }
  if (haystack.includes('lookup') && (haystack.includes('empty') || haystack.includes('not found'))) {
    return 'channel_lookup_empty';
  }
  if (haystack.includes('control') && haystack.includes('overwritten')) {
    return 'channel_control_overwritten';
  }
  if (haystack.includes('runtime_unavailable') || haystack.includes('control_unavailable') || haystack.includes('orca unavailable')) {
    return 'channel_control_unavailable';
  }
  return undefined;
}


export type SmokeNonPassCause =
  | 'zero_parsed_scenarios'
  | 'missing_agent_report'
  | 'executed_scenario_failure'
  | SmokeChildWaitNonPassCause
  | SmokeControlPlaneCause;

export const SMOKE_HARNESS_TERMINAL_CLOSE_ACTION = 'close owned Orca terminal handle';

export function declaredSmokeScenarios(
  partial: Partial<SmokeReport> | null | undefined,
): SmokeScenario[] {
  return (partial?.scenarios ?? []).filter((scenario) => scenario.action !== SMOKE_HARNESS_TERMINAL_CLOSE_ACTION);
}

export function classifySmokeNonPassCause(input: {
  zeroParsedScenarios?: boolean;
  partial: Partial<SmokeReport> | null;
  agentActivityObserved: boolean;
  agentCompleted?: boolean;
}): SmokeNonPassCause | undefined {
  if (input.zeroParsedScenarios) {
    return 'zero_parsed_scenarios';
  }
  if (!input.partial) {
    if (input.agentCompleted && input.agentActivityObserved) {
      return 'missing_agent_report';
    }
    return undefined;
  }
  const hasFailedDeclaredScenario = declaredSmokeScenarios(input.partial)
    .some((scenario) => scenario.outcome === 'fail');
  if (hasFailedDeclaredScenario) {
    return 'executed_scenario_failure';
  }
  return undefined;
}

export function classifyDeclaredScenarioNonPassCause(input: {
  zeroParsedScenarios?: boolean;
  partial: Partial<SmokeReport> | null;
  agentActivityObserved: boolean;
  agentCompleted?: boolean;
}): SmokeNonPassCause | undefined {
  if (!input.partial) {
    return classifySmokeNonPassCause(input);
  }
  return classifySmokeNonPassCause({
    ...input,
    partial: {
      ...input.partial,
      scenarios: declaredSmokeScenarios(input.partial),
    },
  });
}


export function orcaTerminalReadLines(result: unknown): string[] {
  if (!result || typeof result !== 'object') {
    return [];
  }
  const record = result as Record<string, unknown>;
  if (Array.isArray(record.lines)) {
    return record.lines.filter((line): line is string => typeof line === 'string');
  }
  const terminal = record.terminal;
  if (terminal && typeof terminal === 'object') {
    const tail = (terminal as { tail?: unknown }).tail;
    if (Array.isArray(tail)) {
      return tail.filter((line): line is string => typeof line === 'string');
    }
  }
  return [];
}

export function orcaTerminalReadNextCursor(result: unknown): number | undefined {
  if (!result || typeof result !== 'object') {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const direct = record.nextCursor;
  if (typeof direct === 'number' && Number.isFinite(direct)) {
    return direct;
  }
  if (typeof direct === 'string' && direct.trim() !== '') {
    const parsed = Number(direct);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const terminal = record.terminal;
  if (terminal && typeof terminal === 'object') {
    const nested = (terminal as { nextCursor?: unknown }).nextCursor;
    if (typeof nested === 'number' && Number.isFinite(nested)) {
      return nested;
    }
    if (typeof nested === 'string' && nested.trim() !== '') {
      const parsed = Number(nested);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
  }
  return undefined;
}

export function smokeAgentTerminalActivityBeyondSentPrompt(
  observedText: string,
  sentPrompt: string,
): boolean {
  const observed = observedText;
  if (!observed.trim()) {
    return false;
  }
  const prompt = sentPrompt.trim();
  if (!prompt) {
    return observed.trim().length > 0;
  }
  if (prompt.startsWith(observed.trim())) {
    return false;
  }
  let remainder = observed;
  while (remainder.startsWith(prompt)) {
    remainder = remainder.slice(prompt.length);
  }
  return remainder.trim().length > 0;
}

export function smokeAgentTerminalDeltaActivity(
  deltaText: string,
  sentPrompt = '',
): boolean {
  return smokeAgentTerminalActivityBeyondSentPrompt(deltaText, sentPrompt);
}

export function smokeAgentTerminalFullActivity(
  currentFullText: string,
  baselineFullText: string,
  sentPrompt = '',
): boolean {
  const baseline = baselineFullText ?? '';
  const observedSinceBaseline = currentFullText.startsWith(baseline)
    ? currentFullText.slice(baseline.length)
    : currentFullText;
  return smokeAgentTerminalActivityBeyondSentPrompt(observedSinceBaseline, sentPrompt);
}

/** @deprecated Use delta/full helpers explicitly at the Orca read boundary. */
export function smokeAgentTerminalActivityDetected(currentText: string, baselineText: string): boolean {
  return smokeAgentTerminalFullActivity(currentText, baselineText);
}

function collectGhConfigHomeSecretValues(configDir: string): string[] {
  const secrets: string[] = [];
  for (const fileName of ['hosts.yml', 'config.yml']) {
    const filePath = join(configDir, fileName);
    if (!existsSync(filePath)) {
      continue;
    }
    try {
      const content = readFileSync(filePath, 'utf8');
      for (const match of content.matchAll(/(?:oauth_token|password|git_protocol_token):\s*(\S+)/g)) {
        const value = match[1]?.trim();
        if (value && value.length >= 4) {
          secrets.push(value);
        }
      }
    } catch {
      // ignore unreadable config-home files
    }
  }
  return secrets;
}

export function resolveSmokeGhConfigDirs(childEnv: Readonly<NodeJS.ProcessEnv>): string[] {
  const explicit = childEnv.GH_CONFIG_DIR?.trim();
  if (explicit) {
    return [explicit];
  }

  const candidates: string[] = [];
  const xdgConfigHome = childEnv.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    candidates.push(join(xdgConfigHome, 'gh'));
  }
  const home = childEnv.HOME?.trim();
  if (home) {
    candidates.push(join(home, '.config', 'gh'));
  }
  const userProfile = childEnv.USERPROFILE?.trim();
  if (userProfile) {
    candidates.push(join(userProfile, '.config', 'gh'));
    candidates.push(join(userProfile, 'AppData', 'Local', 'GitHub CLI'));
  }
  return [...new Set(candidates)];
}

function scrubConfigHomeCredentialValues(text: string, childEnv: Readonly<NodeJS.ProcessEnv>): string {
  const configDirs = resolveSmokeGhConfigDirs(childEnv);
  if (configDirs.length === 0) {
    return text;
  }
  let scrubbed = text;
  for (const configDir of configDirs) {
    for (const credential of collectGhConfigHomeSecretValues(configDir)) {
      scrubbed = scrubbed.split(credential).join('[redacted-secret]');
    }
  }
  return scrubbed;
}

export function scrubForwardedGhSecrets(
  text: string,
  childEnv: Readonly<NodeJS.ProcessEnv> = buildSmokeGhChildEnv(),
): string {
  let scrubbed = scrubConfigHomeCredentialValues(text, childEnv);
  for (const key of SMOKE_GH_SECRET_ENV_KEYS) {
    const value = childEnv[key];
    if (!value || value.length < 4) {
      continue;
    }
    scrubbed = scrubbed.split(value).join('[redacted-secret]');
  }
  return scrubbed;
}

export function scrubSmokeOutput(text: string, childEnv?: Readonly<NodeJS.ProcessEnv>): string {
  const withSecrets = childEnv ? scrubForwardedGhSecrets(text, childEnv) : text;
  return withSecrets
    .replace(/(?:ghp_|github_pat_)[A-Za-z0-9_]+/g, '[redacted-token]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted-secret]');
}
