import { readFileSync } from 'node:fs';
import {
  checkTierGateGuard,
  formatTierGatePassMessage,
} from './tier-gate-core.js';

export type IssueMutationSubcommand = 'issue create' | 'issue edit';

export type BodySourceKind = 'body-file';

export type MutationArgvClass =
  | 'gh-issue-create-body-file'
  | 'gh-issue-edit-body-file';

export type MismatchClass =
  | 'literal-temp-path'
  | 'truncation'
  | 'content-mismatch';

export interface MutationAuditRecord {
  subcommand: IssueMutationSubcommand;
  repo: string;
  issueNumber: number | null;
  bodySource: BodySourceKind;
  bodyFilePath: string;
  argvClass: MutationArgvClass;
}

export interface ParityResult {
  match: boolean;
  mismatchClass?: MismatchClass;
}

export interface GhInvocationResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TierGateGuardValidationResult {
  ok: boolean;
  message: string;
}

export interface PublishIssueBodySyncDeps {
  runGh(argv: string[]): GhInvocationResult;
  writeBodyFile(content: string): string;
  emitAudit(record: MutationAuditRecord): void;
  validateTierGateGuard?: (draftContent: string, draftPath?: string) => TierGateGuardValidationResult;
}

export interface CreateIssueBodySyncInput {
  mode: 'create';
  draftPath: string;
  draftContent: string;
  repo: string;
  title?: string;
}

export interface EditIssueBodySyncInput {
  mode: 'edit';
  draftPath: string;
  draftContent: string;
  repo: string;
  issueNumber: number;
}

export interface VerifyIssueBodySyncInput {
  mode: 'verify';
  draftPath: string;
  draftContent: string;
  repo: string;
  issueNumber: number;
}

export type PublishIssueBodySyncInput =
  | CreateIssueBodySyncInput
  | EditIssueBodySyncInput
  | VerifyIssueBodySyncInput;

export interface PublishIssueBodySyncSuccess {
  ok: true;
  issueNumber: number;
  audit: MutationAuditRecord;
}

export interface PublishIssueBodySyncFailure {
  ok: false;
  issueNumber: number | null;
  message: string;
  mismatchClass?: MismatchClass;
  audit?: MutationAuditRecord;
}

export type PublishIssueBodySyncResult =
  | PublishIssueBodySyncSuccess
  | PublishIssueBodySyncFailure;

const TEMP_PATH_BODY_RE = /^@\/?tmp\/\S+$/;

export function readDraftFile(draftPath: string): string {
  return readFileSync(draftPath, 'utf8');
}

export function extractDraftTitle(draftContent: string): string {
  const firstLine = draftContent.replace(/\r\n/g, '\n').split('\n')[0] ?? '';
  const match = firstLine.match(/^#\s+(.+?)\s*$/);
  if (!match?.[1]) {
    throw new Error(`draft is missing an H1 title line: ${firstLine || '<empty>'}`);
  }
  return match[1];
}

/** Issue body payload: draft minus H1 and the following blank line (tail -n +3). */
export function extractExpectedIssueBodyFromDraft(draftContent: string): string {
  const lines = draftContent.replace(/\r\n/g, '\n').split('\n');
  return lines.slice(2).join('\n');
}

export function normalizeIssueBodyForParity(body: string): string {
  return body.replace(/\r\n/g, '\n');
}

function stripAtMostOneTrailingNewline(body: string): string {
  const normalized = normalizeIssueBodyForParity(body);
  return normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
}

export function bodiesMatchForParity(expected: string, live: string): boolean {
  return stripAtMostOneTrailingNewline(expected) === stripAtMostOneTrailingNewline(live);
}

export function isLiteralTempPathBody(body: string): boolean {
  return TEMP_PATH_BODY_RE.test(body.trim());
}

export function classifyMismatch(expected: string, live: string): MismatchClass {
  if (isLiteralTempPathBody(live)) {
    return 'literal-temp-path';
  }
  const normalizedExpected = stripAtMostOneTrailingNewline(expected);
  const normalizedLive = stripAtMostOneTrailingNewline(live);
  if (
    normalizedLive.length < normalizedExpected.length &&
    normalizedExpected.startsWith(normalizedLive)
  ) {
    return 'truncation';
  }
  return 'content-mismatch';
}

export function compareIssueBodies(expected: string, live: string): ParityResult {
  if (bodiesMatchForParity(expected, live)) {
    return { match: true };
  }
  return { match: false, mismatchClass: classifyMismatch(expected, live) };
}

export function parseRepoSlug(repo: string): { owner: string; name: string } {
  const trimmed = repo.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new Error(`invalid repo slug (expected owner/name): ${repo}`);
  }
  return { owner: trimmed.slice(0, slash), name: trimmed.slice(slash + 1) };
}

