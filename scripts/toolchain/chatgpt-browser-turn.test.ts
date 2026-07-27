import { randomUUID } from 'node:crypto';
import {
  chmodSync,
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  applyCapabilityAfterSuccessfulTurn,
  capabilityStatus,
  clearReadable,
  downgradeCapability,
  planCapabilityAfterSuccessfulTurn,
  quarantineOpaque,
  statusList,
  __testWriteCapability,
  writeIncident,
} from '../chatgpt-browser-turn/state.ts';
import { atomicJson, configuredProfileKey, profileDirs, sha256 } from '../chatgpt-browser-turn/storage-common.ts';
import {
  __testTiming,
  openTurnPage,
  resolveCausalAssistant,
  runtimeWitnessSurfaceAvailable,
  sendTurn,
  type BrowserConfig,
} from '../chatgpt-browser-turn/ui-adapter.ts';
import { lastDispatchObservationDiagnostic } from '../chatgpt-browser-turn/dispatch-observation.ts';
import { emptyLocator, fakeTurnPage, messageLocator } from '../chatgpt-browser-turn/fixtures/fake-turn-page.ts';
import {
  DELTA_ONLY_FRAME,
  framesToSseBody,
  LIVE_TERMINAL_FAILURE_FRAME_CONTRACT,
  LIVE_TERMINAL_FRAME_CONTRACT,
  PATCH_ONLY_FRAME,
  STREAM_COMPLETE_ONLY_FRAME,
} from '../chatgpt-browser-turn/fixtures/live-terminal-frame-contract.ts';
import {
  createTerminalWitnessState,
  deltaPatchOrStreamCompleteWithoutTerminal,
  ingestServicePayload,
  isMessageAttributedToUserTurn,
  nodeLocalStopWithoutWholeTurn,
  resolveWholeTurnTerminal,
  wholeTurnTerminalOutcome,
} from '../chatgpt-browser-turn/terminal-witness.ts';
import { runProcessSync } from '../kernel/subprocess.ts';

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
    const emptyConversation = { locator: () => ({ count: async () => 0, nth: () => emptyLocator() }) };
    expect(await runtimeWitnessSurfaceAvailable(pageWithRelation)).toBe('available');
    expect(await runtimeWitnessSurfaceAvailable(pageWithoutRelation)).toBe('absent');
    expect(await runtimeWitnessSurfaceAvailable(emptyConversation)).toBe('empty');
    const countThrows = { locator: () => ({ count: async () => { throw new Error('dom query failed'); }, nth: () => emptyLocator() }) };
    expect(await runtimeWitnessSurfaceAvailable(countThrows)).toBe('absent');
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
    __testWriteCapability(profileKey, {
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
    __testWriteCapability(profileKey, {
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


describe('issue 1008 capability self-arm', () => {
  function completion(binding: ReturnType<typeof runtimeCapabilityBinding>, evidenceKey: string, browser = 'Chromium test') {
    return {
      expectedBinding: binding,
      browserProvenance: browser,
      evidenceDigest: sha256(evidenceKey),
      witnessed: true,
    };
  }

  it('arms parallel eligibility from witnessed completion with no operator env', () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    const outcome = applyCapabilityAfterSuccessfulTurn(profileKey, completion(binding, 'self-arm-no-env'));
    expect(outcome.applied).toBe(true);
    expect(capabilityStatus(profileKey, binding).state).toBe('ok');
    expect(capabilityStatus(profileKey, binding).capability?.parallel_eligible).toBe(true);
  });

  it('re-reads capability state so a stale refresh snapshot loses to a downgrade', () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    const now = Date.now();
    __testWriteCapability(profileKey, {
      ...binding,
      browser_provenance: 'Chromium test',
      evidence_digest: sha256('before-downgrade'),
      observed_at: new Date(now - 1_000).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
      downgrade_generation: 0,
      parallel_eligible: true,
    });
    const stale = capabilityStatus(profileKey, binding);
    expect(stale.state).toBe('ok');
    expect(planCapabilityAfterSuccessfulTurn(stale, completion(binding, 'stale-refresh')).parallel_eligible).toBe(true);
    downgradeCapability(profileKey);
    const outcome = applyCapabilityAfterSuccessfulTurn(profileKey, completion(binding, 'post-downgrade-arm'));
    expect(outcome.applied).toBe(true);
    const armed = capabilityStatus(profileKey, binding);
    expect(armed.state).toBe('ok');
    expect(armed.capability?.downgrade_generation).toBe(2);
    expect(armed.capability?.evidence_digest).toBe(sha256('post-downgrade-arm'));
  });


  it('re-read after a competing refresh prevents an older completion from regressing expiry', () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    const now = Date.now();
    const nearFuture = new Date(now + 60 * 60 * 1000).toISOString();
    const farFuture = new Date(now + 5 * 60 * 60 * 1000).toISOString();
    __testWriteCapability(profileKey, {
      ...binding,
      browser_provenance: 'Chromium test',
      evidence_digest: sha256('initial-near'),
      observed_at: new Date(now - 1_000).toISOString(),
      expires_at: nearFuture,
      downgrade_generation: 0,
      parallel_eligible: true,
    });
    const staleRead = capabilityStatus(profileKey, binding);
    expect(staleRead.state).toBe('ok');

    __testWriteCapability(profileKey, {
      ...binding,
      browser_provenance: 'Chromium test',
      evidence_digest: sha256('competing-newer'),
      observed_at: new Date(now).toISOString(),
      expires_at: farFuture,
      downgrade_generation: 0,
      parallel_eligible: true,
    });
    const newerExpires = capabilityStatus(profileKey, binding).capability!.expires_at;
    expect(Date.parse(newerExpires)).toBe(Date.parse(farFuture));

    const stalePlan = planCapabilityAfterSuccessfulTurn(staleRead, completion(binding, 'older-refresh'));
    expect(Date.parse(stalePlan.expires_at)).toBeLessThan(Date.parse(newerExpires));

    const outcome = applyCapabilityAfterSuccessfulTurn(profileKey, completion(binding, 'older-refresh'));
    expect(outcome.applied).toBe(true);
    expect(Date.parse(capabilityStatus(profileKey, binding).capability!.expires_at)).toBeGreaterThanOrEqual(Date.parse(newerExpires));
    expect(capabilityStatus(profileKey, binding).capability?.downgrade_generation).toBe(0);
  });

  it('never shortens expiry on refresh', () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    const now = Date.now();
    const farFuture = new Date(now + 3 * 60 * 60 * 1000).toISOString();
    __testWriteCapability(profileKey, {
      ...binding,
      browser_provenance: 'Chromium test',
      evidence_digest: sha256('initial'),
      observed_at: new Date(now - 1_000).toISOString(),
      expires_at: farFuture,
      downgrade_generation: 1,
      parallel_eligible: true,
    });
    const outcome = applyCapabilityAfterSuccessfulTurn(profileKey, completion(binding, 'refresh-extends'));
    expect(outcome.applied).toBe(true);
    const refreshed = capabilityStatus(profileKey, binding);
    expect(Date.parse(refreshed.capability!.expires_at)).toBeGreaterThanOrEqual(Date.parse(farFuture));
    expect(refreshed.capability?.downgrade_generation).toBe(1);
  });

  it('swallows capability store write failures', () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    const now = Date.now();
    __testWriteCapability(profileKey, {
      ...binding,
      browser_provenance: 'Chromium test',
      evidence_digest: sha256('before-write-failure'),
      observed_at: new Date(now - 1_000).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
      downgrade_generation: 0,
      parallel_eligible: true,
    });
    const profileRoot = profileDirs(profileKey).root;
    chmodSync(profileRoot, 0o555);
    try {
      const outcome = applyCapabilityAfterSuccessfulTurn(profileKey, completion(binding, 'write-fails'));
      expect(outcome.applied).toBe(false);
      expect(outcome.reason).toBe('write_failed');
      expect(capabilityStatus(profileKey, binding).state).toBe('ok');
    } finally {
      chmodSync(profileRoot, 0o755);
    }
  });

  it('arms from serialized completion after provenance downgrade', () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    const now = Date.now();
    __testWriteCapability(profileKey, {
      ...binding,
      browser_provenance: 'old-browser',
      evidence_digest: sha256('old-provenance'),
      observed_at: new Date(now - 1_000).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
      downgrade_generation: 0,
      parallel_eligible: true,
    });
    downgradeCapability(profileKey);
    expect(capabilityStatus(profileKey, binding).state).toBe('downgraded');
    const outcome = applyCapabilityAfterSuccessfulTurn(
      profileKey,
      completion(binding, 'new-provenance-arm', 'new-browser'),
    );
    expect(outcome.applied).toBe(true);
    const armed = capabilityStatus(profileKey, binding);
    expect(armed.state).toBe('ok');
    expect(armed.capability?.browser_provenance).toBe('new-browser');
    expect(armed.capability?.parallel_eligible).toBe(true);
    expect(armed.capability?.downgrade_generation).toBe(2);
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
    const run = (args: string[]) => {
      const result = runProcessSync({
        command: process.execPath,
        args: ['--experimental-strip-types', entry, ...args],
        inheritParentEnv: true,
        env: { CHATGPT_BROWSER_TURN_STATE_DIR: process.env.CHATGPT_BROWSER_TURN_STATE_DIR! },
      });
      const stdout = result.stdout.trim();
      return {
        status: result.exitCode,
        body: stdout ? JSON.parse(stdout) as Record<string, any> : null,
        stderr: result.stderr,
      };
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

describe('issue 996 whole-turn terminal assistant completion', () => {
  const baseConfig = (): BrowserConfig => ({
    cdp,
    profile: join(root, 'profile'),
    chatUrl: 'https://chatgpt.com/c/example',
    newChat: false,
    timeoutMs: 2_000,
  });

  it('does not treat unknown terminal metadata as whole-turn success', () => {
    expect(wholeTurnTerminalOutcome({
      endTurn: true,
      finishDetailsType: 'stop',
      status: 'in_progress',
    })).toBe('none');
    expect(wholeTurnTerminalOutcome({
      endTurn: true,
      finishDetailsType: 'stop',
    })).toBe('success');
  });

  it('preserves sanitized live terminal failure frame contract before AC5/AC6 fixtures', () => {
    expect(LIVE_TERMINAL_FAILURE_FRAME_CONTRACT.map((frame) => frame.type)).toEqual(['delta', 'delta']);
    const generationError = LIVE_TERMINAL_FAILURE_FRAME_CONTRACT[0]?.v as { message?: { status?: string; content?: { content_type?: string } } };
    expect(generationError?.message?.status).toBe('finished_failed');
    expect(generationError?.message?.content?.content_type).toBe('execution_error');
    const interrupted = LIVE_TERMINAL_FAILURE_FRAME_CONTRACT[1]?.v as { message?: { status?: string } };
    expect(interrupted?.message?.status).toBe('interrupted');
  });

  it('AC13 preserves sanitized live terminal-frame contract before fixture derivation', () => {
    const witness = createTerminalWitnessState();
    for (const frame of LIVE_TERMINAL_FRAME_CONTRACT) ingestServicePayload(witness, frame as Record<string, unknown>);
    expect(witness.frames.map((frame) => frame.kind)).toEqual([
      'input_message', 'delta', 'patch', 'delta', 'delta', 'stream_complete',
    ]);
    const terminal = resolveWholeTurnTerminal('user-sanitized-12345678', witness);
    expect(terminal).toEqual({ state: 'success', assistantMessageId: 'asst-terminal-12345678' });
    expect(nodeLocalStopWithoutWholeTurn(witness.terminalByMessageId.get('asst-preamble-12345678'))).toBe(true);
    expect(wholeTurnTerminalOutcome(witness.terminalByMessageId.get('asst-terminal-12345678'))).toBe('success');
    expect(wholeTurnTerminalOutcome({
      endTurn: false,
      status: 'finished_failed',
      contentType: 'execution_error',
    })).toBe('none');
  });

  it('AC13 fail-closes delta-only, patch-only, and stream-complete-only observations', () => {
    for (const frame of [DELTA_ONLY_FRAME, PATCH_ONLY_FRAME, STREAM_COMPLETE_ONLY_FRAME]) {
      const witness = createTerminalWitnessState();
      ingestServicePayload(witness, frame as Record<string, unknown>);
      const terminal = resolveWholeTurnTerminal('user-sanitized-12345678', witness);
      expect(terminal.state).toBe('none');
      expect(deltaPatchOrStreamCompleteWithoutTerminal(witness, terminal)).toBe(true);
    }
  });

  it('AC1 single-node direct-child success preserves existing behavior', async () => {
    const own = 'user-owned-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      assistantParent: own,
      assistantText: 'canonical reply',
    });
    const result = await sendTurn(fixture.page, 'payload', baseConfig());
    expect(result.state).toBe('ok');
    expect(result.assistantMessageId).toBe('assistant-owned-12345678');
    expect(result.reply).toBe('canonical reply');
  });

  it('AC2 interleaved multi-node success publishes terminal assistant only', async () => {
    const own = 'user-owned-12345678';
    const frames = LIVE_TERMINAL_FRAME_CONTRACT.map((frame) => {
      if (frame.type === 'input_message') {
        return { ...frame, input_message: { id: own } };
      }
      if (frame.type === 'delta' && (frame.v as any).message?.id === 'asst-preamble-12345678') {
        return {
          ...frame,
          v: {
            message: {
              ...(frame.v as any).message,
              parent: own,
            },
          },
        };
      }
      return frame;
    });
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      serviceFrames: frames as Record<string, unknown>[],
      assistants: [
        { id: 'asst-preamble-12345678', parent: own, text: 'Thinking...', appearOnSend: true },
        { id: 'asst-terminal-12345678', parent: 'tool-handoff-12345678', text: 'Final answer body', appearOnSend: true },
      ],
    });
    const result = await sendTurn(fixture.page, 'payload', baseConfig());
    expect(result.state).toBe('ok');
    expect(result.assistantMessageId).toBe('asst-terminal-12345678');
    expect(result.reply).toBe('Final answer body');
    expect(result.reply).not.toContain('Thinking');
  });

  it('AC3 attributes terminal assistant across intermediate system/tool nodes', () => {
    const witness = createTerminalWitnessState();
    for (const frame of LIVE_TERMINAL_FRAME_CONTRACT) ingestServicePayload(witness, frame as Record<string, unknown>);
    expect(isMessageAttributedToUserTurn('asst-terminal-12345678', 'user-sanitized-12345678', witness.messages)).toBe(true);
    expect(isMessageAttributedToUserTurn('tool-handoff-12345678', 'user-sanitized-12345678', witness.messages)).toBe(true);
  });

  it('AC4 node-local stop before tool handoff is not terminal', async () => {
    const own = 'user-owned-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      assistants: [{ id: 'asst-preamble-12345678', parent: own, text: 'partial', appearOnSend: true }],
      serviceFrames: [
        {
          type: 'delta',
          v: {
            message: {
              id: 'asst-preamble-12345678',
              author: { role: 'assistant' },
              parent: own,
              end_turn: false,
              metadata: { finish_details: { type: 'stop' } },
            },
          },
        },
        {
          type: 'delta',
          v: {
            message: {
              id: 'tool-handoff-12345678',
              author: { role: 'tool' },
              parent: 'asst-preamble-12345678',
            },
          },
        },
        {
          type: 'delta',
          v: {
            message: {
              id: 'asst-terminal-12345678',
              author: { role: 'assistant' },
              parent: 'tool-handoff-12345678',
              end_turn: true,
              metadata: { finish_details: { type: 'stop' } },
            },
          },
        },
      ],
    });
  await fixture.page.addAssistant({ id: 'asst-terminal-12345678', parent: 'tool-handoff-12345678', text: 'final answer' });
    const result = await sendTurn(fixture.page, 'payload', baseConfig());
    expect(result.state).toBe('ok');
    expect(result.assistantMessageId).toBe('asst-terminal-12345678');
    expect(result.reply).toBe('final answer');
  });

  it('AC5 generation-error terminal failure returns no_reply promptly', async () => {
    const own = 'user-owned-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      serviceFrames: [{
        type: 'delta',
        v: {
          message: {
            id: 'assistant-owned-12345678',
            author: { role: 'assistant' },
            parent: own,
            end_turn: true,
            status: 'finished_failed',
            content: { content_type: 'execution_error', text: 'generation failed' },
          },
        },
      }],
    });
    const result = await sendTurn(fixture.page, 'payload', { ...baseConfig(), timeoutMs: 200 });
    expect(result.state).toBe('no_reply');
    expect(result.cause).toBe('terminal_generation_error');
  });

  it('AC6 interrupted terminal failure returns no_reply promptly', async () => {
    const own = 'user-owned-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      serviceFrames: [{
        type: 'delta',
        v: {
          message: {
            id: 'assistant-owned-12345678',
            author: { role: 'assistant' },
            parent: own,
            end_turn: true,
            status: 'interrupted',
          },
        },
      }],
    });
    const result = await sendTurn(fixture.page, 'payload', { ...baseConfig(), timeoutMs: 200 });
    expect(result.state).toBe('no_reply');
    expect(result.cause).toBe('terminal_interrupted');
  });

  it('AC7 same-turn assistant plurality is not foreign; foreign turn remains foreign', async () => {
    const own = 'user-owned-12345678';
    const pluralFixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      assistants: [
        { id: 'assistant-sibling-12345678', parent: own, text: 'draft', appearOnSend: true },
        { id: 'assistant-owned-12345678', parent: own, text: 'final', appearOnSend: true },
      ],
      serviceFrames: [
        {
          type: 'delta',
          v: {
            message: {
              id: 'assistant-sibling-12345678',
              author: { role: 'assistant' },
              parent: own,
              end_turn: false,
            },
          },
        },
        {
          type: 'delta',
          v: {
            message: {
              id: 'assistant-owned-12345678',
              author: { role: 'assistant' },
              parent: own,
              end_turn: true,
              metadata: { finish_details: { type: 'stop' } },
            },
          },
        },
      ],
    });
    const pluralResult = await sendTurn(pluralFixture.page, 'payload', baseConfig());
    expect(pluralResult.state).toBe('ok');
    expect(pluralResult.assistantMessageId).toBe('assistant-owned-12345678');

    const foreignFixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      foreignDomUserIds: ['user-foreign-12345678'],
      assistants: [{ id: 'assistant-foreign-12345678', parent: 'user-foreign-12345678', text: 'foreign', appearOnSend: true }],
      serviceFrames: [{
        type: 'delta',
        v: {
          message: {
            id: 'assistant-foreign-12345678',
            author: { role: 'assistant' },
            parent: 'user-foreign-12345678',
            end_turn: true,
            metadata: { finish_details: { type: 'stop' } },
          },
        },
      }],
    });
    const foreignResult = await sendTurn(foreignFixture.page, 'payload', { ...baseConfig(), timeoutMs: 200 });
    expect(foreignResult.state).toBe('foreign_activity');
    expect(foreignResult.cause).toBe('unexpected_user_turn');
  });

  it('AC8 waits for complete terminal serialization instead of first partial snapshot', async () => {
    const own = 'user-owned-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      assistants: [{
        id: 'assistant-owned-12345678',
        parent: own,
        textSequence: ['partial', 'complete answer'],
        appearOnSend: true,
      }],
      serviceFrames: [{
        type: 'delta',
        v: {
          message: {
            id: 'assistant-owned-12345678',
            author: { role: 'assistant' },
            parent: own,
            end_turn: true,
            metadata: { finish_details: { type: 'stop' } },
          },
        },
      }],
    });
    const result = await sendTurn(fixture.page, 'payload', baseConfig());
    expect(result.state).toBe('ok');
    expect(result.reply).toBe('complete answer');
  });

  it('does not treat node-local failed/interrupted metadata as whole-turn terminal failure', async () => {
    const own = 'user-owned-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      assistants: [
        { id: 'assistant-preamble-12345678', parent: own, text: 'failed draft', appearOnSend: true },
        { id: 'assistant-owned-12345678', parent: own, text: 'final answer', appearOnSend: true },
      ],
      serviceFrames: [
        {
          type: 'delta',
          v: {
            message: {
              id: 'assistant-preamble-12345678',
              author: { role: 'assistant' },
              parent: own,
              end_turn: false,
              status: 'finished_failed',
              content: { content_type: 'execution_error', text: 'node-local failure' },
            },
          },
        },
        {
          type: 'delta',
          v: {
            message: {
              id: 'assistant-owned-12345678',
              author: { role: 'assistant' },
              parent: own,
              end_turn: true,
              metadata: { finish_details: { type: 'stop' } },
            },
          },
        },
      ],
    });
    const result = await sendTurn(fixture.page, 'payload', baseConfig());
    expect(result.state).toBe('ok');
    expect(result.assistantMessageId).toBe('assistant-owned-12345678');
    expect(result.reply).toBe('final answer');
  });

  it('returns ok for formatted DOM serialization without matching raw service content parts', async () => {
    const own = 'user-owned-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      assistants: [{
        id: 'assistant-owned-12345678',
        parent: own,
        semanticNodes: [{ type: 'heading', children: [{ type: 'text', text: 'Title' }] }],
        appearOnSend: true,
      }],
      serviceFrames: [{
        type: 'delta',
        v: {
          message: {
            id: 'assistant-owned-12345678',
            author: { role: 'assistant' },
            parent: own,
            end_turn: true,
            metadata: { finish_details: { type: 'stop' } },
            content: { content_type: 'text', parts: ['# Title'] },
          },
        },
      }],
    });
    const result = await sendTurn(fixture.page, 'payload', baseConfig());
    expect(result.state).toBe('ok');
    expect(result.reply).toBe('Title');
  });

  it('waits for continuation growth after continue-generating disappears before publish', async () => {
    const own = 'user-owned-12345678';
    const freshTerminal = {
      type: 'delta',
      v: {
        message: {
          id: 'assistant-owned-12345678',
          author: { role: 'assistant' },
          parent: own,
          end_turn: true,
          metadata: { finish_details: { type: 'stop' } },
        },
      },
    };
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      assistants: [{ id: 'assistant-owned-12345678', parent: own, text: 'alpha', appearOnSend: true }],
      continueGenerating: {
        hideAfterClick: true,
        growthSequence: ['alpha', 'alpha\nbeta'],
        terminalFramesAfterClick: [freshTerminal],
      },
      serviceFrames: [freshTerminal],
    });
    const result = await sendTurn(fixture.page, 'payload', baseConfig());
    expect(result.state).toBe('ok');
    expect(result.reply).toBe('alpha\nbeta');
  });

  it('clicks continue on a non-terminal node and waits for fresh whole-turn service evidence', async () => {
    const own = 'user-owned-12345678';
    const freshTerminal = {
      type: 'delta',
      v: {
        message: {
          id: 'assistant-owned-12345678',
          author: { role: 'assistant' },
          parent: own,
          end_turn: true,
          metadata: { finish_details: { type: 'stop' } },
        },
      },
    };
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      assistants: [{ id: 'assistant-owned-12345678', parent: own, text: 'segment one', appearOnSend: true }],
      continueGenerating: {
        growthSequence: ['segment one', 'segment one\nsegment two'],
        terminalFramesAfterClick: [freshTerminal],
      },
      serviceFrames: [{
        type: 'delta',
        v: {
          message: {
            id: 'assistant-owned-12345678',
            author: { role: 'assistant' },
            parent: own,
            end_turn: false,
          },
        },
      }],
    });
    const result = await sendTurn(fixture.page, 'payload', baseConfig());
    expect(result.state).toBe('ok');
    expect(result.reply).toBe('segment one\nsegment two');
  });

  it('does not resurrect pre-continuation terminal authority from a non-terminal continuation delta', async () => {
    const own = 'user-owned-12345678';
    const assistantId = 'assistant-owned-12345678';
    const freshTerminal = {
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
    };
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      assistants: [{ id: assistantId, parent: own, text: 'alpha', appearOnSend: true }],
      continueGenerating: {
        hideAfterClick: true,
        growthSequence: ['alpha', 'alpha\nbeta'],
        postClickFrames: [[{
          type: 'delta',
          v: {
            message: {
              id: assistantId,
              author: { role: 'assistant' },
              parent: own,
              content: { content_type: 'text', parts: ['alpha\nbeta'] },
            },
          },
        }], [freshTerminal]],
      },
      serviceFrames: [freshTerminal],
    });
    const result = await sendTurn(fixture.page, 'payload', baseConfig());
    expect(result.state).toBe('ok');
    expect(result.reply).toBe('alpha\nbeta');
  });

  it('fail-closes unsupported unknown and patch envelopes carrying end_turn metadata', async () => {
    const own = 'user-owned-12345678';
    for (const serviceFrames of [
      [{
        type: 'rogue_terminal_frame',
        v: {
          message: {
            id: 'assistant-owned-12345678',
            author: { role: 'assistant' },
            parent: own,
            end_turn: true,
            metadata: { finish_details: { type: 'stop' } },
          },
        },
      }],
      [{
        type: 'patch',
        v: {
          message: {
            id: 'assistant-owned-12345678',
            author: { role: 'assistant' },
            parent: own,
            end_turn: true,
            metadata: { finish_details: { type: 'stop' } },
          },
        },
      }],
    ]) {
      const fixture = fakeTurnPage({
        dispatchCandidateIds: [own],
        assistants: [{ id: 'assistant-owned-12345678', parent: own, text: 'rogue answer', appearOnSend: true }],
        serviceFrames,
      });
      const result = await sendTurn(fixture.page, 'payload', { ...baseConfig(), timeoutMs: 200 });
      expect(result.state).toBe('stream_timeout');
      expect(result.cause).toBe('no_terminal_evidence');
    }
  });

  it('does not attribute terminal nodes from DOM parent links alone', async () => {
    const own = 'user-owned-12345678';
    const assistantId = 'assistant-owned-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      assistants: [{ id: assistantId, parent: own, text: 'dom-only attribution', appearOnSend: true }],
      serviceFrames: [{
        type: 'delta',
        v: {
          message: {
            id: assistantId,
            author: { role: 'assistant' },
            parent: 'foreign-parent-12345678',
            end_turn: true,
            metadata: { finish_details: { type: 'stop' } },
          },
        },
      }],
    });
    const result = await sendTurn(fixture.page, 'payload', { ...baseConfig(), timeoutMs: 200 });
    expect(result.state).toBe('stream_timeout');
    expect(result.cause).toBe('no_terminal_evidence');
  });

  it('fail-closes arbitrary payload wrappers carrying nested terminal deltas', async () => {
    const own = 'user-owned-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      assistants: [{ id: 'assistant-owned-12345678', parent: own, text: 'rogue answer', appearOnSend: true }],
      serviceFrames: [{
        type: 'rogue_wrapper',
        payload: {
          type: 'delta',
          v: {
            message: {
              id: 'assistant-owned-12345678',
              author: { role: 'assistant' },
              parent: own,
              end_turn: true,
              metadata: { finish_details: { type: 'stop' } },
            },
          },
        },
      }],
    });
    const result = await sendTurn(fixture.page, 'payload', { ...baseConfig(), timeoutMs: 200 });
    expect(result.state).toBe('stream_timeout');
    expect(result.cause).toBe('no_terminal_evidence');
  });

  it('fail-closes nested terminal-looking deltas under unsupported wrapper paths', async () => {
    const own = 'user-owned-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      assistants: [{ id: 'assistant-owned-12345678', parent: own, text: 'rogue answer', appearOnSend: true }],
      serviceFrames: [{
        type: 'rogue_wrapper',
        nested: {
          type: 'delta',
          v: {
            message: {
              id: 'assistant-owned-12345678',
              author: { role: 'assistant' },
              parent: own,
              end_turn: true,
              metadata: { finish_details: { type: 'stop' } },
            },
          },
        },
      }],
    });
    const result = await sendTurn(fixture.page, 'payload', { ...baseConfig(), timeoutMs: 200 });
    expect(result.state).toBe('stream_timeout');
    expect(result.cause).toBe('no_terminal_evidence');
  });

  it('AC9 terminal with unreadable content uses stream_timeout with terminal_content_incomplete', async () => {
    const own = 'user-owned-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      serviceFrames: [{
        type: 'delta',
        v: {
          message: {
            id: 'assistant-owned-12345678',
            author: { role: 'assistant' },
            parent: own,
            end_turn: true,
            metadata: { finish_details: { type: 'stop' } },
          },
        },
      }],
    });
    const result = await sendTurn(fixture.page, 'payload', { ...baseConfig(), timeoutMs: 200 });
    expect(result.state).toBe('stream_timeout');
    expect(result.cause).toBe('terminal_content_incomplete');
  });

  it('AC10 no-terminal retains deadline failure and continuation merge stays covered', async () => {
    const fixture = fakeTurnPage({ dispatchCandidateIds: ['user-owned-12345678'] });
    const timeoutResult = await sendTurn(fixture.page, 'payload', { ...baseConfig(), timeoutMs: 50 });
    expect(timeoutResult.state).toBe('stream_timeout');
    expect(timeoutResult.cause).toBe('no_terminal_evidence');
    expect(mergeContinuationSegments(['alpha\nbeta', 'alpha\nbeta\ngamma'])).toBe('alpha\nbeta\ngamma');
  });

  it('AC11 terminal-present fixtures resolve through terminal branch', async () => {
    const own = 'user-owned-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      assistants: [{ id: 'assistant-owned-12345678', parent: own, text: 'done', appearOnSend: true }],
      serviceFrames: [{
        type: 'delta',
        v: {
          message: {
            id: 'assistant-owned-12345678',
            author: { role: 'assistant' },
            parent: own,
            end_turn: true,
            metadata: { finish_details: { type: 'stop' } },
          },
        },
      }],
    });
    const result = await sendTurn(fixture.page, 'payload', { ...baseConfig(), timeoutMs: 200 });
    expect(result.state).toBe('ok');
    expect(result.cause).toBe('completed');
  });

  it('embeds captured live service-frame body for producer-emission evidence', () => {
    const body = framesToSseBody(LIVE_TERMINAL_FRAME_CONTRACT as unknown as Record<string, unknown>[]);
    expect(body).toContain('"end_turn":true');
    expect(body).toContain('"finish_details"');
    expect(body).toContain('message_stream_complete');
  });
});


