import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
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
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TURN_STATES, turnExitCode, type FailureScope, type TurnState } from '../chatgpt-browser-turn/contracts.ts';
import {
  acquireDomainLock,
  destinationIdentity,
  destinationIdentityForPath,
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
  openTurnPage,
  resolveCausalAssistant,
  runtimeWitnessSurfaceAvailable,
  sendTurn,
  type BrowserConfig,
} from '../chatgpt-browser-turn/ui-adapter.ts';

let root = '';
let profileKey = '';
const cdp = 'http://127.0.0.1:9222';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

function emptyLocator(): any {
  return {
    count: async () => 0,
    nth: () => emptyLocator(),
    getAttribute: async () => null,
    locator: () => emptyLocator(),
    first: () => emptyLocator(),
    innerText: async () => '',
    click: async () => {},
    evaluate: async () => [],
  };
}

function messageLocator(role: 'user' | 'assistant', id: string, parent?: string, text = ''): any {
  return {
    __role: role,
    getAttribute: async (name: string) => {
      if (name === 'data-message-author-role') return role;
      if (name === 'data-message-id') return id;
      if (name === 'data-parent-message-id') return parent ?? null;
      return null;
    },
    locator: () => ({ first: () => ({ getAttribute: async () => null }) }),
    first: () => emptyLocator(),
    count: async () => 1,
    innerText: async () => text,
    click: async () => {},
    evaluate: async () => text
      ? [{ type: 'paragraph', children: [{ type: 'text', text }] } satisfies SemanticNode]
      : [],
  };
}

interface FakeTurnPageOptions {
  dispatchCandidateIds?: string[];
  historicalResponseUserIds?: string[];
  foreignDomUserIds?: string[];
  assistantParent?: string;
  assistantText?: string;
  bodyText?: string;
  alertText?: string;
  alertAfterSend?: string;
  composer?: boolean;
  serviceObserveDispatch?: boolean;
}

function fakeTurnPage(options: FakeTurnPageOptions = {}): { page: any; getSendClicks: () => number } {
  const handlers = new Map<string, Array<(event: any) => unknown>>();
  const messages: any[] = [];
  let sendClicks = 0;
  let sent = false;
  const dispatchIds = options.dispatchCandidateIds ?? ['user-owned-12345678'];
  const composerPresent = options.composer !== false;

  const emit = async (event: string, payload: any): Promise<void> => {
    for (const handler of handlers.get(event) ?? []) await handler(payload);
  };

  const send = {
    ...emptyLocator(),
    count: async () => 1,
    click: async () => {
      sendClicks++;
      sent = true;
      for (const id of options.historicalResponseUserIds ?? []) {
        await emit('response', {
          url: () => 'https://chatgpt.com/backend-api/conversation/history',
          text: async () => JSON.stringify({ message: { id, author: { role: 'user' } } }),
        });
      }
      for (const id of dispatchIds) {
        await emit('request', {
          url: () => 'https://chatgpt.com/backend-api/conversation',
          postData: () => JSON.stringify({ messages: [{ id, author: { role: 'user' } }] }),
        });
      }
      if (options.serviceObserveDispatch !== false) {
        for (const id of dispatchIds) messages.push(messageLocator('user', id));
      }
      for (const id of options.foreignDomUserIds ?? []) messages.push(messageLocator('user', id));
      if (options.assistantParent) {
        messages.push(messageLocator('assistant', 'assistant-owned-12345678', options.assistantParent, options.assistantText ?? 'assistant reply'));
      }
    },
  };

  const selectMessages = (role: 'user' | 'assistant') => {
    const selected = messages.filter((message) => message.__role === role);
    return { count: async () => selected.length, nth: (index: number) => selected[index] ?? emptyLocator() };
  };

  const page = {
    on: (event: string, handler: (value: any) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    url: () => 'https://chatgpt.com/c/example',
    locator: (selector: string) => {
      if (selector === '#prompt-textarea') return { ...emptyLocator(), count: async () => composerPresent ? 1 : 0, click: async () => {} };
      if (selector === '[data-testid="send-button"]') return send;
      if (selector === '[data-testid="stop-button"]') return emptyLocator();
      if (selector === '[data-message-author-role]') return { count: async () => messages.length, nth: (index: number) => messages[index] ?? emptyLocator() };
      if (selector === '[data-message-author-role="user"]') return selectMessages('user');
      if (selector === '[data-message-author-role="assistant"]') return selectMessages('assistant');
      if (selector === '[role="alert"]') {
        const text = sent && options.alertAfterSend ? options.alertAfterSend : options.alertText;
        if (!text) return emptyLocator();
        return { count: async () => 1, nth: () => ({ ...emptyLocator(), innerText: async () => text }) };
      }
      if (selector === 'body') return { ...emptyLocator(), innerText: async () => options.bodyText ?? '' };
      return emptyLocator();
    },
    keyboard: { press: async () => {}, insertText: async () => {} },
    waitForTimeout: async () => {},
    getByText: () => emptyLocator(),
  };

  return { page, getSendClicks: () => sendClicks };
}

function makePublicationFixture(
  invocationId: string,
  outputName: string,
  body: string,
  committed = false,
): { output: string; temp: string; identity: string } {
  const output = resolve(join(root, outputName));
  const identity = destinationIdentityForPath(output).identity;
  const temp = join(dirname(output), `.${basename(output)}.${invocationId}.${randomUUID()}.tmp`);
  writeFileSync(temp, body);
  const witness = statSync(temp, { bigint: true });
  if (committed) renameSync(temp, output);
  atomicJson(join(profileDirs(profileKey).publications, `${invocationId}.json`), {
    schema: PUBLICATION_SCHEMA,
    version: 1,
    configured_profile_key: profileKey,
    invocation_id: invocationId,
    output_path: output,
    output_identity: identity,
    temp_path: temp,
    temp_dev: String(witness.dev),
    temp_ino: String(witness.ino),
    owner_pid: 999999,
    state: 'prepared',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return { output, temp, identity };
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
    expect(() => readStableInput(truncate, { afterRead: () => writeFileSync(truncate, 'x') }))
      .toThrow('input_invalid:changed_during_snapshot');
  });
});