export function buildRestIssueBodyPath(repo: string, issueNumber: number): string {
  const { owner, name } = parseRepoSlug(repo);
  return `repos/${owner}/${name}/issues/${issueNumber}`;
}

export function assertSanctionedGhIssueMutation(argv: string[]): void {
  if (argv.length < 2 || argv[0] !== 'gh') {
    throw new Error(`unsanctioned issue-body mutation transport (expected gh issue create/edit --body-file): ${argv.join(' ')}`);
  }

  const sub = argv[1];
  if (sub === 'api') {
    const joined = argv.join(' ');
    if (/\/issues(?:\/|$)/.test(joined) && /--field\s+body=|--raw-field\s+body=|\bbody=/.test(joined)) {
      throw new Error('unsanctioned low-level gh api issue-body mutation is forbidden');
    }
    throw new Error(`unsanctioned gh api invocation for issue-body sync: ${joined}`);
  }

  if (sub !== 'issue' || (argv[2] !== 'create' && argv[2] !== 'edit')) {
    throw new Error(`unsanctioned issue-body mutation subcommand (expected gh issue create/edit): ${argv.join(' ')}`);
  }

  if (argv.includes('--body')) {
    throw new Error('unsanctioned inline --body mutation is forbidden; use --body-file');
  }

  const bodyFileFlagIndex = argv.indexOf('--body-file');
  if (bodyFileFlagIndex < 0 || !argv[bodyFileFlagIndex + 1]) {
    throw new Error('sanctioned issue-body mutation requires --body-file');
  }
}

export function buildSanctionedMutationArgv(input: {
  mode: 'create' | 'edit';
  repo: string;
  title?: string;
  issueNumber?: number;
  bodyFilePath: string;
}): string[] {
  const argv = ['gh', 'issue', input.mode, '--repo', input.repo, '--body-file', input.bodyFilePath];
  if (input.mode === 'create') {
    if (!input.title?.trim()) {
      throw new Error('gh issue create requires --title or draft H1');
    }
    argv.push('--title', input.title.trim());
  } else {
    if (!input.issueNumber || input.issueNumber <= 0) {
      throw new Error('gh issue edit requires a positive --issue-number');
    }
    argv.push(String(input.issueNumber));
  }
  assertSanctionedGhIssueMutation(argv);
  return argv;
}

export function buildMutationAuditRecord(input: {
  mode: 'create' | 'edit';
  repo: string;
  issueNumber: number | null;
  bodyFilePath: string;
}): MutationAuditRecord {
  return {
    subcommand: input.mode === 'create' ? 'issue create' : 'issue edit',
    repo: input.repo,
    issueNumber: input.issueNumber,
    bodySource: 'body-file',
    bodyFilePath: input.bodyFilePath,
    argvClass: input.mode === 'create' ? 'gh-issue-create-body-file' : 'gh-issue-edit-body-file',
  };
}

