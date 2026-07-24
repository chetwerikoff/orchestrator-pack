import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { turnExitCode } from '../chatgpt-browser-turn/contracts.ts';
import {
  acquireDomainLock,
  destinationIdentity,
  reserveDestination,
} from '../chatgpt-browser-turn/coordination.ts';
import { readStableInput } from '../chatgpt-browser-turn/input.ts';
import { publicationStatus, publishReply, PUBLICATION_SCHEMA } from '../chatgpt-browser-turn/publication.ts';
import { runtimeCapabilityBinding } from '../chatgpt-browser-turn/runtime-binding.ts';
import {
  mergeContinuationSegments,
  serializeSemanticNodes,
  shouldSkipSemanticElement,
  type SemanticNode,
} from '../chatgpt-browser-turn/semantic.ts';
import {
  adjudicateTombstone,
  capabilityStatus,
  clearReadable,
  downgradeCapability,
  quarantineOpaque,
  statusList,
  writeCapability,
  writeIncident,
} from '../chatgpt-browser-turn/state.ts';
import { atomicJson, configuredProfileKey, profileDirs, sha256 } from '../chatgpt-browser-turn/storage-common.ts';
import {
  resolveCausalAssistant,
  runtimeWitnessSurfaceAvailable,
  sendTurn,
  type BrowserConfig,
} from '../chatgpt-browser-turn/ui-adapter.ts';

let root = '';
let profileKey = '';
const cdp = 'http://127.0.0.1:9222';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opk-964-'));
  process.env.CHATGPT_BROWSER_TURN_STATE_DIR = join(root, 'state');
  profileKey = configuredProfileKey(join(root, 'profile'), cdp);
});

afterEach(() => {
  delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
  if (root) rmSync(root, { recursive: true, force: true });
});

function expectCause(path: string, cause: string): void {
  expect(() => readStableInput(path)).toThrow(`input_invalid:${cause}`);
}

function deadOwnerRecord(key: string, phase: 'pre_send' | 'possible_delivery'): void {
  const directory = join(profileDirs(profileKey).locks, sha256(key));
  mkdirSync(directory, { mode: 0o700 });
  atomicJson(join(directory, 'owner.json'), {
    schema: 'chatgpt-browser-turn-lock/v1',
    version: 1,
    configured_profile_key: profileKey,
    key,
    generation: 7,
    pid: 999999,
    process_start_token: 'definitely-not-live',
    nonce: randomUUID(),
    phase,
    created_at: new Date(Date.now() - 600_000).toISOString(),
    updated_at: new Date(Date.now() - 600_000).toISOString(),
  });
}

describe('issue 964 immutable input snapshot', () => {
  it('preserves accepted Unicode and LF/CRLF bytes exactly', () => {
    const path = join(root, 'message.txt');
    const text = 'Привет 🌍\r\nline 2\n';
    writeFileSync(path, text, 'utf8');
    const snapshot = readStableInput(path);
    expect(snapshot.text).toBe(text);
    expect(Buffer.from(snapshot.bytes)).toEqual(readFileSync(path));
  });

  it('rejects empty, BOM, NUL, invalid UTF-8, bare CR, symlink, and non-regular input', () => {
    const empty = join(root, 'empty.txt');
    writeFileSync(empty, '');
    expectCause(empty, 'empty');

    const bom = join(root, 'bom.txt');
    writeFileSync(bom, Buffer.from([0xef, 0xbb, 0xbf, 0x61]));
    expectCause(bom, 'bom');

    const nul = join(root, 'nul.txt');
    writeFileSync(nul, Buffer.from([0x61, 0x00, 0x62]));
    expectCause(nul, 'nul');

    const invalid = join(root, 'invalid.txt');
    writeFileSync(invalid, Buffer.from([0xff]));
    expectCause(invalid, 'utf8');

    const bareCr = join(root, 'cr.txt');
    writeFileSync(bareCr, 'a\r\r\nb');
    expectCause(bareCr, 'bare_cr');

    const target = join(root, 'target.txt');
    const link = join(root, 'link.txt');
    writeFileSync(target, 'safe');
    symlinkSync(target, link);
    expectCause(link, 'not_regular_nonsymlink');

    expectCause(root, 'not_regular_nonsymlink');
  });

  it('rejects deterministic retarget and truncation races instead of sending changed bytes', () => {
    const retarget = join(root, 'retarget.txt');
    const old = join(root, 'retarget.old');
    writeFileSync(retarget, 'original');
    expect(() => readStableInput(retarget, {
      afterOpen: () => {
        renameSync(retarget, old);
        writeFileSync(retarget, 'replacement');
      },
    })).toThrow('input_invalid:changed_during_snapshot');

    const truncate = join(root, 'truncate.txt');
    writeFileSync(truncate, '123456789');
    expect(() => readStableInput(truncate, {
      afterRead: () => writeFileSync(truncate, 'x'),
    })).toThrow('input_invalid:changed_during_snapshot');
  });
});

