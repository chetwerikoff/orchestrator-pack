import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { destinationIdentityForPath } from '../chatgpt-browser-turn/coordination.ts';
import { publicationStatus, publishReply } from '../chatgpt-browser-turn/publication.ts';
import { adjudicateTombstone, quarantineOpaque, statusList } from '../chatgpt-browser-turn/state.ts';
import { atomicJson, configuredProfileKey, profileDirs, sha256 } from '../chatgpt-browser-turn/storage-common.ts';
import { classifyProductWall, productStatusText } from '../chatgpt-browser-turn/ui-adapter.ts';

let root = '';
let profileKey = '';
const cdp = 'http://127.0.0.1:9222';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opk-964-review-fixes-'));
  process.env.CHATGPT_BROWSER_TURN_STATE_DIR = join(root, 'state');
  profileKey = configuredProfileKey(join(root, 'profile'), cdp);
});

afterEach(() => {
  delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
  if (root) rmSync(root, { recursive: true, force: true });
});

function emptyLocator(): any {
  return {
    count: async () => 0,
    nth: () => emptyLocator(),
    innerText: async () => '',
  };
}

function opaqueFixture(name: string, bytes: Buffer): { identity: string; generation: number; evidence: string; path: string } {
  const path = join(profileDirs(profileKey).records, name);
  writeFileSync(path, bytes);
  const listed = statusList(profileKey);
  const item = listed.items!.find((candidate) => candidate.kind === 'opaque_record');
  expect(item).toBeDefined();
  return {
    identity: item!.identity,
    generation: item!.generation,
    evidence: item!.evidence_token,
    path,
  };
}

function preparingTombstone(
  sourceName: string,
  generation: number,
  digest: string,
): { identity: string; path: string; quarantinePath: string } {
  const identity = `tombstone-${randomUUID()}`;
  const now = new Date().toISOString();
  const path = join(profileDirs(profileKey).tombstones, `${identity}.json`);
  const quarantinePath = join(profileDirs(profileKey).quarantine, `${identity}.opaque`);
  atomicJson(path, {
    schema: 'chatgpt-browser-turn-tombstone/v1',
    version: 1,
    configured_profile_key: profileKey,
    identity,
    generation: 1,
    source_area: 'records',
    source_name: sourceName,
    source_generation: generation,
    source_digest: digest,
    quarantine_name: `${identity}.opaque`,
    state: 'preparing',
    created_at: now,
    updated_at: now,
  });
  return { identity, path, quarantinePath };
}

describe('pack review 4773714081 publication crash boundary', () => {
  it('durably records the exact empty temp before any reply body bytes can survive', () => {
    const output = resolve(join(root, 'reply.txt'));
    const destination = destinationIdentityForPath(output);

    expect(() => publishReply(
      profileKey,
      'crash-after-prepare',
      output,
      destination.identity,
      'BODY-MUST-NOT-BE-ORPHANED',
      { afterPreparedRecord: () => { throw new Error('test_crash:after_prepared_record'); } },
    )).toThrow('test_crash:after_prepared_record');

    const recordPath = join(profileDirs(profileKey).publications, 'crash-after-prepare.json');
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, any>;
    expect(record.state).toBe('prepared');
    expect(existsSync(record.temp_path)).toBe(true);
    expect(readFileSync(record.temp_path).byteLength).toBe(0);
    expect(existsSync(output)).toBe(false);

    atomicJson(recordPath, { ...record, owner_pid: 999999, updated_at: new Date().toISOString() });
    const recovered = publicationStatus(profileKey, 'crash-after-prepare');
    expect(recovered.state).toBe('recovery_required');
    expect(recovered.cause).toBe('prepared_without_live_owner');
  });
});