const issue1024Cdp = 'http://127.0.0.1:9222';
const issue1024RepoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const issue1024CompleteObservation = {
  httpContextCoverage: 'complete' as const,
  websocketTargetsCoverage: 'complete' as const,
};

const issue1024BaseConfig = (overrides: Partial<BrowserConfig> = {}): BrowserConfig => ({
  cdp: issue1024Cdp,
  profile: 'automation',
  chatUrl: 'https://chatgpt.com/c/example',
  newChat: false,
  timeoutMs: 60_000,
  ...overrides,
});

function issue1024ZeroActivityFixture(overrides: Parameters<typeof fakeTurnPage>[0] = {}) {
  return fakeTurnPage({
    dispatchCandidateIds: [],
    serviceObserveDispatch: false,
    serviceFrames: [],
    assistants: [],
    dispatchObservation: issue1024CompleteObservation,
    ...overrides,
  });
}

async function issue1024ExhaustSubmittedTurnWindow(
  fixture: ReturnType<typeof fakeTurnPage>,
  config: BrowserConfig = issue1024BaseConfig(),
) {
  fixture.page.waitForTimeout = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
  };
  const turn = sendTurn(fixture.page, 'payload', config);
  await vi.advanceTimersByTimeAsync(31_000);
  return turn;
}