describe('issue 964 semantic reply serialization', () => {
  it('serializes semantic structure deterministically without synthesized trailing newline', () => {
    const nodes: SemanticNode[] = [
      { type: 'heading', children: [{ type: 'text', text: 'Title' }] },
      { type: 'paragraph', children: [
        { type: 'text', text: 'Use ' },
        { type: 'inline_code', text: 'x()' },
        { type: 'text', text: ' at ' },
        { type: 'link', children: [{ type: 'text', text: 'label' }] },
      ] },
      { type: 'unordered_list', items: [
        [{ type: 'text', text: 'one' }],
        [{ type: 'group', children: [
          { type: 'text', text: 'two' },
          { type: 'unordered_list', items: [[{ type: 'text', text: 'nested' }]] },
        ] }],
      ] },
      { type: 'blockquote', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'quoted' }] }] },
      { type: 'code_block', text: 'a\r\nb\n' },
      { type: 'paragraph', children: [{ type: 'text', text: '   ' }] },
    ];
    const result = serializeSemanticNodes(nodes);
    expect(result).toContain('Title\n\nUse x() at label');
    expect(result).toContain('- one');
    expect(result).toContain('nested');
    expect(result).toContain('> quoted');
    expect(result).toContain('a\nb');
    expect(result.endsWith('\n')).toBe(false);
  });

  it('keeps authored link text while excluding known UI chrome and hidden descriptors', () => {
    expect(shouldSkipSemanticElement({ tag: 'button' })).toBe(true);
    expect(shouldSkipSemanticElement({ tag: 'span', ariaHidden: 'true' })).toBe(true);
    expect(shouldSkipSemanticElement({ tag: 'span', testid: 'copy-button' })).toBe(true);
    expect(shouldSkipSemanticElement({ tag: 'span', testid: 'citation-hover-card' })).toBe(true);
    expect(shouldSkipSemanticElement({ tag: 'span', className: 'sr-only' })).toBe(true);
    expect(shouldSkipSemanticElement({ tag: 'a', testid: 'citation-link' })).toBe(false);
    expect(serializeSemanticNodes([
      { type: 'paragraph', children: [
        { type: 'text', text: 'See ' },
        { type: 'link', children: [{ type: 'text', text: 'authored source' }] },
      ] },
    ])).toBe('See authored source');
  });

  it('merges continuation snapshots without duplicate overlap', () => {
    expect(mergeContinuationSegments(['alpha\nbeta', 'alpha\nbeta\ngamma'])).toBe('alpha\nbeta\ngamma');
    const prefix = 'x'.repeat(40);
    expect(mergeContinuationSegments([`a${prefix}`, `${prefix}b`])).toBe(`a${prefix}b`);
  });
});

