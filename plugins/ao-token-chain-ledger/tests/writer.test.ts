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
