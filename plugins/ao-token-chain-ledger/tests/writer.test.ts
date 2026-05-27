import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendLedgerRow,
  normalizeParentSession,
  prepareLedgerRow,
  readLedgerRows,
  resolveChainId,
} from '../lib/writer.js';

describe('writer', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    delete process.env.AO_CHAIN_ID;
    delete process.env.AO_TASK_ID;
    delete process.env.AO_SESSION_INFO_JSON;
  });

  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ao-ledger-'));
    tempDirs.push(dir);
    return dir;
  }

  it('resolves chain_id from AO_CHAIN_ID first', () => {
    const repoRoot = makeRepo();
    process.env.AO_CHAIN_ID = 'explicit-chain';
    expect(
      resolveChainId({ repoRoot, issueNumber: 8, env: process.env }).chain_id,
    ).toBe('explicit-chain');
  });

  it('prefers session chain_id over task_id when both are present', () => {
    const repoRoot = makeRepo();
    expect(
      resolveChainId({
        repoRoot,
        sessionInfo: { chain_id: 'chain-primary', task_id: 'task-secondary' },
      }),
    ).toEqual({ chain_id: 'chain-primary', chain_id_source: 'ao' });
  });

  it('resolves chain_id from AO task_id when chain_id is absent', () => {
    const repoRoot = makeRepo();
    expect(
      resolveChainId({
        repoRoot,
        issueNumber: 8,
        sessionInfo: { task_id: 'ao-task-abc' },
      }),
    ).toEqual({ chain_id: 'ao-task-abc', chain_id_source: 'ao' });
  });

  it('resolves chain_id from AO_TASK_ID env when session metadata lacks chain_id', () => {
    const repoRoot = makeRepo();
    process.env.AO_TASK_ID = 'ao-env-task-99';
    expect(resolveChainId({ repoRoot, issueNumber: 8, env: process.env })).toEqual({
      chain_id: 'ao-env-task-99',
      chain_id_source: 'ao',
    });
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

  it('leaves cost unavailable on started events even when session info has cost', () => {
    const repoRoot = makeRepo();
    process.env.AO_SESSION_INFO_JSON = JSON.stringify({
      cost: { input_tokens: 99, output_tokens: 1, estimated_cost_usd: 0.99 },
    });
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

  it('appends rows to repo-local .ao/ledger/events.jsonl', () => {
    const repoRoot = makeRepo();
    const row = prepareLedgerRow({
      repoRoot,
      issueNumber: 8,
      event_kind: 'started',
      role: 'planner',
      task_id: '8',
    });
    appendLedgerRow(row, { repoRoot });
    const rows = readLedgerRows(join(repoRoot, '.ao', 'ledger', 'events.jsonl'));
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
      readFileSync(join(repoRoot, '.ao', 'ledger', 'active-chain.json'), 'utf8'),
    ) as { chain_id: string };
    expect(state.chain_id).toBe(first.chain_id);
  });
});
