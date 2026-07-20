#!/usr/bin/env node
import './toolchain/native-entrypoint-preflight.ts';
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

const BLOCKING_STATUS_RECONCILE_ATTEMPTS = 4;
const BLOCKING_STATUS_SETTLE_MS = 250;

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

export interface OperatorMergeApprovalStatusSnapshot {
  state: string;
  context: string;
  id?: number | string;
  createdAtUtc?: string;
}

export interface OperatorMergeApprovalCommentRequest {
  repoSlug: string;
  prNumber: number;
  body: string;
}

export interface OperatorMergeApprovalGithubTransport {
  postStatus(request: OperatorMergeApprovalStatusRequest): Promise<void>;
  postComment(request: OperatorMergeApprovalCommentRequest): Promise<void>;
  getLatestStatus(request: { repoSlug: string; headSha: string }): Promise<OperatorMergeApprovalStatusSnapshot | null>;
}

export interface RunOperatorMergeApprovalCommandOptions {
  transport?: OperatorMergeApprovalGithubTransport;
}

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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
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
  if (!result.ok) throw new Error(`GitHub write failed for ${endpoint}: ${describeResult(result)}`);
}

async function ghGetJson(endpoint: string): Promise<unknown> {
  const result = await runProcess({
    command: 'gh',
    args: ['api', endpoint],
    cwd: process.cwd(),
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 30_000,
  });
  if (!result.ok) throw new Error(`GitHub read failed for ${endpoint}: ${describeResult(result)}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`GitHub read returned malformed JSON for ${endpoint}: ${describeError(error)}`);
  }
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
    async getLatestStatus(request) {
      const payload = await ghGetJson(
        `repos/${request.repoSlug}/commits/${request.headSha}/statuses?per_page=100`,
      );
      if (!Array.isArray(payload)) {
        throw new Error('GitHub commit statuses response must be an array');
      }
      const latest = payload.find((entry) => (
        entry
        && typeof entry === 'object'
        && !Array.isArray(entry)
        && String((entry as Record<string, unknown>).context ?? '') === PACK_REVIEW_REQUIRED_STATUS_CONTEXT
      )) as Record<string, unknown> | undefined;
      if (!latest) return null;
      return {
        state: String(latest.state ?? ''),
        context: String(latest.context ?? ''),
        ...(latest.id !== undefined ? { id: String(latest.id) } : {}),
        ...(latest.created_at ? { createdAtUtc: String(latest.created_at) } : {}),
      };
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

async function readLatestPackReviewStatus(
  args: ParsedArguments,
  transport: OperatorMergeApprovalGithubTransport,
): Promise<OperatorMergeApprovalStatusSnapshot | null> {
  const status = await transport.getLatestStatus({ repoSlug: args.repoSlug, headSha: args.headSha });
  if (!status) return null;
  if (status.context !== PACK_REVIEW_REQUIRED_STATUS_CONTEXT) {
    throw new Error(`unexpected status context '${status.context}'`);
  }
  return status;
}

async function reconcileBlockingStatus(
  args: ParsedArguments,
  transport: OperatorMergeApprovalGithubTransport,
  description: string,
): Promise<void> {
  const failures: string[] = [];
  for (let attempt = 1; attempt <= BLOCKING_STATUS_RECONCILE_ATTEMPTS; attempt += 1) {
    try {
      await transport.postStatus({
        repoSlug: args.repoSlug,
        headSha: args.headSha,
        state: 'failure',
        description,
      });
    } catch (error) {
      failures.push(`attempt ${attempt} write: ${describeError(error)}`);
    }

    await delay(BLOCKING_STATUS_SETTLE_MS * attempt);
    let first: OperatorMergeApprovalStatusSnapshot | null = null;
    try {
      first = await readLatestPackReviewStatus(args, transport);
    } catch (error) {
      failures.push(`attempt ${attempt} first read: ${describeError(error)}`);
    }
    if (first?.state !== 'failure') {
      failures.push(`attempt ${attempt} first read state: ${first?.state || 'missing'}`);
      continue;
    }

    await delay(BLOCKING_STATUS_SETTLE_MS * attempt);
    let second: OperatorMergeApprovalStatusSnapshot | null = null;
    try {
      second = await readLatestPackReviewStatus(args, transport);
    } catch (error) {
      failures.push(`attempt ${attempt} confirmation read: ${describeError(error)}`);
    }
    if (second?.state === 'failure') return;
    failures.push(`attempt ${attempt} confirmation state: ${second?.state || 'missing'}`);
  }
  throw new Error(
    `blocking status reconciliation unconfirmed after ${BLOCKING_STATUS_RECONCILE_ATTEMPTS} attempts: ${failures.join('; ')}`,
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
