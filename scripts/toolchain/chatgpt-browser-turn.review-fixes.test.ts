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
import { classifyPreDispatchProductWall, classifyProductWall, observePreDispatchBlockerHint, openTurnPage, productStatusText, witnessSurfaceProbeRequiresDowngrade, __testTiming, sendTurn, createPreSendSegmentBudget, type BrowserConfig } from '../chatgpt-browser-turn/ui-adapter.ts';
import { fakeTurnPage } from '../chatgpt-browser-turn/fixtures/fake-turn-page.ts';
import { liveTurnStreamSequence } from '../chatgpt-browser-turn/fixtures/live-turn-stream-contract.ts';

import { mkdirSync, symlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireDomainLock } from '../chatgpt-browser-turn/coordination.ts';
import {
  createFreshIdentityRetention,
  normalizeConversationUrl,
  observeFreshConversationUrl,
  resolveCanonicalFreshConversation,
} from '../chatgpt-browser-turn/ui-adapter.ts';
import {
  configuredProfileIdentity,
  legacyConfiguredProfileIdentity,
  isWindowsBackedProfilePath,
  legacyProfileKeyAmbiguous,
  profileNamespaceExists,
  profileStoreRoot,
  resolveConfiguredProfile,
} from '../chatgpt-browser-turn/storage-common.ts';
import {
  listReadableIncidents,
  profileStartupCompatibility,
  statusListForConfiguredProfile,
  writeIncident,
} from '../chatgpt-browser-turn/state.ts';
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

  it('refreshes characterization after serialize without admission-epoch gating', () => {
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
      completion(binding, 'post-serialize-refresh'),
    );
    expect(outcome.applied).toBe(true);
    const current = capabilityStatus(profileKey, binding);
    expect(current.capability?.admission_epoch).toBe(1);
    expect(current.capability?.admission_policy).toBe('serialized');
    expect(current.capability?.evidence_digest).toBe(sha256('post-serialize-refresh'));
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


describe('issue 1023 timeout diagnostics', () => {
  it('AC7: before-send browser timeout records distinguishable driver diagnostic operation', async () => {
    vi.resetModules();
    vi.doMock('../chatgpt-browser-turn/ui-adapter.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../chatgpt-browser-turn/ui-adapter.ts')>();
      return {
        ...actual,
        verifyProfile: vi.fn(async () => {
          throw new actual.BrowserOperationTimeoutError('owner_probe');
        }),
      };
    });
    const { runCli } = await import('../chatgpt-browser-turn.ts');
    const input = join(root, 'timeout-input.txt');
    const output = join(root, 'timeout-diagnostic.txt');
    writeFileSync(input, 'hello\n');
    let stdout = '';
    const originalStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    const exitCode = await runCli([
      'turn',
      '--profile', join(root, 'profile'),
      '--cdp', cdp,
      '--input', input,
      '--output', output,
      '--chat-url', 'https://chatgpt.com/c/example',
      '--timeout-ms', '30000',
    ]);
    process.stdout.write = originalStdout;
    vi.resetModules();
    expect(exitCode).toBe(13);
    const body = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(body.cause).toBe('driver_exception_before_send');
    expect(body.driver_diagnostic_id).toBeDefined();
    const diagnostic = readDriverDiagnostic(profileKey, String(body.invocation_id));
    expect(diagnostic?.operation).toBe('browser_operation_timeout:owner_probe');
  });
});


describe('issue 1023 runTurn timeout integration', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../chatgpt-browser-turn/ui-adapter.ts');
    vi.doUnmock('../chatgpt-browser-turn/state.ts');
    vi.doUnmock('../chatgpt-browser-turn/publication.ts');
  });

  function turnArgvFor(outputPath: string, flags: string[] = [], includeChatUrl = true): string[] {
    const input = join(root, `turn-input-${randomUUID()}.txt`);
    writeFileSync(input, 'turn payload\n');
    return [
      'turn',
      '--profile', join(root, 'profile'),
      '--cdp', cdp,
      '--input', input,
      '--output', outputPath,
      ...(includeChatUrl ? ['--chat-url', 'https://chatgpt.com/c/fixture-conv'] : []),
      ...flags,
    ];
  }

  async function runWithSendMock(
    argv: string[],
    sendResult: Record<string, unknown>,
    publicationStub = true,
  ): Promise<number> {
    vi.resetModules();
    const stubPage = {
      close: vi.fn(async () => {}),
      goto: vi.fn(async () => {}),
      url: () => 'https://chatgpt.com/c/fixture-conv',
      bringToFront: vi.fn(async () => {}),
    };
    const stubBrowser = {
      close: vi.fn(async () => {}),
      version: () => 'chromium-fixture',
      contexts: () => [{ pages: () => [] }],
    };
    vi.doMock('../chatgpt-browser-turn/ui-adapter.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../chatgpt-browser-turn/ui-adapter.ts')>();
      const verified = { state: 'verified' as const, cause: 'ok' };
      return {
        ...actual,
        verifyProfile: vi.fn(async () => verified),
        loadChromium: vi.fn(() => ({ connectOverCDP: vi.fn(async () => stubBrowser) })),
        openTurnPage: vi.fn(async () => ({ page: stubPage, owned: true, provisionalId: randomUUID() })),
        runtimeWitnessSurfaceAvailable: vi.fn(async () => 'available' as const),
        sendTurn: vi.fn(async () => sendResult),
      };
    });
    if (publicationStub) {
      vi.doMock('../chatgpt-browser-turn/publication.ts', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../chatgpt-browser-turn/publication.ts')>();
        return {
          ...actual,
          publishReply: vi.fn(() => ({ state: 'committed_ok', output_bytes: 13, output_sha256: 'sha256:fixture' })),
        };
      });
    }
    const { runCli } = await import('../chatgpt-browser-turn.ts');
    return runCli(argv);
  }

  it('AC5: stream_timeout after possible delivery durably records conversation_incident via runTurn', async () => {
    const output = join(root, 'ac5-runturn-out.txt');
    const exitCode = await runWithSendMock(turnArgvFor(output), {
      state: 'stream_timeout',
      cause: 'no_terminal_evidence',
      possibleDelivery: true,
      userMessageId: 'user-owned-12345678',
    });
    expect(exitCode).toBe(11);
    const listed = statusList(profileKey);
    expect(listed.items?.some((item) => item.kind === 'conversation_incident' && item.phase === 'possible_delivery')).toBe(true);
  });

  it('AC12: new-chat stream_timeout with unproven identity becomes fresh_orphan via runTurn', async () => {
    const output = join(root, 'ac12-runturn-out.txt');
    const exitCode = await runWithSendMock(
      turnArgvFor(output, ['--new-chat', '--project-url', 'https://chatgpt.com/g/g-p-6a5dae8454f88191b03140356941cf89-issues/project'], false),
      {
        state: 'stream_timeout',
        cause: 'no_terminal_evidence',
        possibleDelivery: true,
        userMessageId: 'user-owned-12345678',
      },
    );
    expect(exitCode).toBe(12);
    const listed = statusList(profileKey);
    expect(listed.items?.some((item) => item.kind === 'fresh_orphan' && item.phase === 'possible_delivery')).toBe(true);
  });

  it('AC8: successful runTurn publication remains exactly-once after cleanup-unconfirmed', async () => {
    const output = join(root, 'ac8-runturn-out.txt');
    const exitCode = await runWithSendMock(
      turnArgvFor(output),
      {
        state: 'ok',
        cause: 'completed',
        possibleDelivery: true,
        reply: 'committed reply text',
        userMessageId: 'user-fixture-12345678',
        assistantMessageId: 'asst-fixture-12345678',
        conversationId: 'https://chatgpt.com/c/fixture-conv',
      },
      false,
    );
    expect(exitCode).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('committed reply text');
    const invocations = readdirSync(profileDirs(profileKey).publications);
    const invocationId = invocations.find((name) => name.endsWith('.json'))!.replace('.json', '');
    expect(publicationStatus(profileKey, invocationId).state).toBe('committed_ok');
    const { boundedResourceCleanup } = await import('../chatgpt-browser-turn/browser-session.ts');
    const cleanup = await boundedResourceCleanup(() => new Promise<void>(() => {}), 50);
    expect(cleanup).toBe('unconfirmed');
    expect(publicationStatus(profileKey, invocationId).state).toBe('committed_ok');
    expect(readFileSync(output, 'utf8')).toBe('committed reply text');
  });
});


