#!/usr/bin/env node
import './toolchain/native-entrypoint-preflight.ts';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runProcess } from './kernel/subprocess.ts';
import {
  approveOperatorMerge,
  readOperatorMergeApproval,
  revokeOperatorMerge,
  type OperatorMergeApprovalLookup,
  type OperatorMergeApprovalRecord,
} from './lib/operator-merge-approval.ts';
import { PACK_REVIEW_REQUIRED_STATUS_CONTEXT } from './lib/pack-review-delivery.ts';

interface ParsedArguments {
  command: 'approve' | 'show' | 'revoke';
  prNumber: number;
  headSha: string;
  repoSlug: string;
  reason: string;
  actor?: string;
  storeRoot?: string;
}

export interface OperatorMergeApprovalStatusRequest {
  repoSlug: string;
  headSha: string;
  state: 'success' | 'failure';
  description: string;
}

export interface OperatorMergeApprovalCommentRequest {
  repoSlug: string;
  prNumber: number;
  body: string;
}

export interface OperatorMergeApprovalLatestStatusRequest {
  repoSlug: string;
  prNumber: number;
  headSha: string;
  context: string;
}

export type OperatorMergeApprovalRemoteStatusState = 'error' | 'failure' | 'pending' | 'success';

export interface OperatorMergeApprovalStatusSnapshot {
  state: OperatorMergeApprovalRemoteStatusState;
  context: string;
  description: string;
  startedAt?: string;
  completedAt?: string;
}

export interface OperatorMergeApprovalGithubTransport {
  postStatus(request: OperatorMergeApprovalStatusRequest): Promise<void>;
  postComment(request: OperatorMergeApprovalCommentRequest): Promise<void>;
  readLatestStatus(
    request: OperatorMergeApprovalLatestStatusRequest,
  ): Promise<OperatorMergeApprovalStatusSnapshot | null>;
  waitForStatusVisibility(delayMs: number): Promise<void>;
}

export interface RunOperatorMergeApprovalCommandOptions {
  transport?: OperatorMergeApprovalGithubTransport;
}

const BLOCKING_STATUS_RECONCILE_ATTEMPTS = 4;
const BLOCKING_STATUS_VISIBILITY_DELAY_MS = 250;

function usage(): never {
  throw new Error([
    'Usage:',
    '  AO_SESSION_KIND=operator node --experimental-strip-types scripts/operator-merge-approval.ts approve --pr-number N --head-sha SHA [--reason TEXT] [--repo-slug owner/repo]',
    '  AO_SESSION_KIND=operator node --experimental-strip-types scripts/operator-merge-approval.ts show --pr-number N --head-sha SHA',
    '  AO_SESSION_KIND=operator node --experimental-strip-types scripts/operator-merge-approval.ts revoke --pr-number N --head-sha SHA [--reason TEXT]',
  ].join('\n'));
}

