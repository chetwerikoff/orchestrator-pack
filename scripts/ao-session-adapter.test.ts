import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = path.join(repoRoot, 'scripts/lib/Invoke-AoCliJson.ps1');
const capturesRoot = path.join(repoRoot, 'tests/external-output-references/captures/ao-0-10-cli');
const sessionLsCapture = path.join(capturesRoot, 'session-ls.raw.json');
const sessionLsTerminatedCapture = path.join(capturesRoot, 'session-ls-terminated.raw.json');
const orchestratorLsCapture = path.join(capturesRoot, 'orchestrator-ls.raw.json');

function runPwsh(script: string) {
  return execFileSync('pwsh', ['-NoProfile', '-Command', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

function loadCapture(name: string) {
  return JSON.parse(readFileSync(path.join(capturesRoot, name), 'utf8'));
}

describe('Invoke-AoCliJson AO 0.10 session adapter (Issue #619)', () => {
  it('merges worker and orchestrator rows from capture payloads', () => {
    const workerPayload = loadCapture('session-ls.raw.json');
    const orchPayload = loadCapture('orchestrator-ls.raw.json');
    const out = runPwsh(`
      . '${lib}'
      $rows = Get-AoStatusSessions -Project 'orchestrator-pack' -WorkerListPayload (Get-Content '${sessionLsCapture}' -Raw | ConvertFrom-Json) -OrchestratorListPayload (Get-Content '${orchestratorLsCapture}' -Raw | ConvertFrom-Json)
      $rows | ConvertTo-Json -Compress -Depth 6
    `).trim();
    const rows = JSON.parse(out) as Array<{ id: string; role: string; projectId: string }>;
    const list = Array.isArray(rows) ? rows : [rows];
    expect(list.some((r) => r.role === 'worker' && r.id === 'orchestrator-pack-7')).toBe(true);
    expect(list.some((r) => r.role === 'orchestrator' && r.id === 'orchestrator-pack-5')).toBe(true);
    expect(list.some((r) => r.projectId === 'other-project')).toBe(false);
    expect(workerPayload).toBeTruthy();
    expect(orchPayload).toBeTruthy();
  });

  it('includes terminated orchestrator rows in terminated-inclusive merge', () => {
    const out = runPwsh(`
      . '${lib}'
      $rows = Get-AoStatusSessionsIncludingTerminated -Project 'orchestrator-pack' -WorkerListPayload (Get-Content '${sessionLsTerminatedCapture}' -Raw | ConvertFrom-Json) -OrchestratorListPayload (Get-Content '${orchestratorLsCapture}' -Raw | ConvertFrom-Json)
      $rows | ConvertTo-Json -Compress -Depth 6
    `).trim();
    const rows = JSON.parse(out) as Array<{ id: string; isTerminated: boolean }>;
    const list = Array.isArray(rows) ? rows : [rows];
    expect(list.some((r) => r.id === 'orchestrator-pack-1' && r.isTerminated === true)).toBe(true);
  });

  it('fails loud on duplicate ids across worker and orchestrator lists', () => {
    expect(() => runPwsh(`
      . '${lib}'
      $worker = [pscustomobject]@{ data = @([pscustomobject]@{ id='dup'; projectId='orchestrator-pack'; role='worker'; status='working'; isTerminated=$false }) }
      $orch = [pscustomobject]@{ data = @([pscustomobject]@{ id='dup'; projectId='orchestrator-pack'; role='orchestrator'; status='idle'; isTerminated=$false }) }
      Get-AoStatusSessions -Project 'orchestrator-pack' -WorkerListPayload $worker -OrchestratorListPayload $orch | Out-Null
    `)).toThrow();
  });

  it('fails loud on malformed rows missing id', () => {
    expect(() => runPwsh(`
      . '${lib}'
      $worker = [pscustomobject]@{ data = @([pscustomobject]@{ projectId='orchestrator-pack'; role='worker'; status='working'; isTerminated=$false }) }
      $orch = [pscustomobject]@{ data = @() }
      Get-AoStatusSessions -Project 'orchestrator-pack' -WorkerListPayload $worker -OrchestratorListPayload $orch | Out-Null
    `)).toThrow(/missing non-empty id/);
  });

  it('throws classified error for report-surface entry points', () => {
    expect(() => runPwsh(`
      . '${lib}'
      Get-AoStatusReportsJson | Out-Null
    `)).toThrow(/report-surface-unavailable/);
  });

  it('session-get capture forbids reports field', () => {
    const capture = loadCapture('session-get-worker.raw.json') as { session: Record<string, unknown> };
    expect(capture.session).toBeTruthy();
    expect(capture.session.reports).toBeUndefined();
  });

  it('does not resolve terminated-only orchestrator rows as active session', () => {
    const out = runPwsh(`
      . '${lib}'
      $payload = [pscustomobject]@{ data = @(
        [pscustomobject]@{ id='orchestrator-pack-dead'; projectId='orchestrator-pack'; role='orchestrator'; status='terminated'; isTerminated=$true }
      ) }
      $resolved = Resolve-AoOrchestratorSessionId -Project 'orchestrator-pack' -OrchestratorListPayload $payload
      if ($null -eq $resolved) { 'null' } else { $resolved.Id }
    `).trim();
    expect(out).toBe('null');
  });
});

describe('Invoke-AoCliJson report-full readers (Issue #611)', () => {
  it('Get-AoStatusSessionsWithReports decorates fixture report-full payload', () => {
    const capturePath = path.join(
      repoRoot,
      'tests/external-output-references/captures/ao-status-sessions/ready_for_review_on_head.raw.json',
    );
    const out = runPwsh(`
      . '${lib}'
      $rows = Get-AoStatusSessionsWithReports -ReportFullPayload (Get-Content '${capturePath}' -Raw | ConvertFrom-Json)
      $rows | ConvertTo-Json -Compress -Depth 8
    `).trim();
    const rows = JSON.parse(out) as Array<{ name: string; reports?: unknown[]; reportSourcePath?: string }>;
    const list = Array.isArray(rows) ? rows : [rows];
    expect(list[0]?.reports?.length).toBeGreaterThan(0);
    expect(list[0]?.reportSourcePath).toMatch(/\$\.data\[\?name==/);
  });
});
