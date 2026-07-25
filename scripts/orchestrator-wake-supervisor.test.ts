import { runProcessSync } from './kernel/subprocess.ts';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const observerBridge = path.join(repoRoot, 'scripts/lib/Orchestrator-WakeSupervisor.ps1');

describe('Issue #948 wake-supervisor observer bridge', () => {
  it('returns the canonical three-child registry without loading D928', () => {
    const command = [
      `. '${observerBridge.replaceAll("'", "''")}'`,
      '$rows = @(Get-OrchestratorWakeSupervisorChildRegistry)',
      '[ordered]@{ count = $rows.Count; ids = @($rows | ForEach-Object { $_.Id }) } | ConvertTo-Json -Compress',
    ].join('; ');
    const result = runProcessSync({
      command: 'pwsh', args: ['-NoProfile', '-Command', command], cwd: repoRoot,
      inheritParentEnv: true,
    });
    expect(result.ok, result.stderr || result.error).toBe(true);
    const payload = JSON.parse(result.stdout.trim()) as { count: number; ids: string[] };
    expect(payload.count).toBe(3);
    expect(payload.ids).toEqual([
      'review-trigger-reconcile',
      'review-trigger-reeval',
      'review-ready-report-state-seed',
    ]);
  });
});
