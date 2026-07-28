import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireDomainLock,
  reserveDestination,
} from '../chatgpt-browser-turn/coordination.ts';
import { runtimeCapabilityBinding } from '../chatgpt-browser-turn/runtime-binding.ts';
import {
  __testWriteCapability,
  capabilityStatus,
  listReadableIncidents,
  statusList,
  writeIncident,
} from '../chatgpt-browser-turn/state.ts';
import { atomicJson, configuredProfileKey, profileDirs, sha256 } from '../chatgpt-browser-turn/storage-common.ts';
import type { WitnessSurfaceProbe } from '../chatgpt-browser-turn/ui-adapter.ts';

let root = '';
let profileKey = '';
const cdp = 'http://127.0.0.1:9222';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opk-1060-'));
  process.env.CHATGPT_BROWSER_TURN_STATE_DIR = join(root, 'state');
  profileKey = configuredProfileKey(join(root, 'profile'), cdp);
});

afterEach(() => {
  delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
  vi.resetModules();
  vi.doUnmock('../chatgpt-browser-turn/ui-adapter.ts');
  vi.doUnmock('../chatgpt-browser-turn/state.ts');
  vi.doUnmock('../chatgpt-browser-turn/publication.ts');
  if (root) rmSync(root, { recursive: true, force: true });
});

function capabilityFixture(
  binding: ReturnType<typeof runtimeCapabilityBinding>,
  overrides: Record<string, unknown> = {},
) {
  return {
    candidate_digest: binding.candidate_digest,
    build_digest: binding.build_digest,
    browser_provenance: 'Chromium test',
    config_digest: binding.config_digest,
    gate_digest: binding.gate_digest,
    evidence_digest: sha256('fixture'),
    characterized_at: new Date().toISOString(),
    admission_policy: 'parallel' as const,
    admission_epoch: 0,
    ...overrides,
  };
}

function deadOwnerRecord(
  key: string,
  phase: 'pre_send' | 'possible_delivery',
  pid = 999999,
  processStartToken = 'definitely-not-live',
): void {
  const directory = join(profileDirs(profileKey).locks, sha256(key));
  mkdirSync(directory, { mode: 0o700 });
  atomicJson(join(directory, 'owner.json'), {
    schema: 'chatgpt-browser-turn-lock/v1',
    version: 1,
    configured_profile_key: profileKey,
    key,
    generation: 7,
    pid,
    process_start_token: processStartToken,
    nonce: randomUUID(),
    phase,
    created_at: new Date(Date.now() - 600_000).toISOString(),
    updated_at: new Date(Date.now() - 600_000).toISOString(),
  });
}

function turnArgvFor(outputPath: string, flags: string[] = []): string[] {
  const input = join(root, `turn-input-${randomUUID()}.txt`);
  writeFileSync(input, 'turn payload\n');
  return [
    'turn',
    '--profile', join(root, 'profile'),
    '--cdp', cdp,
    '--input', input,
    '--output', outputPath,
    '--chat-url', 'https://chatgpt.com/c/fixture-conv',
    ...flags,
  ];
}

async function runTurnWithMocks(
  argv: string[],
  options: {
    witness?: WitnessSurfaceProbe | WitnessSurfaceProbe[];
    sendResult?: Record<string, unknown>;
    browserProvenance?: string;
  } = {},
): Promise<{ exitCode: number; stdout: string }> {
  vi.resetModules();
  const witnessQueue = Array.isArray(options.witness)
    ? [...options.witness]
    : [options.witness ?? 'available'];
  const stubPage = {
    close: vi.fn(async () => {}),
    goto: vi.fn(async () => {}),
    url: () => 'https://chatgpt.com/c/fixture-conv',
    bringToFront: vi.fn(async () => {}),
  };
  const stubBrowser = {
    close: vi.fn(async () => {}),
    version: () => options.browserProvenance ?? 'chromium-fixture',
    contexts: () => [{ pages: () => [] }],
  };
  vi.doMock('../chatgpt-browser-turn/ui-adapter.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../chatgpt-browser-turn/ui-adapter.ts')>();
    return {
      ...actual,
      verifyProfile: vi.fn(async () => ({ state: 'verified' as const, cause: 'ok' })),
      loadChromium: vi.fn(() => ({ connectOverCDP: vi.fn(async () => stubBrowser) })),
      openTurnPage: vi.fn(async () => ({ page: stubPage, owned: true, provisionalId: randomUUID() })),
      runtimeWitnessSurfaceAvailable: vi.fn(async () => witnessQueue.shift() ?? 'available'),
      sendTurn: vi.fn(async (_page, _text, _config, _provisionalId, onBeforeSend) => {
        if (onBeforeSend) await onBeforeSend();
        return options.sendResult ?? {
        state: 'ok',
        cause: 'completed',
        possibleDelivery: true,
        reply: 'reply text',
        userMessageId: 'user-fixture-12345678',
        assistantMessageId: 'asst-fixture-12345678',
        conversationId: 'https://chatgpt.com/c/fixture-conv',
      };
      }),
    };
  });
  vi.doMock('../chatgpt-browser-turn/publication.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../chatgpt-browser-turn/publication.ts')>();
    return {
      ...actual,
      publishReply: vi.fn(() => ({ state: 'committed_ok', output_bytes: 10, output_sha256: 'sha256:fixture' })),
    };
  });
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
  const { runCli } = await import('../chatgpt-browser-turn.ts');
  const exitCode = await runCli(argv);
  vi.spyOn(process.stdout, 'write').mockRestore();
  return { exitCode, stdout: chunks.join('') };
}