function parseArguments(argv: string[]): ParsedArguments {
  const command = argv[0];
  if (command !== 'approve' && command !== 'show' && command !== 'revoke') usage();
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--')) usage();
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) usage();
    values.set(key.slice(2), value);
    index += 1;
  }
  const prNumber = Number(values.get('pr-number'));
  const headSha = values.get('head-sha') ?? '';
  return {
    command,
    prNumber,
    headSha,
    repoSlug: values.get('repo-slug') ?? 'chetwerikoff/orchestrator-pack',
    reason: values.get('reason')
      ?? (command === 'approve'
        ? 'Explicit operator direct-merge command.'
        : 'Operator merge approval revoked.'),
    ...(values.get('actor') ? { actor: values.get('actor') } : {}),
    ...(values.get('store-root') ? { storeRoot: values.get('store-root') } : {}),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeResult(result: Awaited<ReturnType<typeof runProcess>>): string {
  return String(result.stderr || result.error || result.stdout || result.outcome).trim();
}

export function assertOperatorMergeApprovalSession(): void {
  const sessionId = String(process.env.AO_SESSION_ID ?? '').trim();
  const sessionKind = String(process.env.AO_SESSION_KIND ?? '').trim().toLowerCase();
  if (sessionId) {
    throw new Error('operator merge approval is forbidden inside an AO-managed session');
  }
  if (sessionKind !== 'operator') {
    throw new Error('operator merge approval requires trusted AO_SESSION_KIND=operator');
  }
}

async function ghPost(endpoint: string, payload: Record<string, unknown>): Promise<void> {
  const result = await runProcess({
    command: 'gh',
    args: ['api', '--method', 'POST', endpoint, '--input', '-'],
    input: `${JSON.stringify(payload)}\n`,
    cwd: process.cwd(),
    inheritParentEnv: true,
    allowEmptyStdout: true,
    timeoutMs: 30_000,
  });
  if (!result.ok) throw new Error(`GitHub POST failed for ${endpoint}: ${describeResult(result)}`);
}

async function ghJson(
  args: string[],
  label: string,
  acceptedExitCodes: readonly number[] = [0],
): Promise<unknown> {
  const result = await runProcess({
    command: 'gh',
    args,
    cwd: process.cwd(),
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 30_000,
  });
  if (result.outcome !== 'exit' || result.exitCode === null || !acceptedExitCodes.includes(result.exitCode)) {
    throw new Error(`${label} failed: ${describeResult(result)}`);
  }
  if (!result.stdout) throw new Error(`${label} returned empty stdout`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} returned malformed JSON: ${describeError(error)}`);
  }
}

function normalizeRemoteStatusState(value: unknown): OperatorMergeApprovalRemoteStatusState {
  const state = String(value ?? '').trim().toLowerCase();
  if (state === 'error' || state === 'failure' || state === 'pending' || state === 'success') return state;
  throw new Error(`GitHub returned unsupported status state '${state || '<empty>'}'`);
}

function defaultGithubTransport(): OperatorMergeApprovalGithubTransport {
  return {
    async postStatus(request) {
      await ghPost(`repos/${request.repoSlug}/statuses/${request.headSha}`, {
        state: request.state,
        context: PACK_REVIEW_REQUIRED_STATUS_CONTEXT,
        description: request.description,
      });
    },
    async postComment(request) {
      await ghPost(`repos/${request.repoSlug}/issues/${request.prNumber}/comments`, {
        body: request.body,
      });
    },
    async readLatestStatus(request) {
      const pr = await ghJson([
        'pr', 'view', String(request.prNumber),
        '--repo', request.repoSlug,
        '--json', 'headRefOid,headRefName',
      ], 'GitHub PR head read');
      if (!pr || typeof pr !== 'object' || Array.isArray(pr)) {
        throw new Error('GitHub PR head read must return an object');
      }
      const currentHead = String((pr as Record<string, unknown>).headRefOid ?? '').trim().toLowerCase();
      if (currentHead !== request.headSha.toLowerCase()) {
        throw new Error(`GitHub PR head drifted during status reconciliation: ${currentHead || '<missing>'}`);
      }

      const payload = await ghJson([
        'pr', 'checks', String(request.prNumber),
        '--repo', request.repoSlug,
        '--json', 'name,state,bucket,link,startedAt,completedAt,workflow,description',
      ], 'GitHub PR checks read', [0, 1, 8]);
      if (!Array.isArray(payload)) throw new Error('GitHub PR checks read must return an array');
      const row = payload.find((candidate) => (
        candidate
        && typeof candidate === 'object'
        && !Array.isArray(candidate)
        && String((candidate as Record<string, unknown>).name ?? '') === request.context
      )) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        state: normalizeRemoteStatusState(row.state),
        context: request.context,
        description: String(row.description ?? ''),
        ...(row.startedAt ? { startedAt: String(row.startedAt) } : {}),
        ...(row.completedAt ? { completedAt: String(row.completedAt) } : {}),
      };
    },
    async waitForStatusVisibility(delayMs) {
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, delayMs));
    },
  };
}

function approvalComment(record: OperatorMergeApprovalRecord): string {
  return [
    '## Operator direct-merge approval',
    '',
    `The operator explicitly approved merge of PR #${record.prNumber} at exact head \`${record.headSha}\`.`,
    '',
    `Reason: ${record.reason}`,
    `Actor: ${record.actor}`,
    `Approval: \`${record.approvalId}\``,
    '',
    'Raw pack-review findings remain visible and are not rewritten as fixed. This approval expires on any head change.',
  ].join('\n');
}

function revocationComment(args: ParsedArguments): string {
  return [
    '## Operator direct-merge approval revoked',
    '',
    `Approval for exact head \`${args.headSha}\` was revoked.`,
    '',
    `Reason: ${args.reason}`,
  ].join('\n');
}

function reconciliationDescription(description: string): string {
  const token = randomUUID().replaceAll('-', '').slice(0, 20);
  const suffix = ` [opk-reconcile:${token}]`;
  return `${description.slice(0, Math.max(0, 140 - suffix.length))}${suffix}`;
}

async function readLatestPackReviewStatus(
  args: ParsedArguments,
  transport: OperatorMergeApprovalGithubTransport,
): Promise<OperatorMergeApprovalStatusSnapshot | null> {
  return transport.readLatestStatus({
    repoSlug: args.repoSlug,
    prNumber: args.prNumber,
    headSha: args.headSha,
    context: PACK_REVIEW_REQUIRED_STATUS_CONTEXT,
  });
}

function isOwnBlockingStatus(
  status: OperatorMergeApprovalStatusSnapshot | null,
  description: string,
): boolean {
  return status?.state === 'failure'
    && status.context === PACK_REVIEW_REQUIRED_STATUS_CONTEXT
    && status.description === description;
}

