import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalStoreId } from './worker-nudge-gate.ts';
import { workerNudgeClaimNamespace } from './worker-nudge-claim-store.ts';
import { readMigrationJournal, runSyntheticMigration } from './migration-journal.ts';
import { sendPackReviewWorkerNotification } from './worker-notification.ts';

const roots: string[] = [];
const originalEnv = { ...process.env };

function root(prefix: string): string {
  const value = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

afterEach(() => {
  process.env = { ...originalEnv };
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('[AC4/AC5] review 4750643719 regressions', () => {
  it('honors AO_WORKER_NUDGE_CLAIM_DIR through the canonical store-id namespace', () => {
    const base = root('opk-claim-namespace-');
    const override = path.join(base, 'Claim Store');
    mkdirSync(override, { recursive: true });
    process.env.AO_BASE_DIR = path.join(base, 'ao-base');
    process.env.AO_WORKER_NUDGE_CLAIM_DIR = override;
    expect(workerNudgeClaimNamespace('orchestrator-pack')).toBe(path.join(
      process.env.AO_BASE_DIR,
      'projects',
      'orchestrator-pack',
      'worker-nudge-claims',
      'by-store-id',
      canonicalStoreId(realpathSync(override)),
    ));
  });

  it.each([
    ['prepared', { importedDigest: undefined, importedAt: undefined, committedAt: undefined }],
    ['imported', { importedDigest: undefined, importedAt: '2026-07-20T00:01:00.000Z', committedAt: undefined }],
    ['committed', { importedDigest: 'sha256:x', importedAt: 'not-a-time', committedAt: '2026-07-20T00:02:00.000Z' }],
  ] as const)('fails closed for structurally malformed %s journals', (state, stateFields) => {
    const base = root('opk-malformed-journal-');
    const journal = path.join(base, 'journal.json');
    writeFileSync(journal, `${JSON.stringify({
      schemaVersion: 1,
      journalKey: 'fixture',
      sourcePath: state === 'prepared' ? undefined : path.join(base, 'source.json'),
      targetPath: path.join(base, 'target.json'),
      sourceDigest: 'sha256:source',
      archiveIdentity: 'sha256:archive',
      state,
      preparedAt: '2026-07-20T00:00:00.000Z',
      ...stateFields,
    })}\n`, 'utf8');
    expect(readMigrationJournal(journal)).toEqual({ ok: false, reason: 'corrupt_journal' });
  });

  it('returns corrupt_journal instead of throwing before migration identity comparison', () => {
    const base = root('opk-malformed-run-');
    const source = path.join(base, 'source.json');
    const journal = path.join(base, 'journal.json');
    writeFileSync(source, '{"fixture":true}\n', 'utf8');
    writeFileSync(journal, `${JSON.stringify({
      schemaVersion: 1,
      journalKey: 'fixture',
      sourceDigest: 'sha256:source',
      archiveIdentity: 'sha256:archive',
      state: 'prepared',
      preparedAt: '2026-07-20T00:00:00.000Z',
    })}\n`, 'utf8');
    expect(() => runSyntheticMigration({
      journalPath: journal,
      sourcePath: source,
      targetPath: path.join(base, 'target.json'),
      fixtureRoot: base,
      journalKey: 'fixture',
    })).not.toThrow();
    expect(runSyntheticMigration({
      journalPath: journal,
      sourcePath: source,
      targetPath: path.join(base, 'target.json'),
      fixtureRoot: base,
      journalKey: 'fixture',
    })).toEqual({ ok: false, reason: 'corrupt_journal' });
  });

  it.skipIf(process.platform === 'win32')(
    'keeps a successful multiline notification pending and persists reviewRunId',
    async () => {
      const base = root('opk-notification-journal-');
      const fakeAo = path.join(base, 'ao');
      const journal = path.join(base, 'dispatch-journal.json');
      writeFileSync(fakeAo, '#!/usr/bin/env node\nprocess.exit(0);\n', 'utf8');
      chmodSync(fakeAo, 0o755);
      Object.assign(process.env, {
        OPK_VITEST_HARNESS: '1',
        PACK_REVIEW_WORKER_NOTIFICATION_REAL_ADAPTER: '1',
        PACK_REVIEW_WORKER_NOTIFICATION_FIXTURE_TARGET: 'worker-923:worker-923',
        AO_SESSION_ID: 'orchestrator-surface',
        AO_BASE_DIR: path.join(base, 'ao-base'),
        AO_JOURNALED_SEND_ASSUME_CONTRACT: '1',
        AO_WORKER_MESSAGE_DISPATCH_JOURNAL: journal,
      });
      const head = 'a'.repeat(40);
      const runId = 'prr-review-4750643719';
      const key = `worker-notification:${runId}:${head}`;
      const message = [
        'Pack review completed for PR #923.',
        `Run: ${runId}`,
        `Head: ${head}`,
        'Verdict: findings',
        'Findings: 7',
        'Merge status: failure',
      ].join('\n');
      await expect(sendPackReviewWorkerNotification({
        trustedPackRoot: path.resolve('.'),
        sessionId: 'worker-923',
        request: { message, idempotencyKey: key, reviewRunId: runId },
        foundationConfig: {
          notification: {
            aoPath: fakeAo,
            timeoutMs: 5_000,
            maxJournalAttempts: 2,
            argvCeilingChars: 32_767,
          },
        },
      })).resolves.toMatchObject({ state: 'delivered', reason: 'explicit_send_dispatched' });
      const document = JSON.parse(readFileSync(journal, 'utf8')) as Record<string, Record<string, unknown>>;
      const record = Object.values(document).find((row) => row?.deterministicKey === key);
      expect(record).toMatchObject({
        reviewRunId: runId,
        deliveryPath: 'pending-draft',
        draftState: 'draft_present',
        dispatchOutcome: 'dispatched',
      });
    },
  );

  it('contains no live docs import or JSDoc edge to dormant terminalized TypeScript ports', () => {
    const docs = path.resolve('docs');
    const stack = [docs];
    const offenders: string[] = [];
    while (stack.length > 0) {
      const directory = stack.pop()!;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) stack.push(absolute);
        else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.mts')) {
          const lines = readFileSync(absolute, 'utf8').split(/\r?\n/)
            .filter((line) => !line.startsWith('// Issue #923 foundation-terminalized:'));
          if (lines.join('\n').includes('scripts/pr2-foundation/terminalized')) {
            offenders.push(path.relative(path.resolve('.'), absolute).replace(/\\/g, '/'));
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
