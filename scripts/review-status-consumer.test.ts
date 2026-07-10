import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findLatestAcceptedReadyForReviewAcrossSessions } from '../docs/review-ready-report-state-seed.mjs';
import { evaluateHeadReadyForReview } from '../docs/review-head-ready.mjs';
import { planReconcileActions, unwrapReconcilePlanResult } from '../docs/review-trigger-reconcile.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = path.join(repoRoot, 'scripts/lib/Invoke-AoCliJson.ps1');
const fixtureDir = path.join(repoRoot, 'tests/fixtures/review-status-consumer');

function runPwsh(script: string) {
  return execFileSync('pwsh', ['-NoProfile', '-Command', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf8')) as T;
}

describe('review-status consumer readers (Issue #611)', () => {
  it('decorates report-full payload sessions with reportSourcePath', () => {
    const fixture = loadJson<{ reportFull: Record<string, unknown> }>('live-head-binding-eligible.json');
    const payloadPath = path.join(fixtureDir, '_tmp-live-head.json');
    writeFileSync(payloadPath, JSON.stringify(fixture.reportFull));
    const out = runPwsh(`
      . '${lib}'
      $rows = Get-AoStatusSessionsWithReports -ReportFullPayload (Get-Content '${payloadPath}' -Raw | ConvertFrom-Json)
      $rows | ConvertTo-Json -Compress -Depth 20
    `).trim();
    const rows = JSON.parse(out) as Array<{ name: string; reportSourcePath?: string; reports?: unknown[] }>;
    const list = Array.isArray(rows) ? rows : [rows];
    expect(list[0]?.reportSourcePath).toMatch(/\$\.data\[\?name==/);
    expect(list[0]?.reports?.length).toBeGreaterThan(0);
  });

  it('AC#2: report-full snapshot exposes ready_for_review when plain status rows are empty', () => {
    const fixture = loadJson<{
      plainStatus: { data: Array<Record<string, unknown>> };
      reportFull: { data: Array<Record<string, unknown>> };
    }>('plain-empty-vs-report-full.json');

    const plainSessions = fixture.plainStatus.data;
    const plainReady = findLatestAcceptedReadyForReviewAcrossSessions(plainSessions as never);
    expect(plainReady.report).toBeNull();

    const payloadPath = path.join(fixtureDir, '_tmp-plain-vs-full.json');
    writeFileSync(payloadPath, JSON.stringify(fixture.reportFull));
    const out = runPwsh(`
      . '${lib}'
      $rows = Get-AoStatusSessionsWithReports -ReportFullPayload (Get-Content '${payloadPath}' -Raw | ConvertFrom-Json)
      $rows | ConvertTo-Json -Compress -Depth 20
    `).trim();
    const reportFullSessions = JSON.parse(out) as Array<Record<string, unknown>>;
    const list = Array.isArray(reportFullSessions) ? reportFullSessions : [reportFullSessions];
    const ready = findLatestAcceptedReadyForReviewAcrossSessions(list as never);
    expect(ready.report?.reportState).toBe('ready_for_review');
  });

  it('AC#3: resolves workers from $.data[] without $.sessions', () => {
    const fixture = loadJson<{ reportFull: { data: unknown[]; sessions?: unknown }; expectedJsonPath: string }>(
      'data-array-no-sessions.json',
    );
    expect(fixture.reportFull.sessions).toBeUndefined();
    const payloadPath = path.join(fixtureDir, '_tmp-data-array.json');
    writeFileSync(payloadPath, JSON.stringify(fixture.reportFull));
    const out = runPwsh(`
      . '${lib}'
      $rows = Get-AoStatusSessionsWithReports -ReportFullPayload (Get-Content '${payloadPath}' -Raw | ConvertFrom-Json)
      $rows | ConvertTo-Json -Compress -Depth 20
    `).trim();
    const rows = JSON.parse(out) as Array<{ name: string; reports?: Array<{ reportState: string }> }>;
    const list = Array.isArray(rows) ? rows : [rows];
    expect(list.some((row) => row.name === 'opk-142')).toBe(true);
    expect(list[0]?.reports?.[0]?.reportState).toBe('ready_for_review');
  });

  it('AC#5: prefix-safe Invoke-AoCliJson tolerates notifier lines before JSON', () => {
    const fixture = loadJson<{ rawCliOutput: string }>('notifier-prefixed-report-full.txt');
    const rawPath = path.join(fixtureDir, '_tmp-notifier-prefix.txt');
    writeFileSync(rawPath, fixture.rawCliOutput);
    const out = runPwsh(
      [
        ". '" + lib + "'",
        "$text = Get-Content -LiteralPath '" + rawPath + "' -Raw",
        "$payload = ConvertFrom-AoCliPrefixedOutput -Text $text -FailureLabel 'ao status --reports full'",
        "$rows = Get-AoStatusSessionsWithReportsFromPayload -Payload $payload -SourceKind 'cli-report-full'",
        "(@($rows | Where-Object { $_.name -eq 'opk-611' -or $_.id -eq 'opk-611' }).reports).Count",
      ].join('\n'),
    ).trim();
    expect(Number(out)).toBe(1);
  });

  it('AC#8: classified parse failure when JSON after prefix strip is malformed', () => {
    const rawPath = path.join(fixtureDir, '_tmp-malformed-prefix.txt');
    writeFileSync(rawPath, "[notifier] broken\n{not-json");
    expect(() =>
      runPwsh(
        [
          ". '" + lib + "'",
          "$text = Get-Content -LiteralPath '" + rawPath + "' -Raw",
          "ConvertFrom-AoCliPrefixedOutput -Text $text -FailureLabel 'ao status --reports full' | Out-Null",
        ].join('\n'),
      ),
    ).toThrow(/ao status --reports full parse failed/i);
  });

  it('AC#7: live head-binding path is review-start eligible via report-full reader sessions', () => {
    const fixture = loadJson<{
      reportFull: { data: unknown[] };
      openPrs: unknown[];
      reviewRuns: unknown[];
      ciChecksByPr: Record<string, unknown>;
      requiredCheckNamesByPr: Record<string, string[]>;
      expectWouldRun: boolean;
    }>('live-head-binding-eligible.json');
    const payloadPath = path.join(fixtureDir, '_tmp-head-binding.json');
    writeFileSync(payloadPath, JSON.stringify(fixture.reportFull));
    const out = runPwsh(`
      . '${lib}'
      $rows = Get-AoStatusSessionsWithReports -ReportFullPayload (Get-Content '${payloadPath}' -Raw | ConvertFrom-Json)
      $rows | ConvertTo-Json -Compress -Depth 20
    `).trim();
    const sessions = JSON.parse(out) as Array<Record<string, unknown>>;
    const list = Array.isArray(sessions) ? sessions : [sessions];
    const result = unwrapReconcilePlanResult(
      planReconcileActions({
        openPrs: fixture.openPrs as never,
        reviewRuns: fixture.reviewRuns as never,
        sessions: list as never,
        ciChecksByPr: fixture.ciChecksByPr as never,
        requiredCheckNamesByPr: fixture.requiredCheckNamesByPr,
        requiredCheckLookupFailedByPr: {},
        nowMs: Date.parse('2026-07-05T15:00:00.000Z'),
      }),
    );
    expect(result.actions.some((action) => action.type === 'start_review')).toBe(fixture.expectWouldRun);
  });

  it('AC#8: stale ready_for_review on older head does not authorize current head', () => {
    const fixture = loadJson<{
      reportFull: { data: unknown[] };
      openPrs: Array<{ number: number; headRefOid: string }>;
      reviewRuns: unknown[];
      ciChecksByPr: Record<string, unknown>;
      requiredCheckNamesByPr: Record<string, string[]>;
    }>('stale-ready-older-head.json');
    const payloadPath = path.join(fixtureDir, '_tmp-stale-head.json');
    writeFileSync(payloadPath, JSON.stringify(fixture.reportFull));
    const out = runPwsh(`
      . '${lib}'
      $rows = Get-AoStatusSessionsWithReports -ReportFullPayload (Get-Content '${payloadPath}' -Raw | ConvertFrom-Json)
      $rows | ConvertTo-Json -Compress -Depth 20
    `).trim();
    const sessions = JSON.parse(out) as Array<Record<string, unknown>>;
    const session = (Array.isArray(sessions) ? sessions : [sessions])[0]!;
    const decision = evaluateHeadReadyForReview({
      reviewRuns: [],
      prNumber: fixture.openPrs[0]!.number,
      headSha: fixture.openPrs[0]!.headRefOid,
      session: session as never,
      ciChecks: fixture.ciChecksByPr['611'] as never,
      requiredCheckNames: fixture.requiredCheckNamesByPr['611'],
      requiredCheckLookupFailed: false,
      nowMs: Date.parse('2026-07-05T14:18:00.000Z'),
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).not.toBe('head_ready_for_review');
  });

  it('pack-store fallback attaches reports from worker-report-store JSON', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'ao-pack-store-717-'));
    const stateDir = path.join(tempRoot, 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, 'worker-report-store.json'), JSON.stringify({
      schemaVersion: 1,
      generation: 1,
      lastUpdatedMs: Date.parse('2026-07-05T14:17:58.000Z'),
      records: {
        'orchestrator-pack|opk-audit-611|611|abc611': {
          reportState: 'ready_for_review',
          accepted: true,
          repoSlug: 'orchestrator-pack',
          sessionId: 'opk-audit-611',
          prNumber: 611,
          headSha: 'abc611',
          reportedAtMs: Date.parse('2026-07-05T14:17:58.000Z'),
          reportedAt: '2026-07-05T14:17:58.000Z',
          updatedAtMs: Date.parse('2026-07-05T14:17:58.000Z'),
          updatedAt: '2026-07-05T14:17:58.000Z',
        },
      },
    }));

    const workerPayload = {
      data: [
        {
          id: 'opk-audit-611',
          name: 'opk-audit-611',
          projectId: 'orchestrator-pack',
          role: 'worker',
          status: 'idle',
          isTerminated: false,
        },
      ],
    };
    const orchPayload = { data: [] as unknown[] };
    const workerPath = path.join(tempRoot, 'worker.json');
    const orchPath = path.join(tempRoot, 'orch.json');
    writeFileSync(workerPath, JSON.stringify(workerPayload));
    writeFileSync(orchPath, JSON.stringify(orchPayload));

    const out = runPwsh(
      [
        "$env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR = '" + stateDir.replace(/'/g, "''") + "'",
        ". '" + lib + "'",
        "$rows = Get-AoStatusSessionsWithReports -Project 'orchestrator-pack' -RepoSlug 'orchestrator-pack' `",
        "  -WorkerListPayload (Get-Content '" + workerPath + "' -Raw | ConvertFrom-Json) `",
        "  -OrchestratorListPayload (Get-Content '" + orchPath + "' -Raw | ConvertFrom-Json)",
        '$rows | ConvertTo-Json -Compress -Depth 20',
      ].join('\n'),
    ).trim();
    const rows = JSON.parse(out) as Array<{
      reports?: Array<{ reportState: string }>;
      reportSnapshotKind?: string;
      reportSourcePath?: string;
    }>;
    const list = Array.isArray(rows) ? rows : [rows];
    expect(list[0]?.reportSnapshotKind).toBe('pack-worker-report-store');
    expect(list[0]?.reports?.[0]?.reportState).toBe('ready_for_review');
    expect(list[0]?.reportSourcePath).toMatch(/pack-worker-report-store/);
  });

  it('pack-store merge resolves repo slug when callers omit -RepoSlug', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'ao-pack-store-slug-717-'));
    const stateDir = path.join(tempRoot, 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, 'worker-report-store.json'), JSON.stringify({
      schemaVersion: 1,
      generation: 1,
      lastUpdatedMs: Date.parse('2026-07-05T14:17:58.000Z'),
      records: {
        'chetwerikoff/orchestrator-pack|opk-slug-717|717|abc717': {
          reportState: 'ready_for_review',
          accepted: true,
          repoSlug: 'chetwerikoff/orchestrator-pack',
          sessionId: 'opk-slug-717',
          prNumber: 717,
          headSha: 'abc717',
          reportedAtMs: Date.parse('2026-07-05T14:17:58.000Z'),
          reportedAt: '2026-07-05T14:17:58.000Z',
          updatedAtMs: Date.parse('2026-07-05T14:17:58.000Z'),
          updatedAt: '2026-07-05T14:17:58.000Z',
        },
      },
    }));

    const workerPayload = {
      data: [
        {
          id: 'opk-slug-717',
          name: 'opk-slug-717',
          projectId: 'orchestrator-pack',
          role: 'worker',
          status: 'idle',
          isTerminated: false,
        },
      ],
    };
    const workerPath = path.join(tempRoot, 'worker.json');
    const orchPath = path.join(tempRoot, 'orch.json');
    writeFileSync(workerPath, JSON.stringify(workerPayload));
    writeFileSync(orchPath, JSON.stringify({ data: [] as unknown[] }));

    const out = runPwsh(
      [
        "$env:ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR = '" + stateDir.replace(/'/g, "''") + "'",
        "Remove-Item Env:GITHUB_REPOSITORY -ErrorAction SilentlyContinue",
        "Remove-Item Env:AO_REPO_SLUG -ErrorAction SilentlyContinue",
        ". '" + lib + "'",
        "$rows = Get-AoStatusSessionsWithReports -Project 'orchestrator-pack' `",
        "  -WorkerListPayload (Get-Content '" + workerPath + "' -Raw | ConvertFrom-Json) `",
        "  -OrchestratorListPayload (Get-Content '" + orchPath + "' -Raw | ConvertFrom-Json)",
        '$rows | ConvertTo-Json -Compress -Depth 20',
      ].join('\n'),
    ).trim();
    const rows = JSON.parse(out) as Array<{ reports?: Array<{ reportState: string }> }>;
    const list = Array.isArray(rows) ? rows : [rows];
    expect(list[0]?.reports?.[0]?.reportState).toBe('ready_for_review');
  });
});
