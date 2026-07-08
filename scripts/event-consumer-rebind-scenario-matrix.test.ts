import { describe, expect, it } from 'vitest';
import { classifyWorkerLivenessEvidence } from '../docs/dead-worker-reconciler.mjs';

describe('event consumer rebind scenario matrix (Issue #688)', () => {
  it('covers all 18 liveness cells', () => {
    const rows = ['active', 'terminated', 'absent'] as const;
    const panes = ['pane-alive', 'pane-gone', 'unknown'] as const;
    const killRecords = ['present', 'absent'] as const;
    const cells = rows.flatMap((row) => panes.flatMap((pane) => killRecords.map((kill) => ({ row, pane, kill }))));
    expect(cells).toHaveLength(18);

    for (const cell of cells) {
      const sessionId = `opk-688-${cell.row}-${cell.pane}-${cell.kill}`;
      const evidence = classifyWorkerLivenessEvidence(
        { sessionId, issueNumber: 688, status: cell.row },
        {
          osLiveness: { [sessionId]: cell.pane },
          sanctionedKillSurface: {
            healthy: true,
            records: cell.kill === 'present' ? [{ sessionId, issueNumber: 688, killKind: 'manual', timestampMs: 1 }] : [],
          },
        },
      );
      const expected = cell.kill === 'present'
        ? cell.row === 'active' && cell.pane === 'pane-alive' ? 'live_or_unknown' : 'suppressed'
        : (cell.row === 'terminated' || cell.row === 'absent') && cell.pane === 'pane-gone' ? 'dead'
          : cell.row === 'active' && cell.pane === 'pane-alive' ? 'live_or_unknown'
            : 'audit_only';
      expect(evidence.verdict, JSON.stringify(cell)).toBe(expected);
    }
  });
});
