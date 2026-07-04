import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeFileSize,
  appendAuditJsonlLine,
  listSegments,
  maintenanceLockPath,
  maybeMaintainAuditJsonl,
  releaseMaintenanceLock,
  resolveAuditJsonlPolicy,
  resolveRotationSegmentPath,
  rotateActiveFile,
  tryAcquireMaintenanceLock,
} from './lib/audit-jsonl-retention.mjs';

const repoRoot = join(import.meta.dirname, '..');

function parseJsonl(filePath: string) {
  if (!existsSync(filePath)) {
    return [];
  }
  return readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function makeLine(index: number) {
  return JSON.stringify({ at: new Date().toISOString(), event: 'entry', index });
}

describe('audit jsonl retention policy', () => {
  it('falls back to documented conservative defaults when env is absent or malformed', () => {
    const wrapper = resolveAuditJsonlPolicy('gh-wrapper', {});
    const cache = resolveAuditJsonlPolicy('github-fleet-cache', {});
    expect(wrapper.maxActiveBytes).toBe(64 * 1024 * 1024);
    expect(wrapper.maxTotalBytes).toBe(1024 * 1024 * 1024);
    expect(cache.maxActiveBytes).toBe(16 * 1024 * 1024);
    expect(cache.maxTotalBytes).toBe(200 * 1024 * 1024);
    const malformed = resolveAuditJsonlPolicy('gh-wrapper', {
      GH_WRAPPER_AUDIT_MAX_ACTIVE_BYTES: 'not-a-number',
      GH_WRAPPER_AUDIT_MAX_TOTAL_BYTES: '0',
      GH_WRAPPER_AUDIT_MAX_AGE_DAYS: '-1',
    });
    expect(malformed.maxActiveBytes).toBe(64 * 1024 * 1024);
    expect(malformed.maxTotalBytes).toBe(1024 * 1024 * 1024);
  });
});

describe('gh-wrapper audit retention scenarios', () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  function makeRoot() {
    const root = mkdtempSync(join(tmpdir(), 'audit-jsonl-retention-'));
    roots.push(root);
    return root;
  }

  it('appends without rotation when active file is below bound', () => {
    const root = makeRoot();
    const activePath = join(root, 'gh-wrapper-audit.jsonl');
    const policy = { ...resolveAuditJsonlPolicy('gh-wrapper', {}), maxActiveBytes: 4096 };
    appendAuditJsonlLine(activePath, makeLine(1), { policy });
    appendAuditJsonlLine(activePath, makeLine(2), { policy });
    expect(parseJsonl(activePath)).toHaveLength(2);
    expect(listSegments(root, activePath)).toHaveLength(0);
  });

  it('uses collision-safe rotated segment names within the same second', () => {
    const root = makeRoot();
    const activePath = join(root, 'gh-wrapper-audit.jsonl');
    const policy = {
      ...resolveAuditJsonlPolicy('gh-wrapper', {}),
      maxActiveBytes: 1,
      maxTotalBytes: 1024 * 1024,
      maxAgeMs: 7 * 24 * 60 * 60 * 1000,
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-04T14:13:00.123Z'));
    try {
      appendFileSync(activePath, `${makeLine(0)}\n`);
      rotateActiveFile(activePath, policy);
      appendFileSync(activePath, `${makeLine(1)}\n`);
      rotateActiveFile(activePath, policy);
      const segments = listSegments(root, activePath);
      expect(segments).toHaveLength(2);
      expect(new Set(segments.map((segment) => segment.name)).size).toBe(2);
      const rows = segments.flatMap((segment) => parseJsonl(segment.path));
      expect(rows.map((row) => row.index).sort((left, right) => left - right)).toEqual([0, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries when a resolved rotation segment path already exists', () => {
    const root = makeRoot();
    const first = resolveRotationSegmentPath(root, 'gh-wrapper-audit');
    const second = resolveRotationSegmentPath(root, 'gh-wrapper-audit');
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
    appendFileSync(first!, `${makeLine(0)}\n`);
    const third = resolveRotationSegmentPath(root, 'gh-wrapper-audit');
    expect(third).toBeTruthy();
    expect(third).not.toBe(first);
  });

  it('rotates and prunes when active file exceeds size trigger', () => {
    const root = makeRoot();
    const activePath = join(root, 'gh-wrapper-audit.jsonl');
    const policy = {
      ...resolveAuditJsonlPolicy('gh-wrapper', {}),
      maxActiveBytes: 256,
      maxTotalBytes: 512,
      maxAgeMs: 7 * 24 * 60 * 60 * 1000,
    };
    for (let i = 0; i < 8; i += 1) {
      appendAuditJsonlLine(activePath, makeLine(i), { policy });
    }
    const activeLines = parseJsonl(activePath);
    const segments = listSegments(root, activePath);
    expect(activeLines.length + segments.reduce((sum: number, seg) => sum + parseJsonl(seg.path).length, 0)).toBe(8);
    for (const file of [activePath, ...segments.map((seg) => seg.path)]) {
      if (existsSync(file)) {
        parseJsonl(file).forEach((row) => expect(row).toHaveProperty('index'));
      }
    }
    const totalBytes = activeFileSize(activePath) + segments.reduce((sum: number, seg) => sum + seg.size, 0);
    expect(totalBytes).toBeLessThanOrEqual(policy.maxTotalBytes + 256);
  });

  it('reclaims stale maintenance locks from dead owners before rotating', () => {
    const root = makeRoot();
    const activePath = join(root, 'gh-wrapper-audit.jsonl');
    const lockPath = maintenanceLockPath(activePath);
    writeFileSync(lockPath, '999999\n');
    appendFileSync(activePath, `${makeLine(0)}\n${'x'.repeat(200)}\n`);
    const policy = {
      ...resolveAuditJsonlPolicy('gh-wrapper', {}),
      maxActiveBytes: 100,
      maxTotalBytes: 1024 * 1024,
      maxAgeMs: 7 * 24 * 60 * 60 * 1000,
    };
    const result = maybeMaintainAuditJsonl(activePath, policy);
    expect(result.rotated).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(listSegments(root, activePath).length).toBeGreaterThanOrEqual(1);
  });

  it('does not throw fleet cache calls when audit retention policy is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-cache-audit-guard-'));
    roots.push(root);
    const fleetLib = join(repoRoot, 'scripts/lib/Gh-FleetInventoryCache.ps1').replace(/'/g, "''");
    const missingPolicy = join(root, 'missing-policy.json').replace(/'/g, "''");
    const script = `
$env:GH_FLEET_CACHE_AUDIT = '1'
$env:AO_SIDE_PROCESS_STATE_DIR = '${root.replace(/'/g, "''")}'
$env:AUDIT_JSONL_RETENTION_POLICY_PATH = '${missingPolicy}'
. '${fleetLib}'
Write-GhFleetInventoryCacheAudit -Event 'setup_guard' -Fields @{ key = 'x' }
'ok'
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
    expect(existsSync(join(root, 'github-fleet-cache', 'audit.jsonl'))).toBe(true);
  });

  it('lets lock contenders skip rotation and still append complete lines', () => {
    const root = makeRoot();
    const activePath = join(root, 'gh-wrapper-audit.jsonl');
    const lockPath = maintenanceLockPath(activePath);
    expect(tryAcquireMaintenanceLock(lockPath)).toBe(true);
    try {
      const policy = { ...resolveAuditJsonlPolicy('gh-wrapper', {}), maxActiveBytes: 1 };
      appendFileSync(activePath, `${makeLine(0)}\n`);
      const maintenance = maybeMaintainAuditJsonl(activePath, policy);
      expect(maintenance.lockContended).toBe(true);
      appendAuditJsonlLine(activePath, makeLine(1), { policy });
      expect(parseJsonl(activePath)).toHaveLength(2);
    } finally {
      releaseMaintenanceLock(lockPath);
    }
  });

  it('keeps records complete when maintenance races an open writer', () => {
    const root = makeRoot();
    const activePath = join(root, 'gh-wrapper-audit.jsonl');
    appendFileSync(activePath, `${makeLine(0)}\n`);
    const fd = openSync(activePath, 'r');
    try {
      const policy = { ...resolveAuditJsonlPolicy('gh-wrapper', {}), maxActiveBytes: 1 };
      maybeMaintainAuditJsonl(activePath, policy);
      appendAuditJsonlLine(activePath, makeLine(1), { policy });
      const rows = [];
      if (existsSync(activePath)) {
        rows.push(...parseJsonl(activePath));
      }
      for (const segment of listSegments(root, activePath)) {
        rows.push(...parseJsonl(segment.path));
      }
      expect(rows).toHaveLength(2);
      rows.forEach((row) => expect(row).toHaveProperty('index'));
    } finally {
      closeSync(fd);
    }
  });

  it('does not fail wrapped gh calls when audit maintenance fails', () => {
    const root = makeRoot();
    const auditPath = root;
    const result = spawnSync(process.execPath, [join(repoRoot, 'scripts/lib/gh-wrapper.mjs'), 'version'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GH_WRAPPER_AUDIT: '1',
        GH_WRAPPER_AUDIT_FILE: auditPath,
        PATH: `${join(repoRoot, 'scripts')}:${process.env.PATH ?? ''}`,
      },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('gh-wrapper-audit: write_failed');
  });
});

describe('fleet cache audit retention scenarios', () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  it('covers writer/rotator matrix cells via PowerShell harness', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-cache-audit-retention-'));
    roots.push(root);
    const retentionLib = join(repoRoot, 'scripts/lib/Audit-JsonlRetention.ps1').replace(/'/g, "''");
    const script = `
. '${retentionLib}'
$active = '${root.replace(/'/g, "''")}/audit.jsonl'
$policy = Resolve-AuditJsonlRetentionPolicy -StreamId 'github-fleet-cache'
$policy.maxActiveBytes = 128
$policy.maxTotalBytes = 384
Add-AuditJsonlLine -ActivePath $active -Line '{"event":"one"}' -Policy $policy
Add-AuditJsonlLine -ActivePath $active -Line '{"event":"two"}' -Policy $policy
for ($i = 0; $i -lt 6; $i++) {
  Add-AuditJsonlLine -ActivePath $active -Line "{\\"event\\":\\"row-$i\\"}" -Policy $policy
}
$segments = Get-AuditJsonlSegments -ActivePath $active
$activeCount = if (Test-Path -LiteralPath $active) { (Get-Content -LiteralPath $active).Count } else { 0 }
@{ activeCount = $activeCount; segmentCount = $segments.Count } | ConvertTo-Json -Compress
`;
    const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout.trim());
    expect(summary.activeCount + summary.segmentCount).toBeGreaterThan(0);
    const activePath = join(root, 'audit.jsonl');
    const allFiles = readdirSync(root).filter((name) => name.endsWith('.jsonl'));
    for (const name of allFiles) {
      const lines = readFileSync(join(root, name), 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
    if (existsSync(activePath)) {
      expect(statSync(activePath).size).toBeGreaterThan(0);
    }
  });
});
