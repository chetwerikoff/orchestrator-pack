import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readWorkerStatusStoreFile } from '../lib/worker-status-store.mjs';
import { serializeJsonArtifact } from '#opk-kernel/json-artifact';
import { buildWorkerStatusReport, mergeAoStatusSessionRows, parseAoPrefixedJson, WORKER_STATUS_REPORT_CONTRACT } from './worker-status-report.ts';

const root = join(import.meta.dirname, '..', '..', 'tests/external-output-references/variants/opk-json-producers/worker-status-report');
const lists = JSON.parse(readFileSync(join(root, 'session-lists.json'), 'utf8')) as { workerList: unknown; orchestratorList: unknown };

describe('worker-status report producer', () => {
  it('matches the committed report golden byte-for-byte', () => {
    const sessions = mergeAoStatusSessionRows(lists.workerList, lists.orchestratorList, 'orchestrator-pack');
    const store = readWorkerStatusStoreFile(join(root, 'store.json')) as unknown as Record<string, unknown>;
    const report = buildWorkerStatusReport(sessions, store, 1_767_225_600_123, { killSwitchActive: false, siblingReady: true, repoTickGeneration: 1 });
    const actual = serializeJsonArtifact(report, WORKER_STATUS_REPORT_CONTRACT);
    expect(Buffer.from(actual).equals(readFileSync(join(root, 'report.json')))).toBe(true);
  });

  it('preserves zero workers and degrades absent rows without null optional fields', () => {
    const empty = buildWorkerStatusReport([], {}, 10, { killSwitchActive: false, siblingReady: true });
    expect(empty.workers).toEqual([]);
    const sessions = mergeAoStatusSessionRows(lists.workerList, lists.orchestratorList, 'orchestrator-pack');
    const degraded = buildWorkerStatusReport(sessions, {}, 10, { killSwitchActive: true, siblingReady: true });
    expect(degraded.workers.every((row) => row.derivedStatus === 'unknown' && row.freshnessAgeMs === -1)).toBe(true);
  });

  it('parses prefixed AO output and rejects malformed or duplicate session rows', () => {
    expect(parseAoPrefixedJson('log line\n{"data":[]}', 'ao')).toEqual({ data: [] });
    expect(() => parseAoPrefixedJson('not-json', 'ao')).toThrow(/no JSON/);
    expect(() => mergeAoStatusSessionRows(
      { data: [{ id: 'dup', role: 'worker', status: 'running', projectId: 'orchestrator-pack', isTerminated: false }] },
      { data: [{ id: 'dup', role: 'orchestrator', status: 'running', projectId: 'orchestrator-pack', isTerminated: false }] },
      'orchestrator-pack',
    )).toThrow(/duplicate session id/);
  });
});
