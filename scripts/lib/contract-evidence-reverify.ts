import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { extractAtJsonPath } from '../external-output-shape-guard.mjs';
import {
  acceptanceCriterionSection,
  canonicalProducer,
  extractAuthoritativeContractEvidenceBody,
  isCliBehaviorBinding,
  parseContractEvidenceRows,
  parseProducerEmissionBlocks,
  producerEmissionHasExecutableProof,
  producerEmissionIsComplete,
} from '../contract-evidence.mjs';
import { loadCommittedCaptureManifest } from '../generate-capture-manifest.mjs';
import {
  collectAuthoritativeReferences,
  hashIssueBodySnapshot,
  sha256Hex,
} from './reviewer-contract-mapping.js';
import {
  DEFAULT_REVERIFY_MANIFEST_PATH,
  isCommandSafe,
  resolveAllowlistedCommand,
} from './reverify-command-resolution.js';
import { runSandboxedAllowlistedCommand } from './reverify-sandbox.js';

export { DEFAULT_REVERIFY_MANIFEST_PATH };

const require = createRequire(import.meta.url);
const producerRegistry = require('../contract-evidence-producer-registry.json') as {
  external?: string[];
  repoOwned?: string[];
  aliases?: Record<string, string>;
};
const allowlist = require('../contract-evidence-reverify-allowlist.json') as {
  externalProducers: string[];
  trustedCommandPrefixes: string[];
  mutatingTokenPattern: string;
  trustedCheckerRelativePaths: string[];
  defaultTimeoutMs: number;
  maxObservedLength: number;
};

export const REVERIFY_STATUSES = [
  'verified',
  'divergent',
  'unfulfilled-new',
  'unverified',
  'integrity-failed',
] as const;
export type ReverifyStatus = (typeof REVERIFY_STATUSES)[number];

export const REVERIFY_VERIFICATION_MODES = ['live', 'compared-to-record', 'not-run'] as const;
export type ReverifyVerificationMode = (typeof REVERIFY_VERIFICATION_MODES)[number];

export const REVERIFY_REASONS = [
  'producer-unreachable',
  'unsafe-or-undeclared-command',
  'unsupported-producer',
  'non-genuine-proof',
  'untrusted-pr-modified',
  'network-sandbox-unavailable',
] as const;
export type ReverifyReason = (typeof REVERIFY_REASONS)[number];

export const REVERIFY_RUN_OUTCOMES = [
  'no-rows',
  'no-linked-issue',
  'multiple-linked-issues',
  'pr-issue-mismatch',
  'unavailable-snapshot',
  'check-error',
  'partial-run',
  'rows-evaluated',
] as const;
export type ReverifyRunOutcome = (typeof REVERIFY_RUN_OUTCOMES)[number];

export interface ReverifyRowResult {
  rowIndex: number;
  rowHash: string;
  bindingId?: string;
  status: ReverifyStatus;
  verificationMode: ReverifyVerificationMode;
  reason?: ReverifyReason;
  asserted?: string;
  observed?: string;
  producerVerified: boolean;
}

export interface ReverifyRunResult {
  runOutcome: ReverifyRunOutcome;
  issueNumber: number | null;
  snapshotHash: string | null;
  snapshotDrift: boolean;
  prHeadSha: string | null;
  rows: ReverifyRowResult[];
  candidateOnly: true;
  neverBlocks: true;
}

export interface ReverifyRunInput {
  repoRoot: string;
  trustedBaseRoot: string;
  reviewTargetRoot?: string;
  manifestPath: string;
  boundSnapshotBody: string | null;
  currentIssueBody?: string | null;
  prBody?: string | null;
  explicitIssueNumber?: number | null;
  declarationIssueNumber?: number | null;
  expectedIssueNumber?: number | null;
  prHeadSha?: string | null;
  prModifiedPaths?: string[];
  timeoutMs?: number;
  simulateCrashBeforeFirstRow?: boolean;
  simulateCrashAfterRow?: number;
  forceProducerUnreachable?: boolean;
}

