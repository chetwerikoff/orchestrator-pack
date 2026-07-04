import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..');
const auditLib = join(repoRoot, 'scripts/lib/Orchestrator-ReviewStartAudit.ps1').replace(/'/g, "''");

describe('orchestrator review-start preflight refusal audit', () => {
  it('records PR and head identity keys on preflight refusals', () => {
    const root = mkdtempSync(join(tmpdir(), 'review-start-preflight-audit-'));
    try {
      const script = `
. '${auditLib}'
$result = Write-OrchestratorReviewStartPreflightRefusal -AuditRoot '${root.replace(/'/g, "''")}' -Reason 'gate_marker_missing' -MarkerState 'missing' -PrNumber 581 -HeadSha 'ABCDEF1234'
Get-Content -LiteralPath $result.path -Raw
`;
      const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      const record = JSON.parse(result.stdout.trim());
      expect(record).toMatchObject({
        kind: 'preflight_refusal',
        prNumber: 581,
        headSha: 'abcdef1234',
        reason: 'gate_marker_missing',
        markerState: 'missing',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
