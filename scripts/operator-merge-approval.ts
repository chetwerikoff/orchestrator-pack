#!/usr/bin/env node
import { runProcess } from './kernel/subprocess.ts';
import {
  approveOperatorMerge,
  readOperatorMergeApproval,
  revokeOperatorMerge,
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

function usage(): never {
  throw new Error([
    'Usage:',
    '  node --experimental-strip-types scripts/operator-merge-approval.ts approve --pr-number N --head-sha SHA [--reason TEXT] [--repo-slug owner/repo]',
    '  node --experimental-strip-types scripts/operator-merge-approval.ts show --pr-number N --head-sha SHA',
    '  node --experimental-strip-types scripts/operator-merge-approval.ts revoke --pr-number N --head-sha SHA [--reason TEXT]',
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

function describeResult(result: Awaited<ReturnType<typeof runProcess>>): string {
  return String(result.stderr || result.error || result.stdout || result.outcome).trim();
}

async function ghPost(repoRoot: string, endpoint: string, payload: Record<string, unknown>): Promise<void> {
  const result = await runProcess({
    command: 'gh',
    args: ['api', '--method', 'POST', endpoint, '--input', '-'],
    input: `${JSON.stringify(payload)}\n`,
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: true,
    timeoutMs: 30_000,
  });
  if (!result.ok) throw new Error(`GitHub write failed for ${endpoint}: ${describeResult(result)}`);
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

async function publishApproval(record: OperatorMergeApprovalRecord): Promise<void> {
  await ghPost(process.cwd(), `repos/${record.repoSlug}/issues/${record.prNumber}/comments`, {
    body: approvalComment(record),
  });
  await ghPost(process.cwd(), `repos/${record.repoSlug}/statuses/${record.headSha}`, {
    state: 'success',
    context: PACK_REVIEW_REQUIRED_STATUS_CONTEXT,
    description: 'Pack review findings accepted by explicit operator merge command.',
  });
}

async function publishRevocation(args: ParsedArguments): Promise<void> {
  await ghPost(process.cwd(), `repos/${args.repoSlug}/issues/${args.prNumber}/comments`, {
    body: [
      '## Operator direct-merge approval revoked',
      '',
      `Approval for exact head \`${args.headSha}\` was revoked.`,
      '',
      `Reason: ${args.reason}`,
    ].join('\n'),
  });
  await ghPost(process.cwd(), `repos/${args.repoSlug}/statuses/${args.headSha}`, {
    state: 'pending',
    context: PACK_REVIEW_REQUIRED_STATUS_CONTEXT,
    description: 'Operator merge approval revoked; pack review must be re-evaluated.',
  });
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === 'show') {
    console.log(JSON.stringify(readOperatorMergeApproval(args), null, 2));
    return;
  }
  if (args.command === 'approve') {
    const record = approveOperatorMerge(args);
    try {
      await publishApproval(record);
    } catch (error) {
      revokeOperatorMerge({
        ...args,
        reason: `approval publication failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    }
    console.log(JSON.stringify({ ok: true, approval: record }, null, 2));
    return;
  }
  const revoked = revokeOperatorMerge(args);
  if (revoked.reason === 'revoked') await publishRevocation(args);
  console.log(JSON.stringify({ ok: true, approval: revoked }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