async function reconcileBlockingStatus(
  args: ParsedArguments,
  transport: OperatorMergeApprovalGithubTransport,
  description: string,
): Promise<void> {
  let lastObservation = 'not_attempted';
  for (let attempt = 1; attempt <= BLOCKING_STATUS_RECONCILE_ATTEMPTS; attempt += 1) {
    const ownDescription = reconciliationDescription(description);
    try {
      await transport.postStatus({
        repoSlug: args.repoSlug,
        headSha: args.headSha,
        state: 'failure',
        description: ownDescription,
      });
    } catch (error) {
      // A pre-existing failure can never confirm a write that did not succeed.
      lastObservation = `attempt ${attempt} failure write error: ${describeError(error)}`;
      continue;
    }

    await transport.waitForStatusVisibility(BLOCKING_STATUS_VISIBILITY_DELAY_MS * attempt);
    let first: OperatorMergeApprovalStatusSnapshot | null;
    try {
      first = await readLatestPackReviewStatus(args, transport);
    } catch (error) {
      lastObservation = `attempt ${attempt} first read error: ${describeError(error)}`;
      continue;
    }
    if (!isOwnBlockingStatus(first, ownDescription)) {
      lastObservation = `attempt ${attempt} first read: ${first?.state ?? 'missing'} ${first?.description ?? ''}`.trim();
      continue;
    }

    await transport.waitForStatusVisibility(BLOCKING_STATUS_VISIBILITY_DELAY_MS * attempt);
    let second: OperatorMergeApprovalStatusSnapshot | null;
    try {
      second = await readLatestPackReviewStatus(args, transport);
    } catch (error) {
      lastObservation = `attempt ${attempt} confirmation read error: ${describeError(error)}`;
      continue;
    }
    if (isOwnBlockingStatus(second, ownDescription)) return;
    lastObservation = `attempt ${attempt} confirmation: ${second?.state ?? 'missing'} ${second?.description ?? ''}`.trim();
  }
  throw new Error(
    `blocking status reconciliation did not confirm its own write after ${BLOCKING_STATUS_RECONCILE_ATTEMPTS} attempts: ${lastObservation}`,
  );
}

async function reconcileFailedApprovalPublication(
  args: ParsedArguments,
  transport: OperatorMergeApprovalGithubTransport,
  publicationError: unknown,
): Promise<never> {
  const publicationReason = describeError(publicationError);
  let revocationError = '';
  try {
    revokeOperatorMerge({
      ...args,
      reason: `approval publication failed: ${publicationReason}`,
    });
  } catch (error) {
    revocationError = describeError(error);
  }

  let statusError = '';
  try {
    await reconcileBlockingStatus(
      args,
      transport,
      'Operator approval publication failed; pack review remains blocking.',
    );
  } catch (error) {
    statusError = describeError(error);
  }

  const details = [
    `approval publication failed: ${publicationReason}`,
    revocationError ? `local revocation failed: ${revocationError}` : '',
    statusError ? `blocking status reconciliation failed: ${statusError}` : '',
  ].filter(Boolean).join('; ');
  throw new Error(details);
}

export async function runOperatorMergeApprovalCommand(
  argv: string[],
  options: RunOperatorMergeApprovalCommandOptions = {},
): Promise<{ ok: true; approval: OperatorMergeApprovalRecord | OperatorMergeApprovalLookup }> {
  const args = parseArguments(argv);
  assertOperatorMergeApprovalSession();
  const transport = options.transport ?? defaultGithubTransport();

  if (args.command === 'show') {
    return { ok: true, approval: readOperatorMergeApproval(args) };
  }

  if (args.command === 'approve') {
    const record = approveOperatorMerge(args);
    try {
      await transport.postComment({
        repoSlug: record.repoSlug,
        prNumber: record.prNumber,
        body: approvalComment(record),
      });
      await transport.postStatus({
        repoSlug: record.repoSlug,
        headSha: record.headSha,
        state: 'success',
        description: 'Pack review findings accepted by explicit operator merge command.',
      });
    } catch (error) {
      return reconcileFailedApprovalPublication(args, transport, error);
    }
    return { ok: true, approval: record };
  }

  const before = readOperatorMergeApproval(args);
  let after = before;
  let transitioned = false;
  if (before.approved) {
    after = revokeOperatorMerge(args);
    transitioned = after.reason === 'revoked';
  }

  await reconcileBlockingStatus(
    args,
    transport,
    'Operator merge approval revoked; pack review must be re-evaluated.',
  );
  if (transitioned) {
    await transport.postComment({
      repoSlug: args.repoSlug,
      prNumber: args.prNumber,
      body: revocationComment(args),
    });
  }
  return { ok: true, approval: after };
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  runOperatorMergeApprovalCommand(process.argv.slice(2))
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(describeError(error));
      process.exitCode = 1;
    });
}
