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
import { classifyProductWall, productStatusText, witnessSurfaceProbeRequiresDowngrade, __testTiming, sendTurn, type BrowserConfig } from '../chatgpt-browser-turn/ui-adapter.ts';
import { fakeTurnPage } from '../chatgpt-browser-turn/fixtures/fake-turn-page.ts';
import { liveTurnStreamSequence } from '../chatgpt-browser-turn/fixtures/live-turn-stream-contract.ts';

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


