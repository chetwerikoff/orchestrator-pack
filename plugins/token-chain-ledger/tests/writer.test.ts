import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendLedgerRow,
  normalizeParentSession,
  prepareLedgerRow,
  resolveParentSession,
  readLedgerRows,
  resolveChainId,
} from '../lib/writer.js';

describe('writer', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pack-ledger-'));
    tempDirs.push(dir);
    return dir;
  }

  it('resolves an explicit manual chain id first', () => {
    const repoRoot = makeRepo();
    expect(resolveChainId({ repoRoot, issueNumber: 8, manualChainId: 'explicit-chain' }).chain_id)
      .toBe('explicit-chain');
  });

  it('prefers session chain_id over task_id when both are present', () => {
    const repoRoot = makeRepo();
    expect(
      resolveChainId({
        repoRoot,
        sessionInfo: { chain_id: 'chain-primary', task_id: 'task-secondary' },
      }),
    ).toEqual({ chain_id: 'chain-primary', chain_id_source: 'runtime' });
  });

  it('resolves chain_id from runtime task_id when chain_id is absent', () => {
    const repoRoot = makeRepo();
    expect(
      resolveChainId({
        repoRoot,
        issueNumber: 8,
        sessionInfo: { task_id: 'runtime-task-abc' },
      }),
    ).toEqual({ chain_id: 'runtime-task-abc', chain_id_source: 'runtime' });
  });

  it('resolves chain_id from camelCase taskId in session metadata', () => {
    const repoRoot = makeRepo();
    expect(
      resolveChainId({
        repoRoot,
        issueNumber: 8,
        sessionInfo: { taskId: 'runtime-task-camel' },
      }),
    ).toEqual({ chain_id: 'runtime-task-camel', chain_id_source: 'runtime' });
  });


  it('falls back to issue-{n} when no higher-priority source exists', () => {
    const repoRoot = makeRepo();
    expect(resolveChainId({ repoRoot, issueNumber: 8 }).chain_id).toBe('issue-8');
  });

  it('records unavailable parent_session_id without throwing', () => {
    expect(normalizeParentSession(undefined)).toEqual({
      parent_session_id: null,
      parent_session_id_source: 'unavailable',
    });
  });

  it('marks parent_session_id_source runtime when parent comes from session metadata', () => {
    expect(
      resolveParentSession({
        sessionInfo: { parentSessionId: 'parent-runtime-1' },
      }),
    ).toEqual({
      parent_session_id: 'parent-runtime-1',
      parent_session_id_source: 'runtime',
    });
  });

  it('marks parent_session_id_source runtime when parent comes from AO_\u0050ARENT_SESSION_ID', () => {
    expect(
      resolveParentSession({
        explicitId: 'parent-explicit-1',
        explicitSource: 'manual',
      }),
    ).toEqual({
      parent_session_id: 'parent-explicit-1',
      parent_session_id_source: 'manual',
    });
  });

  it('prepareLedgerRow uses runtime parent source from session metadata', () => {
    const repoRoot = makeRepo();
    const row = prepareLedgerRow(
      {
        repoRoot,
        issueNumber: 8,
        event_kind: 'started',
        role: 'worker',
        task_id: '8',
      },
      { sessionInfo: { parentSessionId: 'parent-runtime-2' } },
    );
    expect(row.parent_session_id).toBe('parent-runtime-2');
    expect(row.parent_session_id_source).toBe('runtime');
  });

  it('uses agentSessionId from explicit runtime session metadata', () => {
    const repoRoot = makeRepo();
    const row = prepareLedgerRow(
      {
        repoRoot,
        issueNumber: 8,
        event_kind: 'started',
        role: 'worker',
        task_id: '8',
      },
      { sessionInfo: { agentSessionId: 'runtime-sess-42' } },
    );
    expect(row.session_id).toBe('runtime-sess-42');
  });

  it('prefers an explicitly supplied row session id over runtime metadata', () => {
    const repoRoot = makeRepo();
    const row = prepareLedgerRow(
      {
        repoRoot,
        issueNumber: 8,
        event_kind: 'started',
        role: 'worker',
        task_id: '8',
        session_id: 'explicit-sess',
      },
      { sessionInfo: { agentSessionId: 'metadata-sess' } },
    );
    expect(row.session_id).toBe('explicit-sess');
  });

  it('leaves cost unavailable on started events even when session info has cost', () => {
    const repoRoot = makeRepo();
    const row = prepareLedgerRow({
      repoRoot,
      issueNumber: 8,
      event_kind: 'started',
      role: 'worker',
      task_id: '8',
    });
    expect(row.cost).toEqual({
      input_tokens: null,
      output_tokens: null,
      estimated_cost_usd: null,
      source: 'unavailable',
    });
  });

  it('appends rows to repo-local .orchestrator-pack/ledger/events.jsonl', () => {
    const repoRoot = makeRepo();
    const row = prepareLedgerRow({
      repoRoot,
      issueNumber: 8,
      event_kind: 'started',
      role: 'planner',
      task_id: '8',
    });
    appendLedgerRow(row, { repoRoot });
    const rows = readLedgerRows(join(repoRoot, '.orchestrator-pack', 'ledger', 'events.jsonl'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.chain_id).toBe('issue-8');
    expect(rows[0]?.cost.source).toBe('unavailable');
  });

  it('persists wrapper-generated chain_id for reuse', () => {
    const repoRoot = makeRepo();
    const first = resolveChainId({ repoRoot });
    const second = resolveChainId({ repoRoot });
    expect(first.chain_id_source).toBe('wrapper_generated');
    expect(second.chain_id).toBe(first.chain_id);
    const state = JSON.parse(
      readFileSync(join(repoRoot, '.orchestrator-pack', 'ledger', 'active-chain.json'), 'utf8'),
    ) as { chain_id: string };
    expect(state.chain_id).toBe(first.chain_id);
  });
});
