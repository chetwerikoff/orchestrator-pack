import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatReportReceiptSurfaceRemovedLog } from '../docs/events-optional-consumer-signal-recovery.mjs';
import { isDeliveryConfirmed } from '../docs/review-finding-delivery-confirm.mjs';
import { findLatestAcceptedReadyForReviewAcrossSessions } from '../docs/review-ready-report-state-seed.mjs';
import {
  PACK_WORKER_REPORT_STORE_SURFACE,
  buildWorkerReportRecordKey,
  createDefaultWorkerReportStore,
  evictWorkerReportRecords,
  findPackWorkerAckReportAfterDelivery,
  mergePackWorkerReportsIntoSessions,
  migrateLegacySeedStateToWorkerReportStore,
  seedShouldPromoteReadyForReview,
  validateWorkerReportTrustBoundary,
  writeWorkerReportRecordWithCas,
} from '../docs/worker-report-store.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerStoreLib = path.join(repoRoot, 'scripts/lib/WorkerReportStore.ps1');
const aoCliLib = path.join(repoRoot, 'scripts/lib/Invoke-AoCliJson.ps1');
const seedLib = path.join(repoRoot, 'scripts/lib/Invoke-ReviewReadyReportStateSeed.ps1');

function runPwsh(script: string) {
  return execFileSync('pwsh', ['-NoProfile', '-Command', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

describe('worker-report-store-write', () => {
  it('pack command writes ready_for_review into durable JSON store', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wr-store-write-'));
    const storePath = path.join(dir, 'worker-report-store.json');
    const result = writeWorkerReportRecordWithCas({
      storePath,
      callerSessionId: 'opk-717',
      nowMs: Date.parse('2026-07-09T12:00:00.000Z'),
      record: {
        reportState: 'ready_for_review',
        accepted: true,
        repoSlug: 'chetwerikoff/orchestrator-pack',
        sessionId: 'opk-717',
        prNumber: 717,
        headSha: 'abc123',
      },
    });
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(readFileSync(storePath, 'utf8'));
    const key = buildWorkerReportRecordKey({
      repoSlug: 'chetwerikoff/orchestrator-pack',
      sessionId: 'opk-717',
      prNumber: 717,
      headSha: 'abc123',
    });
    expect(parsed.sourceRecords[key].reportState).toBe('ready_for_review');
  });

  it('Write-PackWorkerReportRecord uses locked read-modify-write without dropping prior records', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wr-store-locked-'));
    const storePath = path.join(dir, 'worker-report-store.json');
    const lib = workerStoreLib.replace(/'/g, "''");
    const escapedPath = storePath.replace(/'/g, "''");
    runPwsh(`
      . '${lib}'
      $env:AO_WORKER_REPORT_STORE = '${escapedPath}'
      Write-PackWorkerReportRecord -ReportState 'working' -SessionId 'opk-a' -RepoSlug 'org/a' -PrNumber 1 -HeadSha 'head1' -NowMs 1000 | Out-Null
      Write-PackWorkerReportRecord -ReportState 'ready_for_review' -SessionId 'opk-b' -RepoSlug 'org/a' -PrNumber 2 -HeadSha 'head2' -NowMs 2000 | Out-Null
    `);
    const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as WorkerReportStoreState & { generation?: number };
    expect(Object.keys(parsed.sourceRecords ?? {})).toHaveLength(2);
    expect(Number(parsed.generation ?? 0)).toBeGreaterThanOrEqual(2);
  });
});

describe('review-ready-report-state-seed-pack-source', () => {
  it('seed consumer path merges pack store without report-audit readers', () => {
    const seedRaw = readFileSync(seedLib, 'utf8');
    expect(seedRaw).not.toMatch(/Get-AoAgentReportAuditDir|Merge-AoSessionRowsWithReportAudit|Get-AoStatusReportsJson/);
    const aoCliRaw = readFileSync(aoCliLib, 'utf8');
    expect(aoCliRaw).not.toMatch(/Get-AoAgentReportAuditDir|Merge-AoSessionRowsWithReportAudit/);
    expect(aoCliRaw).toMatch(/Merge-AoSessionRowsWithWorkerReportStore/);

    const store = createDefaultWorkerReportStore();
    store.sourceRecords['org/a|opk-seed|42|deadbeef'] = {
      reportState: 'ready_for_review',
      accepted: true,
      repoSlug: 'org/a',
      sessionId: 'opk-seed',
      prNumber: 42,
      headSha: 'deadbeef',
      reportedAtMs: Date.parse('2026-07-09T12:00:00.000Z'),
    };
    const sessions = mergePackWorkerReportsIntoSessions(
      [{ id: 'opk-seed', name: 'opk-seed', role: 'worker' }],
      store,
      'org/a',
    );
    const ready = findLatestAcceptedReadyForReviewAcrossSessions(sessions as never);
    expect(ready.report?.reportState).toBe('ready_for_review');
    expect(seedRaw).toMatch(/Invoke-WorkerReportStoreEviction/);
    expect(seedRaw).toMatch(/Invoke-GhOpenPrList.*review-ready-report-state-seed-eviction/s);
    expect(seedRaw).toMatch(/Build-WorkerReportStoreCurrentHeadByPr/);
  });
});

describe('delivery-confirm-pack-ack', () => {
  it('credits addressing_reviews after delivery and rejects unrelated states', () => {
    const sendMs = Date.parse('2026-07-09T12:00:00.000Z');
    const session = {
      id: 'opk-dc',
      name: 'opk-dc',
      role: 'worker',
      prNumber: 717,
      reportSnapshotKind: PACK_WORKER_REPORT_STORE_SURFACE,
      reports: [
        {
          reportState: 'ready_for_review',
          reportedAt: '2026-07-09T12:05:00.000Z',
          headSha: 'abc',
        },
        {
          reportState: 'addressing_reviews',
          reportedAt: '2026-07-09T12:10:00.000Z',
          headSha: 'abc',
        },
      ],
    };
    const run = { id: 'run-1', linkedSessionId: 'opk-dc', prNumber: 717, targetSha: 'abc' };
    const openPrs = [{ number: 717, headRefOid: 'abc' }];
    expect(findPackWorkerAckReportAfterDelivery(session, run, sendMs)?.reportState).toBe(
      'addressing_reviews',
    );
    expect(
      isDeliveryConfirmed(
        run as never,
        [session] as never,
        sendMs,
        [run] as never,
        { runs: {} },
        openPrs as never,
      ),
    ).toBe(true);
    const badSession = {
      ...session,
      reports: [{ reportState: 'fixing_ci', reportedAt: '2026-07-09T12:10:00.000Z', headSha: 'abc' }],
    };
    expect(
      isDeliveryConfirmed(
        run as never,
        [badSession] as never,
        sendMs,
        [run] as never,
        { runs: {} },
        [],
      ),
    ).toBe(false);
  });
});

describe('events-optional-consumer-signal-recovery', () => {
  it('report_receipt_surface_removed followup names pack-worker-report-store', () => {
    expect(formatReportReceiptSurfaceRemovedLog('review-finding-delivery-confirm')).toMatch(
      /report_receipt_surface_removed surface=review-finding-delivery-confirm followup=pack-worker-report-store/,
    );
  });
});

describe('worker-report-store-eviction', () => {
  it('evicts terminal PR records and prevents unbounded growth', () => {
    const store = createDefaultWorkerReportStore();
    const nowMs = Date.parse('2026-07-09T12:00:00.000Z');
    for (let i = 0; i < 20; i += 1) {
      store.sourceRecords[`org/a|s${i}|${100 + i}|head${i}`] = {
        reportState: 'ready_for_review',
        accepted: true,
        repoSlug: 'org/a',
        sessionId: `s${i}`,
        prNumber: 100 + i,
        headSha: `head${i}`,
        reportedAtMs: nowMs - 86_400_000,
        lastObservedMs: nowMs - 86_400_000,
      };
    }
    const result = evictWorkerReportRecords({
      store,
      openPrs: [{ number: 100, state: 'closed' }],
      currentHeadByPr: { 'org/a|101': 'newhead' },
      nowMs,
      maxAgeMs: 1_000,
      nonterminalMaxAgeMs: 1_000,
      openListAuthoritative: true,
    });
    expect(result.removed).toBeGreaterThan(0);
    expect(result.recordCount).toBeLessThan(20);
  });

  it('preserves records for open PRs missing from a session-scoped open list', () => {
    const store = createDefaultWorkerReportStore() as WorkerReportStoreState;
    const nowMs = Date.parse('2026-07-09T12:00:00.000Z');
    store.sourceRecords['org/a|dead-worker|42|abc42'] = {
      reportState: 'ready_for_review',
      accepted: true,
      repoSlug: 'org/a',
      sessionId: 'dead-worker',
      prNumber: 42,
      headSha: 'abc42',
      reportedAtMs: nowMs,
      lastObservedMs: nowMs,
    };
    const result = evictWorkerReportRecords({
      store,
      openPrs: [{ number: 99, state: 'open', headRefOid: 'head99' }],
      nowMs,
      openListAuthoritative: false,
    });
    expect(result.removed).toBe(0);
    expect(store.sourceRecords['org/a|dead-worker|42|abc42']).toBeTruthy();
  });
  it('scopes authoritative eviction to the supervised repository', () => {
    const store = createDefaultWorkerReportStore() as WorkerReportStoreState;
    const nowMs = Date.parse('2026-07-09T12:00:00.000Z');
    store.sourceRecords['org/a|a-worker|42|abc42'] = {
      reportState: 'ready_for_review',
      accepted: true,
      repoSlug: 'org/a',
      sessionId: 'a-worker',
      prNumber: 42,
      headSha: 'abc42',
      reportedAtMs: nowMs,
      lastObservedMs: nowMs,
    };
    store.sourceRecords['org/b|b-worker|42|def42'] = {
      reportState: 'ready_for_review',
      accepted: true,
      repoSlug: 'org/b',
      sessionId: 'b-worker',
      prNumber: 42,
      headSha: 'def42',
      reportedAtMs: nowMs,
      lastObservedMs: nowMs,
    };
    const result = evictWorkerReportRecords({
      store,
      openPrs: [{ number: 99, state: 'open', headRefOid: 'head99' }],
      nowMs,
      openListAuthoritative: true,
      repoSlug: 'org/a',
    });
    expect(result.removed).toBe(1);
    expect(store.sourceRecords['org/a|a-worker|42|abc42']).toBeUndefined();
    expect(store.sourceRecords['org/b|b-worker|42|def42']).toBeTruthy();
  });

  it('does not treat another repo closed PR as terminal for scoped records', () => {
    const store = createDefaultWorkerReportStore() as WorkerReportStoreState;
    const nowMs = Date.parse('2026-07-09T12:00:00.000Z');
    store.sourceRecords['org/b|b-worker|1|head1'] = {
      reportState: 'working',
      accepted: true,
      repoSlug: 'org/b',
      sessionId: 'b-worker',
      prNumber: 1,
      headSha: 'head1',
      reportedAtMs: nowMs,
      lastObservedMs: nowMs,
    };
    const result = evictWorkerReportRecords({
      store,
      openPrs: [{ number: 1, state: 'closed' }],
      nowMs,
      maxAgeMs: 86_400_000,
      nonterminalMaxAgeMs: 86_400_000,
      openListAuthoritative: true,
      repoSlug: 'org/a',
    });
    expect(result.removed).toBe(0);
    expect(store.sourceRecords['org/b|b-worker|1|head1']).toBeTruthy();
  });

});

describe('worker-report-store-superseded-head', () => {
  it('seed promotion rejects superseded head', () => {
    const store = createDefaultWorkerReportStore();
    store.sourceRecords['org/a|opk|1|headA'] = {
      reportState: 'ready_for_review',
      accepted: true,
      repoSlug: 'org/a',
      sessionId: 'opk',
      prNumber: 1,
      headSha: 'headA',
    };
    const decision = seedShouldPromoteReadyForReview(store, 'org/a', 1, 'headA', 'headB');
    expect(decision.promote).toBe(false);
  });
});

describe('worker-report-store-schema-migration', () => {
  it('migrates legacy seed state without losing bindings', () => {
    const migrated = migrateLegacySeedStateToWorkerReportStore({
      bindingByKey: { 'org/a|12': { prNumber: 12 } },
      seededKeys: ['k1'],
      deferredScanKeys: ['d1'],
      githubSnapshot: { openPrCount: 1 },
      lastUpdatedMs: 1,
    });
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.bindingByKey['org/a|12']).toEqual({ prNumber: 12 });
    expect(migrated.seededKeys).toEqual(['k1']);
  });
});

describe('worker-report-store-concurrency', () => {
  it('CAS generation rejects stale writers', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wr-cas-'));
    const storePath = path.join(dir, 'worker-report-store.json');
    writeWorkerReportRecordWithCas({
      storePath,
      callerSessionId: 'opk-a',
      nowMs: 1,
      record: {
        reportState: 'working',
        repoSlug: 'org/a',
        sessionId: 'opk-a',
        prNumber: 1,
        headSha: 'h1',
      },
    });
    const stale = writeWorkerReportRecordWithCas({
      storePath,
      callerSessionId: 'opk-a',
      nowMs: 2,
      expectedGeneration: 0,
      record: {
        reportState: 'ready_for_review',
        repoSlug: 'org/a',
        sessionId: 'opk-a',
        prNumber: 1,
        headSha: 'h1',
      },
    });
    expect(stale.ok).toBe(false);
  });
});

describe('worker-report-store-trust-boundary', () => {
  it('rejects cross-session report writes', () => {
    const trust = validateWorkerReportTrustBoundary({
      callerSessionId: 'worker-a',
      record: {
        reportState: 'ready_for_review',
        repoSlug: 'org/a',
        sessionId: 'worker-b',
        prNumber: 1,
        headSha: 'abc',
      },
    });
    expect(trust.ok).toBe(false);
  });
});

describe('worker-report-store-nonterminal-ttl', () => {
  it('evicts stale open-PR records after maxAgeMs', () => {
    const store = createDefaultWorkerReportStore();
    store.sourceRecords['org/a|opk|9|head9'] = {
      reportState: 'working',
      accepted: true,
      repoSlug: 'org/a',
      sessionId: 'opk',
      prNumber: 9,
      headSha: 'head9',
      lastObservedMs: Date.parse('2026-01-01T00:00:00.000Z'),
    };
    const result = evictWorkerReportRecords({
      store,
      openPrs: [{ number: 9, state: 'open', headRefOid: 'head9' }],
      nowMs: Date.parse('2026-07-09T00:00:00.000Z'),
      nonterminalMaxAgeMs: 1_000,
    });
    expect(result.removed).toBe(1);
  });
});

describe('worker-report-store-cross-repo', () => {
  it('repo A records do not attach to repo B sessions', () => {
    const store = createDefaultWorkerReportStore();
    store.sourceRecords['org/a|opk|1|h1'] = {
      reportState: 'ready_for_review',
      accepted: true,
      repoSlug: 'org/a',
      sessionId: 'opk',
      prNumber: 1,
      headSha: 'h1',
    };
    const sessions = mergePackWorkerReportsIntoSessions(
      [{ id: 'opk', name: 'opk' }],
      store,
      'org/b',
    );
    expect(sessions[0]?.reports ?? []).toHaveLength(0);
  });
});


describe('worker-report-store-blocked-state', () => {
  it('accepts blocked as a valid report state', () => {
    const trust = validateWorkerReportTrustBoundary({
      callerSessionId: 'opk-blocked',
      record: {
        reportState: 'blocked',
        repoSlug: 'org/a',
        sessionId: 'opk-blocked',
        prNumber: 717,
        headSha: 'abc717',
      },
    });
    expect(trust.ok).toBe(true);
  });
});


describe('worker-report-store-discovery-candidates', () => {
  it('Get-PackWorkerReportDiscoveryCandidates filters by repo slug', () => {
    const out = runPwsh(`
      . 'scripts/lib/WorkerReportStore.ps1'
      $storePath = Join-Path ([System.IO.Path]::GetTempPath()) ('wr-discovery-' + [guid]::NewGuid().ToString())
      $dir = Split-Path -Parent $storePath
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      $env:AO_WORKER_REPORT_STORE = $storePath
      @'
{
  "schemaVersion": 2,
  "generation": 1,
  "lastUpdatedMs": 1,
  "sourceRecords": {
    "org/a|opk-a|1|h1": {"reportState":"working","accepted":true,"repoSlug":"org/a","sessionId":"opk-a","prNumber":1,"headSha":"h1"},
    "org/b|opk-b|2|h2": {"reportState":"working","accepted":true,"repoSlug":"org/b","sessionId":"opk-b","prNumber":2,"headSha":"h2"}
  }
}
'@ | Set-Content -LiteralPath $storePath -Encoding utf8
      $rows = Get-PackWorkerReportDiscoveryCandidates -RepoSlug 'org/a'
      $rows | ConvertTo-Json -Compress -Depth 5
    `).trim();
    const rows = JSON.parse(out) as Array<{ sessionId: string; prNumber: number }>;
    const list = Array.isArray(rows) ? rows : [rows];
    expect(list).toHaveLength(1);
    expect(list[0]?.sessionId).toBe('opk-a');
    expect(list[0]?.prNumber).toBe(1);
  });
});

describe('worker-report-store DROP proof helpers', () => {
  it('Invoke-AoCliJson has no report-audit bind', () => {
    const raw = readFileSync(aoCliLib, 'utf8');
    expect(raw).not.toMatch(/Get-AoAgentReportAuditDir|Merge-AoSessionRowsWithReportAudit|Get-AoStatusReportsJson/);
  });

  it('pack-worker-report wrapper delegates to PowerShell command', () => {
    const out = runPwsh(`
      $env:AO_SESSION_ID = 'opk-cli'
      $env:AO_PR_NUMBER = '717'
      $env:GITHUB_REPOSITORY = 'chetwerikoff/orchestrator-pack'
      & '${path.join(repoRoot, 'scripts/pack-worker-report.ps1').replace(/'/g, "''")}' ready_for_review -RepoRoot '${repoRoot.replace(/'/g, "''")}' -DryRun
    `).trim();
    expect(out).toContain('ready_for_review');
  });

  it('pack-worker-report wrapper forwards explicit binding flags', () => {
    const wrapper = path.join(repoRoot, 'scripts/pack-worker-report');
    const out = execFileSync(
      wrapper,
      [
        '--state',
        'ready_for_review',
        '-SessionId',
        'opk-wrapper-717',
        '-RepoSlug',
        'chetwerikoff/orchestrator-pack',
        '-PrNumber',
        '717',
        '-HeadSha',
        'abc717wrapper',
        '-DryRun',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          AO_SESSION_ID: '',
          AO_WORKER_SESSION_ID: '',
          AO_PR_NUMBER: '',
          GITHUB_REPOSITORY: '',
          AO_REPO_SLUG: '',
          AO_HEAD_SHA: '',
          GITHUB_SHA: '',
        },
      },
    ).trim();
    expect(out).toContain('ready_for_review');
    expect(out).toContain('opk-wrapper-717');
  });
});
