import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AC_MUTATION_CONTROLS } from './contracts.ts';
import { FOUNDATION_MUTATION_CATALOG } from './mutation-catalog.ts';

describe('[AC8] external mutation catalog', () => {
  it('binds every declared control exactly once to a real artifact and specific checker ID', () => {
    const expected = Object.entries(AC_MUTATION_CONTROLS).flatMap(([ac, ids]) =>
      ids.map((mutationId) => `${ac}:${mutationId}`),
    );
    const actual = FOUNDATION_MUTATION_CATALOG.map((entry) => `${entry.ac}:${entry.mutationId}`);
    expect(new Set(actual).size).toBe(actual.length);
    expect([...actual].sort()).toEqual([...expected].sort());
    for (const binding of FOUNDATION_MUTATION_CATALOG) {
      expect(binding.artifactPath).not.toMatch(/^\/|^[A-Za-z]:[\\/]/);
      expect(binding.strategy).not.toBe('corrupt');
      expect(binding.strategy).not.toBe('delete');
      expect(binding.failingTestId).toBe(`mutation-contract:${binding.ac}:${binding.mutationId}`);
    }
  });
});

describe('[Issue 1440] orchestration escalation guarantees', () => {
  it('gives every formerly unproved at-least-once-until-ack class one explicit disposition', () => {
    const catalog = JSON.parse(readFileSync(
      new URL('../orchestrator-message-catalog.json', import.meta.url),
      'utf8',
    )) as {
      escalationClasses: Array<{
        code: string;
        delivery_guarantee: string;
        guarantee_reconciliation?: { decision?: string; reason?: string };
      }>;
    };
    const codes = ['E1', 'E3', 'E5', 'E10', 'E11-promoted', 'E12', 'E14', 'E15', 'E16'];
    const selected = catalog.escalationClasses.filter((entry) => codes.includes(entry.code));
    expect(selected.map((entry) => entry.code).sort()).toEqual([...codes].sort());
    for (const entry of selected) {
      expect(entry.guarantee_reconciliation?.decision).toMatch(/^(retain|downgrade)$/);
      expect(entry.guarantee_reconciliation?.reason?.trim()).toBeTruthy();
      if (entry.guarantee_reconciliation?.decision === 'downgrade') {
        expect(entry.delivery_guarantee).not.toBe('at-least-once-until-ack');
      }
    }
  });

  it('guards the role-bound drain and supervised-heartbeat policy in the runbook', () => {
    const runbook = readFileSync(
      new URL('../../docs/orchestration-runbook.md', import.meta.url),
      'utf8',
    );
    for (const required of [
      '## Bound-run inbox drain and acknowledgement',
      '**Manager:** drain before starting or claiming the next authoring/review stage, immediately before manager `worker_done`, and immediately before ending a turn without `worker_done`.',
      '**Worker:** drain immediately before worker `worker_done` and before emitting a blocker/escalation that hands control upward.',
      '**Coordinator / flow-manager / orchestrator acting on the bound Run:** drain before issuing a reply, ruling, escalation decision, or dispatch, and again before reporting its own turn complete.',
      'Exactly one acknowledgement is issued per Delivery, never per message.',
      'Supervised agents do not emit `type: heartbeat` / `subject: alive` control chatter merely to assert liveness.',
      'A supervised agent with no actionable report sends nothing.',
      'A supervised manager emits `worker_done --outcome succeeded` exactly once, and only after acceptance satisfies its existing whole-task completion contract.',
      '`recoverable`, `external_pause`, and `contract_defect` never complete or settle the parent task.',
      'A manager sends `worker_done --outcome failed` only after a direct coordinator/operator cancellation message',
      'S1 remains the sole liveness observer',
      '`nested_worker_depth_exceeded` -> use the existing pane-launch path instead of nesting another worker;',
      '`dispatch_capability_invalid` -> use the existing orchestration mailbox fallback/path instead of re-dispatching the revoked capability;',
      '`consumer_fenced` -> re-read the exact current runtime/terminal handle before any effect;',
      '`stable_pane_required` -> re-read the exact current runtime/terminal handle before any effect.',
      'never act on a stale, reused, or guessed handle.',
    ]) expect(runbook).toContain(required);
  });
});