export function parseCreatedIssueNumber(stdout: string): number | null {
  const match = stdout.match(/\/issues\/(\d+)\b/);
  if (!match?.[1]) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function formatParityFailureMessage(input: {
  issueNumber: number;
  mismatchClass: MismatchClass;
  repo: string;
}): string {
  return [
    `publish-issue-body sync failed for issue #${input.issueNumber} (${input.repo})`,
    `mismatch class: ${input.mismatchClass}`,
    'live REST issue body does not match the local expected draft body',
  ].join('\n');
}

export function readLiveIssueBodyViaRest(
  deps: Pick<PublishIssueBodySyncDeps, 'runGh'>,
  repo: string,
  issueNumber: number,
): GhInvocationResult {
  const path = buildRestIssueBodyPath(repo, issueNumber);
  return deps.runGh(['gh', 'api', path, '--jq', '.body']);
}

export function validateTierGateGuardReceipt(
  draftContent: string,
  draftPath?: string,
): TierGateGuardValidationResult {
  const result = checkTierGateGuard(draftContent, {
    draftPath,
    repoRoot: process.cwd(),
  });
  if (!result.ok) {
    return {
      ok: false,
      message: result.errors.map((error: string) => `tier-gate guard: ${error}`).join('\n'),
    };
  }
  return {
    ok: true,
    message: formatTierGatePassMessage(result),
  };
}

export function syncPublishIssueBody(
  deps: PublishIssueBodySyncDeps,
  input: PublishIssueBodySyncInput,
): PublishIssueBodySyncResult {
  const expectedBody = extractExpectedIssueBodyFromDraft(input.draftContent);
  let issueNumber = input.mode === 'create' ? null : input.issueNumber;
  let audit: MutationAuditRecord | undefined;

  if (input.mode !== 'verify') {
    const validateTierGate = deps.validateTierGateGuard ?? validateTierGateGuardReceipt;
    const tierGate = validateTierGate(input.draftContent, input.draftPath);
    if (!tierGate.ok) {
      return {
        ok: false,
        issueNumber: issueNumber ?? null,
        message: tierGate.message,
      };
    }

    const title = input.mode === 'create'
      ? (input.title ?? extractDraftTitle(input.draftContent))
      : undefined;
    const bodyFilePath = deps.writeBodyFile(expectedBody);
    const mutationArgv = buildSanctionedMutationArgv({
      mode: input.mode,
      repo: input.repo,
      title,
      issueNumber: issueNumber ?? undefined,
      bodyFilePath,
    });

    audit = buildMutationAuditRecord({
      mode: input.mode,
      repo: input.repo,
      issueNumber,
      bodyFilePath,
    });
    deps.emitAudit(audit);

    const mutation = deps.runGh(mutationArgv);
    if (mutation.exitCode !== 0) {
      return {
        ok: false,
        issueNumber,
        message: mutation.stderr.trim() || mutation.stdout.trim() || 'gh issue mutation failed',
        audit,
      };
    }

    if (input.mode === 'create') {
      issueNumber = parseCreatedIssueNumber(mutation.stdout);
      if (!issueNumber) {
        return {
          ok: false,
          issueNumber: null,
          message: 'gh issue create succeeded but issue number could not be parsed from stdout',
          audit,
        };
      }
      audit = buildMutationAuditRecord({
        mode: 'create',
        repo: input.repo,
        issueNumber,
        bodyFilePath,
      });
      deps.emitAudit(audit);
    }
  }

  const resolvedIssueNumber =
    issueNumber ?? (input.mode === 'create' ? null : input.issueNumber);
  if (!resolvedIssueNumber) {
    return {
      ok: false,
      issueNumber: null,
      message: 'issue number is required for live REST parity read',
      audit,
    };
  }
  const liveRead = readLiveIssueBodyViaRest(deps, input.repo, resolvedIssueNumber);
  if (liveRead.exitCode !== 0) {
    return {
      ok: false,
      issueNumber: resolvedIssueNumber,
      message: liveRead.stderr.trim() || liveRead.stdout.trim() || 'live REST issue-body read failed',
      audit,
    };
  }

  const parity = compareIssueBodies(expectedBody, liveRead.stdout);
  if (!parity.match) {
    const mismatchClass = parity.mismatchClass ?? 'content-mismatch';
    return {
      ok: false,
      issueNumber: resolvedIssueNumber,
      mismatchClass,
      message: formatParityFailureMessage({
        issueNumber: resolvedIssueNumber,
        mismatchClass,
        repo: input.repo,
      }),
      audit,
    };
  }

  return {
    ok: true,
    issueNumber: resolvedIssueNumber,
    audit: audit ?? buildMutationAuditRecord({
      mode: input.mode === 'create' ? 'create' : 'edit',
      repo: input.repo,
      issueNumber: resolvedIssueNumber,
      bodyFilePath: '<verify-only>',
    }),
  };
}
