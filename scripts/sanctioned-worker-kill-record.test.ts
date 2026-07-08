import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendSanctionedWorkerKillRecord,
  readSanctionedWorkerKillSurface,
} from '../docs/sanctioned-worker-kill-record.mjs';

describe('sanctioned worker kill record surface (Issue #688 AC#4)', () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempRecordPath(name = 'sanctioned-worker-kills.json'): string {
    const dir = mkdtempSync(join(tmpdir(), 'sanctioned-kill-record-'));
    temps.push(dir);
    return join(dir, name);
  }

  it('treats a missing record file as unhealthy absent surface', () => {
    const path = tempRecordPath();
    const surface = readSanctionedWorkerKillSurface(path);
    expect(surface.healthy).toBe(false);
    expect(surface.reason).toBe('sanctioned_kill_record_surface_absent');
    expect(surface.records).toEqual([]);
  });

  it('treats a readable empty record file as healthy with zero records', () => {
    const path = tempRecordPath();
    writeFileSync(path, '[]\n', 'utf8');
    const surface = readSanctionedWorkerKillSurface(path);
    expect(surface.healthy).toBe(true);
    expect(surface.records).toEqual([]);
  });

  it('allows append to bootstrap a never-written surface', () => {
    const path = tempRecordPath();
    const surface = appendSanctionedWorkerKillRecord(path, {
      sessionId: 'opk-688-bootstrap',
      issueNumber: 688,
      killKind: 'manual',
      timestampMs: 1,
    });
    expect(surface.healthy).toBe(true);
    expect(surface.records).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(1);
  });
  it('PowerShell writer preserves records array shape for a single entry', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    const path = tempRecordPath();
    const lib = join(repoRoot, 'scripts/lib/Sanctioned-Worker-Kill-Record.ps1');
    execFileSync(
      'pwsh',
      [
        '-NoProfile',
        '-Command',
        `. '${lib}'; Add-SanctionedWorkerKillRecord -SessionId 'opk-688-ps-single' -IssueNumber 688 -Path '${path.replace(/'/g, "''")}' | Out-Null`,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const surface = readSanctionedWorkerKillSurface(path);
    expect(Array.isArray(parsed.records)).toBe(true);
    expect(parsed.records).toHaveLength(1);
    expect(surface.records).toHaveLength(1);
    expect(surface.records[0]?.sessionId).toBe('opk-688-ps-single');
  });

});