describe('issue 1060 remove profile-wide admission', () => {
  it('AC1/AC11a: independent conversation locks succeed while capability is absent or serialized', () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    __testWriteCapability(profileKey, capabilityFixture(binding, {
      admission_policy: 'serialized',
      admission_epoch: 3,
      browser_provenance: 'stale-browser',
    }));

    const one = acquireDomainLock(profileKey, 'conversation:https://chatgpt.com/c/one');
    const two = acquireDomainLock(profileKey, 'conversation:https://chatgpt.com/c/two');
    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    two!.release();
    one!.release();
  });

  it('AC2/AC6/AC11c: incompatible capability is diagnostic and does not profile-block status/list', () => {
    writeFileSync(profileDirs(profileKey).capability, '{ "schema": "broken" }');
    const listed = statusList(profileKey);
    expect(listed.state).not.toBe('profile_blocked');
    expect(listed.items?.some((item) => item.kind === 'opaque_record')).toBe(true);

    const binding = runtimeCapabilityBinding(profileKey, cdp);
    const status = capabilityStatus(profileKey, binding);
    expect(status.state).toBe('downgraded');
    expect(status.cause).toBe('capability_incompatible');
  });

  it('AC3/AC11b: witness loss fails invocation locally while sibling conversation lock stays usable', async () => {
    const siblingKey = 'conversation:https://chatgpt.com/c/sibling';
    const sibling = acquireDomainLock(profileKey, siblingKey);
    expect(sibling).not.toBeNull();

    const output = join(root, 'witness-fail-out.txt');
    const { exitCode, stdout } = await runTurnWithMocks(turnArgvFor(output), {
      witness: ['absent'],
    });
    expect(exitCode).toBe(13);
    expect(stdout).toContain('pre_send_witness_unavailable');

    const stillHeld = acquireDomainLock(profileKey, siblingKey);
    expect(stillHeld).toBeNull();
    sibling!.release();
  });

  it('AC4/AC11b: final pre-send witness loss cleans owner and releases fine lock', async () => {
    const output = join(root, 'final-witness-fail-out.txt');
    const { exitCode, stdout } = await runTurnWithMocks(turnArgvFor(output), {
      witness: ['available', 'absent'],
    });
    expect(exitCode).toBe(13);
    expect(stdout).toContain('pre_send_witness_unavailable');
    expect(listReadableIncidents(profileKey).some(({ record }) => record.kind === 'active_owner')).toBe(false);
    expect(acquireDomainLock(profileKey, 'conversation:https://chatgpt.com/c/fixture-conv')).not.toBeNull();
  });

  it('AC5/AC11e: same-conversation overlap still refuses duplicate scheduling', () => {
    const key = 'conversation:https://chatgpt.com/c/same';
    const first = acquireDomainLock(profileKey, key);
    expect(first).not.toBeNull();
    expect(acquireDomainLock(profileKey, key)).toBeNull();
    first!.release();
  });

  it('AC11d: dead pre-send owner on one fine domain can be reclaimed without profile-wide state', () => {
    const lockKey = 'conversation:https://chatgpt.com/c/reclaim';
    deadOwnerRecord(lockKey, 'pre_send');
    const reclaimed = acquireDomainLock(profileKey, lockKey, 1);
    expect(reclaimed).not.toBeNull();
    expect(statusList(profileKey).state).not.toBe('profile_blocked');
    reclaimed!.release();
  });

  it('AC7: serialized capability does not force profile scheduling in runTurn', async () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    __testWriteCapability(profileKey, capabilityFixture(binding, {
      admission_policy: 'serialized',
      admission_epoch: 9,
    }));
    const output = join(root, 'serialized-cap-out.txt');
    const { exitCode, stdout } = await runTurnWithMocks(turnArgvFor(output));
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('profile_busy');
    expect(stdout).not.toContain('profile:');
  });
});