describe('issue 964 semantic reply serialization — S2', () => {
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
      { type: 'paragraph', children: [{ type: 'text', text: 'See ' }, { type: 'link', children: [{ type: 'text', text: 'authored source' }] }] },
    ])).toBe('See authored source');
  });

  it('merges continuation snapshots without duplicate overlap', () => {
    expect(mergeContinuationSegments(['alpha\nbeta', 'alpha\nbeta\ngamma'])).toBe('alpha\nbeta\ngamma');
    const prefix = 'x'.repeat(40);
    expect(mergeContinuationSegments([`a${prefix}`, `${prefix}b`])).toBe(`a${prefix}b`);
  });
});

describe('issue 964 service-issued causal witness — S1/S3/S12', () => {
  it('requires one exact assistant parent relation and rejects heuristic/ambiguous candidates', () => {
    const userId = 'user-12345678';
    expect(resolveCausalAssistant(userId, [
      { id: 'assistant-12345678', role: 'assistant', parent: userId },
      { id: 'assistant-12345678', role: 'assistant', parent: userId },
      { id: 'assistant-foreign-1', role: 'assistant', parent: 'user-other-123' },
    ])).toEqual({ state: 'matched', assistantMessageId: 'assistant-12345678' });
    expect(resolveCausalAssistant(userId, [
      { id: 'assistant-neighbor', role: 'assistant' },
      { id: 'assistant-wrong-parent', role: 'assistant', parent: 'user-other-123' },
    ])).toEqual({ state: 'none' });
    expect(resolveCausalAssistant(userId, [
      { id: 'assistant-match-one', role: 'assistant', parent: userId },
      { id: 'assistant-match-two', role: 'assistant', parent: userId },
    ])).toEqual({ state: 'ambiguous' });
  });

  it('admits a witness surface only when a visible assistant has an exact visible user parent', async () => {
    const user = messageLocator('user', 'user-12345678');
    const assistant = messageLocator('assistant', 'assistant-12345678', 'user-12345678');
    const pageWithRelation = { locator: () => ({ count: async () => 2, nth: (index: number) => [user, assistant][index] }) };
    const pageWithoutRelation = { locator: () => ({ count: async () => 2, nth: (index: number) => [user, messageLocator('assistant', 'assistant-12345678')][index] }) };
    expect(await runtimeWitnessSurfaceAvailable(pageWithRelation)).toBe(true);
    expect(await runtimeWitnessSurfaceAvailable(pageWithoutRelation)).toBe(false);
  });

  it('S1 binds a dispatch candidate only after the same ID is service-visible; historical response IDs are ignored', async () => {
    const own = 'user-owned-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      historicalResponseUserIds: ['user-historical-12345678'],
      assistantParent: own,
      assistantText: 'canonical reply',
    });
    const result = await sendTurn(fixture.page, 'payload', {
      cdp,
      profile: join(root, 'profile'),
      chatUrl: 'https://chatgpt.com/c/example',
      newChat: false,
      timeoutMs: 2_000,
    });
    expect(result.state).toBe('ok');
    expect(result.userMessageId).toBe(own);
    expect(result.assistantMessageId).toBe('assistant-owned-12345678');
    expect(result.reply).toBe('canonical reply');
  });

  it('fails recovery when a dispatch request candidate is never observed on a service-visible surface', async () => {
    const fixture = fakeTurnPage({ dispatchCandidateIds: ['user-local-only-12345678'], serviceObserveDispatch: false });
    const result = await sendTurn(fixture.page, 'payload', {
      cdp,
      profile: join(root, 'profile'),
      chatUrl: 'https://chatgpt.com/c/example',
      newChat: false,
      timeoutMs: 1,
    });
    expect(result.state).toBe('recovery_required');
    expect(result.cause).toBe('submitted_turn_id_unproven');
  });

  it('S12 rejects multiple dispatch candidates and never guesses which one belongs to the invocation', async () => {
    const fixture = fakeTurnPage({ dispatchCandidateIds: ['user-one-12345678', 'user-two-12345678'] });
    const result = await sendTurn(fixture.page, 'payload', {
      cdp,
      profile: join(root, 'profile'),
      chatUrl: 'https://chatgpt.com/c/example',
      newChat: false,
      timeoutMs: 10,
    });
    expect(result.state).toBe('foreign_activity');
    expect(result.cause).toBe('submitted_turn_ambiguous');
  });

  it('S12 rejects foreign DOM activity even when this dispatch user ID is proven exactly', async () => {
    const own = 'user-owned-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      foreignDomUserIds: ['user-foreign-12345678'],
      assistantParent: own,
    });
    const result = await sendTurn(fixture.page, 'payload', {
      cdp,
      profile: join(root, 'profile'),
      chatUrl: 'https://chatgpt.com/c/example',
      newChat: false,
      timeoutMs: 10,
    });
    expect(result.state).toBe('foreign_activity');
    expect(result.cause).toBe('unexpected_user_turn');
  });

  it('S3 returns stream_timeout after possible delivery when no attributed assistant terminal appears', async () => {
    const fixture = fakeTurnPage({ dispatchCandidateIds: ['user-owned-12345678'] });
    const result = await sendTurn(fixture.page, 'payload', {
      cdp,
      profile: join(root, 'profile'),
      chatUrl: 'https://chatgpt.com/c/example',
      newChat: false,
      timeoutMs: 1,
    });
    expect(result.state).toBe('stream_timeout');
    expect(result.possibleDelivery).toBe(true);
  });

  it('awaits the final pre-send admission guard and performs zero dispatch when it refuses', async () => {
    const fixture = fakeTurnPage({ bodyText: 'ordinary conversation says usage limit and just a moment' });
    const config: BrowserConfig = {
      cdp,
      profile: join(root, 'profile'),
      chatUrl: 'https://chatgpt.com/c/example',
      newChat: false,
      timeoutMs: 1_000,
    };
    await expect(sendTurn(fixture.page, 'immutable payload', config, undefined, async () => {
      throw new Error('pre_send_test_refusal');
    })).rejects.toThrow('pre_send_test_refusal');
    expect(fixture.getSendClicks()).toBe(0);
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

describe('issue 964 normative terminal-state matrix', () => {
  const rows: Array<{
    state: TurnState;
    exit: number;
    scope: FailureScope;
    incident: 'none' | 'wall' | 'yes' | 'active-reference' | 'conditional';
    unblock: string;
  }> = [
    { state: 'ok', exit: 0, scope: 'none', incident: 'none', unblock: 'publication-status-only' },
    { state: 'input_invalid', exit: 10, scope: 'invocation', incident: 'none', unblock: 'new-valid-input' },
    { state: 'send_failed', exit: 10, scope: 'invocation', incident: 'none', unblock: 'proven-non-delivery' },
    { state: 'ui_contract_mismatch', exit: 10, scope: 'invocation', incident: 'none', unblock: 'compatible-ui-evidence' },
    { state: 'output_conflict', exit: 10, scope: 'invocation', incident: 'none', unblock: 'distinct-destination' },
    { state: 'quota', exit: 12, scope: 'profile', incident: 'wall', unblock: 'positive-ready-probe-plus-clear' },
    { state: 'challenge', exit: 12, scope: 'profile', incident: 'wall', unblock: 'positive-ready-probe-plus-clear' },
    { state: 'login', exit: 12, scope: 'profile', incident: 'wall', unblock: 'positive-ready-probe-plus-clear' },
    { state: 'chrome_not_running', exit: 12, scope: 'profile', incident: 'wall', unblock: 'positive-profile-verification-plus-clear' },
    { state: 'profile_mismatch', exit: 12, scope: 'profile', incident: 'wall', unblock: 'positive-owner-verification-plus-clear' },
    { state: 'orphaned_fresh_turn', exit: 12, scope: 'profile', incident: 'yes', unblock: 'canonical-recovery-or-exact-clear' },
    { state: 'profile_busy', exit: 12, scope: 'profile', incident: 'active-reference', unblock: 'owner-terminal-or-validated-reclaim' },
    { state: 'stream_timeout', exit: 11, scope: 'conversation', incident: 'yes', unblock: 'status-plus-exact-clear' },
    { state: 'no_reply', exit: 11, scope: 'conversation', incident: 'yes', unblock: 'terminal-evidence-plus-exact-clear' },
    { state: 'recovery_required', exit: 11, scope: 'conversation', incident: 'yes', unblock: 'recovery-or-exact-clear' },
    { state: 'foreign_activity', exit: 11, scope: 'conversation', incident: 'yes', unblock: 'status-plus-exact-clear' },
    { state: 'conversation_busy', exit: 11, scope: 'conversation', incident: 'active-reference', unblock: 'owner-terminal-or-validated-reclaim' },
    { state: 'driver_error', exit: 13, scope: 'machine', incident: 'conditional', unblock: 'resolved-scope-rule' },
    { state: 'incompatible_record', exit: 14, scope: 'profile', incident: 'yes', unblock: 'compatible-resolution-or-adjudication' },
  ];

  it('covers every mandatory state and stable exit family with scope/incident/unblock expectations', () => {
    expect(new Set(rows.map((row) => row.state))).toEqual(new Set(TURN_STATES));
    for (const row of rows) {
      expect(turnExitCode(row.state)).toBe(row.exit);
      expect(row.scope.length).toBeGreaterThan(0);
      expect(row.incident.length).toBeGreaterThan(0);
      expect(row.unblock.length).toBeGreaterThan(0);
    }
  });

  it('executes representative durable incident rows through the common status surface', () => {
    const representatives = [
      writeIncident(profileKey, { kind: 'profile_wall', generation: 1, phase: 'pre_send', cause: 'quota' }),
      writeIncident(profileKey, { kind: 'fresh_orphan', generation: 2, phase: 'possible_delivery', provisional_id: 'p-1', cause: 'orphan' }),
      writeIncident(profileKey, { kind: 'conversation_incident', generation: 3, phase: 'possible_delivery', conversation_id: 'https://chatgpt.com/c/a', cause: 'stream_timeout' }),
      writeIncident(profileKey, { kind: 'active_owner', generation: 4, phase: 'pre_send', cause: 'profile_busy' }),
      writeIncident(profileKey, { kind: 'publication_incident', generation: 5, phase: 'publication_prepared', invocation_id: 'matrix-publication', output_identity: 'output-fixture', cause: 'publication_commit_collision' }),
    ];
    const listed = statusList(profileKey);
    expect(listed.items).toHaveLength(representatives.length);
    expect(new Set(listed.items!.map((item) => item.kind))).toEqual(new Set([
      'profile_wall', 'fresh_orphan', 'conversation_incident', 'active_owner', 'publication_incident',
    ]));
  });
});

describe('issue 964 destination and scheduling fences — S4/S5/S6', () => {
  it('canonicalizes aliases, rejects dangling symlinks, and reserves a destination exclusively', () => {
    const output = join(root, 'out.txt');
    expect(destinationIdentity(output)).toEqual(destinationIdentity(join(root, '.', 'out.txt')));
    const first = reserveDestination(profileKey, output);
    expect(() => reserveDestination(profileKey, output)).toThrow('output_conflict:reserved');
    first.release();
    writeFileSync(output, 'external');
    expect(() => destinationIdentity(output)).toThrow('output_conflict:exists');
    expect(readFileSync(output, 'utf8')).toBe('external');

    const dangling = join(root, 'dangling.txt');
    symlinkSync(join(root, 'missing-target'), dangling);
    expect(() => destinationIdentity(dangling)).toThrow('output_conflict:exists');
  });

  it('revalidates an externally-created destination immediately before dispatch and sends zero times', async () => {
    const output = join(root, 'race.txt');
    const reservation = reserveDestination(profileKey, output);
    writeFileSync(output, 'external-winner');
    const fixture = fakeTurnPage();
    await expect(sendTurn(fixture.page, 'payload', {
      cdp,
      profile: join(root, 'profile'),
      chatUrl: 'https://chatgpt.com/c/example',
      newChat: false,
      timeoutMs: 100,
    })).rejects.toThrow('output_conflict:exists');
    expect(fixture.getSendClicks()).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('external-winner');
    reservation.release();
  });

  it('S4 permits distinct conversation locks while positive admission is parallel', () => {
    const one = acquireDomainLock(profileKey, 'conversation:https://chatgpt.com/c/one');
    const two = acquireDomainLock(profileKey, 'conversation:https://chatgpt.com/c/two');
    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    two!.release();
    one!.release();
  });

  it('S5 selects one same-chat winner', () => {
    const key = 'conversation:https://chatgpt.com/c/abc';
    const first = acquireDomainLock(profileKey, key);
    expect(first).not.toBeNull();
    expect(acquireDomainLock(profileKey, key)).toBeNull();
    first!.release();
  });

  it('S6 permits distinct fresh identities but profile fallback conflicts with active parallel owners', () => {
    const freshOne = acquireDomainLock(profileKey, 'fresh:one');
    const freshTwo = acquireDomainLock(profileKey, 'fresh:two');
    expect(freshOne).not.toBeNull();
    expect(freshTwo).not.toBeNull();
    expect(acquireDomainLock(profileKey, `profile:${profileKey}`)).toBeNull();
    freshTwo!.release();
    freshOne!.release();

    const profile = acquireDomainLock(profileKey, `profile:${profileKey}`);
    expect(profile).not.toBeNull();
    expect(acquireDomainLock(profileKey, 'conversation:https://chatgpt.com/c/new')).toBeNull();
    profile!.release();
  });

  it('reclaims only proven-dead stale pre-send owners; unknown start-token evidence remains busy', () => {
    const reclaimKey = 'conversation:reclaim';
    deadOwnerRecord(reclaimKey, 'pre_send');
    const reclaimed = acquireDomainLock(profileKey, reclaimKey, 1);
    expect(reclaimed?.generation).toBe(8);
    reclaimed!.release();

    const deliveryKey = 'conversation:no-reclaim';
    deadOwnerRecord(deliveryKey, 'possible_delivery');
    expect(acquireDomainLock(profileKey, deliveryKey, 1)).toBeNull();

    const unknownKey = 'conversation:unknown-owner-token';
    deadOwnerRecord(unknownKey, 'pre_send', process.pid, '');
    expect(acquireDomainLock(profileKey, unknownKey, 1)).toBeNull();
  });
});

describe('issue 964 UI ownership and profile walls — S7/S8/S9', () => {
  it('S7 refuses duplicate exact-chat tabs rather than selecting stale authority', async () => {
    const page = (url: string) => ({ url: () => url, bringToFront: async () => {} });
    const browser = { contexts: () => [{ pages: () => [page('https://chatgpt.com/c/a'), page('https://chatgpt.com/c/a')] }] };
    await expect(openTurnPage(browser, {
      cdp,
      profile: join(root, 'profile'),
      chatUrl: 'https://chatgpt.com/c/a',
      newChat: false,
      timeoutMs: 100,
    })).rejects.toThrow('ui_contract_mismatch:duplicate_tabs');
  });

  it('S8 recognizes a product-owned quota alert before send', async () => {
    const fixture = fakeTurnPage({ alertText: "You've reached the current usage limit" });
    const result = await sendTurn(fixture.page, 'payload', {
      cdp,
      profile: join(root, 'profile'),
      chatUrl: 'https://chatgpt.com/c/example',
      newChat: false,
      timeoutMs: 100,
    });
    expect(result.state).toBe('quota');
    expect(fixture.getSendClicks()).toBe(0);
  });

  it('S8 does not treat authored conversation wall phrases as product state while composer is healthy', async () => {
    const fixture = fakeTurnPage({ bodyText: 'verify you are human; just a moment; usage limit; please try again later' });
    await expect(sendTurn(fixture.page, 'payload', {
      cdp,
      profile: join(root, 'profile'),
      chatUrl: 'https://chatgpt.com/c/example',
      newChat: false,
      timeoutMs: 100,
    }, undefined, async () => {
      throw new Error('reached_send_boundary');
    })).rejects.toThrow('reached_send_boundary');
    expect(fixture.getSendClicks()).toBe(0);
  });

  it('S8 preserves possible-delivery evidence when a product wall appears mid-turn', async () => {
    const own = 'user-owned-12345678';
    const fixture = fakeTurnPage({ dispatchCandidateIds: [own], alertAfterSend: 'usage limit' });
    const result = await sendTurn(fixture.page, 'payload', {
      cdp,
      profile: join(root, 'profile'),
      chatUrl: 'https://chatgpt.com/c/example',
      newChat: false,
      timeoutMs: 100,
    });
    expect(result.state).toBe('recovery_required');
    expect(result.cause).toBe('profile_wall:quota');
    expect(result.userMessageId).toBe(own);
  });

  it('S9 returns ui_contract_mismatch with zero send when composer is unavailable without a product wall', async () => {
    const fixture = fakeTurnPage({ composer: false, bodyText: 'ordinary page' });
    const result = await sendTurn(fixture.page, 'payload', {
      cdp,
      profile: join(root, 'profile'),
      chatUrl: 'https://chatgpt.com/c/example',
      newChat: false,
      timeoutMs: 1,
    });
    expect(result.state).toBe('ui_contract_mismatch');
    expect(fixture.getSendClicks()).toBe(0);
  });
});

describe('issue 964 publication witness and races — S11', () => {
  it('S1 publishes exactly once with an invocation-exclusive inode witness', () => {
    const output = join(root, 'reply.txt');
    const destination = destinationIdentity(output);
    const reply = 'line one\nline two';
    const published = publishReply(profileKey, 'invocation-ok', destination.finalPath, destination.identity, reply);
    expect(published.state).toBe('committed_ok');
    expect(readFileSync(output, 'utf8')).toBe(reply);
    expect(published.output_sha256).toBe(sha256(reply));
    expect(publicationStatus(profileKey, 'invocation-ok').state).toBe('committed_ok');
  });

  it('S11 never overwrites a foreign destination after possible delivery and retains the complete temp', () => {
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
  });

  it('recognizes a post-rename/pre-emission crash as committed from the exact regular-file inode', () => {
    const fixture = makePublicationFixture('crashed', 'post-rename.txt', 'completed', true);
    const status = publicationStatus(profileKey, 'crashed');
    expect(status.state).toBe('committed_ok');
    expect(status.output_sha256).toBe(sha256('completed'));
    expect(existsSync(fixture.output)).toBe(true);
  });

  it('reports a prepared reply with a dead owner as recovery, never retryable output conflict', () => {
    const fixture = makePublicationFixture('prepared', 'prepared.txt', 'complete-but-uncommitted');
    const status = publicationStatus(profileKey, 'prepared');
    expect(status.state).toBe('recovery_required');
    expect(status.cause).toBe('prepared_without_live_owner');
    expect(existsSync(fixture.output)).toBe(false);
  });

  it('blocks malformed path-bearing publication records and never deletes the unrelated target', () => {
    const output = resolve(join(root, 'safe-output.txt'));
    const identity = destinationIdentityForPath(output).identity;
    const unrelated = join(root, 'unrelated.tmp');
    writeFileSync(unrelated, 'keep-me');
    const witness = statSync(unrelated, { bigint: true });
    atomicJson(join(profileDirs(profileKey).publications, 'unsafe.json'), {
      schema: PUBLICATION_SCHEMA,
      version: 1,
      configured_profile_key: profileKey,
      invocation_id: 'unsafe',
      output_path: output,
      output_identity: identity,
      temp_path: unrelated,
      temp_dev: String(witness.dev),
      temp_ino: String(witness.ino),
      owner_pid: 999999,
      state: 'prepared',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    expect(statusList(profileKey).state).toBe('profile_blocked');
    const incident = writeIncident(profileKey, {
      kind: 'publication_incident',
      generation: 1,
      phase: 'publication_prepared',
      invocation_id: 'unsafe',
      output_identity: identity,
      cause: 'fixture',
    });
    expect(clearReadable(profileKey, incident.identity, 1, incident.record.evidence_token).state).toBe('refused_active');
    expect(readFileSync(unrelated, 'utf8')).toBe('keep-me');
  });

  it('refuses traversal in a publication-status invocation identifier', () => {
    expect(publicationStatus(profileKey, '../../outside').state).toBe('profile_blocked');
  });
});

describe('issue 964 durable incident recovery — S10 and opaque force', () => {
  it('lists and clears exact readable incidents but refuses a live owner and path-traversal identity', () => {
    const live = writeIncident(profileKey, {
      kind: 'active_owner',
      generation: 1,
      phase: 'pre_send',
      owner: { pid: process.pid, started_at: new Date().toISOString(), nonce: 'live' },
    });
    expect(statusList(profileKey).state).toBe('ok');
    expect(clearReadable(profileKey, live.identity, 1, live.record.evidence_token).state).toBe('refused_active');
    expect(clearReadable(profileKey, '../../escape', 1, 'x').state).toBe('not_found');

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

  it('quarantines opaque bytes, enumerates quarantine+tombstone, and stays blocked until exact adjudication', () => {
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
    expect(blocked.items!.some((item) => item.kind === 'opaque_quarantine')).toBe(true);
    const tombstone = blocked.items!.find((item) => item.kind === 'blocking_tombstone')!;
    const evidence = sha256('operator-adjudication');
    expect(adjudicateTombstone(profileKey, tombstone.identity, tombstone.generation, evidence, sha256('changed')).state).toBe('evidence_changed');
    expect(adjudicateTombstone(profileKey, tombstone.identity, tombstone.generation, evidence, evidence).state).toBe('cleared');
    expect(statusList(profileKey).state).toBe('none');
    const preserved = readdirSync(profileDirs(profileKey).resolved).find((name) => name.endsWith('.opaque'))!;
    expect(readFileSync(join(profileDirs(profileKey).resolved, preserved))).toEqual(opaqueBytes);
  });

  it('opaque live-owner, possible-delivery, and committed-publication stand-ins retain blocking force', () => {
    writeFileSync(join(profileDirs(profileKey).records, 'future-live-owner.json'), '{"future":"live-owner"}\n');
    writeFileSync(join(profileDirs(profileKey).records, 'future-possible-delivery.json'), '{"future":"possible-delivery"}\n');
    writeFileSync(join(profileDirs(profileKey).publications, 'future-committed.json'), '{"future":"committed-publication"}\n');
    for (let index = 0; index < 3; index++) {
      const current = statusList(profileKey);
      const opaque = current.items!.find((item) => item.kind === 'opaque_record');
      expect(opaque).toBeDefined();
      expect(quarantineOpaque(profileKey, opaque!.identity, opaque!.generation).state).toBe('quarantined');
      expect(statusList(profileKey).state).toBe('profile_blocked');
    }
    const final = statusList(profileKey);
    expect(final.items!.filter((item) => item.kind === 'blocking_tombstone')).toHaveLength(3);
    expect(final.items!.filter((item) => item.kind === 'opaque_quarantine')).toHaveLength(3);
  });

  it('rejects tombstone traversal metadata without touching an outside file', () => {
    const identity = `tombstone-${randomUUID()}`;
    const outside = join(profileDirs(profileKey).root, 'outside.opaque');
    writeFileSync(outside, 'outside');
    atomicJson(join(profileDirs(profileKey).tombstones, `${identity}.json`), {
      schema: 'chatgpt-browser-turn-tombstone/v1',
      version: 1,
      configured_profile_key: profileKey,
      identity,
      generation: 1,
      source_area: 'records',
      source_name: 'future.json',
      source_generation: 1,
      source_digest: sha256('outside'),
      quarantine_name: '../outside.opaque',
      state: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    expect(statusList(profileKey).state).toBe('profile_blocked');
    const evidence = sha256('operator');
    expect(adjudicateTombstone(profileKey, identity, 1, evidence, evidence).state).toBe('profile_blocked');
    expect(readFileSync(outside, 'utf8')).toBe('outside');
  });

  it('S10 preserves a fresh-orphan incident until exact generation/evidence clear', () => {
    const orphan = writeIncident(profileKey, {
      kind: 'fresh_orphan',
      generation: 4,
      phase: 'possible_delivery',
      provisional_id: 'provisional-1',
      cause: 'canonical_fresh_conversation_unproven',
    });
    expect(statusList(profileKey).items!.some((item) => item.kind === 'fresh_orphan')).toBe(true);
    expect(clearReadable(profileKey, orphan.identity, 3, orphan.record.evidence_token).state).toBe('stale_generation');
    expect(clearReadable(profileKey, orphan.identity, 4, orphan.record.evidence_token).state).toBe('cleared');
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

describe('issue 964 privacy boundary', () => {
  it('keeps plaintext, encoded, transformed, and known-digest canaries out of helper JSON state', () => {
    const secretBody = 'DO-NOT-LEAK-UNIQUE-BODY-964';
    const destination = destinationIdentity(join(root, 'leak.txt'));
    writeFileSync(destination.finalPath, 'external');
    publishReply(profileKey, 'leak-collision', destination.finalPath, destination.identity, secretBody);
    const canaries = [
      secretBody,
      Buffer.from(secretBody, 'utf8').toString('base64'),
      Buffer.from(secretBody, 'utf8').toString('hex'),
      secretBody.split('').reverse().join(''),
      sha256(secretBody),
    ];
    const jsonFiles: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.json')) jsonFiles.push(path);
      }
    };
    walk(profileDirs(profileKey).root);
    for (const path of jsonFiles) {
      const text = readFileSync(path, 'utf8');
      for (const canary of canaries) expect(text).not.toContain(canary);
    }
    const survivingTemp = readdirSync(root).find((name) => name.includes('leak-collision') && name.endsWith('.tmp'))!;
    expect(readFileSync(join(root, survivingTemp), 'utf8')).toBe(secretBody);
  });
});

describe('issue 964 retained recovery binary lifecycle', () => {
  it('runs an out-of-worktree retained copy for status, clear, quarantine/adjudication, and publication status', () => {
    const retained = join(root, 'retained-copy');
    mkdirSync(join(retained, 'scripts', 'kernel'), { recursive: true });
    mkdirSync(join(retained, '.claude', 'skills', 'discuss-with-gpt'), { recursive: true });
    cpSync(join(repoRoot, 'package.json'), join(retained, 'package.json'));
    cpSync(join(repoRoot, 'scripts', 'chatgpt-browser-turn.ts'), join(retained, 'scripts', 'chatgpt-browser-turn.ts'));
    cpSync(join(repoRoot, 'scripts', 'chatgpt-browser-turn'), join(retained, 'scripts', 'chatgpt-browser-turn'), { recursive: true });
    cpSync(join(repoRoot, 'scripts', 'kernel', 'subprocess.ts'), join(retained, 'scripts', 'kernel', 'subprocess.ts'));
    cpSync(
      join(repoRoot, '.claude', 'skills', 'discuss-with-gpt', 'verify-cdp-owner.mjs'),
      join(retained, '.claude', 'skills', 'discuss-with-gpt', 'verify-cdp-owner.mjs'),
    );
    const entry = join(retained, 'scripts', 'chatgpt-browser-turn.ts');
    const env = { ...process.env, CHATGPT_BROWSER_TURN_STATE_DIR: process.env.CHATGPT_BROWSER_TURN_STATE_DIR! };
    const run = (args: string[]) => {
      const result = spawnSync(process.execPath, ['--experimental-strip-types', entry, ...args], { encoding: 'utf8', env });
      const stdout = result.stdout.trim();
      return { status: result.status, body: stdout ? JSON.parse(stdout) as Record<string, any> : null, stderr: result.stderr };
    };
    const base = ['--profile', join(root, 'profile'), '--cdp', cdp];

    const readable = writeIncident(profileKey, {
      kind: 'conversation_incident',
      generation: 1,
      phase: 'possible_delivery',
      cause: 'fixture',
    });
    let observed = run(['status/list', ...base]);
    expect(observed.status).toBe(0);
    expect(observed.body?.items.some((item: any) => item.identity === readable.identity)).toBe(true);
    observed = run([
      'clear', ...base,
      '--identity', readable.identity,
      '--generation', '1',
      '--evidence-token', readable.record.evidence_token,
    ]);
    expect(observed.body?.state).toBe('cleared');

    writeFileSync(join(profileDirs(profileKey).records, 'future-retained.json'), '{"future":true}\n');
    observed = run(['status/list', ...base]);
    const opaque = observed.body?.items.find((item: any) => item.kind === 'opaque_record');
    expect(opaque).toBeDefined();
    observed = run([
      'clear', ...base,
      '--identity', opaque.identity,
      '--generation', String(opaque.generation),
      '--quarantine',
    ]);
    expect(observed.body?.state).toBe('quarantined');
    observed = run(['status/list', ...base]);
    const tombstone = observed.body?.items.find((item: any) => item.kind === 'blocking_tombstone');
    expect(tombstone).toBeDefined();
    expect(observed.body?.items.some((item: any) => item.kind === 'opaque_quarantine')).toBe(true);
    const evidenceFile = join(root, 'adjudication.txt');
    writeFileSync(evidenceFile, 'operator evidence');
    const evidenceDigest = sha256(readFileSync(evidenceFile));
    observed = run([
      'clear', ...base,
      '--identity', tombstone.identity,
      '--generation', String(tombstone.generation),
      '--adjudicate',
      '--adjudication-evidence-file', evidenceFile,
      '--expected-adjudication-sha256', evidenceDigest,
    ]);
    expect(observed.body?.state).toBe('cleared');

    makePublicationFixture('retained-prepared', 'retained-output.txt', 'complete reply');
    observed = run(['publication-status', ...base, '--invocation', 'retained-prepared']);
    expect(observed.status).toBe(20);
    expect(observed.body?.state).toBe('recovery_required');
  });
});