interface CaptureManifestEntry {
  id: string;
  producer: string;
  sourceCommand?: string;
  kind?: string;
  path?: string;
  contentHash?: string;
  exitStatus?: number;
}

interface CommandRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  blocked: boolean;
  blockReason?: string;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function resolveRepoPath(repoRoot: string, candidate: string): string {
  return path.isAbsolute(candidate) ? candidate : path.join(repoRoot, candidate);
}

function hashRow(row: Record<string, string>): string {
  const keys = Object.keys(row).sort();
  const canonical = keys.map((key) => `${key}:${row[key]}`).join('\n');
  return `sha256:${sha256Hex(canonical)}`;
}

function boundValue(value: unknown, max = allowlist.maxObservedLength): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const redacted = text
    .replace(/ghp_[A-Za-z0-9]{20,}/g, 'ghp_[REDACTED]')
    .replace(/AKIA[0-9A-Z]{16}/g, 'AKIA[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  if (redacted.length <= max) {
    return redacted;
  }
  return `${redacted.slice(0, max)}…`;
}

function valuesEqual(value: unknown, expected: string): boolean {
  if (typeof value === 'string') {
    return value === expected;
  }
  try {
    return JSON.stringify(value) === expected;
  } catch {
    return String(value) === expected;
  }
}

function isExternalProducer(producer: string): boolean {
  const canonical = canonicalProducer(producer);
  return (allowlist.externalProducers ?? producerRegistry.external ?? []).includes(canonical);
}

function isTrustedCheckerModified(prModifiedPaths: string[]): boolean {
  const normalized = new Set(prModifiedPaths.map(normalizePath));
  return allowlist.trustedCheckerRelativePaths.some((rel) => normalized.has(normalizePath(rel)));
}

function isManifestEntryModified(manifestPath: string, entryPath: string, prModifiedPaths: string[]): boolean {
  const normalized = new Set(prModifiedPaths.map(normalizePath));
  if (normalized.has(normalizePath(manifestPath))) {
    return true;
  }
  if (entryPath && normalized.has(normalizePath(entryPath))) {
    return true;
  }
  return false;
}

function runTrustedCommand(command: string, options: {
  cwd: string;
  timeoutMs: number;
  forceUnreachable?: boolean;
  sandboxMode: 'trusted-base' | 'pr-head-new';
}): CommandRunResult {
  const resolved = resolveAllowlistedCommand(command, { repoRoot: options.cwd });
  if (!resolved) {
    return {
      ok: false,
      stdout: '',
      stderr: 'unsafe-or-undeclared-command',
      exitCode: null,
      timedOut: false,
      blocked: true,
    };
  }

  return runSandboxedAllowlistedCommand(resolved, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    sandboxMode: options.sandboxMode,
    forceUnreachable: options.forceUnreachable,
  });
}

function compareStructuredOutput(stdout: string, selector: string, expected: string): {
  matched: boolean;
  observed: string;
} {
  const trimmed = stdout.trim();
  let parsed: unknown = trimmed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = trimmed;
  }
  const matches = extractAtJsonPath(parsed, selector);
  if (matches.length === 0) {
    return { matched: false, observed: boundValue(parsed) };
  }
  const observed = matches[0]?.value;
  return {
    matched: matches.some((item) => valuesEqual(item.value, expected)),
    observed: boundValue(observed),
  };
}

function compareCaptureContent(
  content: string,
  row: Record<string, string>,
  bindingType: string,
): { matched: boolean; observed?: string; asserted?: string } {
  if (bindingType === 'structured' || bindingType === 'cli-behavior') {
    const selector = row.selector ?? '';
    const expected = row.expected ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { matched: false, observed: boundValue(content), asserted: boundValue(expected) };
    }
    const comparison = compareStructuredOutput(JSON.stringify(parsed), selector, expected);
    return {
      matched: comparison.matched,
      observed: comparison.observed,
      asserted: boundValue(expected),
    };
  }
  const token = row.token ?? '';
  return {
    matched: content.includes(token),
    observed: boundValue(content.slice(0, 120)),
    asserted: boundValue(token),
  };
}

