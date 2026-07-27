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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { destinationIdentityForPath } from '../chatgpt-browser-turn/coordination.ts';
import { publicationStatus, publishReply } from '../chatgpt-browser-turn/publication.ts';
import { runtimeCapabilityBinding } from '../chatgpt-browser-turn/runtime-binding.ts';
import {
  adjudicateTombstone,
  applyCapabilityAfterSuccessfulTurn,
  capabilityStatus,
  mutateCapabilityAdmissionPolicy,
  quarantineOpaque,
  statusList,
  __testWriteCapability,
} from '../chatgpt-browser-turn/state.ts';
import { atomicJson, configuredProfileKey, profileDirs, sha256 } from '../chatgpt-browser-turn/storage-common.ts';
import * as coordination from '../chatgpt-browser-turn/coordination.ts';
import { readDriverDiagnostic } from '../chatgpt-browser-turn/diagnostics.ts';
import { classifyProductWall, productStatusText, witnessSurfaceProbeRequiresDowngrade } from '../chatgpt-browser-turn/ui-adapter.ts';

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

describe('issue 1028 capability policy race safety', () => {
  function completion(binding: ReturnType<typeof runtimeCapabilityBinding>, evidence: string, browser = 'Chromium test') {
    return {
      expectedBinding: binding,
      browserProvenance: browser,
      evidenceDigest: sha256(evidence),
      witnessed: true,
    };
  }

  function capabilityFixture(
    binding: ReturnType<typeof runtimeCapabilityBinding>,
    overrides: Partial<{
      browser_provenance: string;
      evidence_digest: string;
      characterized_at: string;
      admission_policy: 'parallel' | 'serialized';
      admission_epoch: number;
    }> = {},
  ) {
    const now = Date.now();
    return {
      ...binding,
      browser_provenance: 'Chromium test',
      evidence_digest: sha256('capability-fixture'),
      characterized_at: new Date(now - 1_000).toISOString(),
      admission_policy: 'parallel' as const,
      admission_epoch: 0,
      ...overrides,
    };
  }

  it('ignores stale gate export while a serialized no-evidence turn characterizes only', () => {
    const staleGateEnv = ['CHATGPT', 'BROWSER', 'TURN', 'GATE', 'B', 'DIGEST'].join('_');
    process.env[staleGateEnv] = 'definitely-wrong';
    try {
      const binding = runtimeCapabilityBinding(profileKey, cdp);
      expect(capabilityStatus(profileKey, binding).state).toBe('no_evidence');
      const outcome = applyCapabilityAfterSuccessfulTurn(profileKey, completion(binding, 'wrong-export-ignored'));
      expect(outcome.applied).toBe(true);
      expect(capabilityStatus(profileKey, binding).state).toBe('downgraded');
    } finally {
      delete process.env[staleGateEnv];
    }
  });

  it('does not let a stale parallel completion overwrite a newer serialized epoch', () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    __testWriteCapability(profileKey, capabilityFixture(binding));
    const admitted = capabilityStatus(profileKey, binding);
    expect(admitted.state).toBe('ok');

    __testWriteCapability(profileKey, capabilityFixture(binding, {
      admission_policy: 'serialized',
      admission_epoch: 1,
      evidence_digest: sha256('newer-serialize'),
    }));

    const outcome = applyCapabilityAfterSuccessfulTurn(
      profileKey,
      completion(binding, 'stale-parallel-completion'),
    );
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe('not_eligible');
    const current = capabilityStatus(profileKey, binding);
    expect(current.capability?.admission_epoch).toBe(1);
    expect(current.capability?.admission_policy).toBe('serialized');
  });

  it('refuses capability mutation when witnessed is false even with parallel policy', () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    __testWriteCapability(profileKey, capabilityFixture(binding));
    const outcome = applyCapabilityAfterSuccessfulTurn(profileKey, {
      ...completion(binding, 'stale-pre-send-probe'),
      witnessed: false,
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe('not_witnessed');
    expect(capabilityStatus(profileKey, binding).capability?.admission_epoch).toBe(0);
  });

  it('keeps repeated keeper-free witness failures invocation-local without policy mutation', () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    const initial = capabilityFixture(binding, {
      evidence_digest: sha256('stable-operator-policy'),
      admission_epoch: 7,
    });
    __testWriteCapability(profileKey, initial);

    for (let attempt = 0; attempt < 3; attempt++) {
      expect(witnessSurfaceProbeRequiresDowngrade('absent', false)).toBe(true);
      const outcome = applyCapabilityAfterSuccessfulTurn(profileKey, {
        ...completion(binding, `unwitnessed-${attempt}`),
        witnessed: false,
      });
      expect(outcome).toMatchObject({ applied: false, reason: 'not_witnessed' });
    }

    const current = capabilityStatus(profileKey, binding);
    expect(current.state).toBe('ok');
    expect(current.capability?.admission_policy).toBe('parallel');
    expect(current.capability?.admission_epoch).toBe(7);
    expect(current.capability?.evidence_digest).toBe(initial.evidence_digest);
  });
});

describe('issue 1028 invocation-local witness surface fallback', () => {
  it('does not request fallback when a fresh conversation has zero nodes', () => {
    expect(witnessSurfaceProbeRequiresDowngrade('empty', true)).toBe(false);
  });

  it('requests fallback for an existing conversation that reports zero nodes', () => {
    expect(witnessSurfaceProbeRequiresDowngrade('empty', false)).toBe(true);
  });

  it('requests fallback when the probe query throws', () => {
    expect(witnessSurfaceProbeRequiresDowngrade('absent', false)).toBe(true);
    expect(witnessSurfaceProbeRequiresDowngrade('absent', true)).toBe(true);
  });

  it('requests fallback when a populated conversation probe finds no causal relation', () => {
    expect(witnessSurfaceProbeRequiresDowngrade('absent', false)).toBe(true);
    expect(witnessSurfaceProbeRequiresDowngrade('available', false)).toBe(false);
    expect(witnessSurfaceProbeRequiresDowngrade('available', true)).toBe(false);
  });

  it('records a driver diagnostic when capability mutation lock release fails without changing the mutation outcome', () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    const now = Date.now();
    const invocationId = 'capability-lock-release-test';
    __testWriteCapability(profileKey, {
      ...binding,
      browser_provenance: 'Chromium test',
      evidence_digest: sha256('lock-release-seed'),
      characterized_at: new Date(now - 1_000).toISOString(),
      admission_policy: 'parallel',
      admission_epoch: 0,
    });
    const originalAcquire = coordination.acquireDomainLock;
    vi.spyOn(coordination, 'acquireDomainLock').mockImplementation((profileKeyArg, key, staleMs) => {
      const lock = originalAcquire(profileKeyArg, key, staleMs);
      if (!lock || !key.startsWith('capability-mutation:')) return lock;
      return {
        ...lock,
        release: () => { throw new Error('test capability mutation lock release failed'); },
      };
    });
    const outcome = applyCapabilityAfterSuccessfulTurn(profileKey, {
      expectedBinding: binding,
      browserProvenance: 'Chromium test',
      evidenceDigest: sha256('lock-release-success'),
      witnessed: true,
      invocationId,
    });
    expect(outcome.applied).toBe(true);
    const diagnostic = readDriverDiagnostic(profileKey, invocationId);
    expect(diagnostic?.cause).toBe('capability_mutation_lock_release_failed');
    vi.restoreAllMocks();
  });
});