describe('issue 1024 Half A proven non-delivery', () => {
  afterEach(() => {
    __testTiming.now = undefined;
    vi.useRealTimers();
  });

  it('AC1 returns send_failed dispatch_request_not_observed after full window with complete boundary and zero activity', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1024ZeroActivityFixture();
    const result = await issue1024ExhaustSubmittedTurnWindow(fixture);

    expect(result).toEqual({
      state: 'send_failed',
      cause: 'dispatch_request_not_observed',
      possibleDelivery: false,
    });
    expect(lastDispatchObservationDiagnostic?.submitted_turn_window_exhausted).toBe(true);
    expect(lastDispatchObservationDiagnostic?.post_arm_http_request_count).toBe(0);
    expect(lastDispatchObservationDiagnostic?.post_arm_websocket_frame_sent_count).toBe(0);
    expect(lastDispatchObservationDiagnostic?.user_node_delta).toBe(0);
    expect(lastDispatchObservationDiagnostic?.new_chat_url_changed).toBe('na');
  });

  it('AC1 new-chat unchanged URL is required for proven non-delivery', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1024ZeroActivityFixture({
      newChatUrlAfterArm: 'https://chatgpt.com/c/new-conversation',
    });
    const result = await issue1024ExhaustSubmittedTurnWindow(fixture, {
      cdp: issue1024Cdp,
      profile: 'automation',
      newChat: true,
      projectUrl: 'https://chatgpt.com/',
      timeoutMs: 60_000,
    });

    expect(result.state).toBe('recovery_required');
    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC2 blocks proven non-delivery for post-arm context HTTP regardless of origin', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1024ZeroActivityFixture({
      postArmContextRequests: [{ url: 'https://example.com/any-path' }],
    });
    const result = await issue1024ExhaustSubmittedTurnWindow(fixture);

    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC2 blocks proven non-delivery for service-worker-owned HTTP on the context boundary', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1024ZeroActivityFixture({
      serviceWorkerHttpAfterArm: [{ url: 'https://chatgpt.com/sw-owned-request' }],
    });
    const result = await issue1024ExhaustSubmittedTurnWindow(fixture);

    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC2 blocks proven non-delivery for outbound WebSocket frame on covered target', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1024ZeroActivityFixture({
      postArmWebSocketSent: [{}],
    });
    const result = await issue1024ExhaustSubmittedTurnWindow(fixture);

    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC2 blocks proven non-delivery for new user DOM node beyond baseline', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1024ZeroActivityFixture({
      postArmUserDomIds: ['user-new-dom-12345678'],
    });
    const result = await issue1024ExhaustSubmittedTurnWindow(fixture);

    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC2 blocks proven non-delivery when HTTP context coverage is unknown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1024ZeroActivityFixture({
      dispatchObservation: {
        ...issue1024CompleteObservation,
        httpContextCoverage: 'unknown',
      },
    });
    const result = await issue1024ExhaustSubmittedTurnWindow(fixture);

    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC2 blocks proven non-delivery when websocket target coverage is incomplete', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1024ZeroActivityFixture({
      dispatchObservation: {
        ...issue1024CompleteObservation,
        websocketTargetsCoverage: 'incomplete',
      },
    });
    const result = await issue1024ExhaustSubmittedTurnWindow(fixture);

    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC2 forbids proven non-delivery before submitted-turn window exhaustion', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1024ZeroActivityFixture();
    fixture.page.waitForTimeout = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    };
    const turn = sendTurn(fixture.page, 'payload', issue1024BaseConfig());
    await vi.advanceTimersByTimeAsync(5_000);
    const early = await Promise.race([
      turn.then((value) => ({ done: true as const, value })),
      Promise.resolve({ done: false as const }),
    ]);
    expect(early.done).toBe(false);
    await vi.advanceTimersByTimeAsync(26_000);
    const result = await turn;
    expect(result.cause).toBe('dispatch_request_not_observed');
  });

  it('AC2 late-window outbound HTTP still blocks proven non-delivery', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1024ZeroActivityFixture({
      postArmContextRequests: [{ url: 'https://chatgpt.com/backend-api/f/conversation' }],
    });
    const result = await issue1024ExhaustSubmittedTurnWindow(fixture);
    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC3 pre-dispatch observer establishment failure performs zero send', async () => {
    const fixture = issue1024ZeroActivityFixture({
      dispatchObservation: { establishmentFails: true },
    });
    await expect(sendTurn(fixture.page, 'payload', issue1024BaseConfig())).rejects.toThrow('dispatch_observation_establishment_failed');
    expect(fixture.getSendClicks()).toBe(0);
  });

  it('AC10 records body-free dispatch observation diagnostic fields', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1024ZeroActivityFixture();
    await issue1024ExhaustSubmittedTurnWindow(fixture);
    const diagnostic = lastDispatchObservationDiagnostic;
    expect(diagnostic?.http_context_armed).toBe(true);
    expect(diagnostic?.websocket_targets_armed).toBe(true);
    expect(diagnostic?.coverage_summary).toContain('http-context:complete');
    expect(diagnostic?.coverage_summary).toContain('websocket-targets:complete');
    expect(JSON.stringify(diagnostic)).not.toMatch(/payload|reply|prompt/i);
  });

});

describe('issue 1024 gate-B characterization notes', () => {
  it('documents live boundary probes required on supported Chromium/Playwright runtime', () => {
    const notes = readFileSync(
      join(issue1024RepoRoot, 'scripts/chatgpt-browser-turn/README.md'),
      'utf8',
    );
    expect(notes).toContain('service-worker-owned HTTP');
    expect(notes).toContain('worker/secondary-target outbound WebSocket');
    expect(notes).toContain('dispatch_request_not_observed');
  });
});