function blockedUnverifiedReason(run: CommandRunResult): ReverifyReason {
  if (run.blockReason === 'network-sandbox-unavailable') {
    return 'network-sandbox-unavailable';
  }
  return 'unsafe-or-undeclared-command';
}

function buildUnverified(
  rowIndex: number,
  row: Record<string, string>,
  reason: ReverifyReason,
): ReverifyRowResult {
  return {
    rowIndex,
    rowHash: hashRow(row),
    bindingId: row['binding-id'],
    status: 'unverified',
    verificationMode: 'not-run',
    reason,
    producerVerified: false,
  };
}

function evaluateCaptureRow(input: {
  rowIndex: number;
  row: Record<string, string>;
  entry: CaptureManifestEntry;
  manifestPath: string;
  corpusRoot: string;
  trustedBaseRoot: string;
  reviewTargetRoot: string;
  prModifiedPaths: string[];
  timeoutMs: number;
  forceProducerUnreachable?: boolean;
}): ReverifyRowResult {
  const {
    row,
    rowIndex,
    entry,
    manifestPath,
    corpusRoot,
    trustedBaseRoot,
    reviewTargetRoot,
    prModifiedPaths,
    timeoutMs,
    forceProducerUnreachable,
  } = input;
  const bindingType = (row['binding-type'] ?? 'structured').trim().toLowerCase();
  const captureRelPath = entry.path ?? '';
  const capturePath = captureRelPath
    ? path.join(trustedBaseRoot, corpusRoot, captureRelPath)
    : '';
  const assertedExpected = row.expected ?? row.token ?? '';

  if (
    isManifestEntryModified(
      manifestPath,
      captureRelPath ? path.join(corpusRoot, captureRelPath) : '',
      prModifiedPaths,
    )
    || isTrustedCheckerModified(prModifiedPaths)
  ) {
    return buildUnverified(rowIndex, row, 'untrusted-pr-modified');
  }

  if (!captureRelPath || !entry.contentHash) {
    return buildUnverified(rowIndex, row, 'unsupported-producer');
  }

  if (!existsSync(capturePath)) {
    return buildUnverified(rowIndex, row, 'unsupported-producer');
  }

  const captureContent = readFileSync(capturePath, 'utf8');
  const actualHash = `sha256:${createHash('sha256').update(captureContent).digest('hex')}`;
  if (actualHash !== entry.contentHash) {
    return {
      rowIndex,
      rowHash: hashRow(row),
      bindingId: row['binding-id'],
      status: 'integrity-failed',
      verificationMode: 'not-run',
      asserted: boundValue(assertedExpected),
      observed: boundValue(actualHash),
      producerVerified: false,
    };
  }

  const external = isExternalProducer(entry.producer);
  const command = (entry.sourceCommand ?? '').trim();
  const canRunLive = !external && command && isCommandSafe(command, reviewTargetRoot);

  if (canRunLive) {
    const run = runTrustedCommand(command, {
      cwd: reviewTargetRoot,
      timeoutMs,
      forceUnreachable: forceProducerUnreachable,
      sandboxMode: 'trusted-base',
    });
    if (run.blocked) {
      return compareToRecordFallback(rowIndex, row, bindingType, captureContent, assertedExpected);
    }
    if (run.timedOut) {
      return buildUnverified(rowIndex, row, 'producer-unreachable');
    }
    if (bindingType === 'cli-behavior' || isCliBehaviorBinding(row)) {
      const expectedExit = String(entry.exitStatus ?? '0');
      const observedExit = String(run.exitCode ?? 'null');
      const matched = observedExit === expectedExit;
      return {
        rowIndex,
        rowHash: hashRow(row),
        bindingId: row['binding-id'],
        status: matched ? 'verified' : 'divergent',
        verificationMode: 'live',
        asserted: boundValue(expectedExit),
        observed: boundValue(observedExit),
        producerVerified: matched,
      };
    }
    const comparison = compareCaptureContent(run.stdout, row, bindingType);
    return {
      rowIndex,
      rowHash: hashRow(row),
      bindingId: row['binding-id'],
      status: comparison.matched ? 'verified' : 'divergent',
      verificationMode: 'live',
      asserted: comparison.asserted ?? boundValue(assertedExpected),
      observed: comparison.observed,
      producerVerified: comparison.matched,
    };
  }

  if (external) {
    return compareToRecord(rowIndex, row, bindingType, captureContent, assertedExpected);
  }

  if (command && !isCommandSafe(command, reviewTargetRoot)) {
    if (captureRelPath) {
      return compareToRecord(rowIndex, row, bindingType, captureContent, assertedExpected);
    }
    return buildUnverified(rowIndex, row, 'unsafe-or-undeclared-command');
  }

  return buildUnverified(rowIndex, row, 'unsupported-producer');
}

