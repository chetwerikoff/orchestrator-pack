import '../toolchain/native-entrypoint-preflight.ts';

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  branchMatchesIssue,
  captureLeakReason,
  collectOpenPrSnapshot,
  normalizeAoSessionRow,
  resolveFoundationBinding,
  sanitizerIdentity,
  sanitizeAoSessions,
  validateAoPreflight,
  type OpenPrSnapshotRow,
} from './binding.ts';
import {
  DEFAULT_FOUNDATION_CONFIG,
  notificationConfig,
  parseFoundationConfig,
} from './config.ts';
import { runSyntheticMigration } from './migration-journal.ts';
import { buildDormantScheduler, runDormantMergeActuator } from './scheduler.ts';
import { fixtureAoSession } from './test-fixtures.ts';
import {
  DISPATCH_OUTCOME_DISPATCHED,
  DRAFT_STATE_DRAFT_PRESENT,
  finalizeDispatchJournalRecord,
} from './worker-dispatch-journal.ts';

function invariant(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

function session() {
  return fixtureAoSession();
}

function openPr(draft = false, overrides: Partial<OpenPrSnapshotRow> = {}): OpenPrSnapshotRow {
  return {
    repoSlug: 'chetwerikoff/orchestrator-pack',
    number: 939,
    state: 'OPEN',
    isDraft: draft,
    headRefName: 'agent/issue-923-pr2-foundation',
    headRefOid: 'a'.repeat(40),
    ...overrides,
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

function captureSecretRejected(): void {
  const payload = { authorization: `ghp_${'a'.repeat(24)}` };
  invariant(captureLeakReason(payload) === 'capture_metadata_secret_scan_failed', 'capture_secret_accepted');
}

function schemaExact(): void {
  invariant(normalizeAoSessionRow(session()) !== null, 'verified_schema_rejected');
  invariant(normalizeAoSessionRow({ ...session(), branch: 'issue-923' }) === null, 'schema_shape_broadened');
}

function preflightFailClosed(): void {
  const rows = [session()];
  const sanitizerId = sanitizerIdentity(sanitizeAoSessions(rows));
  invariant(!validateAoPreflight({
    command: 'ao session get --json',
    appStateVersion: '0.10.3',
    sessions: rows,
    sanitizerId,
  }).ok, 'preflight_command_accepted');
  invariant(!validateAoPreflight({
    command: 'ao session ls --json',
    appStateVersion: '0.10.3',
    sessions: [],
    sanitizerId,
  }).ok, 'preflight_empty_fleet_accepted');
  invariant(!validateAoPreflight({
    command: 'ao session ls --json',
    appStateVersion: '0.10.4',
    sessions: rows,
    sanitizerId,
  }).ok, 'preflight_version_accepted');
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

function bindingFailClosed(): void {
  const base = {
    session: session(),
    configuredRepo: 'chetwerikoff/orchestrator-pack',
    now: '2026-07-20T01:00:00.000Z',
  };
  const zero = resolveFoundationBinding({ ...base, openPrs: [] });
  invariant(!zero.bound && zero.reason === 'no_source', 'zero_candidate_bound');
  const ambiguous = resolveFoundationBinding({
    ...base,
    openPrs: [
      openPr(false),
      openPr(false, { number: 940, headRefName: 'feat/923', headRefOid: 'b'.repeat(40) }),
    ],
  });
  invariant(!ambiguous.bound && ambiguous.reason === 'live_ambiguous', 'multiple_candidates_bound');
  const bound = resolveFoundationBinding({ ...base, openPrs: [openPr(false)] });
  invariant(bound.bound && bound.currentHeadSha === 'a'.repeat(40), 'bound_head_not_recorded');
}

async function crossRepoRejected(): Promise<void> {
  let rejected = false;
  try {
    await collectOpenPrSnapshot('chetwerikoff/orchestrator-pack', async () => [
      openPr(false, { repoSlug: 'other/repository' }),
    ]);
  } catch (error) {
    rejected = error instanceof Error && error.message.includes('invalid_open_pr_snapshot');
  }
  invariant(rejected, 'cross_repo_candidate_accepted');
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
  const live = notificationConfig({ notification: { timeoutMs: 12_345 } });
  invariant(live.timeoutMs === 12_345, 'notification_config_not_consumed');
}

function historicalJournalReadable(): void {
  const deliveryId = 'legacy-delivery-923';
  const legacyRecord = {
    deliveryId,
    sessionId: 'legacy-session',
    deliveredAtMs: 1_700_000_000_000,
    source: 'legacy-pack-send',
    sourceKey: 'legacy-source-key',
    deliveryPath: 'pending-draft',
    messageShape: { charLength: 91, lineCount: 6 },
    dispatchOutcome: 'in-flight',
    draftState: 'draft_present',
    legacyOpaqueField: { preserved: true, version: 7 },
  };
  const finalized = finalizeDispatchJournalRecord(
    { [deliveryId]: legacyRecord },
    deliveryId,
    DISPATCH_OUTCOME_DISPATCHED,
    1_700_000_000_100,
    DRAFT_STATE_DRAFT_PRESENT,
  );
  invariant(finalized.ok, 'historical_record_unreadable');
  invariant(
    JSON.stringify(finalized.record.legacyOpaqueField) === JSON.stringify(legacyRecord.legacyOpaqueField),
    'historical_unknown_fields_dropped',
  );
}

function withMigrationFixture(run: (paths: {
  fixtureRoot: string;
  sourcePath: string;
  targetPath: string;
  journalPath: string;
}) => void): void {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'opk-mutation-migration-'));
  try {
    const sourcePath = path.join(fixtureRoot, 'source.json');
    const targetPath = path.join(fixtureRoot, 'target.json');
    const journalPath = path.join(fixtureRoot, 'journal.json');
    writeFileSync(sourcePath, '{"fixture":true}\n', 'utf8');
    run({ fixtureRoot, sourcePath, targetPath, journalPath });
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function readJournalState(journalPath: string): string {
  const parsed = JSON.parse(readFileSync(journalPath, 'utf8')) as { state?: unknown };
  return String(parsed.state ?? '');
}

function migrationJournalKeyRequired(): void {
  withMigrationFixture(({ fixtureRoot, sourcePath, targetPath, journalPath }) => {
    const result = runSyntheticMigration({
      fixtureRoot,
      sourcePath,
      targetPath,
      journalPath,
      journalKey: '   ',
      now: '2026-07-20T00:00:00.000Z',
    });
    invariant(!result.ok && result.reason === 'journal_key_required', 'empty_journal_key_accepted');
    invariant(!existsSync(journalPath), 'journal_created_without_key');
    invariant(!existsSync(targetPath), 'target_created_without_key');
  });
}

function migrationPrepareBeforeEffects(): void {
  withMigrationFixture(({ fixtureRoot, sourcePath, targetPath, journalPath }) => {
    const result = runSyntheticMigration({
      fixtureRoot,
      sourcePath,
      targetPath,
      journalPath,
      journalKey: 'fixture-key',
      now: '2026-07-20T00:00:00.000Z',
      crashAt: 'before_prepare',
    });
    invariant(!result.ok && result.reason === 'injected_crash:before_prepare', 'before_prepare_not_injected');
    invariant(!existsSync(journalPath), 'journal_written_before_prepare_boundary');
    invariant(!existsSync(targetPath), 'target_mutated_before_prepare');
  });
}

function migrationPreparedBeforeImport(): void {
  withMigrationFixture(({ fixtureRoot, sourcePath, targetPath, journalPath }) => {
    const result = runSyntheticMigration({
      fixtureRoot,
      sourcePath,
      targetPath,
      journalPath,
      journalKey: 'fixture-key',
      now: '2026-07-20T00:00:00.000Z',
      crashAt: 'before_import',
    });
    invariant(!result.ok && result.reason === 'injected_crash:before_import', 'before_import_not_injected');
    invariant(existsSync(journalPath), 'prepared_journal_missing');
    invariant(readJournalState(journalPath) === 'prepared', 'journal_advanced_before_import');
    invariant(!existsSync(targetPath), 'target_written_before_import_boundary');
  });
}

function migrationReplayIdempotent(): void {
  withMigrationFixture(({ fixtureRoot, sourcePath, targetPath, journalPath }) => {
    const input = {
      fixtureRoot,
      sourcePath,
      targetPath,
      journalPath,
      journalKey: 'fixture-key',
      now: '2026-07-20T00:00:00.000Z',
    };
    const first = runSyntheticMigration(input);
    invariant(first.ok && first.reason === 'committed', 'initial_migration_not_committed');
    const before = readFileSync(targetPath, 'utf8');
    const replay = runSyntheticMigration({ ...input, now: '2026-07-20T00:01:00.000Z' });
    invariant(replay.ok && replay.reason === 'already_committed' && replay.replayed === true, 'committed_marker_reimported');
    invariant(readFileSync(targetPath, 'utf8') === before, 'replay_changed_target_bytes');
  });
}

function migrationTornJournalRejected(): void {
  withMigrationFixture(({ fixtureRoot, sourcePath, targetPath, journalPath }) => {
    writeFileSync(journalPath, '{"schemaVersion":1,"state":"prepared"', 'utf8');
    const result = runSyntheticMigration({
      fixtureRoot,
      sourcePath,
      targetPath,
      journalPath,
      journalKey: 'fixture-key',
      now: '2026-07-20T00:00:00.000Z',
    });
    invariant(!result.ok && result.reason === 'corrupt_journal', 'torn_journal_accepted');
    invariant(!existsSync(targetPath), 'target_written_from_torn_journal');
  });
}

function migrationLiveRootRefused(): void {
  withMigrationFixture(({ fixtureRoot, targetPath, journalPath }) => {
    const liveRoot = path.join(fixtureRoot, 'live-store');
    mkdirSync(liveRoot, { recursive: true });
    const liveSource = path.join(liveRoot, 'source.json');
    writeFileSync(liveSource, '{"live":true}\n', 'utf8');
    const result = runSyntheticMigration({
      fixtureRoot,
      sourcePath: liveSource,
      targetPath,
      journalPath,
      liveStoreRoots: [liveRoot],
      journalKey: 'fixture-key',
      now: '2026-07-20T00:00:00.000Z',
    });
    invariant(!result.ok && result.reason === 'foundation_live_import_forbidden', 'live_store_import_allowed');
    invariant(!existsSync(journalPath), 'journal_created_for_live_store');
    invariant(!existsSync(targetPath), 'target_created_from_live_store');
  });
}

async function main(): Promise<void> {
  const probeIndex = process.argv.indexOf('--probe');
  const probe = probeIndex >= 0 ? String(process.argv[probeIndex + 1] ?? '') : '';
  if (probe === 'scheduler-inert') schedulerInert();
  else if (probe === 'capture-secret-rejected') captureSecretRejected();
  else if (probe === 'schema-exact') schemaExact();
  else if (probe === 'preflight-fail-closed') preflightFailClosed();
  else if (probe === 'draft-rejected') draftRejected();
  else if (probe === 'missing-draft-rejected') await missingDraftRejected();
  else if (probe === 'pr-body-not-trusted') prBodyNotTrusted();
  else if (probe === 'binding-fail-closed') bindingFailClosed();
  else if (probe === 'cross-repo-rejected') await crossRepoRejected();
  else if (probe === 'config-fail-closed') configFailClosed();
  else if (probe === 'historical-journal-readable') historicalJournalReadable();
  else if (probe === 'migration-journal-key-required') migrationJournalKeyRequired();
  else if (probe === 'migration-prepare-before-effects') migrationPrepareBeforeEffects();
  else if (probe === 'migration-prepared-before-import') migrationPreparedBeforeImport();
  else if (probe === 'migration-replay-idempotent') migrationReplayIdempotent();
  else if (probe === 'migration-torn-rejected') migrationTornJournalRejected();
  else if (probe === 'migration-live-root-refused') migrationLiveRootRefused();
  else throw new Error(`unknown_behavior_fixture:${probe}`);
  process.stdout.write(`behavior-fixture:${probe}:passed\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