describe('issue 964 causal witness gate', () => {
  it('requires one exact service-issued parent relation and rejects heuristic or ambiguous candidates', () => {
    const userId = 'user-12345678';
    const assistantId = 'assistant-12345678';
    expect(resolveCausalAssistant(userId, [
      { id: assistantId, role: 'assistant', parent: userId },
      { id: assistantId, role: 'assistant', parent: userId },
      { id: 'assistant-foreign-1', role: 'assistant', parent: 'user-other-123' },
    ])).toEqual({ state: 'matched', assistantMessageId: assistantId });

    expect(resolveCausalAssistant(userId, [
      { id: 'assistant-neighbor', role: 'assistant' },
      { id: 'assistant-wrong-parent', role: 'assistant', parent: 'user-other-123' },
    ])).toEqual({ state: 'none' });

    expect(resolveCausalAssistant(userId, [
      { id: 'assistant-match-one', role: 'assistant', parent: userId },
      { id: 'assistant-match-two', role: 'assistant', parent: userId },
    ])).toEqual({ state: 'ambiguous' });
  });

  it('admits parallel witness surface only when a visible assistant has an exact visible user parent', async () => {
    const userId = 'user-12345678';
    const messageLocator = (role: 'user' | 'assistant', id: string, parent?: string) => ({
      getAttribute: async (name: string) => {
        if (name === 'data-message-author-role') return role;
        if (name === 'data-message-id') return id;
        if (name === 'data-parent-message-id') return parent ?? null;
        return null;
      },
      locator: () => ({ first: () => ({ getAttribute: async () => null }) }),
    });
    const pageWithRelation = {
      locator: () => {
        const messages = [
          messageLocator('user', userId),
          messageLocator('assistant', 'assistant-12345678', userId),
        ];
        return { count: async () => messages.length, nth: (index: number) => messages[index] };
      },
    };
    const pageWithoutRelation = {
      locator: () => {
        const messages = [
          messageLocator('user', userId),
          messageLocator('assistant', 'assistant-12345678'),
        ];
        return { count: async () => messages.length, nth: (index: number) => messages[index] };
      },
    };
    expect(await runtimeWitnessSurfaceAvailable(pageWithRelation)).toBe(true);
    expect(await runtimeWitnessSurfaceAvailable(pageWithoutRelation)).toBe(false);
  });

  it('awaits the final pre-send admission guard and performs zero dispatch when it refuses', async () => {
    let sendClicks = 0;
    const emptyLocator = () => ({
      count: async () => 0,
      nth: () => emptyLocator(),
      getAttribute: async () => null,
      locator: () => emptyLocator(),
      first: () => emptyLocator(),
      innerText: async () => '',
      click: async () => {},
    });
    const composer = { ...emptyLocator(), count: async () => 1, click: async () => {} };
    const send = { ...emptyLocator(), count: async () => 1, click: async () => { sendClicks++; } };
    const body = { ...emptyLocator(), innerText: async () => '' };
    const page = {
      on: () => {},
      url: () => 'https://chatgpt.com/c/example',
      locator: (selector: string) => {
        if (selector === '#prompt-textarea') return composer;
        if (selector === '[data-testid="send-button"]') return send;
        if (selector === 'body') return body;
        return emptyLocator();
      },
      keyboard: { press: async () => {}, insertText: async () => {} },
      waitForTimeout: async () => {},
      getByText: () => emptyLocator(),
    };
    const config: BrowserConfig = {
      cdp,
      profile: join(root, 'profile'),
      chatUrl: 'https://chatgpt.com/c/example',
      newChat: false,
      timeoutMs: 1_000,
    };

    await expect(sendTurn(page, 'immutable payload', config, undefined, async () => {
      await Promise.resolve();
      throw new Error('pre_send_test_refusal');
    })).rejects.toThrow('pre_send_test_refusal');
    expect(sendClicks).toBe(0);
  });
});

describe('issue 964 configured profile identity', () => {
  it('collapses filesystem, Windows/WSL, and case aliases into one lock namespace', () => {
    const actual = join(root, 'Profile-Actual');
    const alias = join(root, 'profile-alias');
    mkdirSync(actual);
    symlinkSync(actual, alias, 'dir');
    expect(configuredProfileKey(actual, cdp)).toBe(configuredProfileKey(alias, cdp));

    if (process.platform !== 'win32') {
      expect(configuredProfileKey('C:\\Users\\Automation\\Profile', cdp))
        .toBe(configuredProfileKey('/mnt/c/users/automation/profile/', cdp));
    }
  });
});

describe('issue 964 result contract', () => {
  it('keeps stable exit-code families', () => {
    expect(turnExitCode('ok')).toBe(0);
    expect(turnExitCode('input_invalid')).toBe(10);
    expect(turnExitCode('recovery_required')).toBe(11);
    expect(turnExitCode('profile_busy')).toBe(12);
    expect(turnExitCode('driver_error')).toBe(13);
    expect(turnExitCode('incompatible_record')).toBe(14);
  });
});

describe('issue 964 destination and scheduling fences', () => {
  it('canonicalizes aliases and reserves a destination exclusively', () => {
    const output = join(root, 'out.txt');
    const relativeAlias = join(root, '.', 'out.txt');
    expect(destinationIdentity(output)).toEqual(destinationIdentity(relativeAlias));

    const first = reserveDestination(profileKey, output);
    expect(() => reserveDestination(profileKey, output)).toThrow('output_conflict:reserved');
    first.release();
    const second = reserveDestination(profileKey, output);
    second.release();

    writeFileSync(output, 'external');
    expect(() => destinationIdentity(output)).toThrow('output_conflict:exists');
    expect(readFileSync(output, 'utf8')).toBe('external');
  });

  it('selects one same-domain winner and only reclaims stale pre-send dead owners', () => {
    const key = 'conversation:https://chatgpt.com/c/abc';
    const first = acquireDomainLock(profileKey, key);
    expect(first).not.toBeNull();
    expect(acquireDomainLock(profileKey, key)).toBeNull();
    first!.release();

    const reclaimKey = 'conversation:reclaim';
    deadOwnerRecord(reclaimKey, 'pre_send');
    const reclaimed = acquireDomainLock(profileKey, reclaimKey, 1);
    expect(reclaimed?.generation).toBe(8);
    reclaimed!.release();

    const deliveryKey = 'conversation:no-reclaim';
    deadOwnerRecord(deliveryKey, 'possible_delivery');
    expect(acquireDomainLock(profileKey, deliveryKey, 1)).toBeNull();
  });
});

