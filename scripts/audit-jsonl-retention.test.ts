import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
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
const retentionLib = join(repoRoot, 'scripts/lib/Audit-JsonlRetention.ps1').replace(/'/g, "''");
const cacheMatrixFixture = join(repoRoot, 'scripts/fixtures/fleet-cache-audit-retention-matrix.ps1').replace(/'/g, "''");

function psQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runPwsh(script: string) {
  const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return result;
}

function runPwshAsync(script: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn('pwsh', ['-NoProfile', '-Command', script], { cwd: repoRoot });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function runCacheMatrixCell(cell: string, root: string) {
  const result = runPwsh(`& ${psQuote(cacheMatrixFixture)} -Cell ${psQuote(cell)} -Root ${psQuote(root)}`);
  expect(result.status).toBe(0);
  if (result.stderr) {
    expect(result.stderr).toBe('');
  }
  return JSON.parse(result.stdout.trim()) as { cell: string; ok: boolean; detail: Record<string, unknown> };
}

function collectAllJsonlRecords(root: string, activePath: string) {
  const records: Array<Record<string, unknown>> = [];
  const files = [activePath, ...listSegments(root, activePath).map((segment) => segment.path)];
  for (const filePath of files) {
    if (!existsSync(filePath)) {
      continue;
    }
    for (const line of readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean)) {
      records.push(JSON.parse(line));
    }
  }
  return records;
}

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

  it('falls back when policy JSON omits the requested stream', () => {
    const root = mkdtempSync(join(tmpdir(), 'audit-policy-omit-stream-'));
    try {
      const policyPath = join(root, 'policy.json');
      writeFileSync(policyPath, JSON.stringify({
        'github-fleet-cache': {
          maxActiveBytes: 16777216,
          maxTotalBytes: 209715200,
          maxAgeDays: 7,
        },
      }));
      const wrapper = resolveAuditJsonlPolicy('gh-wrapper', {
        AUDIT_JSONL_RETENTION_POLICY_PATH: policyPath,
      });
      expect(wrapper.maxActiveBytes).toBe(64 * 1024 * 1024);
      expect(wrapper.maxTotalBytes).toBe(1024 * 1024 * 1024);
      expect(wrapper.maxAgeMs).toBe(7 * 24 * 60 * 60 * 1000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back when PowerShell policy JSON omits the requested stream', () => {
    const root = mkdtempSync(join(tmpdir(), 'audit-policy-omit-stream-ps-'));
    const policyPath = join(root, 'policy.json');
    writeFileSync(policyPath, '{}');
    const retentionLib = join(repoRoot, 'scripts/lib/Audit-JsonlRetention.ps1').replace(/'/g, "''");
    try {
      const script = `
. '${retentionLib}'
$env:AUDIT_JSONL_RETENTION_POLICY_PATH = '${policyPath.replace(/'/g, "''")}'
$policy = Resolve-AuditJsonlRetentionPolicy -StreamId 'github-fleet-cache'
$policy | ConvertTo-Json -Compress
`;
      const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      const policy = JSON.parse(result.stdout.trim());
      expect(policy.maxActiveBytes).toBe(16 * 1024 * 1024);
      expect(policy.maxTotalBytes).toBe(200 * 1024 * 1024);
      expect(policy.maxAgeMs).toBe(7 * 24 * 60 * 60 * 1000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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


  it('prunes corrupted historical segments without breaking active appends', () => {
    const root = makeRoot();
    const activePath = join(root, 'gh-wrapper-audit.jsonl');
    const base = 'gh-wrapper-audit';
    const expiredValid = join(root, `${base}.20200101T000000000Z-deadbeef.jsonl`);
    const expiredCorrupt = join(root, `${base}.20200102T000000000Z-cafebabe.jsonl`);
    writeFileSync(expiredValid, '{"event":"expired-valid"}\n');
    writeFileSync(expiredCorrupt, '{not-json\n');
    const oldTime = Date.now() - (10 * 24 * 60 * 60 * 1000);
    utimesSync(expiredValid, oldTime / 1000, oldTime / 1000);
    utimesSync(expiredCorrupt, oldTime / 1000, oldTime / 1000);
    const policy = {
      ...resolveAuditJsonlPolicy('gh-wrapper', {}),
      maxActiveBytes: 96,
      maxTotalBytes: 256,
      maxAgeMs: 2 * 24 * 60 * 60 * 1000,
    };
    for (let i = 0; i < 6; i += 1) {
      appendAuditJsonlLine(activePath, makeLine(i), { policy });
    }
    const records = collectAllJsonlRecords(root, activePath);
    expect(records).toHaveLength(6);
    expect(existsSync(expiredValid)).toBe(false);
    expect(existsSync(expiredCorrupt)).toBe(false);
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

  function makeRoot(suffix: string) {
    const root = mkdtempSync(join(tmpdir(), `fleet-cache-audit-${suffix}-`));
    roots.push(root);
    return root;
  }

  it('matrix: below bound appends without rotation', () => {
    const result = runCacheMatrixCell('below_bound', makeRoot('below'));
    expect(result.ok).toBe(true);
    expect(result.detail.segmentCount).toBe(0);
    expect(result.detail.lineCount).toBe(2);
  });

  it('matrix: same-process rotation keeps valid JSONL over size bound', () => {
    const result = runCacheMatrixCell('rotate_over_bound', makeRoot('rotate'));
    expect(result.ok).toBe(true);
    expect(result.detail.recordCount).toBe(8);
    expect(result.detail.segmentCount).toBeGreaterThan(0);
  });

  it('matrix: concurrent cache writers keep complete JSONL lines', async () => {
    const root = makeRoot('concurrent');
    const activePath = join(root, 'audit.jsonl');
    mkdirSync(root, { recursive: true });
    const writers = Array.from({ length: 8 }, (_, index) => {
      const line = JSON.stringify({ event: 'concurrent', index });
      return runPwshAsync(`
. '${retentionLib}'
$active = ${psQuote(activePath)}
$policy = @{
  streamId = 'github-fleet-cache'
  maxActiveBytes = 96
  maxTotalBytes = 4096
  maxAgeMs = 604800000
}
Add-AuditJsonlLine -ActivePath $active -Line '${line}' -Policy $policy
`);
    });
    const results = await Promise.all(writers);
    for (const result of results) {
      expect(result.status).toBe(0);
    }
    const records = collectAllJsonlRecords(root, activePath);
    expect(records).toHaveLength(8);
    expect(new Set(records.map((record) => record.index)).size).toBe(8);
  });

  it('matrix: lock contenders skip rotation and still append', async () => {
    const root = makeRoot('lock');
    const activePath = join(root, 'audit.jsonl');
    mkdirSync(root, { recursive: true });
    const lockPath = `${activePath}.maintenance.lock`;
    const holder = spawn('pwsh', [
      '-NoProfile',
      '-Command',
      `. '${retentionLib}'; if (-not (Test-AuditJsonlMaintenanceLock -LockPath ${psQuote(lockPath)})) { exit 2 }; Start-Sleep -Seconds 6; Remove-AuditJsonlMaintenanceLock -LockPath ${psQuote(lockPath)}`,
    ], { cwd: repoRoot, stdio: 'ignore' });
    await sleep(500);
    const policyScript = `@{
  streamId = 'github-fleet-cache'
  maxActiveBytes = 1
  maxTotalBytes = 100000
  maxAgeMs = 604800000
}`;
    const contenders = await Promise.all([0, 1].map((index) => {
      const line = JSON.stringify({ event: 'lock', index });
      return runPwshAsync(`
. '${retentionLib}'
$active = ${psQuote(activePath)}
$policy = ${policyScript}
if (-not (Test-Path -LiteralPath $active)) { Set-Content -LiteralPath $active -Value '{"event":"seed"}' -Encoding UTF8 }
Add-AuditJsonlLine -ActivePath $active -Line '${line}' -Policy $policy
`);
    }));
    await new Promise<void>((resolve, reject) => {
      holder.on('close', (code) => {
        if (code === 0 || code === 2) {
          resolve();
          return;
        }
        reject(new Error(`lock holder exited ${code}`));
      });
    });
    for (const result of contenders) {
      expect(result.status).toBe(0);
    }
    const records = collectAllJsonlRecords(root, activePath);
    expect(records.length).toBeGreaterThanOrEqual(2);
  });

  it('matrix: open writer rename race keeps complete records', () => {
    const result = runCacheMatrixCell('open_before_rename', makeRoot('open'));
    expect(result.ok).toBe(true);
    expect(result.detail.recordCount).toBe(2);
  });

  it('matrix: blocked rotation remains appendable and observable', () => {
    const result = runCacheMatrixCell('rotate_blocked', makeRoot('blocked'));
    expect(result.ok).toBe(true);
    expect(result.detail.recordCount).toBeGreaterThanOrEqual(2);
    expect(result.detail.maintenanceEvents).toContain('rotate_failed');
  });

  it('matrix: corrupted historical segments prune without touching active JSONL', () => {
    const result = runCacheMatrixCell('corrupted_segment_prune', makeRoot('corrupt'));
    expect(result.ok).toBe(true);
    expect(result.detail.recordCount).toBe(6);
    expect(result.detail.expiredStillPresent).toEqual([false, false]);
  });
});

