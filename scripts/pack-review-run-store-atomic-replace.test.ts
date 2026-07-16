import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsHarness = vi.hoisted(() => ({
  actualRenameSync: undefined as typeof import('node:fs').renameSync | undefined,
  renameSync: vi.fn((source: string, destination: string) => {
    fsHarness.actualRenameSync!(source, destination);
  }),
}));
const cryptoHarness = vi.hoisted(() => ({
  actualRandomUUID: undefined as typeof import('node:crypto').randomUUID | undefined,
  randomUUID: vi.fn(() => cryptoHarness.actualRandomUUID!()),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsHarness.actualRenameSync = actual.renameSync;
  return { ...actual, renameSync: fsHarness.renameSync };
});
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  cryptoHarness.actualRandomUUID = actual.randomUUID;
  return { ...actual, randomUUID: cryptoHarness.randomUUID };
});

import {
  createPackReviewRun,
  getPackReviewRun,
  listPackReviewRuns,
  setPackReviewRunTerminal,
  updatePackReviewRun,
} from './lib/pack-review-run-store.js';

const roots: string[] = [];
const HEAD_SHA = '8610000000000000000000000000000000000000';
const START = new Date('2026-07-16T08:00:00.000Z');

function useRealRename(): void {
  fsHarness.renameSync.mockReset();
  fsHarness.renameSync.mockImplementation((source, destination) => {
    fsHarness.actualRenameSync!(source, destination);
  });
}

function useRealRandomUUID(): void {
  cryptoHarness.randomUUID.mockReset();
  cryptoHarness.randomUUID.mockImplementation(() => cryptoHarness.actualRandomUUID!());
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function createFixture() {
  const storeRoot = mkdtempSync(join(tmpdir(), 'opk-pack-review-run-store-'));
  roots.push(storeRoot);
  const result = createPackReviewRun({
    prNumber: 861,
    headSha: HEAD_SHA,
    trustedPackRoot: storeRoot,
    sourceRepoRoot: storeRoot,
    storeRoot,
    now: START,
  });
  return { storeRoot, run: result.run, path: join(storeRoot, 'runs', `${result.run.id}.json`) };
}

function readRaw(path: string): string {
  return readFileSync(path, 'utf8');
}

function readRecord(path: string) {
  return JSON.parse(readRaw(path)) as { status: string; latestRunStatus: string };
}

beforeEach(() => {
  useRealRename();
  useRealRandomUUID();
});

afterEach(() => {
  useRealRename();
  useRealRandomUUID();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pack review-run record atomic replacement (#861)', () => {
  it('positive-outcome: lands a terminal status through the public readers', () => {
    const fixture = createFixture();
    fsHarness.renameSync.mockClear();

    setPackReviewRunTerminal(fixture.run.id, 'up_to_date', {}, {
      storeRoot: fixture.storeRoot,
      now: new Date('2026-07-16T08:01:00.000Z'),
    });

    expect(fsHarness.renameSync).toHaveBeenCalledTimes(1);
    expect(getPackReviewRun(fixture.run.id, { storeRoot: fixture.storeRoot })?.status).toBe('up_to_date');
    expect(listPackReviewRuns({ storeRoot: fixture.storeRoot })).toEqual([
      expect.objectContaining({ id: fixture.run.id, status: 'up_to_date', latestRunStatus: 'up_to_date' }),
    ]);
  });

  it('keeps the prior parseable record when rename is interrupted before taking effect', () => {
    const fixture = createFixture();
    const prior = readRaw(fixture.path);
    fsHarness.renameSync.mockReset();
    fsHarness.renameSync.mockImplementationOnce(() => {
      throw errno('EIO', 'simulated interruption before rename effect');
    });

    expect(() => updatePackReviewRun(fixture.run.id, {
      status: 'reviewing',
      latestRunStatus: 'reviewing',
    }, { storeRoot: fixture.storeRoot })).toThrow(/simulated interruption/);

    expect(existsSync(fixture.path)).toBe(true);
    expect(readRaw(fixture.path)).toBe(prior);
    expect(readRecord(fixture.path).status).toBe('queued');
    expect(readdirSync(join(fixture.storeRoot, 'runs')).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('retries the rename itself after a transient failure without deleting the destination', () => {
    const fixture = createFixture();
    const prior = readRaw(fixture.path);
    let observedDuringFailure = '';
    fsHarness.renameSync.mockReset();
    fsHarness.renameSync
      .mockImplementationOnce((_source, destination) => {
        observedDuringFailure = readFileSync(destination, 'utf8');
        throw errno('EBUSY', 'simulated transient contention');
      })
      .mockImplementation((source, destination) => {
        fsHarness.actualRenameSync!(source, destination);
      });

    updatePackReviewRun(fixture.run.id, {
      status: 'reviewing',
      latestRunStatus: 'reviewing',
    }, { storeRoot: fixture.storeRoot });

    expect(fsHarness.renameSync).toHaveBeenCalledTimes(2);
    expect(observedDuringFailure).toBe(prior);
    expect(readRecord(fixture.path).status).toBe('reviewing');
  });

  it('bounds transient retries, reports exhaustion, preserves a record, and releases the store lock', () => {
    const fixture = createFixture();
    fsHarness.renameSync.mockReset();
    fsHarness.renameSync.mockImplementation(() => {
      throw errno('EPERM', 'simulated persistent contention');
    });

    expect(() => updatePackReviewRun(fixture.run.id, {
      status: 'reviewing',
      latestRunStatus: 'reviewing',
    }, { storeRoot: fixture.storeRoot })).toThrow(
      /rename_retry_exhausted code=EPERM attempts=4/,
    );

    expect(fsHarness.renameSync).toHaveBeenCalledTimes(4);
    expect(existsSync(fixture.path)).toBe(true);
    expect(['queued', 'reviewing']).toContain(readRecord(fixture.path).status);
    expect(existsSync(join(fixture.storeRoot, '.store-lock'))).toBe(false);

    useRealRename();
    expect(updatePackReviewRun(fixture.run.id, {
      status: 'reviewing',
      latestRunStatus: 'reviewing',
    }, { storeRoot: fixture.storeRoot }).status).toBe('reviewing');
  });

  it('keeps create-only collision behavior unchanged', () => {
    const fixture = createFixture();
    setPackReviewRunTerminal(fixture.run.id, 'up_to_date', {}, { storeRoot: fixture.storeRoot });
    const existingIdSource = fixture.run.id.slice('prr-'.length);
    cryptoHarness.randomUUID
      .mockImplementationOnce(() => '11111111-1111-4111-8111-111111111111')
      .mockImplementationOnce(() => existingIdSource as ReturnType<typeof import('node:crypto').randomUUID>);

    expect(() => createPackReviewRun({
      prNumber: 861,
      headSha: HEAD_SHA,
      trustedPackRoot: fixture.storeRoot,
      sourceRepoRoot: fixture.storeRoot,
      storeRoot: fixture.storeRoot,
      now: new Date('2026-07-16T08:02:00.000Z'),
    })).toThrow(`pack review run already exists: ${fixture.run.id}`);
  });
});
