import {
  branchMatchesIssue,
  collectOpenPrSnapshot,
  resolveFoundationBinding,
  type AoSessionRow,
  type OpenPrSnapshotRow,
} from './binding.ts';
import { DEFAULT_FOUNDATION_CONFIG, parseFoundationConfig } from './config.ts';
import { buildDormantScheduler, runDormantMergeActuator } from './scheduler.ts';

function invariant(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

function session(): AoSessionRow {
  return {
    createdAt: '2026-07-20T00:00:00.000Z',
    harness: 'cursor',
    id: 'session-923',
    isTerminated: false,
    issueId: 923,
    lastActivityAt: '2026-07-20T00:10:00.000Z',
    projectId: 'orchestrator-pack',
    role: 'worker',
    status: 'working',
    updatedAt: '2026-07-20T00:10:00.000Z',
  };
}

function openPr(draft = false): OpenPrSnapshotRow {
  return {
    repoSlug: 'chetwerikoff/orchestrator-pack',
    number: 939,
    state: 'OPEN',
    isDraft: draft,
    headRefName: 'agent/issue-923-pr2-foundation',
    headRefOid: 'a'.repeat(40),
  };
}

function schedulerInert(): void {
  const previous = process.env.OPK_PR2_FOUNDATION_SCHEDULER_RUNNING;
  process.env.OPK_PR2_FOUNDATION_SCHEDULER_RUNNING = '1';
  try {
    const state = buildDormantScheduler(DEFAULT_FOUNDATION_CONFIG);
    invariant(state.running === false, 'scheduler_running');
    invariant(state.claimAcquirer === false, 'scheduler_claim_acquirer');
    invariant(state.activationEpochEnforced === false, 'activation_epoch_enforced');
  } finally {
    if (previous === undefined) delete process.env.OPK_PR2_FOUNDATION_SCHEDULER_RUNNING;
    else process.env.OPK_PR2_FOUNDATION_SCHEDULER_RUNNING = previous;
  }
}

function draftRejected(): void {
  const result = resolveFoundationBinding({
    session: session(),
    configuredRepo: 'chetwerikoff/orchestrator-pack',
    openPrs: [openPr(true)],
    now: '2026-07-20T01:00:00.000Z',
  });
  invariant(!result.bound, 'draft_candidate_bound');
  invariant(result.classId === 'B1', `draft_candidate_class:${result.classId}`);
  invariant(result.reason === 'no_source', `draft_candidate_reason:${result.reason}`);
}

async function missingDraftRejected(): Promise<void> {
  let rejected = false;
  try {
    await collectOpenPrSnapshot('chetwerikoff/orchestrator-pack', async () => [{
      ...openPr(false),
      isDraft: undefined,
    }]);
  } catch (error) {
    rejected = error instanceof Error && error.message.includes('invalid_open_pr_snapshot');
  }
  invariant(rejected, 'missing_draft_bit_accepted');
}

function prBodyNotTrusted(): void {
  invariant(!branchMatchesIssue('feature/Closes #923', 923), 'pr_body_reference_trusted');
  invariant(!branchMatchesIssue('feature/unrelated', 923), 'hypothetical_branch_trusted');
}

function configFailClosed(): void {
  invariant(parseFoundationConfig(null).ok === false, 'invalid_config_accepted');
  const malformed = parseFoundationConfig({ notification: { timeoutMs: '30000' } });
  invariant(!malformed.ok && malformed.reason === 'invalid_config', 'malformed_value_defaulted');
  const unknown = parseFoundationConfig({ scheduler: { surprise: true } });
  invariant(!unknown.ok && unknown.reason === 'unknown_config_key', 'unknown_config_key_ignored');
  const enabled = parseFoundationConfig({ actuator: { enabled: true } });
  invariant(enabled.ok, 'valid_config_rejected');
  invariant(runDormantMergeActuator(enabled.config).executed === false, 'foundation_config_activated_actuator');
}

async function main(): Promise<void> {
  const probeIndex = process.argv.indexOf('--probe');
  const probe = probeIndex >= 0 ? String(process.argv[probeIndex + 1] ?? '') : '';
  if (probe === 'scheduler-inert') schedulerInert();
  else if (probe === 'draft-rejected') draftRejected();
  else if (probe === 'missing-draft-rejected') await missingDraftRejected();
  else if (probe === 'pr-body-not-trusted') prBodyNotTrusted();
  else if (probe === 'config-fail-closed') configFailClosed();
  else throw new Error(`unknown_behavior_fixture:${probe}`);
  process.stdout.write(`behavior-fixture:${probe}:passed\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