describe('issue 964 publication witness and races', () => {
  it('publishes exactly once with an invocation-exclusive inode witness', () => {
    const output = join(root, 'reply.txt');
    const destination = destinationIdentity(output);
    const reply = 'line one\nline two';
    const published = publishReply(profileKey, 'invocation-ok', destination.finalPath, destination.identity, reply);
    expect(published.state).toBe('committed_ok');
    expect(readFileSync(output, 'utf8')).toBe(reply);
    expect(published.output_sha256).toBe(sha256(reply));
    expect(publicationStatus(profileKey, 'invocation-ok').state).toBe('committed_ok');
  });

  it('never overwrites a foreign destination that appears after possible delivery and retains the complete temp', () => {
    const output = join(root, 'collision.txt');
    const destination = destinationIdentity(output);
    writeFileSync(output, 'external-winner');
    const reply = 'assistant reply body';
    const published = publishReply(profileKey, 'invocation-collision', destination.finalPath, destination.identity, reply);
    expect(published.state).toBe('recovery_required');
    expect(published.cause).toBe('publication_commit_collision');
    expect(readFileSync(output, 'utf8')).toBe('external-winner');
    const temps = readdirSync(root).filter((name) => name.includes('invocation-collision') && name.endsWith('.tmp'));
    expect(temps).toHaveLength(1);
    expect(readFileSync(join(root, temps[0]!), 'utf8')).toBe(reply);
    expect(publicationStatus(profileKey, 'invocation-collision').state).toBe('recovery_required');
  });

  it('recognizes post-rename missing emission as committed from the exact inode', () => {
    const output = join(root, 'post-rename.txt');
    const temp = join(root, '.post-rename.tmp');
    writeFileSync(temp, 'completed');
    const witness = statSync(temp, { bigint: true });
    renameSync(temp, output);
    atomicJson(join(profileDirs(profileKey).publications, 'crashed.json'), {
      schema: PUBLICATION_SCHEMA,
      version: 1,
      configured_profile_key: profileKey,
      invocation_id: 'crashed',
      output_path: resolve(output),
      output_identity: destinationIdentity(join(root, 'unused.txt')).identity,
      temp_path: temp,
      temp_dev: String(witness.dev),
      temp_ino: String(witness.ino),
      owner_pid: 999999,
      state: 'prepared',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const status = publicationStatus(profileKey, 'crashed');
    expect(status.state).toBe('committed_ok');
    expect(status.output_sha256).toBe(sha256('completed'));
  });

  it('reports a prepared reply with a dead owner as recovery, never retryable output conflict', () => {
    const output = join(root, 'prepared.txt');
    const temp = join(root, '.prepared.tmp');
    writeFileSync(temp, 'complete-but-uncommitted');
    const witness = statSync(temp, { bigint: true });
    atomicJson(join(profileDirs(profileKey).publications, 'prepared.json'), {
      schema: PUBLICATION_SCHEMA,
      version: 1,
      configured_profile_key: profileKey,
      invocation_id: 'prepared',
      output_path: resolve(output),
      output_identity: destinationIdentity(output).identity,
      temp_path: temp,
      temp_dev: String(witness.dev),
      temp_ino: String(witness.ino),
      owner_pid: 999999,
      state: 'prepared',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const status = publicationStatus(profileKey, 'prepared');
    expect(status.state).toBe('recovery_required');
    expect(status.cause).toBe('prepared_without_live_owner');
    expect(existsSync(output)).toBe(false);
  });
});

describe('issue 964 durable incident recovery', () => {
  it('lists and clears exact readable incidents but refuses a live owner', () => {
    const live = writeIncident(profileKey, {
      kind: 'active_owner',
      generation: 1,
      phase: 'pre_send',
      owner: { pid: process.pid, started_at: new Date().toISOString(), nonce: 'live' },
    });
    expect(statusList(profileKey).state).toBe('ok');
    expect(clearReadable(profileKey, live.identity, 1, live.record.evidence_token).state).toBe('refused_active');

    const dead = writeIncident(profileKey, {
      kind: 'conversation_incident',
      generation: 3,
      phase: 'possible_delivery',
      conversation_id: 'https://chatgpt.com/c/example',
      cause: 'stream_timeout',
    });
    expect(clearReadable(profileKey, dead.identity, 2, dead.record.evidence_token).state).toBe('stale_generation');
    expect(clearReadable(profileKey, dead.identity, 3, 'wrong').state).toBe('evidence_changed');
    expect(clearReadable(profileKey, dead.identity, 3, dead.record.evidence_token).state).toBe('cleared');
  });

  it('quarantines opaque bytes without discarding them and keeps a tombstone until exact adjudication', () => {
    const bad = join(profileDirs(profileKey).records, 'future.json');
    const opaqueBytes = Buffer.from('{"future":true}\n', 'utf8');
    writeFileSync(bad, opaqueBytes);
    const listed = statusList(profileKey);
    expect(listed.state).toBe('profile_blocked');
    expect(listed.complete).toBe(false);
    const opaque = listed.items!.find((item) => item.kind === 'opaque_record')!;

    expect(quarantineOpaque(profileKey, opaque.identity, opaque.generation).state).toBe('quarantined');
    const blocked = statusList(profileKey);
    expect(blocked.state).toBe('profile_blocked');
    const tombstone = blocked.items!.find((item) => item.kind === 'blocking_tombstone')!;

    const evidence = sha256('operator-adjudication');
    expect(adjudicateTombstone(profileKey, tombstone.identity, tombstone.generation, evidence, sha256('changed')).state).toBe('evidence_changed');
    expect(adjudicateTombstone(profileKey, tombstone.identity, tombstone.generation, evidence, evidence).state).toBe('cleared');
    expect(statusList(profileKey).state).toBe('none');
    const preserved = readdirSync(profileDirs(profileKey).resolved).find((name) => name.endsWith('.opaque'))!;
    expect(readFileSync(join(profileDirs(profileKey).resolved, preserved))).toEqual(opaqueBytes);
  });

  it('fails the whole profile closed on an incompatible publication record', () => {
    writeFileSync(join(profileDirs(profileKey).publications, 'unknown.json'), '{"schema":"future/v9"}\n');
    const listed = statusList(profileKey);
    expect(listed.state).toBe('profile_blocked');
    expect(listed.complete).toBe(false);
  });
});

describe('issue 964 capability policy', () => {
  it('binds positive evidence to exact candidate/build/config/gate and downgrades visibly', () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    const now = Date.now();
    writeCapability(profileKey, {
      ...binding,
      browser_provenance: 'Chromium test',
      evidence_digest: sha256('causal-witness-fixture'),
      observed_at: new Date(now - 1_000).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
      downgrade_generation: 0,
      parallel_eligible: true,
    });
    expect(capabilityStatus(profileKey, binding).state).toBe('ok');
    expect(capabilityStatus(profileKey, { ...binding, gate_digest: sha256('different-gate') }).state).toBe('downgraded');
    downgradeCapability(profileKey);
    const downgraded = capabilityStatus(profileKey, binding);
    expect(downgraded.state).toBe('downgraded');
    expect(downgraded.capability?.downgrade_generation).toBe(1);
  });

  it('expires evidence and never treats stale characterization as parallel authority', () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    const now = Date.now();
    writeCapability(profileKey, {
      ...binding,
      browser_provenance: 'Chromium test',
      evidence_digest: sha256('old-evidence'),
      observed_at: new Date(now - 120_000).toISOString(),
      expires_at: new Date(now - 60_000).toISOString(),
      downgrade_generation: 0,
      parallel_eligible: true,
    });
    expect(capabilityStatus(profileKey, binding).state).toBe('expired');
  });
});

describe('issue 964 body leakage boundary', () => {
  it('keeps helper-owned JSON state body-free', () => {
    const secretBody = 'DO-NOT-LEAK-UNIQUE-BODY-964';
    const destination = destinationIdentity(join(root, 'leak.txt'));
    writeFileSync(destination.finalPath, 'external');
    publishReply(profileKey, 'leak-collision', destination.finalPath, destination.identity, secretBody);

    const jsonFiles: string[] = [];
    const walk = (directory: string): void => {
      for (const name of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, name.name);
        if (name.isDirectory()) walk(path);
        else if (name.name.endsWith('.json')) jsonFiles.push(path);
      }
    };
    walk(profileDirs(profileKey).root);
    for (const path of jsonFiles) expect(readFileSync(path, 'utf8')).not.toContain(secretBody);
  });
});