function compareToRecordFallback(
  rowIndex: number,
  row: Record<string, string>,
  bindingType: string,
  captureContent: string,
  assertedExpected: string,
): ReverifyRowResult {
  return compareToRecord(rowIndex, row, bindingType, captureContent, assertedExpected);
}

function compareToRecord(
  rowIndex: number,
  row: Record<string, string>,
  bindingType: string,
  captureContent: string,
  assertedExpected: string,
): ReverifyRowResult {
  const comparison = compareCaptureContent(captureContent, row, bindingType);
  return {
    rowIndex,
    rowHash: hashRow(row),
    bindingId: row['binding-id'],
    status: comparison.matched ? 'verified' : 'divergent',
    verificationMode: 'compared-to-record',
    asserted: comparison.asserted ?? boundValue(assertedExpected),
    observed: comparison.observed,
    producerVerified: false,
  };
}

function findProducerEmissionForRow(markdown: string, acNumber: number): Record<string, string> | null {
  const section = acceptanceCriterionSection(markdown, acNumber);
  if (!section) {
    return null;
  }
  const blocks = parseProducerEmissionBlocks(section);
  return blocks.find((block) => producerEmissionIsComplete(block)) ?? null;
}

function evaluateNewRow(input: {
  rowIndex: number;
  row: Record<string, string>;
  markdown: string;
  reviewTargetRoot: string;
  timeoutMs: number;
  forceProducerUnreachable?: boolean;
}): ReverifyRowResult {
  const { row, rowIndex, markdown, reviewTargetRoot, timeoutMs, forceProducerUnreachable } = input;
  const evidence = row.evidence ?? '';
  const acMatch = evidence.match(/^NEW\(produced-by AC#(\d+)\)$/i);
  if (!acMatch) {
    return buildUnverified(rowIndex, row, 'unsupported-producer');
  }
  const acNumber = Number(acMatch[1]);
  const block = findProducerEmissionForRow(markdown, acNumber);
  if (!block) {
    return buildUnverified(rowIndex, row, 'unsupported-producer');
  }
  const proofCommand = (block['proof-command'] ?? block.command ?? '').trim();
  if (!proofCommand) {
    return buildUnverified(rowIndex, row, 'unsupported-producer');
  }
  if (!isCommandSafe(proofCommand, reviewTargetRoot)) {
    return buildUnverified(rowIndex, row, 'unsafe-or-undeclared-command');
  }

  const run = runTrustedCommand(proofCommand, {
    cwd: reviewTargetRoot,
    timeoutMs,
    forceUnreachable: forceProducerUnreachable,
    sandboxMode: 'pr-head-new',
  });
  if (run.blocked) {
    return buildUnverified(rowIndex, row, blockedUnverifiedReason(run));
  }
  if (run.timedOut) {
    return buildUnverified(rowIndex, row, 'producer-unreachable');
  }

  const expected = block.expected ?? '';
  const datum = block.datum ?? block.selector ?? '';
  const selector = datum.includes(':') ? `$.${datum.split(':').pop()}` : `$.${datum}`;
  const stdout = run.stdout.trim();
  if (!stdout) {
    return buildUnverified(rowIndex, row, 'non-genuine-proof');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return buildUnverified(rowIndex, row, 'non-genuine-proof');
  }

  if (proofCommand.includes('echo-expected') || parsed.invokedProducerPath !== true) {
    if (!parsed.invokedProducerPath) {
      return buildUnverified(rowIndex, row, 'non-genuine-proof');
    }
  }

  const comparison = compareStructuredOutput(stdout, selector, expected);
  if (comparison.matched) {
    return {
      rowIndex,
      rowHash: hashRow(row),
      bindingId: row['binding-id'],
      status: 'verified',
      verificationMode: 'live',
      asserted: boundValue(expected),
      observed: comparison.observed,
      producerVerified: true,
    };
  }

  return {
    rowIndex,
    rowHash: hashRow(row),
    bindingId: row['binding-id'],
    status: 'unfulfilled-new',
    verificationMode: 'live',
    asserted: boundValue(expected),
    observed: comparison.observed,
    producerVerified: false,
  };
}

export function resolveLinkedIssueNumber(input: {
  prBody?: string | null;
  explicitIssueNumber?: number | null;
  declarationIssueNumber?: number | null;
  expectedIssueNumber?: number | null;
}): { ok: true; issueNumber: number } | { ok: false; runOutcome: ReverifyRunOutcome } {
  const refs = collectAuthoritativeReferences({
    explicitIssueNumber: input.explicitIssueNumber ?? undefined,
    prBody: input.prBody ?? null,
    declarationIssueNumber: input.declarationIssueNumber ?? undefined,
  });

  if (refs.length === 0) {
    return { ok: false, runOutcome: 'no-linked-issue' };
  }
  if (refs.length > 1) {
    return { ok: false, runOutcome: 'multiple-linked-issues' };
  }

  const issueNumber = refs[0]!;
  if (input.expectedIssueNumber && input.expectedIssueNumber !== issueNumber) {
    return { ok: false, runOutcome: 'pr-issue-mismatch' };
  }
  return { ok: true, issueNumber };
}

export function formatReviewerReverifySummary(result: ReverifyRunResult): string {
  const lines = [
    '## Checkpoint-2 contract-evidence re-verification (candidate evidence only)',
    '',
    `run-outcome: ${result.runOutcome}`,
    `issue: ${result.issueNumber ?? 'n/a'}`,
    `snapshot-hash: ${result.snapshotHash ?? 'n/a'}`,
    `snapshot-drift: ${result.snapshotDrift}`,
    `pr-head-sha: ${result.prHeadSha ?? 'n/a'}`,
    'never-blocks: true',
    '',
  ];
  if (result.rows.length === 0) {
    lines.push('rows: none');
    return lines.join('\n');
  }
  lines.push('rows:');
  for (const row of result.rows) {
    const parts = [
      `#${row.rowIndex + 1}`,
      `status=${row.status}`,
      `verification-mode=${row.verificationMode}`,
      `producer-verified=${row.producerVerified}`,
    ];
    if (row.reason) {
      parts.push(`reason=${row.reason}`);
    }
    if (row.asserted !== undefined) {
      parts.push(`asserted=${row.asserted}`);
    }
    if (row.observed !== undefined) {
      parts.push(`observed=${row.observed}`);
    }
    lines.push(`- ${parts.join(' ')}`);
  }
  return lines.join('\n');
}

export function runContractEvidenceReverify(input: ReverifyRunInput): ReverifyRunResult {
  const prModifiedPaths = (input.prModifiedPaths ?? []).map(normalizePath);
  const reviewTargetRoot = input.reviewTargetRoot ?? input.repoRoot;
  const timeoutMs = input.timeoutMs ?? allowlist.defaultTimeoutMs;

  const baseResult: ReverifyRunResult = {
    runOutcome: 'rows-evaluated',
    issueNumber: null,
    snapshotHash: null,
    snapshotDrift: false,
    prHeadSha: input.prHeadSha ?? null,
    rows: [],
    candidateOnly: true,
    neverBlocks: true,
  };

  if (input.simulateCrashBeforeFirstRow) {
    return { ...baseResult, runOutcome: 'check-error' };
  }

  if (!input.boundSnapshotBody) {
    return { ...baseResult, runOutcome: 'unavailable-snapshot' };
  }

  const linked = resolveLinkedIssueNumber({
    prBody: input.prBody,
    explicitIssueNumber: input.explicitIssueNumber,
    declarationIssueNumber: input.declarationIssueNumber,
    expectedIssueNumber: input.expectedIssueNumber,
  });
  if (!linked.ok) {
    return { ...baseResult, runOutcome: linked.runOutcome };
  }

  const issueNumber = linked.issueNumber;
  const snapshotHash = `sha256:${hashIssueBodySnapshot(input.boundSnapshotBody)}`;
  const snapshotDrift = Boolean(
    input.currentIssueBody
    && `sha256:${hashIssueBodySnapshot(input.currentIssueBody)}` !== snapshotHash,
  );

  const body = extractAuthoritativeContractEvidenceBody(input.boundSnapshotBody);
  if (body === null) {
    return {
      ...baseResult,
      issueNumber,
      snapshotHash,
      snapshotDrift,
      runOutcome: 'no-rows',
    };
  }

  const parsed = parseContractEvidenceRows(body);
  if (parsed.none) {
    return {
      ...baseResult,
      issueNumber,
      snapshotHash,
      snapshotDrift,
      runOutcome: 'no-rows',
    };
  }
  if (parsed.malformed || parsed.rows.length === 0) {
    return {
      ...baseResult,
      issueNumber,
      snapshotHash,
      snapshotDrift,
      runOutcome: 'check-error',
    };
  }

  let manifest;
  try {
    manifest = loadCommittedCaptureManifest(input.trustedBaseRoot, input.manifestPath);
  } catch {
    return {
      ...baseResult,
      issueNumber,
      snapshotHash,
      snapshotDrift,
      runOutcome: 'check-error',
    };
  }
  const corpusRoot = path.dirname(input.manifestPath).replace(/\\/g, '/');
  const rows: ReverifyRowResult[] = [];

  for (const [index, row] of parsed.rows.entries()) {
    if (input.simulateCrashAfterRow === index) {
      return {
        ...baseResult,
        issueNumber,
        snapshotHash,
        snapshotDrift,
        runOutcome: 'partial-run',
        rows,
      };
    }

    const evidence = row.evidence ?? '';
    if (/^NEW\(produced-by AC#\d+\)$/i.test(evidence)) {
      rows.push(
        evaluateNewRow({
          rowIndex: index,
          row,
          markdown: input.boundSnapshotBody,
          reviewTargetRoot,
          timeoutMs,
          forceProducerUnreachable: input.forceProducerUnreachable,
        }),
      );
      continue;
    }

    const captureMatch = evidence.match(/^capture@(.+)$/i);
    if (!captureMatch) {
      rows.push(buildUnverified(index, row, 'unsupported-producer'));
      continue;
    }
    const manifestId = captureMatch[1].trim();
    const entry = manifest.entries?.[manifestId] as CaptureManifestEntry | undefined;
    if (!entry) {
      rows.push(buildUnverified(index, row, 'unsupported-producer'));
      continue;
    }

    rows.push(
      evaluateCaptureRow({
        rowIndex: index,
        row,
        entry,
        manifestPath: input.manifestPath,
        corpusRoot,
        trustedBaseRoot: input.trustedBaseRoot,
        reviewTargetRoot,
        prModifiedPaths,
        timeoutMs,
        forceProducerUnreachable: input.forceProducerUnreachable,
      }),
    );
  }

  return {
    ...baseResult,
    issueNumber,
    snapshotHash,
    snapshotDrift,
    rows,
  };
}

export function loadPromptReverifyMarkers(): {
  requiredInAgentRules: string[];
  requiredInCodexPrompt: string[];
} {
  return {
    requiredInAgentRules: [
      'Checkpoint-2 contract-evidence re-verification',
      'candidate evidence only',
      'invoke-contract-evidence-reverify.ps1',
      'producer-verified',
      'compared-to-record',
      'verification-mode',
      'never auto-blocks',
    ],
    requiredInCodexPrompt: [
      'Checkpoint-2 contract-evidence re-verification',
      'candidate evidence only',
      'invoke-contract-evidence-reverify.ps1',
      'producer-verified',
      'independently validate',
    ],
  };
}