const issue1025HalfBCdp = 'http://127.0.0.1:9222';
const issue1025HalfBBaseConfig = (overrides: Partial<BrowserConfig> = {}): BrowserConfig => ({
  cdp: issue1025HalfBCdp,
  profile: 'automation',
  chatUrl: 'https://chatgpt.com/c/example',
  newChat: false,
  timeoutMs: 60_000,
  ...overrides,
});

describe('issue 1025 Half B finished reply without terminal', () => {
  const own = 'user-owned-12345678';
  const assistantId = 'assistant-owned-12345678';

  function finishedReplyFixture(overrides: Parameters<typeof fakeTurnPage>[0] = {}) {
    return fakeTurnPage({
      dispatchCandidateIds: [own],
      serviceFrames: [
        {
          type: 'input_message',
          input_message: {
            id: own,
            author: { role: 'user' },
            content: { content_type: 'text', parts: ['payload'] },
          },
        },
        {
          message: {
            id: assistantId,
            author: { role: 'assistant' },
            parent: own,
            content: { content_type: 'text', parts: ['finished reply text'] },
          },
        },
      ],
      assistants: [{
        id: assistantId,
        parent: own,
        text: 'finished reply text',
        streaming: false,
      }],
      ...overrides,
    });
  }

  it('AC5 exits promptly as recovery_required reply_finished_terminal_unproven without publication', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = finishedReplyFixture();
    fixture.page.waitForTimeout = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    };
    const started = Date.now();
    const turn = sendTurn(fixture.page, 'payload', { ...issue1025HalfBBaseConfig(), timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await turn;
    expect(result).toMatchObject({
      state: 'recovery_required',
      cause: 'reply_finished_terminal_unproven',
      possibleDelivery: true,
      userMessageId: own,
      assistantMessageId: assistantId,
    });
    expect(result.reply).toBeUndefined();
    expect(Date.now() - started).toBeLessThanOrEqual(30_000);
  });

  it('AC5 live in_progress service shape without resolvable terminal still early-exits', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const turnId = 'turn-live-12345678';
    const liveFrames = liveTurnStreamSequence(own, assistantId, { turnId }, { replyText: 'finished reply text' });
    const unresolvedTerminalFrames = liveFrames.filter((frame) => {
      const payload = (frame as { payload?: { payload?: { encoded_item?: string } } }).payload?.payload?.encoded_item ?? '';
      return !payload.includes('"o":"patch"') || !payload.includes('finished_successfully');
    });
    const fixture = finishedReplyFixture({
      serviceFrames: unresolvedTerminalFrames,
    });
    fixture.page.waitForTimeout = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    };
    const turn = sendTurn(fixture.page, 'payload', { ...issue1025HalfBBaseConfig(), timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await turn;
    expect(result).toMatchObject({
      state: 'recovery_required',
      cause: 'reply_finished_terminal_unproven',
      possibleDelivery: true,
      userMessageId: own,
      assistantMessageId: assistantId,
    });
  });

  it('AC6 stable text with active generation UI does not early-exit', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = finishedReplyFixture({
      pageLevelStopButton: true,
      assistants: [{
        id: assistantId,
        parent: own,
        text: 'finished reply text',
        streaming: false,
      }],
    });
    fixture.page.waitForTimeout = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    };
    const turn = sendTurn(fixture.page, 'payload', { ...issue1025HalfBBaseConfig(), timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(5_100);
    const result = await turn;
    expect(result.cause).not.toBe('reply_finished_terminal_unproven');
    expect(result.state).toBe('stream_timeout');
  });

  it('AC5 explicit end_turn:false metadata does not suppress finished-reply early exit', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = finishedReplyFixture({
      serviceFrames: [
        {
          type: 'input_message',
          input_message: {
            id: own,
            author: { role: 'user' },
            content: { content_type: 'text', parts: ['payload'] },
          },
        },
        {
          type: 'delta',
          v: {
            message: {
              id: assistantId,
              author: { role: 'assistant' },
              parent: own,
              end_turn: false,
              content: { content_type: 'text', parts: ['finished reply text'] },
            },
          },
        },
      ],
    });
    fixture.page.waitForTimeout = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    };
    const turn = sendTurn(fixture.page, 'payload', { ...issue1025HalfBBaseConfig(), timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await turn;
    expect(result).toMatchObject({
      state: 'recovery_required',
      cause: 'reply_finished_terminal_unproven',
      possibleDelivery: true,
      userMessageId: own,
      assistantMessageId: assistantId,
    });
  });

  it('AC5 node-local finish_details:stop without whole-turn terminal still early-exits', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = finishedReplyFixture({
      serviceFrames: [
        {
          type: 'input_message',
          input_message: {
            id: own,
            author: { role: 'user' },
            content: { content_type: 'text', parts: ['payload'] },
          },
        },
        {
          type: 'delta',
          v: {
            message: {
              id: assistantId,
              author: { role: 'assistant' },
              parent: own,
              end_turn: false,
              metadata: { finish_details: { type: 'stop' } },
              content: { content_type: 'text', parts: ['finished reply text'] },
            },
          },
        },
      ],
    });
    fixture.page.waitForTimeout = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    };
    const turn = sendTurn(fixture.page, 'payload', { ...issue1025HalfBBaseConfig(), timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await turn;
    expect(result).toMatchObject({
      state: 'recovery_required',
      cause: 'reply_finished_terminal_unproven',
      possibleDelivery: true,
      userMessageId: own,
      assistantMessageId: assistantId,
    });
    expect(result.reply).toBeUndefined();
  });

  it('AC5 terminal evidence arriving during finished-reply probes wins over recovery exit', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = finishedReplyFixture({
      lateTerminalFramesOnPoll: {
        poll: 1,
        frames: [{
          type: 'delta',
          v: {
            message: {
              id: assistantId,
              author: { role: 'assistant' },
              parent: own,
              end_turn: true,
              metadata: { finish_details: { type: 'stop' } },
            },
          },
        }],
      },
    });
    const originalWaitForTimeout = fixture.page.waitForTimeout?.bind(fixture.page);
    fixture.page.waitForTimeout = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      if (originalWaitForTimeout) await originalWaitForTimeout(ms);
    };
    const turn = sendTurn(fixture.page, 'payload', { ...issue1025HalfBBaseConfig(), timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await turn;
    expect(result.state).toBe('ok');
    expect(result.cause).toBe('completed');
    expect(result.cause).not.toBe('reply_finished_terminal_unproven');
  });

  it('AC7 suppresses finished-reply diagnosis while awaiting fresh terminal after continuation', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = finishedReplyFixture({
      continueGenerating: {
        hideAfterClick: true,
        growthSequence: ['finished reply text'],
      },
    });
    fixture.page.waitForTimeout = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    };
    const turn = sendTurn(fixture.page, 'payload', { ...issue1025HalfBBaseConfig(), timeoutMs: 8_000 });
    await vi.advanceTimersByTimeAsync(8_100);
    const result = await turn;
    expect(result.cause).not.toBe('reply_finished_terminal_unproven');
  });

  it('AC8 foreign user activity wins before finished-reply diagnosis', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = finishedReplyFixture({
      foreignDomUserIds: ['foreign-user-12345678'],
    });
    fixture.page.waitForTimeout = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    };
    const turn = sendTurn(fixture.page, 'payload', { ...issue1025HalfBBaseConfig(), timeoutMs: 8_000 });
    await vi.advanceTimersByTimeAsync(8_100);
    const result = await turn;
    expect(result.state).toBe('foreign_activity');
    expect(result.cause).not.toBe('reply_finished_terminal_unproven');
  });
});