describe('pack review 4773714081 opaque quarantine crash recovery', () => {
  it('resumes a preparing tombstone when the crash occurred before the move', () => {
    const bytes = Buffer.from('{"future":"before-move"}\n');
    const source = opaqueFixture('future-before-move.json', bytes);
    const tombstone = preparingTombstone('future-before-move.json', source.generation, source.evidence);

    const pending = statusList(profileKey).items!.find((item) => item.kind === 'blocking_tombstone' && item.identity === tombstone.identity)!;
    expect(pending.cause).toBe('quarantine_preparation_incomplete');
    expect(quarantineOpaque(profileKey, pending.identity, pending.generation).state).toBe('quarantined');
    expect(existsSync(source.path)).toBe(false);
    expect(readFileSync(tombstone.quarantinePath)).toEqual(bytes);
    const record = JSON.parse(readFileSync(tombstone.path, 'utf8')) as Record<string, any>;
    expect(record.state).toBe('active');
    expect(readdirSync(profileDirs(profileKey).tombstones)).toHaveLength(1);
  });

  it('resumes a preparing tombstone when the crash occurred after the move', () => {
    const bytes = Buffer.from('{"future":"after-move"}\n');
    const source = opaqueFixture('future-after-move.json', bytes);
    const tombstone = preparingTombstone('future-after-move.json', source.generation, source.evidence);
    renameSync(source.path, tombstone.quarantinePath);

    const pending = statusList(profileKey).items!.find((item) => item.kind === 'blocking_tombstone' && item.identity === tombstone.identity)!;
    expect(pending.cause).toBe('quarantine_preparation_incomplete');
    expect(quarantineOpaque(profileKey, pending.identity, pending.generation).state).toBe('quarantined');
    const record = JSON.parse(readFileSync(tombstone.path, 'utf8')) as Record<string, any>;
    expect(record.state).toBe('active');
    expect(readFileSync(tombstone.quarantinePath)).toEqual(bytes);
    const listed = statusList(profileKey);
    expect(listed.items!.some((item) => item.kind === 'opaque_quarantine' && item.cause === 'quarantine_missing_or_unreadable')).toBe(false);
  });
});

describe('pack review 4773714081 product-owned wall detection', () => {
  it('never treats ordinary page body phrases as quota/challenge/login evidence when composer is absent', async () => {
    let bodyReads = 0;
    const page = {
      locator: (selector: string) => {
        if (selector === '#prompt-textarea') return emptyLocator();
        if (selector === 'body') {
          return {
            ...emptyLocator(),
            innerText: async () => {
              bodyReads++;
              return 'verify you are human; just a moment; usage limit; please try again later; log in';
            },
          };
        }
        return emptyLocator();
      },
    };

    const surface = await productStatusText(page);
    expect(surface.composer).toBe(false);
    expect(surface.text).toBe('');
    expect(bodyReads).toBe(0);
    expect(classifyProductWall(surface)).toEqual({});
  });

  it('still recognizes a product-owned status surface without reading ordinary body text', async () => {
    let bodyReads = 0;
    const page = {
      locator: (selector: string) => {
        if (selector === '#prompt-textarea') return emptyLocator();
        if (selector === '[role="alert"]') {
          return {
            count: async () => 1,
            nth: () => ({ innerText: async () => "You've reached the current usage limit" }),
          };
        }
        if (selector === 'body') {
          return { ...emptyLocator(), innerText: async () => { bodyReads++; return 'ordinary conversation'; } };
        }
        return emptyLocator();
      },
    };

    const surface = await productStatusText(page);
    expect(classifyProductWall(surface)).toEqual({ state: 'quota', cause: 'quota_detected' });
    expect(bodyReads).toBe(0);
  });
});

describe('pack review 4774405996 publication exclusive commit recovery', () => {
  it('does not treat an external hard link to the prepared temp as the helper rename', () => {
    const output = resolve(join(root, 'hardlink-race.txt'));
    const destination = destinationIdentityForPath(output);
    const invocation = 'hardlink-race';

    expect(() => publishReply(
      profileKey,
      invocation,
      output,
      destination.identity,
      'complete assistant reply',
      { afterTempFsync: () => { throw new Error('test_crash:after_temp_fsync'); } },
    )).toThrow('test_crash:after_temp_fsync');

    const record = JSON.parse(
      readFileSync(join(profileDirs(profileKey).publications, `${invocation}.json`), 'utf8'),
    ) as Record<string, any>;
    expect(readFileSync(record.temp_path, 'utf8')).toBe('complete assistant reply');
    linkSync(record.temp_path, output);

    const recovered = publicationStatus(profileKey, invocation);
    expect(recovered.state).toBe('recovery_required');
    expect(recovered.cause).toBe('publication_commit_alias_present');
    expect(existsSync(record.temp_path)).toBe(true);
    expect(readFileSync(output, 'utf8')).toBe('complete assistant reply');
  });
});