const issue1068RepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('issue 1068 durable fresh identity and profile keys', () => {
  let issue1068Root = '';

  beforeEach(() => {
    issue1068Root = mkdtempSync(join(tmpdir(), 'opk-1068-'));
    process.env.CHATGPT_BROWSER_TURN_STATE_DIR = join(issue1068Root, 'state');
  });

  afterEach(() => {
    delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
    if (issue1068Root) rmSync(issue1068Root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

function conversationUrlFromPrefix(prefix: string, conversationUuid: string): string {
  return normalizeConversationUrl(`${prefix.replace(/\/+$/, '')}/c/${conversationUuid}`);
}

function correlatedNetwork(userMessageId: string, conversationId: string): any {
  return {
    messages: [{ id: userMessageId, role: 'user', conversationId }],
    serviceSubmittedUserIds: new Set([userMessageId]),
  };
}

describe('issue 1068 profile identity and legacy keys', () => {
  it('AC4: native Linux case-distinct profile directories derive distinct keys', () => {
    if (process.platform === 'win32') return;
    const parent = join(issue1068Root, 'case-parent');
    const upper = join(parent, 'ProfileCase');
    const lower = join(parent, 'profilecase');
    mkdirSync(upper, { recursive: true });
    mkdirSync(lower, { recursive: true });
    expect(configuredProfileKey(upper, cdp)).not.toBe(configuredProfileKey(lower, cdp));
    expect(configuredProfileIdentity(upper)).not.toBe(configuredProfileIdentity(lower));
  });

  it('AC4/AC5: CDP-owner normalization uses the same filesystem semantics', async () => {
    const ownerPath = join(issue1068RepoRoot, '.claude', 'skills', 'discuss-with-gpt', 'verify-cdp-owner.mjs');
    const owner = await import(pathToFileURL(ownerPath).href) as { normalizeProfilePath(path: string): string };
    if (process.platform !== 'win32') {
      const parent = join(issue1068Root, 'owner-case');
      const upper = join(parent, 'OwnerProfile');
      const lower = join(parent, 'ownerprofile');
      mkdirSync(upper, { recursive: true });
      mkdirSync(lower, { recursive: true });
      expect(owner.normalizeProfilePath(upper)).not.toBe(owner.normalizeProfilePath(lower));
    }
    expect(owner.normalizeProfilePath('C:\\Users\\Automation\\Profile'))
      .toBe(owner.normalizeProfilePath('/mnt/c/Users/Automation/Profile'));
  });

  it('AC5: deterministic Windows-drive and /mnt aliases stay stable', () => {
    const windows = 'C:\\Users\\Automation\\Profile';
    const wsl = '/mnt/c/Users/Automation/Profile';
    expect(configuredProfileKey(windows, cdp)).toBe(configuredProfileKey(wsl, cdp));
    expect(configuredProfileIdentity(windows)).toBe(configuredProfileIdentity(wsl));
  });

  it('AC8: unresolvable case-distinct spellings do not collapse via lexical lowercasing', () => {
    if (process.platform === 'win32') return;
    const parent = join(issue1068Root, 'unresolved-parent');
    mkdirSync(parent, { recursive: true });
    const mixed = join(parent, 'MixedProfile');
    const folded = join(parent, 'mixedprofile');
    expect(configuredProfileKey(mixed, cdp)).not.toBe(configuredProfileKey(folded, cdp));
    expect(legacyConfiguredProfileIdentity(mixed)).toBe(legacyConfiguredProfileIdentity(folded));
  });

  it('AC6: active legacy possible_delivery blocks startup on the new key', () => {
    const profile = join(issue1068Root, 'Profile');
    mkdirSync(profile, { recursive: true });
    const resolved = resolveConfiguredProfile(profile, cdp);
    expect(resolved.keysDiffer).toBe(true);
    writeIncident(resolved.legacyProfileKey, {
      kind: 'conversation_incident',
      generation: 1,
      phase: 'possible_delivery',
      conversation_id: 'https://chatgpt.com/c/legacy',
      cause: 'stream_timeout',
    });
    const blocked = profileStartupCompatibility(profile, cdp);
    expect(blocked?.state).toBe('profile_blocked');
    expect(blocked?.cause).toBe('legacy_profile_namespace_active');
    expect(blocked?.legacy_namespace_root).toBe(profileStoreRoot(resolved.legacyProfileKey));
  });

  it('AC9: status/list merges safety-bearing legacy namespace items', () => {
    const profile = join(issue1068Root, 'Profile');
    mkdirSync(profile, { recursive: true });
    const resolved = resolveConfiguredProfile(profile, cdp);
    const incident = writeIncident(resolved.legacyProfileKey, {
      kind: 'fresh_orphan',
      generation: 1,
      phase: 'possible_delivery',
      provisional_id: randomUUID(),
      cause: 'canonical_fresh_conversation_unproven',
    });
    const listed = statusListForConfiguredProfile(profile, cdp);
    expect(listed.legacy_configured_profile_key).toBe(resolved.legacyProfileKey);
    expect(listed.items?.some((item) => item.identity === incident.identity && item.kind === 'fresh_orphan')).toBe(true);
  });

  it('AC9: existing status and clear commands operate on a legacy incident', async () => {
    const profile = join(issue1068Root, 'Profile');
    mkdirSync(profile, { recursive: true });
    const resolved = resolveConfiguredProfile(profile, cdp);
    const incident = writeIncident(resolved.legacyProfileKey, {
      kind: 'conversation_incident',
      generation: 3,
      phase: 'possible_delivery',
      conversation_id: 'https://chatgpt.com/c/legacy-clear',
      cause: 'stream_timeout',
    });
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
    const { runCli } = await import('../chatgpt-browser-turn.ts');
    await runCli(['status/list', '--profile', profile, '--cdp', cdp]);
    expect(chunks.join('')).toContain(incident.identity);
    chunks.length = 0;
    await runCli([
      'clear', '--profile', profile, '--cdp', cdp,
      '--identity', incident.identity,
      '--generation', String(incident.record.generation),
      '--evidence-token', incident.record.evidence_token,
    ]);
    write.mockRestore();
    expect(chunks.join('')).toContain('cleared');
    expect(listReadableIncidents(resolved.legacyProfileKey)).toHaveLength(0);
  });

  it('AC7: legacy safety classes refuse startup instead of using an empty new namespace', () => {
    const profile = join(issue1068Root, 'Profile');
    mkdirSync(profile, { recursive: true });
    const resolved = resolveConfiguredProfile(profile, cdp);
    const seeds: Array<() => (() => void) | void> = [
      () => { writeIncident(resolved.legacyProfileKey, {
        kind: 'conversation_incident',
        generation: 1,
        phase: 'possible_delivery',
        conversation_id: 'https://chatgpt.com/c/a',
        cause: 'stream_timeout',
      }); },
      () => { writeIncident(resolved.legacyProfileKey, {
        kind: 'profile_wall',
        generation: 1,
        phase: 'pre_send',
        cause: 'quota',
      }); },
      () => {
        const lock = acquireDomainLock(resolved.legacyProfileKey, 'fresh:legacy-lock');
        expect(lock).not.toBeNull();
        return () => lock?.release();
      },
      () => {
        writeFileSync(join(profileDirs(resolved.legacyProfileKey).quarantine, 'legacy.opaque'), 'opaque');
      },
      () => {
        writeFileSync(join(profileDirs(resolved.legacyProfileKey).tombstones, 'legacy.json'), '{}');
      },
      () => {
        writeFileSync(join(profileDirs(resolved.legacyProfileKey).publications, `${randomUUID()}.json`), '{}');
      },
    ];
    for (const seed of seeds) {
      rmSync(join(issue1068Root, 'state'), { recursive: true, force: true });
      process.env.CHATGPT_BROWSER_TURN_STATE_DIR = join(issue1068Root, 'state');
      const cleanup = seed();
      expect(profileStartupCompatibility(profile, cdp)?.cause).toBe('legacy_profile_namespace_active');
      expect(profileNamespaceExists(resolved.profileKey)).toBe(false);
      cleanup?.();
    }
  });

  it('AC7/AC10: diagnostic-only legacy bytes do not revive profile-wide admission', () => {
    const profile = join(issue1068Root, 'Profile');
    mkdirSync(profile, { recursive: true });
    const resolved = resolveConfiguredProfile(profile, cdp);
    writeFileSync(join(profileDirs(resolved.legacyProfileKey).diagnostics, 'note.json'), '{}');
    expect(profileStartupCompatibility(profile, cdp)).toBeNull();

    const currentLock = acquireDomainLock(resolved.profileKey, 'fresh:independent');
    expect(currentLock).not.toBeNull();
    expect(statusList(resolved.profileKey).state).not.toBe('profile_blocked');
    currentLock?.release();
  });

  it('marks ambiguous when case-distinct siblings exist on native Linux', () => {
    if (process.platform === 'win32') return;
    const parent = join(issue1068Root, 'ambiguous-parent');
    const upper = join(parent, 'ProfileA');
    const lower = join(parent, 'profilea');
    mkdirSync(upper, { recursive: true });
    mkdirSync(lower, { recursive: true });
    if (!existsSync(upper) || !existsSync(lower) || upper === lower) return;
    expect(legacyProfileKeyAmbiguous(upper)).toBe(true);
    const resolved = resolveConfiguredProfile(upper, cdp);
    writeIncident(resolved.legacyProfileKey, {
      kind: 'conversation_incident',
      generation: 1,
      phase: 'possible_delivery',
      cause: 'stream_timeout',
    });
    expect(profileStartupCompatibility(upper, cdp)?.cause).toBe('legacy_profile_key_ambiguous');
  });


  it('marks ambiguous when case collisions exist in ancestor path components', () => {
    if (process.platform === 'win32') return;
    const parent = join(issue1068Root, 'TenantParent');
    const upper = join(parent, 'Tenant', 'Profile');
    const lower = join(parent, 'tenant', 'Profile');
    mkdirSync(upper, { recursive: true });
    mkdirSync(lower, { recursive: true });
    expect(legacyProfileKeyAmbiguous(upper)).toBe(true);
  });

  it('AC9: publication-status surfaces legacy profile blocks on the new key', async () => {
    const profile = join(issue1068Root, 'Profile');
    mkdirSync(profile, { recursive: true });
    const resolved = resolveConfiguredProfile(profile, cdp);
    if (!resolved.keysDiffer) return;
    writeIncident(resolved.legacyProfileKey, {
      kind: 'conversation_incident',
      generation: 1,
      phase: 'possible_delivery',
      conversation_id: 'https://chatgpt.com/c/legacy-possible',
      cause: 'stream_timeout',
    });
    const { runCli } = await import('../chatgpt-browser-turn.ts');
    let stdout = '';
    const originalStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    const exitCode = await runCli(['publication-status', '--profile', profile, '--cdp', cdp, '--invocation', randomUUID()]);
    process.stdout.write = originalStdout;
    const body = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(exitCode).toBe(21);
    expect(body.state).toBe('profile_blocked');
  });


  it('AC4: /mnt/<drive> paths are not case-insensitive on native Linux by pathname shape', () => {
    if (process.platform === 'win32') return;
    const upper = '/mnt/c/Users/Automation/Profile';
    const lower = '/mnt/c/users/automation/profile';
    expect(isWindowsBackedProfilePath(upper)).toBe(false);
    expect(configuredProfileKey(upper, cdp)).not.toBe(configuredProfileKey(lower, cdp));
    expect(configuredProfileIdentity(upper)).not.toBe(configuredProfileIdentity(lower));
  });

  it('blocks clear from mutating ambiguous legacy namespace incidents', async () => {
    if (process.platform === 'win32') return;
    const parent = join(issue1068Root, 'clear-ambiguous-parent');
    const upper = join(parent, 'ProfileA');
    const lower = join(parent, 'profilea');
    mkdirSync(upper, { recursive: true });
    mkdirSync(lower, { recursive: true });
    if (!existsSync(upper) || !existsSync(lower) || upper === lower) return;
    const resolved = resolveConfiguredProfile(upper, cdp);
    const incident = writeIncident(resolved.legacyProfileKey, {
      kind: 'conversation_incident',
      generation: 2,
      phase: 'possible_delivery',
      conversation_id: 'https://chatgpt.com/c/legacy-only',
      cause: 'stream_timeout',
    });
    const { runCli } = await import('../chatgpt-browser-turn.ts');
    let stdout = '';
    const originalStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    const exitCode = await runCli([
      'clear', '--profile', upper, '--cdp', cdp,
      '--identity', incident.identity,
      '--generation', String(incident.record.generation),
      '--evidence-token', incident.record.evidence_token,
    ]);
    process.stdout.write = originalStdout;
    expect(exitCode).toBe(21);
    const body = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(body.state).toBe('profile_blocked');
    expect(body.cause).toBe('legacy_profile_clear_ambiguous');
    expect(listReadableIncidents(resolved.legacyProfileKey)).toHaveLength(1);
  });

  it('resolves symlink aliases to the same configured profile key', () => {
    const actual = join(issue1068Root, 'Profile-Actual');
    const alias = join(issue1068Root, 'profile-alias');
    mkdirSync(actual);
    symlinkSync(actual, alias, 'dir');
    expect(configuredProfileKey(actual, cdp)).toBe(configuredProfileKey(alias, cdp));
  });
});

describe('issue 1068 fresh canonical identity retention', () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-fixture/project';
  const conversationUuid = '6a65acd9-4d44-83ec-bcb9-5787832fac24';
  const inProjectConversation = `https://chatgpt.com/g/g-p-fixture/project/c/${conversationUuid}`;
  const outOfProjectConversation = `https://chatgpt.com/c/${conversationUuid}`;

  it('AC2: byte-identical in-project identity from URL and correlator fallback', () => {
    const userMessageId = 'user-owned-12345678';
    const config: BrowserConfig = { cdp, profile: 'automation', projectUrl, newChat: true, timeoutMs: 60_000 };
    const retention = createFreshIdentityRetention();
    observeFreshConversationUrl(retention, inProjectConversation, projectUrl);
    const fromUrl = resolveCanonicalFreshConversation(
      config,
      retention,
      { url: () => inProjectConversation },
      correlatedNetwork(userMessageId, conversationUuid),
      userMessageId,
    );
    expect(fromUrl).toBe(inProjectConversation);

    const fallback = createFreshIdentityRetention();
    const fromCorrelator = resolveCanonicalFreshConversation(
      config,
      fallback,
      undefined,
      correlatedNetwork(userMessageId, conversationUuid),
      userMessageId,
    );
    expect(fromCorrelator).toBe(conversationUrlFromPrefix(normalizeConversationUrl(projectUrl), conversationUuid));
    expect(fromCorrelator).toBe(inProjectConversation);
  });

  it('AC2: byte-identical out-of-project identity uses observed URL prefix', () => {
    const userMessageId = 'user-owned-12345678';
    const retention = createFreshIdentityRetention();
    observeFreshConversationUrl(retention, outOfProjectConversation, projectUrl);
    const fromCorrelator = resolveCanonicalFreshConversation(
      { cdp, profile: 'automation', projectUrl, newChat: true, timeoutMs: 60_000 },
      retention,
      { url: () => outOfProjectConversation },
      correlatedNetwork(userMessageId, conversationUuid),
      userMessageId,
    );
    expect(fromCorrelator).toBe(outOfProjectConversation);
  });

  it('AC2/AC3: fails closed without an own unambiguous service correlator or provable prefix', () => {
    const userMessageId = 'user-owned-12345678';
    const config: BrowserConfig = { cdp, profile: 'automation', projectUrl, newChat: true, timeoutMs: 60_000 };
    const noCorrelator = createFreshIdentityRetention();
    observeFreshConversationUrl(noCorrelator, inProjectConversation, projectUrl);
    expect(resolveCanonicalFreshConversation(config, noCorrelator, undefined, correlatedNetwork('foreign-user', conversationUuid), userMessageId))
      .toBeUndefined();

    const conflictingPrefixes = createFreshIdentityRetention();
    observeFreshConversationUrl(conflictingPrefixes, inProjectConversation, projectUrl);
    observeFreshConversationUrl(conflictingPrefixes, outOfProjectConversation, projectUrl);
    expect(resolveCanonicalFreshConversation(
      config,
      conflictingPrefixes,
      undefined,
      correlatedNetwork(userMessageId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
      userMessageId,
    )).toBeUndefined();
  });

  it('AC2/AC3: promotion is durable through its callback and monotonic across conflicts', () => {
    const retained: string[] = [];
    const userMessageId = 'user-owned-12345678';
    const config: BrowserConfig = { cdp, profile: 'automation', projectUrl, newChat: true, timeoutMs: 60_000 };
    const retention = createFreshIdentityRetention((identity) => retained.push(identity));
    observeFreshConversationUrl(retention, inProjectConversation, projectUrl);
    expect(resolveCanonicalFreshConversation(
      config,
      retention,
      undefined,
      correlatedNetwork(userMessageId, conversationUuid),
      userMessageId,
    )).toBe(inProjectConversation);
    expect(retained).toEqual([inProjectConversation]);
    expect(resolveCanonicalFreshConversation(
      config,
      retention,
      { url: () => { throw new Error('page_url_unreadable'); } },
      correlatedNetwork(userMessageId, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
      userMessageId,
    )).toBe(inProjectConversation);
    expect(retained).toEqual([inProjectConversation]);
  });


  it('rejects foreign observed chat prefix when correlating service UUID', () => {
    const userMessageId = 'user-owned-12345678';
    const foreignUuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const ownUuid = '6a65acd9-4d44-83ec-bcb9-5787832fac24';
    const foreignUrl = `https://chatgpt.com/c/${foreignUuid}`;
    const config: BrowserConfig = { cdp, profile: 'automation', projectUrl, newChat: true, timeoutMs: 60_000 };
    const retention = createFreshIdentityRetention();
    observeFreshConversationUrl(retention, foreignUrl, projectUrl);
    expect(resolveCanonicalFreshConversation(
      config,
      retention,
      undefined,
      correlatedNetwork(userMessageId, ownUuid),
      userMessageId,
    )).toBeUndefined();
  });

  it('AC2/AC3: realistic sendTurn fixture retains canonical identity across URL loss and blocks same-chat resend', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const profile = join(issue1068Root, 'Profile');
    mkdirSync(profile, { recursive: true });
    const pk = configuredProfileKey(profile, cdp);
    const conversationUuid = '6a65acd9-4d44-83ec-bcb9-5787832fac24';
    const canonicalUrl = conversationUrlFromPrefix(normalizeConversationUrl(projectUrl), conversationUuid);
    const own = 'user-owned-12345678';
    const assistantId = 'assistant-owned-12345678';
    const turnId = 'turn-owned-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      newChatUrlAfterArm: canonicalUrl,
      serviceFrames: [{
        conversation_id: conversationUuid,
        type: 'input_message',
        input_message: {
          id: own,
          author: { role: 'user' },
          content: { content_type: 'text', parts: ['payload'] },
        },
      }],
      assistants: [{ id: assistantId, parent: own, text: 'growing', streaming: true, appearOnSend: true }],
    });
    fixture.page.waitForTimeout = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    };
    const retained: string[] = [];
    const freshIdentity = createFreshIdentityRetention((identity) => retained.push(identity));
    const turn = sendTurn(fixture.page, 'payload', {
      cdp,
      profile,
      newChat: true,
      projectUrl,
      timeoutMs: 10_000,
    }, undefined, undefined, undefined, freshIdentity);
    await vi.advanceTimersByTimeAsync(10_500);
    const result = await turn;
    expect(result.state).toBe('stream_timeout');
    expect(result.conversationId).toBe(canonicalUrl);
    expect(retained).toEqual([canonicalUrl]);
    fixture.page.url = () => { throw new Error('page_url_unreadable'); };
    expect(resolveCanonicalFreshConversation(
      { cdp, profile, newChat: true, projectUrl, timeoutMs: 60_000 },
      freshIdentity,
      fixture.page,
    )).toBe(canonicalUrl);
    writeIncident(pk, {
      kind: 'conversation_incident',
      generation: 1,
      phase: 'possible_delivery',
      conversation_id: canonicalUrl,
      cause: 'no_terminal_evidence',
    });
    const input = join(issue1068Root, 'blocked-input.txt');
    const output = join(issue1068Root, 'blocked-output.txt');
    writeFileSync(input, 'retry\n');
    const { runCli } = await import('../chatgpt-browser-turn.ts');
    let stdout = '';
    const originalStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    const exitCode = await runCli([
      'turn', '--profile', profile, '--cdp', cdp,
      '--input', input, '--output', output,
      '--chat-url', canonicalUrl,
    ]);
    process.stdout.write = originalStdout;
    const body = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(exitCode).toBe(11);
    expect(body.state).toBe('conversation_busy');
    expect(body.cause).toBe('conversation_incident_active');
  });

  it('AC3: concurrent fresh-turn retention handles cannot steal each other\'s identity', () => {
    const uuidA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const uuidB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const userA = 'user-concurrent-a-12345678';
    const userB = 'user-concurrent-b-12345678';
    const urlA = `https://chatgpt.com/c/${uuidA}`;
    const urlB = `https://chatgpt.com/c/${uuidB}`;
    const config: BrowserConfig = { cdp, profile: 'automation', projectUrl, newChat: true, timeoutMs: 60_000 };
    const retentionA = createFreshIdentityRetention();
    const retentionB = createFreshIdentityRetention();
    observeFreshConversationUrl(retentionA, urlA, projectUrl);
    observeFreshConversationUrl(retentionB, urlB, projectUrl);
    expect(resolveCanonicalFreshConversation(config, retentionA, undefined, correlatedNetwork(userA, uuidA), userA)).toBe(urlA);
    expect(resolveCanonicalFreshConversation(config, retentionB, undefined, correlatedNetwork(userB, uuidB), userB)).toBe(urlB);
    expect(resolveCanonicalFreshConversation(config, retentionA, undefined, correlatedNetwork(userB, uuidB), userB)).toBe(urlA);
  });


describe('issue 1065 browser-surface classification', () => {
  function productStatusPage(elements: Array<{ text: string; testId?: string; role?: string }>, composer = false): any {
    return {
      locator: (selector: string) => {
        if (selector === '#prompt-textarea') {
          return { count: async () => composer ? 1 : 0 };
        }
        const matches = elements.filter((element) => {
          if (selector === '[role="alert"]') return element.role === 'alert';
          if (selector === '[role="dialog"]') return element.role === 'dialog';
          if (selector === '[data-testid*="limit"]') return element.testId?.includes('limit');
          if (selector === '[data-testid*="quota"]') return element.testId?.includes('quota');
          if (selector === '[data-testid*="challenge"]') return element.testId?.includes('challenge');
          if (selector === '[data-testid*="login"]') return element.testId?.includes('login');
          if (selector === '[data-testid*="auth"]') return element.testId?.includes('auth');
          if (selector === '[data-testid*="error"]') return element.testId?.includes('error');
          return false;
        });
        return {
          count: async () => matches.length,
          nth: (index: number) => ({
            innerText: async () => matches[index]?.text ?? '',
            getAttribute: async (name: string) => name === 'data-testid' ? matches[index]?.testId ?? null : null,
          }),
        };
      },
    };
  }

  it('AC1: names the observed conversation-history quota wall before dispatch', async () => {
    const page = productStatusPage([
      {
        role: 'dialog',
        testId: 'modal-conversation-history-rate-limit',
        text: 'Please wait a few minutes before trying again.',
      },
    ], true);
    expect(classifyPreDispatchProductWall(await productStatusText(page))).toEqual({
      state: 'quota',
      cause: 'conversation_history_quota',
    });
  });

  it('AC2: unknown blocking dialogs fail closed; visible non-blocking product status is ignored', async () => {
    const blocking = productStatusPage([
      { role: 'dialog', testId: 'modal-unknown-product-wall', text: 'Unexpected product blocker' },
    ], false);
    expect(classifyPreDispatchProductWall(await productStatusText(blocking))).toEqual({});
    expect(observePreDispatchBlockerHint(await productStatusText(blocking))).toBe(
      'unclassified_blocking_dialog:modal-unknown-product-wall',
    );

    const textlessBlocking = productStatusPage([
      { role: 'dialog', testId: 'modal-empty-product-wall', text: '' },
    ], false);
    expect(observePreDispatchBlockerHint(await productStatusText(textlessBlocking))).toBe(
      'unclassified_blocking_dialog:modal-empty-product-wall',
    );

    const nonBlocking = productStatusPage([
      { role: 'alert', text: 'benign product notice' },
    ], true);
    expect(classifyPreDispatchProductWall(await productStatusText(nonBlocking))).toEqual({});
    expect(classifyProductWall(await productStatusText(nonBlocking))).toEqual({});

    const longTestId = 'modal-' + 'x'.repeat(120);
    const longBlocking = productStatusPage([
      { role: 'dialog', testId: longTestId, text: 'long test id wall' },
    ], false);
    const longCause = observePreDispatchBlockerHint(await productStatusText(longBlocking));
    expect(longCause?.startsWith('unclassified_blocking_dialog:digest:')).toBe(true);
    expect(longCause!.length).toBeLessThanOrEqual('unclassified_blocking_dialog:digest:'.length + 16);
  });

  it('AC7: post-dispatch product status scan does not read data-testid', async () => {
    let getAttributeCalls = 0;
    const page = {
      locator: (selector: string) => {
        if (selector === '#prompt-textarea') return { count: async () => 1 };
        if (selector === '[role="dialog"]') {
          return {
            count: async () => 1,
            nth: () => ({
              innerText: async () => 'You have reached the usage limit',
              getAttribute: async (name: string) => {
                if (name === 'data-testid') getAttributeCalls++;
                return 'modal-quota';
              },
            }),
          };
        }
        return { count: async () => 0, nth: () => ({ innerText: async () => '', getAttribute: async () => null }) };
      },
    };
    await productStatusText(page, undefined, { collectElementIdentity: false });
    expect(getAttributeCalls).toBe(0);
    expect(classifyProductWall(await productStatusText(page, undefined, { collectElementIdentity: false }))).toEqual({
      state: 'quota',
      cause: 'quota_detected',
    });
  });

  it('AC2: unknown blocking dialog through readiness deadline prefers blocker cause over composer_readiness timeout', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const page = productStatusPage([
      { role: 'dialog', testId: 'modal-unknown-product-wall', text: 'Unexpected product blocker' },
    ], false) as any;
    page.on = () => page;
    page.waitForTimeout = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    };
    const turn = sendTurn(
      page,
      'payload',
      {
        cdp: 'http://127.0.0.1:9222',
        profile: join(root, 'profile-1065-readiness'),
        chatUrl: 'https://chatgpt.com/c/readiness',
        newChat: false,
        timeoutMs: 5_000,
      },
      undefined,
      undefined,
      createPreSendSegmentBudget(200),
    );
    await vi.advanceTimersByTimeAsync(250);
    const result = await turn;
    expect(result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'unclassified_blocking_dialog:modal-unknown-product-wall',
    });
    vi.useRealTimers();
  });

  it('AC2: textless blocking dialog through readiness deadline records unclassified cause', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const page = productStatusPage([
      { role: 'dialog', testId: 'modal-empty-product-wall', text: '' },
    ], false) as any;
    page.on = () => page;
    page.waitForTimeout = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    };
    const turn = sendTurn(
      page,
      'payload',
      {
        cdp: 'http://127.0.0.1:9222',
        profile: join(root, 'profile-1065-textless'),
        chatUrl: 'https://chatgpt.com/c/textless',
        newChat: false,
        timeoutMs: 5_000,
      },
      undefined,
      undefined,
      createPreSendSegmentBudget(200),
    );
    await vi.advanceTimersByTimeAsync(250);
    const result = await turn;
    expect(result).toMatchObject({
      state: 'ui_contract_mismatch',
      cause: 'unclassified_blocking_dialog:modal-empty-product-wall',
    });
    vi.useRealTimers();
  });

  it('AC3: duplicate tabs expose bounded match diagnostics without auto-closing tabs', async () => {
    const page = (url: string) => ({ url: () => url, bringToFront: async () => {} });
    const browser = {
      contexts: () => [{
        pages: () => [
          page('https://chatgpt.com/c/a?tab=0'),
          page('https://chatgpt.com/c/a?tab=1'),
        ],
      }],
    };
    await expect(openTurnPage(browser, {
      cdp: 'http://127.0.0.1:9222',
      profile: join(root, 'profile-1065'),
      chatUrl: 'https://chatgpt.com/c/a',
      newChat: false,
      timeoutMs: 100,
    })).rejects.toThrow(
      'ui_contract_mismatch:duplicate_tabs:count=2:index=0;id=7f5bbb6cee59bae5;index=1;id=6f7c899363c969c0',
    );
    expect(browser.contexts()[0]!.pages().length).toBe(2);
  });

  it('AC4: Gate-B characterization control results use gate-b-characterization operation', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../chatgpt-browser-turn.ts'), 'utf8');
    expect(source).toContain("operation: 'gate-b-characterization'");
    expect(source).toContain("'gate-b-characterization'");
    expect(source).toContain("'turn',");
    expect(source).toContain('CONTROL_OPERATIONS');
  });


  it('AC4: invalid commands omit operation from control-result', async () => {
    const { runCli } = await import('../chatgpt-browser-turn.ts');
    let stdout = '';
    const originalStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    const exitCode = await runCli(['bogus']);
    process.stdout.write = originalStdout;
    expect(exitCode).toBe(22);
    const body = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(body.cause).toBe('command_invalid');
    expect(body.operation).toBeUndefined();
  });

  it('AC6: missing option value preserves argument cause and emits Usage', async () => {
    const { runCli } = await import('../chatgpt-browser-turn.ts');
    const profile = join(root, 'profile-1065-cli-missing');
    let stdout = '';
    let stderr = '';
    const originalStdout = process.stdout.write.bind(process.stdout);
    const originalStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    const exitCode = await runCli([
      'turn',
      '--profile', profile,
      '--cdp', cdp,
      '--input', join(root, 'missing-value-input.txt'),
      '--output', join(root, 'missing-value-output.txt'),
      '--new-chat',
      '--project-url', 'https://chatgpt.com/g/test',
      '--timeout-ms',
    ]);
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    expect(exitCode).toBe(22);
    const body = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(body.operation).toBe('turn');
    expect(body.cause).toBe('argument_value_missing:timeout-ms');
    expect(stderr).toContain('Usage: npm run chatgpt-browser-turn');
  });

  it('AC6: turn mode/required argument failures preserve cause and Usage', async () => {
    const { runCli } = await import('../chatgpt-browser-turn.ts');
    const profile = join(root, 'profile-1065-cli-mode');
    let stdout = '';
    let stderr = '';
    const originalStdout = process.stdout.write.bind(process.stdout);
    const originalStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    const exitCode = await runCli([
      'turn',
      '--profile', profile,
      '--cdp', cdp,
      '--input', join(root, 'mode-input.txt'),
      '--output', join(root, 'mode-output.txt'),
      '--chat-url', 'https://chatgpt.com/c/mode',
      '--new-chat',
      '--project-url', 'https://chatgpt.com/g/test',
    ]);
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    expect(exitCode).toBe(13);
    const body = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(body.schema).toBe('turn-result/v1');
    expect(body.cause).toBe('argument_mode_invalid');
    expect(stderr).toContain('Usage: npm run chatgpt-browser-turn');
  });

  it('AC5: bounded connectOverCDP degradation maps to cdp_degraded with diagnostics retained', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../chatgpt-browser-turn.ts'), 'utf8');
    expect(source).toContain('? \'cdp_degraded\'');
    expect(source).toContain('cause === \'cdp_degraded\'');
    expect(source).toContain('browserOperationClassFromError(error) === \'connect_over_cdp\'');
  });

  it('AC6: unknown CLI options preserve argument cause and emit Usage on stderr', async () => {
    const { runCli } = await import('../chatgpt-browser-turn.ts');
    const profile = join(root, 'profile-1065-cli');
    let stdout = '';
    let stderr = '';
    const originalStdout = process.stdout.write.bind(process.stdout);
    const originalStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    const exitCode = await runCli([
      'status/list',
      '--profile', profile,
      '--cdp', cdp,
      '--bogus-flag', 'value',
    ]);
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    expect(exitCode).toBe(22);
    const body = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(body.cause).toBe('argument_unknown:bogus-flag');
    expect(stderr).toContain('Usage:');
  });
});

});

});