describe('pack review 4774405996 adjudication crash recovery', () => {
  function activeTombstone(bytes: Buffer, name: string): { identity: string; generation: number; evidence: string } {
    const source = opaqueFixture(name, bytes);
    expect(quarantineOpaque(profileKey, source.identity, source.generation).state).toBe('quarantined');
    const listed = statusList(profileKey);
    const tombstone = listed.items!.find((item) => item.kind === 'blocking_tombstone')!;
    expect(tombstone).toBeDefined();
    return { identity: tombstone.identity, generation: tombstone.generation, evidence: sha256('operator-adjudication') };
  }

  it('resumes exact adjudication after a crash immediately after the durable resolution record', () => {
    const bytes = Buffer.from('{"future":"resolution-record"}\n');
    const tombstone = activeTombstone(bytes, 'future-resolution-record.json');

    expect(() => adjudicateTombstone(
      profileKey,
      tombstone.identity,
      tombstone.generation,
      tombstone.evidence,
      tombstone.evidence,
      { afterResolutionRecord: () => { throw new Error('test_crash:after_resolution_record'); } },
    )).toThrow('test_crash:after_resolution_record');

    const d = profileDirs(profileKey);
    expect(existsSync(join(d.tombstones, `${tombstone.identity}.json`))).toBe(true);
    expect(existsSync(join(d.quarantine, `${tombstone.identity}.opaque`))).toBe(true);
    expect(existsSync(join(d.resolved, `${tombstone.identity}.json`))).toBe(true);
    expect(existsSync(join(d.resolved, `${tombstone.identity}.opaque`))).toBe(false);

    expect(adjudicateTombstone(
      profileKey,
      tombstone.identity,
      tombstone.generation,
      tombstone.evidence,
      tombstone.evidence,
    ).state).toBe('cleared');
    expect(statusList(profileKey).state).toBe('none');
    expect(readFileSync(join(d.resolved, `${tombstone.identity}.opaque`))).toEqual(bytes);
  });

  it('resumes exact adjudication after the opaque bytes moved but before tombstone retirement', () => {
    const bytes = Buffer.from('{"future":"resolved-move"}\n');
    const tombstone = activeTombstone(bytes, 'future-resolved-move.json');

    expect(() => adjudicateTombstone(
      profileKey,
      tombstone.identity,
      tombstone.generation,
      tombstone.evidence,
      tombstone.evidence,
      { afterResolvedMove: () => { throw new Error('test_crash:after_resolved_move'); } },
    )).toThrow('test_crash:after_resolved_move');

    const d = profileDirs(profileKey);
    expect(existsSync(join(d.tombstones, `${tombstone.identity}.json`))).toBe(true);
    expect(existsSync(join(d.quarantine, `${tombstone.identity}.opaque`))).toBe(false);
    expect(existsSync(join(d.resolved, `${tombstone.identity}.opaque`))).toBe(true);
    const pending = statusList(profileKey).items!.find(
      (item) => item.kind === 'blocking_tombstone' && item.identity === tombstone.identity,
    );
    expect(pending?.cause).toBe('adjudication_resolution_incomplete');

    expect(adjudicateTombstone(
      profileKey,
      tombstone.identity,
      tombstone.generation,
      tombstone.evidence,
      tombstone.evidence,
    ).state).toBe('cleared');
    expect(statusList(profileKey).state).toBe('none');
    expect(readFileSync(join(d.resolved, `${tombstone.identity}.opaque`))).toEqual(bytes);
  });
});
