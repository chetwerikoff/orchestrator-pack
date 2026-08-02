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
import { Worker } from 'node:worker_threads';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  mutateCapabilityAdmissionPolicy,
  planCapabilityAfterSuccessfulTurn,
  quarantineOpaque,
  statusList,
  __testWriteCapability,
  listReadableIncidents,
  writeIncident,
} from '../chatgpt-browser-turn/state.ts';
import { atomicJson, configuredProfileKey, profileDirs, sha256 } from '../chatgpt-browser-turn/storage-common.ts';
import { releaseCdpBrowser } from '../chatgpt-browser-turn/browser-session.ts';
import {
  createPreSendSegmentBudget,
  createTurnOperationBudget,
  loadChromium,
  openTurnPage,
  resolveCausalAssistant,
  runtimeWitnessSurfaceAvailable,
  productStatusText,
  sendTurn,
  verifyProfile,
  __testTiming,
  witnessInstallOperationWaitMs,
  WITNESS_INSTALL_MAX_WAIT_MS,
  type BrowserConfig,
  type WitnessSurfaceProbe,
} from '../chatgpt-browser-turn/ui-adapter.ts';
import { lastDispatchObservationDiagnostic } from '../chatgpt-browser-turn/dispatch-observation.ts';
import { boundedResourceCleanup } from '../chatgpt-browser-turn/browser-session.ts';
import { delayedComposerFakePage } from '../chatgpt-browser-turn/fixtures/issue-1023-timeout.ts';
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
import {
  COMPOSER_INSERTION_MS_PER_LINE,
  COMPOSER_INSERTION_WAIT_MS,
  COMPOSER_READINESS_WAIT_MS,
  deriveComposerInsertionBudgetMs,
  __testComposerMutation,
} from '../chatgpt-browser-turn/state-light-turn.ts';
import {
  collectionLocator,
  readyTurnObservationFrames,
  scalarLocator,
} from '../chatgpt-browser-turn/state-light-turn.test-fixtures.ts';
import { COMPOSER_SELECTOR, MESSAGE_NODE_SELECTOR, SEND_BUTTON_SELECTOR } from '../chatgpt-browser-turn/product-page-selectors.ts';


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

  it('classifies absent parent service attributes as absent without service_attribute timeout (#1077)', async () => {
    const budget = createTurnOperationBudget(5_000);
    let nestedFirstCalls = 0;
    const hangingNestedFirst = () => ({
      getAttribute: async () => {
        nestedFirstCalls++;
        await new Promise((resolve) => { setTimeout(resolve, budget.remainingMs()); });
        return null;
      },
    });
    const message = (role: 'user' | 'assistant', id: string) => ({
      getAttribute: async (name: string) => {
        if (name === 'data-message-author-role') return role;
        if (name === 'data-message-id') return id;
        return null;
      },
      locator: (selector: string) => ({
        count: async () => (selector.includes('data-parent-message-id') || selector.includes('data-parent-turn-id') ? 0 : 1),
        first: () => hangingNestedFirst(),
      }),
    });
    const page = {
      locator: () => ({
        count: async () => 2,
        nth: (index: number) => message(index === 0 ? 'user' : 'assistant', index === 0 ? 'user-12345678' : 'assistant-12345678'),
      }),
    };
    const started = Date.now();
    await expect(runtimeWitnessSurfaceAvailable(page, budget)).resolves.toBe('absent');
    expect(Date.now() - started).toBeLessThan(500);
    expect(nestedFirstCalls).toBe(0);
  });

  it('keeps stalled parent service attribute reads as bounded service_attribute timeouts (#1077)', async () => {
    const budget = createTurnOperationBudget(80);
    const page = {
      locator: () => ({
        count: async () => 1,
        nth: () => ({
          getAttribute: async (name: string) => {
            if (name === 'data-message-author-role') return 'assistant';
            if (name === 'data-message-id') return 'assistant-12345678';
            return null;
          },
          locator: (selector: string) => ({
            count: async () => (selector.includes('data-parent-message-id') ? 1 : 0),
            first: () => ({
              getAttribute: async () => {
                const error = new Error('Timeout 80ms exceeded');
                error.name = 'TimeoutError';
                throw error;
              },
            }),
          }),
        }),
      }),
    };
    await expect(runtimeWitnessSurfaceAvailable(page, budget)).rejects.toThrow('browser_operation_timeout:service_attribute');
  });

  it('existing-chat witness probe returns absent when product DOM omits parent service attrs (#1077)', async () => {
    const user = messageLocator('user', 'user-existing-12345678');
    const assistant = messageLocator('assistant', 'assistant-existing-12345678');
    const page = {
      locator: () => ({ count: async () => 2, nth: (index: number) => [user, assistant][index] }),
    };
    await expect(runtimeWitnessSurfaceAvailable(page, createTurnOperationBudget(5_000))).resolves.toBe('absent');
  });

  it('reclamps nested parent count wait after earlier probe consumes segment budget (#1077 review)', async () => {
    const budget = createTurnOperationBudget(200);
    let nestedCountWait = -1;
    const page = {
      locator: () => ({
        count: async () => 1,
        nth: () => ({
          getAttribute: async (name: string) => {
            if (name === 'data-message-author-role') return 'assistant';
            if (name === 'data-message-id') return 'assistant-12345678';
            if (name === 'data-parent-message-id') {
              await new Promise((resolve) => { setTimeout(resolve, 150); });
              return null;
            }
            return null;
          },
          locator: (selector: string) => ({
            count: async () => {
              nestedCountWait = budget.clampOperationWaitMs();
              return 0;
            },
            first: () => ({ getAttribute: async () => null }),
          }),
        }),
      }),
    };
    await expect(runtimeWitnessSurfaceAvailable(page, budget)).resolves.toBe('absent');
    expect(nestedCountWait).toBeGreaterThanOrEqual(0);
    expect(nestedCountWait).toBeLessThanOrEqual(80);
    expect(nestedCountWait).toBeLessThan(150);
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
    const segmentBudget = createPreSendSegmentBudget(30_000);
    const result = await sendTurn(fixture.page, 'payload', {
      cdp,
      profile: join(root, 'profile'),
      chatUrl: 'https://chatgpt.com/c/example',
      newChat: false,
      timeoutMs: 1,
    }, undefined, undefined, segmentBudget);
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
  it('collapses filesystem and Windows/WSL spellings while preserving native Linux case', () => {
    const actual = join(root, 'Profile-Actual');
    const alias = join(root, 'profile-alias');
    mkdirSync(actual);
    symlinkSync(actual, alias, 'dir');
    expect(configuredProfileKey(actual, cdp)).toBe(configuredProfileKey(alias, cdp));
    if (process.platform !== 'win32') {
      expect(configuredProfileKey('C:\\Users\\Automation\\Profile', cdp))
        .toBe(configuredProfileKey('/mnt/c/Users/Automation/Profile', cdp));
      expect(configuredProfileKey('/mnt/c/Users/Automation/Profile', cdp))
        .not.toBe(configuredProfileKey('/mnt/c/users/automation/profile/', cdp));
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
    { state: 'rate_limit', exit: 12, scope: 'invocation', incident: 'wall', unblock: 'wait-for-throttle-window' },
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
    { state: 'observation_uncertain', exit: 11, scope: 'invocation', incident: 'yes', unblock: 'caller-decides-next-step' },
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

  it('S6 permits distinct fresh identities and independent conversation locks without profile-wide exclusion', () => {
    const freshOne = acquireDomainLock(profileKey, 'fresh:one');
    const freshTwo = acquireDomainLock(profileKey, 'fresh:two');
    const conversation = acquireDomainLock(profileKey, 'conversation:https://chatgpt.com/c/new');
    expect(freshOne).not.toBeNull();
    expect(freshTwo).not.toBeNull();
    expect(conversation).not.toBeNull();
    conversation!.release();
    freshTwo!.release();
    freshOne!.release();
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

function legacyCapabilityFixture(
  binding: ReturnType<typeof runtimeCapabilityBinding>,
  overrides: Partial<{
    browser_provenance: string;
    evidence_digest: string;
    observed_at: string;
    expires_at: string;
    downgrade_generation: number;
    parallel_eligible: boolean;
  }> = {},
) {
  const now = Date.now();
  return {
    schema: 'chatgpt-browser-turn-capability/v1' as const,
    version: 1 as const,
    configured_profile_key: '',
    ...binding,
    browser_provenance: 'Chromium test',
    evidence_digest: sha256('legacy-capability-fixture'),
    observed_at: new Date(now - 1_000).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    downgrade_generation: 0,
    parallel_eligible: true,
    ...overrides,
  };
}

describe('issue 964 capability policy', () => {
  it('binds parallel operator policy to exact candidate/build/config/gate and serializes visibly', async () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    __testWriteCapability(profileKey, capabilityFixture(binding));
    expect(capabilityStatus(profileKey, binding).state).toBe('ok');
    expect(capabilityStatus(profileKey, { ...binding, gate_digest: sha256('different-gate') }).state).toBe('downgraded');
    await mutateCapabilityAdmissionPolicy(profileKey, 'serialized', binding);
    const downgraded = capabilityStatus(profileKey, binding);
    expect(downgraded.state).toBe('downgraded');
    expect(downgraded.capability?.admission_policy).toBe('serialized');
    expect(downgraded.capability?.admission_epoch).toBe(1);
  });

  it('migrates legacy positive and negative eligibility to serialized characterization without idle expiry', () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    const now = Date.now();
    for (const parallelEligible of [true, false]) {
      const legacy = legacyCapabilityFixture(binding, {
        observed_at: new Date(now - 120_000).toISOString(),
        expires_at: new Date(now - 60_000).toISOString(),
        parallel_eligible: parallelEligible,
      });
      legacy.configured_profile_key = profileKey;
      atomicJson(profileDirs(profileKey).capability, legacy);
      const migrated = capabilityStatus(profileKey, binding);
      expect(migrated.state).toBe('downgraded');
      expect(migrated.capability?.admission_policy).toBe('serialized');
      expect(migrated.characterization?.characterized).toBe(true);
      expect(JSON.parse(readFileSync(profileDirs(profileKey).capability, 'utf8')).schema)
        .toBe('chatgpt-browser-turn-capability/v2');
    }
  });
});


describe('issue 1028 admission policy separation', () => {
  function completion(binding: ReturnType<typeof runtimeCapabilityBinding>, evidenceKey: string, browser = 'Chromium test') {
    return {
      expectedBinding: binding,
      browserProvenance: browser,
      evidenceDigest: sha256(evidenceKey),
      witnessed: true,
    };
  }

  it('characterizes from witnessed completion without self-arming parallel policy', () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    const outcome = applyCapabilityAfterSuccessfulTurn(profileKey, completion(binding, 'characterize-only'));
    expect(outcome.applied).toBe(true);
    const status = capabilityStatus(profileKey, binding);
    expect(status.state).toBe('downgraded');
    expect(status.capability?.admission_policy).toBe('serialized');
    expect(status.characterization?.characterized).toBe(true);
  });

  it('requires deliberate operator arm for parallel admission after characterization', async () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    applyCapabilityAfterSuccessfulTurn(profileKey, completion(binding, 'arm-prereq'));
    const armed = await mutateCapabilityAdmissionPolicy(profileKey, 'parallel', binding, 'Chromium test');
    expect(armed.mutation?.applied).toBe(true);
    expect(capabilityStatus(profileKey, binding).state).toBe('ok');

    const serialized = await mutateCapabilityAdmissionPolicy(profileKey, 'serialized', binding);
    expect(serialized.mutation?.applied).toBe(true);
    expect(serialized.capability?.admission_policy).toBe('serialized');
    expect(serialized.capability?.admission_epoch).toBe(1);

    const serializedAgain = await mutateCapabilityAdmissionPolicy(profileKey, 'serialized', binding);
    expect(serializedAgain.mutation?.applied).toBe(true);
    expect(serializedAgain.capability?.admission_epoch).toBe(2);

    const rearmed = await mutateCapabilityAdmissionPolicy(profileKey, 'parallel', binding, 'Chromium test');
    expect(rearmed.mutation?.applied).toBe(true);
    expect(rearmed.capability?.admission_policy).toBe('parallel');
    expect(rearmed.capability?.admission_epoch).toBe(2);
  });

  it('serializes policy without profile admission barrier while a fine scheduling lock is active', async () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    __testWriteCapability(profileKey, capabilityFixture(binding));
    const fineLock = acquireDomainLock(profileKey, 'conversation:https://chatgpt.com/c/active');
    expect(fineLock).not.toBeNull();
    try {
      const outcome = await mutateCapabilityAdmissionPolicy(profileKey, 'serialized', binding);
      expect(outcome.mutation).toMatchObject({ applied: true });
      expect(outcome.capability?.admission_policy).toBe('serialized');
      expect(outcome.capability?.admission_epoch).toBe(1);
    } finally {
      fineLock?.release();
    }
  });

  it('refuses parallel arm without live browser provenance verification', async () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    __testWriteCapability(profileKey, capabilityFixture(binding));
    const armed = await mutateCapabilityAdmissionPolicy(profileKey, 'parallel', binding);
    expect(armed.mutation).toEqual({ applied: false, reason: 'binding_mismatch' });
  });

  it('serializes policy without reclaiming unrelated fine scheduling locks', async () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    __testWriteCapability(profileKey, capabilityFixture(binding));
    const lockKey = 'conversation:https://chatgpt.com/c/crash-window';
    deadOwnerRecord(lockKey, 'pre_send');
    writeIncident(profileKey, {
      kind: 'active_owner',
      generation: 1,
      phase: 'possible_delivery',
      lock_key: lockKey,
      invocation_id: randomUUID(),
      owner: { pid: 999999, started_at: new Date().toISOString(), nonce: randomUUID() },
    });
    const outcome = await mutateCapabilityAdmissionPolicy(profileKey, 'serialized', binding);
    expect(outcome.mutation).toMatchObject({ applied: true });
    expect(existsSync(join(profileDirs(profileKey).locks, sha256(lockKey), 'owner.json'))).toBe(true);
  });

  it('serializes policy while an unrelated active pre_send lock remains held', async () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    __testWriteCapability(profileKey, capabilityFixture(binding));
    const lockKey = 'conversation:https://chatgpt.com/c/active-pre-send';
    deadOwnerRecord(lockKey, 'pre_send');
    writeIncident(profileKey, {
      kind: 'active_owner',
      generation: 1,
      phase: 'pre_send',
      lock_key: lockKey,
      invocation_id: randomUUID(),
      owner: { pid: 999999, started_at: new Date().toISOString(), nonce: randomUUID() },
    });
    const outcome = await mutateCapabilityAdmissionPolicy(profileKey, 'serialized', binding);
    expect(outcome.mutation).toMatchObject({ applied: true });
    expect(existsSync(join(profileDirs(profileKey).locks, sha256(lockKey), 'owner.json'))).toBe(true);
  });

  it('reclaims a dead orphan fine lock before committing serialized policy', async () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    __testWriteCapability(profileKey, capabilityFixture(binding));
    deadOwnerRecord(`fresh:orphan-${randomUUID()}`, 'pre_send');
    const outcome = await mutateCapabilityAdmissionPolicy(profileKey, 'serialized', binding);
    expect(outcome.mutation?.applied).toBe(true);
    expect(outcome.capability?.admission_policy).toBe('serialized');
  });

  it('resolves browser provenance through commit-time resolver for parallel arm', async () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    applyCapabilityAfterSuccessfulTurn(profileKey, completion(binding, 'commit-provenance'));
    let probeCount = 0;
    const armed = await mutateCapabilityAdmissionPolicy(profileKey, 'parallel', binding, () => {
      probeCount += 1;
      return 'Chromium test';
    });
    expect(probeCount).toBe(1);
    expect(armed.mutation?.applied).toBe(true);
  });

  it('refuses parallel arm without prior characterization', async () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    const armed = await mutateCapabilityAdmissionPolicy(profileKey, 'parallel', binding, 'Chromium test');
    expect(armed.mutation).toEqual({ applied: false, reason: 'not_characterized' });
  });

  it('preserves explicit policy and epoch across characterization refresh', () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    __testWriteCapability(profileKey, capabilityFixture(binding, { admission_epoch: 2 }));
    const before = capabilityStatus(profileKey, binding);
    const planned = planCapabilityAfterSuccessfulTurn(before, completion(binding, 'refresh-only'));
    expect(planned.admission_policy).toBe('parallel');
    expect(planned.admission_epoch).toBe(2);
    applyCapabilityAfterSuccessfulTurn(profileKey, completion(binding, 'refresh-only'));
    const after = capabilityStatus(profileKey, binding);
    expect(after.capability?.admission_policy).toBe('parallel');
    expect(after.capability?.admission_epoch).toBe(2);
    expect(after.capability?.evidence_digest).toBe(sha256('refresh-only'));
  });

  it('allows completion refresh after operator serialize because admission epoch is not a turn gate', async () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    __testWriteCapability(profileKey, capabilityFixture(binding));
    const admitted = capabilityStatus(profileKey, binding);
    expect(admitted.state).toBe('ok');
    await mutateCapabilityAdmissionPolicy(profileKey, 'serialized', binding);
    const outcome = applyCapabilityAfterSuccessfulTurn(profileKey, completion(binding, 'stale-after-serialize'));
    expect(outcome.applied).toBe(true);
  });

  it('keeps idle characterization stable without policy decay', () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    __testWriteCapability(profileKey, capabilityFixture(binding, { characterized_at: old, admission_policy: 'parallel' }));
    const status = capabilityStatus(profileKey, binding);
    expect(status.state).toBe('ok');
    expect(status.capability?.characterized_at).toBe(old);
  });

  it('swallows capability store write failures', () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    __testWriteCapability(profileKey, capabilityFixture(binding));
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

  it('characterizes a new browser provenance under serialized policy without self-arming', async () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    __testWriteCapability(profileKey, capabilityFixture(binding, { browser_provenance: 'old-browser' }));
    await mutateCapabilityAdmissionPolicy(profileKey, 'serialized', binding);
    const outcome = applyCapabilityAfterSuccessfulTurn(
      profileKey,
      completion(binding, 'new-provenance-characterize', 'new-browser'),
    );
    expect(outcome.applied).toBe(true);
    const status = capabilityStatus(profileKey, binding);
    expect(status.state).toBe('downgraded');
    expect(status.capability?.browser_provenance).toBe('new-browser');
    expect(status.capability?.admission_policy).toBe('serialized');
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
  it('runs an out-of-worktree retained copy for status, clear, quarantine/adjudication, and publication status', async () => {
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

    let liveBrowserProvenance = 'Chromium retained-test';
    let cdpAvailable = false;
    try {
      const chromium = loadChromium();
      const browser = await chromium.connectOverCDP(cdp);
      try {
        liveBrowserProvenance = String(browser.version?.() ?? 'chromium-cdp');
        cdpAvailable = true;
      } finally {
        await releaseCdpBrowser(browser);
      }
    } catch {
      // CDP is unavailable in CI; parallel arm assertions below use the fail-closed branch.
    }

    let observed = run(['capability', ...base]);
    expect(observed.status).toBe(0);
    expect(observed.body?.state).toBe('no_evidence');
    atomicJson(profileDirs(profileKey).capability, {
      schema: 'chatgpt-browser-turn-capability/v2',
      version: 2,
      configured_profile_key: profileKey,
      ...observed.body!.expected_binding,
      browser_provenance: liveBrowserProvenance,
      evidence_digest: sha256('retained-capability-evidence'),
      characterized_at: new Date().toISOString(),
      admission_policy: 'serialized',
      admission_epoch: 4,
    });
    observed = run(['capability', ...base, '--admission-policy', 'parallel']);
    if (cdpAvailable) {
      expect(observed.status).toBe(0);
      expect(observed.body?.mutation).toEqual({ applied: true });
      expect(observed.body?.admission).toEqual({ policy: 'parallel', epoch: 4 });
    } else {
      expect(observed.status).toBe(22);
      expect(observed.body?.cause).toBe('cdp_unavailable');
    }
    observed = run(['capability', ...base, '--admission-policy', 'serialized']);
    expect(observed.status).toBe(0);
    expect(observed.body?.mutation).toEqual({ applied: true });
    expect(observed.body?.admission).toEqual({ policy: 'serialized', epoch: 5 });

    const readable = writeIncident(profileKey, {
      kind: 'conversation_incident',
      generation: 1,
      phase: 'possible_delivery',
      cause: 'fixture',
    });
    observed = run(['status/list', ...base]);
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
    const timeoutResult = await sendTurn(
      fixture.page,
      'payload',
      { ...baseConfig(), timeoutMs: 50 },
      undefined,
      undefined,
      createPreSendSegmentBudget(30_000),
    );
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



const issue1025Cdp = 'http://127.0.0.1:9222';
const issue1025RepoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const issue1025CompleteObservation = {
  httpContextCoverage: 'complete' as const,
  websocketTargetsCoverage: 'complete' as const,
};

const issue1025BaseConfig = (overrides: Partial<BrowserConfig> = {}): BrowserConfig => ({
  cdp: issue1025Cdp,
  profile: 'automation',
  chatUrl: 'https://chatgpt.com/c/example',
  newChat: false,
  timeoutMs: 60_000,
  ...overrides,
});

function issue1025ZeroActivityFixture(overrides: Parameters<typeof fakeTurnPage>[0] = {}) {
  return fakeTurnPage({
    dispatchCandidateIds: [],
    serviceObserveDispatch: false,
    serviceFrames: [],
    assistants: [],
    dispatchObservation: issue1025CompleteObservation,
    ...overrides,
  });
}

async function issue1025ExhaustSubmittedTurnWindow(
  fixture: ReturnType<typeof fakeTurnPage>,
  config: BrowserConfig = issue1025BaseConfig(),
) {
  const originalWaitForTimeout = fixture.page.waitForTimeout?.bind(fixture.page);
  fixture.page.waitForTimeout = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    if (originalWaitForTimeout) await originalWaitForTimeout(ms);
  };
  const turn = sendTurn(fixture.page, 'payload', config);
  await vi.advanceTimersByTimeAsync(31_000);
  return turn;
}

describe('issue 1025 Half A proven non-delivery', () => {
  afterEach(() => {
    __testTiming.now = undefined;
    vi.useRealTimers();
  });

  it('AC1 returns send_failed dispatch_request_not_issued after full window with complete boundary and zero activity', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1025ZeroActivityFixture();
    const result = await issue1025ExhaustSubmittedTurnWindow(fixture);

    expect(result).toEqual({
      state: 'send_failed',
      cause: 'dispatch_request_not_issued',
      possibleDelivery: false,
    });
  });

  it('AC1 new-chat URL transition without recognized submission remains proven non-delivery', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1025ZeroActivityFixture({
      newChatUrlAfterArm: 'https://chatgpt.com/c/new-conversation',
    });
    const result = await issue1025ExhaustSubmittedTurnWindow(fixture, {
      cdp: issue1025Cdp,
      profile: 'automation',
      newChat: true,
      projectUrl: 'https://chatgpt.com/',
      timeoutMs: 60_000,
    });

    expect(result.state).toBe('send_failed');
    expect(result.cause).toBe('dispatch_request_not_issued');
    expect(result.possibleDelivery).toBe(false);
  });

  it('AC2 allows proven non-delivery when post-arm context HTTP is not a recognized submission', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1025ZeroActivityFixture({
      postArmContextRequests: [{ url: 'https://example.com/any-path' }],
    });
    const result = await issue1025ExhaustSubmittedTurnWindow(fixture);

    expect(result).toEqual({
      state: 'send_failed',
      cause: 'dispatch_request_not_issued',
      possibleDelivery: false,
    });
  });

  it('AC2 allows proven non-delivery when service-worker-owned HTTP is not a recognized submission', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1025ZeroActivityFixture({
      serviceWorkerHttpAfterArm: [{ url: 'https://chatgpt.com/sw-owned-request' }],
    });
    const result = await issue1025ExhaustSubmittedTurnWindow(fixture);

    expect(result.cause).toBe('dispatch_request_not_issued');
    expect(result.possibleDelivery).toBe(false);
  });

  it('AC2 allows proven non-delivery when outbound WebSocket frames are not recognized submissions', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1025ZeroActivityFixture({
      postArmWebSocketSent: [{}],
    });
    const result = await issue1025ExhaustSubmittedTurnWindow(fixture);

    expect(result.cause).toBe('dispatch_request_not_issued');
    expect(result.possibleDelivery).toBe(false);
  });

  it('AC2 DOM-only user nodes without recognized submission remain proven non-delivery', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1025ZeroActivityFixture({
      postArmUserDomIds: ['user-new-dom-12345678'],
    });
    const result = await issue1025ExhaustSubmittedTurnWindow(fixture);

    expect(result.cause).toBe('dispatch_request_not_issued');
    expect(result.possibleDelivery).toBe(false);
  });

  it('AC2 unreadable DOM service ids without recognized submission remain proven non-delivery', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1025ZeroActivityFixture({
      preDispatchUserDomIds: ['short'],
    });
    const result = await issue1025ExhaustSubmittedTurnWindow(fixture);

    expect(result.state).toBe('send_failed');
    expect(result.cause).toBe('dispatch_request_not_issued');
    expect(result.possibleDelivery).toBe(false);
  });


  it('AC2 fails closed when request-observer coverage is not proven even if WebSocket witnessInstall completes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1025ZeroActivityFixture({
      requestObserverCoverage: 'incomplete',
    });
    const result = await issue1025ExhaustSubmittedTurnWindow(fixture);

    expect(result.state).toBe('recovery_required');
    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC3 unknown HTTP context coverage performs zero send before dispatch boundary', async () => {
    const fixture = issue1025ZeroActivityFixture({
      dispatchObservation: {
        ...issue1025CompleteObservation,
        httpContextCoverage: 'unknown',
      },
    });
    await expect(sendTurn(fixture.page, 'payload', issue1025BaseConfig())).rejects.toThrow('dispatch_observation_establishment_failed');
    expect(fixture.getSendClicks()).toBe(0);
  });

  it('AC3 incomplete websocket target coverage performs zero send before dispatch boundary', async () => {
    const fixture = issue1025ZeroActivityFixture({
      dispatchObservation: {
        ...issue1025CompleteObservation,
        websocketTargetsCoverage: 'incomplete',
      },
    });
    await expect(sendTurn(fixture.page, 'payload', issue1025BaseConfig())).rejects.toThrow('dispatch_observation_establishment_failed');
    expect(fixture.getSendClicks()).toBe(0);
  });

  it('AC2 forbids proven non-delivery before submitted-turn window exhaustion', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1025ZeroActivityFixture();
    fixture.page.waitForTimeout = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    };
    const turn = sendTurn(fixture.page, 'payload', issue1025BaseConfig());
    await vi.advanceTimersByTimeAsync(5_000);
    const early = await Promise.race([
      turn.then((value) => ({ done: true as const, value })),
      Promise.resolve({ done: false as const }),
    ]);
    expect(early.done).toBe(false);
    await vi.advanceTimersByTimeAsync(26_000);
    const result = await turn;
    expect(result.cause).toBe('dispatch_request_not_issued');
  });

  it('AC3 recognized submission request issuance blocks proven non-delivery', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = fakeTurnPage({
      dispatchCandidateIds: ['user-owned-12345678'],
      serviceObserveDispatch: false,
      serviceFrames: [],
      assistants: [],
      dispatchObservation: issue1025CompleteObservation,
    });
    const result = await issue1025ExhaustSubmittedTurnWindow(fixture);
    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC3 service-worker recognized submission blocks proven non-delivery', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1025ZeroActivityFixture({
      postDispatchContextRequests: [{ userId: 'user-owned-12345678' }],
    });
    const result = await issue1025ExhaustSubmittedTurnWindow(fixture);
    expect(result.state).toBe('recovery_required');
    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC3 broad legacy dispatch witness before recognized submission still blocks proven non-delivery', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1025ZeroActivityFixture({
      postDispatchDelayedRequests: [{ url: 'https://chatgpt.com/backend-api/messages', method: 'GET' }],
      postClickRequests: [{ userId: 'user-owned-12345678' }],
    });
    const result = await issue1025ExhaustSubmittedTurnWindow(fixture);
    expect(result.state).toBe('recovery_required');
    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC4 post-boundary coverage loss remains possible-delivery', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __testTiming.now = () => Date.now();
    const fixture = issue1025ZeroActivityFixture({
      dispatchObservation: {
        ...issue1025CompleteObservation,
        coverageLossAfterArm: true,
      },
    });
    const result = await issue1025ExhaustSubmittedTurnWindow(fixture);
    expect(result.state).toBe('recovery_required');
    expect(result.cause).toBe('submitted_turn_id_unproven');
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC3 pre-dispatch observer establishment failure performs zero send', async () => {
    const fixture = issue1025ZeroActivityFixture({
      dispatchObservation: { establishmentFails: true },
    });
    await expect(sendTurn(fixture.page, 'payload', issue1025BaseConfig())).rejects.toThrow('dispatch_observation_establishment_failed');
    expect(fixture.getSendClicks()).toBe(0);
  });

});



describe('issue 1025 gate-B characterization notes', () => {
  it('documents live boundary probes required on supported Chromium/Playwright runtime', () => {
    const notes = readFileSync(
      join(issue1025RepoRoot, 'scripts/chatgpt-browser-turn/README.md'),
      'utf8',
    );
    expect(notes).toContain('service-worker-owned HTTP');
    expect(notes).toContain('worker/secondary-target outbound WebSocket');
    expect(notes).toContain('dispatch_request_not_issued');
    expect(notes).toContain('gate-b-characterization');
  });

  it('ships the Gate-B live characterization probe module', async () => {
    const module = await import('../chatgpt-browser-turn/dispatch-observation.ts');
    expect(module.GATE_B_REQUIRED_PROBES).toEqual([
      'service-worker-owned-http-on-configured-context',
      'worker-or-secondary-target-websocket-frame-sent',
    ]);
    const summary = module.summarizeGateBCharacterization([
      {
        probe: 'service-worker-owned-http-on-configured-context',
        observed: true,
        detail: 'context_request_observed',
      },
      {
        probe: 'worker-or-secondary-target-websocket-frame-sent',
        observed: false,
        detail: 'pending_live_run',
      },
    ]);
    expect(summary.complete).toBe(false);
  });

  it('persists and reloads Gate-B characterization records per configured profile', async () => {
    const module = await import('../chatgpt-browser-turn/dispatch-observation.ts');
    const profileKey = 'profile-test-gate-b-record';
    const complete = module.bindGateBCharacterizationRecord(
      module.summarizeGateBCharacterization([
        {
          probe: 'service-worker-owned-http-on-configured-context',
          observed: true,
          detail: 'context_request_observed',
        },
        {
          probe: 'worker-or-secondary-target-websocket-frame-sent',
          observed: true,
          detail: 'websocket_frame_sent_observed',
        },
      ]),
      profileKey,
      issue1025Cdp,
    );
    module.writeGateBCharacterizationRecord(profileKey, complete);
    expect(module.readGateBCharacterizationRecord(profileKey, issue1025Cdp)?.complete).toBe(true);
    expect(module.readGateBCharacterizationRecord(profileKey, 'http://127.0.0.1:9223')).toBeNull();
  });
});

describe('issue 1023 operation-level bounds', () => {
  const issue1023Config = (): BrowserConfig => ({
    cdp,
    profile: join(root, 'profile'),
    chatUrl: 'https://chatgpt.com/c/example',
    newChat: false,
    timeoutMs: 2_000,
  });
  it('AC2: bounded owner probe timeout is failure-to-know, not profile negative evidence', async () => {
    const ownerPath = join(repoRoot, '.claude', 'skills', 'discuss-with-gpt', 'verify-cdp-owner.mjs');
    const ownerMod = await import(pathToFileURL(ownerPath).href) as {
      __testOwnerProbe: { stallExecFile: boolean; stallFetch: boolean };
    };
    ownerMod.__testOwnerProbe.stallExecFile = true;
    const budget = createPreSendSegmentBudget(150);
    await expect(verifyProfile({
      cdp,
      profile: join(root, 'profile'),
      newChat: false,
      timeoutMs: 60_000,
    }, budget)).rejects.toThrow('browser_operation_timeout:owner_probe');
    ownerMod.__testOwnerProbe.stallExecFile = false;
  });

  it('AC2: stalled reachability fetch aborts with distinguishable timeout', async () => {
    const ownerPath = join(repoRoot, '.claude', 'skills', 'discuss-with-gpt', 'verify-cdp-owner.mjs');
    const ownerMod = await import(pathToFileURL(ownerPath).href) as {
      __testOwnerProbe: { stallExecFile: boolean; stallFetch: boolean };
      isCdpReachable: (cdpUrl: string, options?: { timeoutMs?: number }) => Promise<boolean>;
    };
    ownerMod.__testOwnerProbe.stallFetch = true;
    const start = Date.now();
    await expect(ownerMod.isCdpReachable(cdp, { timeoutMs: 100 })).rejects.toMatchObject({ message: 'cdp_reachability_timeout' });
    expect(Date.now() - start).toBeLessThan(500);
    ownerMod.__testOwnerProbe.stallFetch = false;
  });

  it('AC3: pre-send composer mutation cannot settle late after bounded timeout', async () => {
    const fixture = delayedComposerFakePage({ insertTextDelayMs: 400 });
    const budget = createTurnOperationBudget(100);
    await expect(sendTurn(fixture.page, 'late-payload', {
      cdp,
      profile: join(root, 'profile'),
      chatUrl: 'https://chatgpt.com/c/example',
      newChat: false,
      timeoutMs: 60_000,
    }, undefined, undefined, budget)).rejects.toThrow('browser_operation_timeout:');
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    expect(fixture.page.getInsertedText()).toBe('');
  });

  it('AC4: segment and loop budgets clamp to remaining remainder', () => {
    const segment = createPreSendSegmentBudget(500, 1_000);
    expect(segment.clampOperationWaitMs(1_200)).toBe(300);
    expect(segment.canStartOperation(1_500)).toBe(false);
    const deliveredBudget = createTurnOperationBudget(30, 4_970);
    expect(deliveredBudget.clampOperationWaitMs(4_980)).toBe(20);
  });

  it('AC4: healthy post-dispatch polls can complete before the turn deadline', async () => {
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
    const result = await sendTurn(fixture.page, 'payload', { ...issue1023Config(), timeoutMs: 200 });
    expect(result.state).toBe('ok');
  });


  it('AC6: late newPage handle is not adopted and cleanup is bounded', async () => {
    let latePageCreated = false;
    let latePageClosed = false;
    const ctx = {
      pages: () => [],
      newPage: () => new Promise((resolve) => {
        setTimeout(() => {
          latePageCreated = true;
          resolve({
            close: async () => { latePageClosed = true; },
            goto: async () => {},
          });
        }, 500);
      }),
    };
    const browser = { contexts: () => [ctx] };
    const budget = createPreSendSegmentBudget(80);
    await expect(openTurnPage(browser, {
      cdp,
      profile: join(root, 'profile'),
      chatUrl: 'https://chatgpt.com/c/new',
      newChat: false,
      timeoutMs: 60_000,
    }, { segmentBudget: budget })).rejects.toThrow('browser_operation_timeout:new_page');
    await new Promise((resolve) => { setTimeout(resolve, 600); });
    expect(latePageCreated).toBe(true);
    expect(latePageClosed).toBe(true);
  });


  it('AC4: witness install wait is capped at 10s within segment remainder', () => {
    const wide = createPreSendSegmentBudget(30_000);
    expect(witnessInstallOperationWaitMs(wide)).toBe(WITNESS_INSTALL_MAX_WAIT_MS);
    const tightBudget = {
      endsAtMs: 0,
      remainingMs: () => 500,
      clampOperationWaitMs: () => 500,
      canStartOperation: () => true,
    };
    expect(witnessInstallOperationWaitMs(tightBudget)).toBe(500);
  });

  it('openTurnPage reuses an existing tab without goto when URL already matches', async () => {
    const target = 'https://chatgpt.com/c/focus-tab-12345678';
    let gotoCalled = false;
    const page = {
      url: () => target,
      goto: async () => {
        gotoCalled = true;
        throw new Error('goto should not run when URL already matches');
      },
      bringToFront: async () => { throw new Error('bringToFront should not run'); },
    };
    const browser = { contexts: () => [{ pages: () => [page] }] };
    const out = await openTurnPage(browser, {
      cdp,
      profile: join(root, 'profile'),
      chatUrl: target,
      newChat: false,
      timeoutMs: 60_000,
    });
    expect(gotoCalled).toBe(false);
    expect(out.page).toBe(page);
    expect(out.owned).toBe(false);
  });

  it('openTurnPage opens an owned page when no existing tab matches the conversation URL', async () => {
    const target = 'https://chatgpt.com/c/focus-tab-12345678';
    let newPageCreated = false;
    const foreign = {
      url: () => 'https://chatgpt.com/c/other-tab-12345678',
      goto: async () => { throw new Error('foreign tab goto should not run'); },
    };
    const ctx = {
      pages: () => [foreign],
      newPage: async () => {
        newPageCreated = true;
        let current = 'about:blank';
        return {
          url: () => current,
          goto: async (url: string, opts: { timeout?: number }) => {
            expect(url).toBe(target);
            expect(opts.timeout).toBeGreaterThan(0);
            current = url;
          },
          close: async () => {},
        };
      },
    };
    const out = await openTurnPage({ contexts: () => [ctx] }, {
      cdp,
      profile: join(root, 'profile'),
      chatUrl: target,
      newChat: false,
      timeoutMs: 60_000,
    });
    expect(newPageCreated).toBe(true);
    expect(out.owned).toBe(true);
  });

  it('AC6: never-settling page.close does not block terminalization beyond cleanup bound', async () => {
    const started = Date.now();
    const outcome = await boundedResourceCleanup(
      () => new Promise<void>(() => {}),
      50,
    );
    expect(outcome).toBe('unconfirmed');
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('AC4: healthy post-dispatch polls may continue beyond 30s and still reach ok', async () => {
    let clock = 1_000;
    __testTiming.now = () => clock;
    const own = 'user-owned-12345678';
    const assistantId = 'assistant-owned-12345678';
    let assistantVisible = false;
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      assistants: [{ id: assistantId, parent: own, text: 'late ok', appearOnSend: false }],
      serviceFrames: [{
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
    });
    const baseLocator = fixture.page.locator.bind(fixture.page);
    fixture.page.locator = (selector: string) => {
      if (selector === '[data-message-author-role="assistant"]') {
        return {
          count: async () => assistantVisible ? 1 : 0,
          nth: (index: number) => messageLocator('assistant', assistantId, own, 'late ok'),
        };
      }
      return baseLocator(selector);
    };
    fixture.page.waitForTimeout = async (ms: number) => {
      clock += ms;
      if (clock >= 36_000) assistantVisible = true;
    };
    const result = await sendTurn(fixture.page, 'payload', {
      ...issue1023Config(),
      timeoutMs: 60_000,
    }, undefined, undefined, createPreSendSegmentBudget(30_000));
    expect(result.state).toBe('ok');
    expect(result.reply).toBe('late ok');
    expect(clock - 1_000).toBeGreaterThan(30_000);
    __testTiming.now = undefined;
  });

  it('AC4: delivered loop respects remainder when less than 30s remains', async () => {
    let clock = 5_000;
    __testTiming.now = () => clock;
    const own = 'user-owned-12345678';
    const fixture = fakeTurnPage({
      dispatchCandidateIds: [own],
      serviceObserveDispatch: false,
      serviceFrames: [],
    });
    fixture.page.waitForTimeout = async (ms: number) => { clock += ms; };
    const started = clock;
    const result = await sendTurn(fixture.page, 'payload', {
      ...issue1023Config(),
      timeoutMs: 5_500,
    }, undefined, undefined, createPreSendSegmentBudget(30_000));
    expect(result.possibleDelivery).toBe(true);
    expect(['stream_timeout', 'recovery_required']).toContain(result.state);
    expect(clock - started).toBeLessThan(35_000);
    __testTiming.now = undefined;
  });

  it('AC11: witness surface reclamps wait between sequential serviceId reads', async () => {
    const budget = createTurnOperationBudget(80);
    let attrCalls = 0;
    const page = {
      locator: () => ({
        count: async () => 1,
        nth: () => ({
          getAttribute: async (name: string) => {
            attrCalls++;
            await new Promise((resolve) => { setTimeout(resolve, 40); });
            if (name === 'data-message-author-role') return 'assistant';
            return null;
          },
          locator: () => ({ first: () => ({ getAttribute: async () => null }) }),
        }),
      }),
    };
    await expect(runtimeWitnessSurfaceAvailable(page, budget)).rejects.toThrow('browser_operation_timeout:witness_surface');
    expect(attrCalls).toBeGreaterThan(1);
  });

  it('AC6: cleanup-unconfirmed residual tab is re-enumerated on next openTurnPage', async () => {
    const target = 'https://chatgpt.com/c/residual-tab-12345678';
    const residual = {
      url: () => target,
      close: async () => new Promise<void>(() => {}),
      goto: async () => {},
    };
    let newPageCreated = false;
    const ctx = {
      pages: () => [residual],
      newPage: async () => {
        newPageCreated = true;
        return {
          url: () => 'about:blank',
          goto: async (url: string) => { residual.url = () => url; },
          close: async () => {},
        };
      },
    };
    const browser = { contexts: () => [ctx] };
    const cleanup = await boundedResourceCleanup(() => residual.close(), 50);
    expect(cleanup).toBe('unconfirmed');
    const opened = await openTurnPage(browser, {
      cdp,
      profile: join(root, 'profile'),
      chatUrl: target,
      newChat: false,
      timeoutMs: 60_000,
    });
    expect(opened.page).toBe(residual);
    expect(opened.owned).toBe(false);
    expect(newPageCreated).toBe(false);
  });

  it('AC8: timeout before terminal reply creates no publication side effect', async () => {
    const own = 'user-owned-12345678';
    const fixture = fakeTurnPage({ dispatchCandidateIds: [own] });
    const result = await sendTurn(fixture.page, 'payload', { ...issue1023Config(), timeoutMs: 1 }, undefined, undefined, createPreSendSegmentBudget(30_000));
    expect(result.state).toBe('stream_timeout');
    expect(result.reply).toBeUndefined();
    expect(result.possibleDelivery).toBe(true);
  });

  it('AC11: Enter dispatch without send button cannot settle late after timeout', async () => {
    const own = 'user-owned-12345678';
    const fixture = fakeTurnPage({
      hideSendButton: true,
      composerPressDelayMs: 400,
      dispatchCandidateIds: [own],
    });
    const budget = createPreSendSegmentBudget(100);
    const result = await sendTurn(fixture.page, 'payload', issue1023Config(), undefined, undefined, budget);
    expect(result.state).toBe('recovery_required');
    expect(fixture.getEnterPresses()).toBe(1);
    expect(fixture.getSendClicks()).toBe(0);
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    expect(fixture.getSendClicks()).toBe(0);
  });

  it('AC11: productStatusText reclamps sequential reads to the governing remainder', async () => {
    let reads = 0;
    const page = {
      locator: (selector: string) => {
        if (selector === '#prompt-textarea') return { count: async () => 1 };
        if (selector === '[role="alert"]') {
          return {
            count: async () => 5,
            nth: (index: number) => ({
              innerText: async () => {
                reads++;
                clock += 60;
                return `alert-${index}`;
              },
            }),
          };
        }
        return { count: async () => 0, nth: () => ({ innerText: async () => '' }) };
      },
    };
    let clock = 1_000;
    __testTiming.now = () => clock;
    const deadline = 1_100;
    await expect(productStatusText(page, () => Math.max(0, deadline - __testTiming.now!()))).rejects.toThrow('browser_operation_timeout:product_status');
    expect(reads).toBeLessThan(5);
    __testTiming.now = undefined;
  });

});

async function runTurnWithMocks1060(
  argv: string[],
  options: {
    witness?: WitnessSurfaceProbe | WitnessSurfaceProbe[];
    sendResult?: Record<string, unknown>;
    browserProvenance?: string;
    onBeforeSend?: () => void | Promise<void>;
    deleteIncidentFails?: boolean;
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
        if (options.onBeforeSend) await options.onBeforeSend();
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
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
  let deleteIncidentSpy: ReturnType<typeof vi.spyOn> | undefined;
  if (options.deleteIncidentFails) {
    const stateMod = await import('../chatgpt-browser-turn/state.ts');
    deleteIncidentSpy = vi.spyOn(stateMod, 'deleteIncident').mockImplementation(() => {
      throw new Error('cleanup_failed');
    });
  }
  const { runCli } = await import('../chatgpt-browser-turn.ts');
  const exitCode = await runCli(argv);
  deleteIncidentSpy?.mockRestore();
  vi.spyOn(process.stdout, 'write').mockRestore();
  return { exitCode, stdout: chunks.join('') };
}


async function runParallelTurnsWithMocks1060(
  specs: Array<{
    argv: string[];
    witness?: WitnessSurfaceProbe | WitnessSurfaceProbe[];
    onBeforeSend?: () => void | Promise<void>;
    sendResult?: Record<string, unknown>;
    pageUrl?: string;
  }>,
): Promise<Array<{ exitCode: number; stdout: string }>> {
  vi.resetModules();
  let started = 0;
  let releaseBarrier: (() => void) | undefined;
  const allStarted = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  const witnessQueues = new Map<string, WitnessSurfaceProbe[]>();
  for (const spec of specs) {
    const chatFlag = spec.argv.indexOf('--chat-url');
    const key = chatFlag >= 0 ? spec.argv[chatFlag + 1]! : 'default';
    witnessQueues.set(key, Array.isArray(spec.witness)
      ? [...spec.witness]
      : [spec.witness ?? 'available']);
  }
  const specByUrl = new Map(specs.map((spec) => {
    const chatFlag = spec.argv.indexOf('--chat-url');
    const key = chatFlag >= 0 ? spec.argv[chatFlag + 1]! : 'https://chatgpt.com/c/fixture-conv';
    return [key, spec];
  }));
  const stubBrowser = {
    close: vi.fn(async () => {}),
    version: () => 'chromium-fixture',
    contexts: () => [{ pages: () => [] }],
  };
  vi.doMock('../chatgpt-browser-turn/ui-adapter.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../chatgpt-browser-turn/ui-adapter.ts')>();
    return {
      ...actual,
      verifyProfile: vi.fn(async () => ({ state: 'verified' as const, cause: 'ok' })),
      loadChromium: vi.fn(() => ({ connectOverCDP: vi.fn(async () => stubBrowser) })),
      openTurnPage: vi.fn(async (_browser, config) => {
        started += 1;
        if (started >= specs.length) releaseBarrier?.();
        await allStarted;
        const pageUrl = config.chatUrl ?? 'https://chatgpt.com/c/fixture-conv';
        const stubPage = {
          close: vi.fn(async () => {}),
          goto: vi.fn(async () => {}),
          url: () => pageUrl,
          bringToFront: vi.fn(async () => {}),
        };
        return { page: stubPage, owned: true, provisionalId: randomUUID() };
      }),
      runtimeWitnessSurfaceAvailable: vi.fn(async (page) => {
        const queue = witnessQueues.get(page.url()) ?? witnessQueues.get('default') ?? ['available'];
        return queue.shift() ?? 'available';
      }),
      sendTurn: vi.fn(async (page, _text, _config, _provisionalId, onBeforeSend) => {
        const spec = specByUrl.get(page.url());
        if (onBeforeSend) await onBeforeSend();
        if (spec?.onBeforeSend) await spec.onBeforeSend();
        return spec?.sendResult ?? {
          state: 'ok',
          cause: 'completed',
          possibleDelivery: true,
          reply: 'reply text',
          userMessageId: 'user-fixture-12345678',
          assistantMessageId: 'asst-fixture-12345678',
          conversationId: page.url(),
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
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const captureStore = new AsyncLocalStorage<string[]>();
  const { runCli } = await import('../chatgpt-browser-turn.ts');
  const restore = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    const chunks = captureStore.getStore();
    if (chunks) {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    }
    return true;
  });
  const results = await Promise.all(specs.map(async (spec) => captureStore.run([], async () => {
    const exitCode = await runCli(spec.argv);
    return { exitCode, stdout: (captureStore.getStore() ?? []).join('') };
  })));
  restore.mockRestore();
  return results;
}

function turnArgvFor1060Conversation(outputPath: string, conversationUrl: string): string[] {
  const input = join(root, `turn-input-${randomUUID()}.txt`);
  writeFileSync(input, 'turn payload\n');
  return [
    'turn',
    '--profile', join(root, 'profile'),
    '--cdp', cdp,
    '--input', input,
    '--output', outputPath,
    '--chat-url', conversationUrl,
  ];
}

function turnArgvFor1060(outputPath: string, flags: string[] = []): string[] {
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

describe('issue 1060 remove profile-wide admission', () => {
  it('AC1/AC11a: independent conversations race while capability is absent and changing', async () => {
    const [one, two] = await Promise.all([
      Promise.resolve().then(() => acquireDomainLock(profileKey, 'conversation:https://chatgpt.com/c/one')),
      Promise.resolve().then(() => acquireDomainLock(profileKey, 'conversation:https://chatgpt.com/c/two')),
    ]);
    expect(one).not.toBeNull();
    expect(two).not.toBeNull();

    const binding = runtimeCapabilityBinding(profileKey, cdp);
    __testWriteCapability(profileKey, capabilityFixture(binding, {
      admission_policy: 'serialized',
      admission_epoch: 3,
      browser_provenance: 'stale-browser',
    }));
    writeFileSync(profileDirs(profileKey).capability, '{ "schema": "changed-mid-race" }');

    const three = acquireDomainLock(profileKey, 'conversation:https://chatgpt.com/c/three');
    expect(three).not.toBeNull();
    expect(statusList(profileKey).state).not.toBe('profile_blocked');
    three!.release();
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

    __testWriteCapability(profileKey, capabilityFixture(binding));
    expect(capabilityStatus(profileKey, binding).state).toBe('ok');
    expect(statusList(profileKey).state).toBe('none');
  });

  it('AC3/AC11b: witness loss fails invocation locally while sibling conversation lock stays usable', async () => {
    const siblingKey = 'conversation:https://chatgpt.com/c/sibling';
    const sibling = acquireDomainLock(profileKey, siblingKey);
    expect(sibling).not.toBeNull();

    const output = join(root, 'witness-fail-out.txt');
    const { exitCode, stdout } = await runTurnWithMocks1060(turnArgvFor1060(output), {
      witness: ['absent'],
    });
    expect(exitCode).toBe(13);
    expect(stdout).toContain('pre_send_witness_unavailable');

    const stillHeld = acquireDomainLock(profileKey, siblingKey);
    expect(stillHeld).toBeNull();
    const independent = acquireDomainLock(profileKey, 'conversation:https://chatgpt.com/c/continues');
    expect(independent).not.toBeNull();
    independent!.release();
    sibling!.release();
  });

  it('AC4/AC11b: final pre-send witness loss cleans owner and releases fine lock', async () => {
    const siblingKey = 'conversation:https://chatgpt.com/c/final-sibling';
    const sibling = acquireDomainLock(profileKey, siblingKey);
    expect(sibling).not.toBeNull();
    const output = join(root, 'final-witness-fail-out.txt');
    const { exitCode, stdout } = await runTurnWithMocks1060(turnArgvFor1060(output), {
      witness: ['available', 'absent'],
    });
    expect(exitCode).toBe(13);
    expect(stdout).toContain('pre_send_witness_unavailable');
    expect(listReadableIncidents(profileKey).some(({ record }) => record.kind === 'active_owner')).toBe(false);
    const recovered = acquireDomainLock(profileKey, 'conversation:https://chatgpt.com/c/fixture-conv');
    expect(recovered).not.toBeNull();
    expect(acquireDomainLock(profileKey, siblingKey)).toBeNull();
    recovered!.release();
    sibling!.release();
  });


  it('AC4/AC11b: pre-send witness failure keeps fine lock when incident cleanup fails', async () => {
    const output = join(root, 'cleanup-fail-out.txt');
    const { exitCode, stdout } = await runTurnWithMocks1060(turnArgvFor1060(output), {
      witness: ['available', 'absent'],
      deleteIncidentFails: true,
    });
    expect(exitCode).toBe(13);
    expect(stdout).toContain('pre_send_incident_cleanup_failed');
    expect(acquireDomainLock(profileKey, 'conversation:https://chatgpt.com/c/fixture-conv')).toBeNull();
    expect(listReadableIncidents(profileKey).some(({ record }) => record.kind === 'active_owner')).toBe(true);
  });

  it('AC4/AC11b: sendTurn pre-dispatch failure keeps fine lock when incident cleanup fails', async () => {
    const output = join(root, 'send-cleanup-fail-out.txt');
    const { exitCode, stdout } = await runTurnWithMocks1060(turnArgvFor1060(output), {
      sendResult: {
        state: 'driver_error',
        cause: 'composer_unavailable',
        possibleDelivery: false,
      },
      deleteIncidentFails: true,
    });
    expect(exitCode).toBe(13);
    expect(stdout).toContain('pre_send_incident_cleanup_failed');
    expect(acquireDomainLock(profileKey, 'conversation:https://chatgpt.com/c/fixture-conv')).toBeNull();
    expect(listReadableIncidents(profileKey).some(({ record }) => record.kind === 'active_owner')).toBe(true);
  });

  it('AC5/AC11e: same-conversation overlap refuses the turn before duplicate send', async () => {
    const key = 'conversation:https://chatgpt.com/c/fixture-conv';
    const first = acquireDomainLock(profileKey, key);
    expect(first).not.toBeNull();
    const output = join(root, 'same-conversation-overlap.txt');
    const { exitCode, stdout } = await runTurnWithMocks1060(turnArgvFor1060(output));
    expect(exitCode).toBe(11);
    expect(stdout).toContain('conversation_busy');
    expect(existsSync(output)).toBe(false);
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

  it('AC8/AC11f: fresh-chat runTurn uses fresh lock domain without profile scheduling', async () => {
    const output = join(root, 'fresh-chat-out.txt');
    const input = join(root, `turn-input-${randomUUID()}.txt`);
    writeFileSync(input, 'fresh turn payload\n');
    const projectUrl = 'https://chatgpt.com/g/fixture-project';
    const freshConversation = 'https://chatgpt.com/c/fresh-conversation';
    const { exitCode, stdout } = await runTurnWithMocks1060([
      'turn',
      '--profile', join(root, 'profile'),
      '--cdp', cdp,
      '--input', input,
      '--output', output,
      '--new-chat',
      '--project-url', projectUrl,
    ], {
      sendResult: {
        state: 'ok',
        cause: 'completed',
        possibleDelivery: true,
        reply: 'fresh reply',
        userMessageId: 'user-fresh-12345678',
        assistantMessageId: 'asst-fresh-12345678',
        conversationId: freshConversation,
      },
    });
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('profile_busy');
    expect(stdout).not.toContain('profile:');
    expect(stdout).not.toContain('conversation_busy');
    expect(stdout).toContain('fresh-conversation');
  });

  it('AC2: binding-mismatch capability is diagnostic and runTurn still completes', async () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    __testWriteCapability(profileKey, {
      ...capabilityFixture(binding),
      config_digest: sha256('mismatched-binding'),
    });
    expect(capabilityStatus(profileKey, binding).cause).toBe('capability_binding_mismatch');

    const output = join(root, 'binding-mismatch-out.txt');
    const { exitCode, stdout } = await runTurnWithMocks1060(turnArgvFor1060(output));
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('profile_busy');
    expect(stdout).not.toContain('capability_binding_mismatch');
  });

  it('AC2: stale browser provenance is observable on successful runTurn without admission downgrade', async () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    __testWriteCapability(profileKey, capabilityFixture(binding, {
      browser_provenance: 'stale-browser-provenance',
    }));

    const output = join(root, 'provenance-drift-out.txt');
    const { exitCode, stdout } = await runTurnWithMocks1060(turnArgvFor1060(output), {
      browserProvenance: 'live-browser-provenance',
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('browser_provenance_drift_observed');
    expect(stdout).not.toContain('profile_busy');
  });

  it('AC6: capability quarantine stays non-blocking for status/list and runTurn', async () => {
    writeFileSync(profileDirs(profileKey).capability, '{ "schema": "broken-capability" }\n');
    const listed = statusList(profileKey);
    expect(listed.state).not.toBe('profile_blocked');
    const opaque = listed.items!.find((item) => item.kind === 'opaque_record' && item.identity.includes(':capability:'));
    expect(opaque).toBeDefined();
    expect(quarantineOpaque(profileKey, opaque!.identity, opaque!.generation).state).toBe('quarantined');
    expect(statusList(profileKey).state).not.toBe('profile_blocked');
    expect(statusList(profileKey).items!.some((item) => item.kind === 'blocking_tombstone')).toBe(true);

    const output = join(root, 'capability-quarantine-out.txt');
    const { exitCode, stdout } = await runTurnWithMocks1060(turnArgvFor1060(output));
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('profile_busy');
    expect(stdout).not.toContain('pre_send_profile_blocked');
  });

  it('AC1/AC11a: two concurrent runTurn calls on independent conversations both complete', async () => {
    const convA = 'https://chatgpt.com/c/concurrent-a';
    const convB = 'https://chatgpt.com/c/concurrent-b';
    const outA = join(root, 'concurrent-a-out.txt');
    const outB = join(root, 'concurrent-b-out.txt');
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    __testWriteCapability(profileKey, capabilityFixture(binding));

    const results = await runParallelTurnsWithMocks1060([
      { argv: turnArgvFor1060Conversation(outA, convA) },
      { argv: turnArgvFor1060Conversation(outB, convB) },
    ]);
    expect(results).toHaveLength(2);
    const a = results[0]!;
    const b = results[1]!;
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toContain('concurrent-a');
    expect(b.stdout).toContain('concurrent-b');
    expect(a.stdout).not.toContain('profile_busy');
    expect(b.stdout).not.toContain('profile_busy');
  });

  it('AC11a: mid-run capability corruption during send does not profile-block runTurn', async () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    __testWriteCapability(profileKey, capabilityFixture(binding));
    const output = join(root, 'mid-run-send-out.txt');
    const { exitCode, stdout } = await runTurnWithMocks1060(turnArgvFor1060(output), {
      onBeforeSend: () => {
        writeFileSync(profileDirs(profileKey).capability, '{ "schema": "changed-mid-run" }');
      },
    });
    expect(capabilityStatus(profileKey, binding).state).toBe('downgraded');
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('profile_busy');
    expect(statusList(profileKey).state).not.toBe('profile_blocked');
  });

  it('AC3/AC11b: witness-failing turn and publishing sibling runTurn overlap concurrently', async () => {
    const failConv = 'https://chatgpt.com/c/witness-fail';
    const okConv = 'https://chatgpt.com/c/witness-sibling-ok';
    const failOut = join(root, 'witness-fail-out.txt');
    const okOut = join(root, 'witness-sibling-out.txt');
    const witnessResults = await runParallelTurnsWithMocks1060([
      {
        argv: turnArgvFor1060Conversation(failOut, failConv),
        witness: ['absent'],
      },
      {
        argv: turnArgvFor1060Conversation(okOut, okConv),
        witness: ['available'],
      },
    ]);
    expect(witnessResults).toHaveLength(2);
    const failed = witnessResults[0]!;
    const ok = witnessResults[1]!;
    expect(failed.exitCode).toBe(13);
    expect(failed.stdout).toContain('pre_send_witness_unavailable');
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain('witness-sibling-ok');
    expect(ok.stdout).toContain('completed');
  });

  it('AC7: serialized capability does not force profile scheduling in runTurn', async () => {
    const binding = runtimeCapabilityBinding(profileKey, cdp);
    __testWriteCapability(profileKey, capabilityFixture(binding, {
      admission_policy: 'serialized',
      admission_epoch: 9,
    }));
    const output = join(root, 'serialized-cap-out.txt');
    const { exitCode, stdout } = await runTurnWithMocks1060(turnArgvFor1060(output));
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('profile_busy');
    expect(stdout).not.toContain('profile:');
  });
});


describe('issue 1089 bounded scheduling-admission retry', () => {
  const coordinationModuleUrl = pathToFileURL(
    join(repoRoot, 'scripts/chatgpt-browser-turn/coordination.ts'),
  ).href;

  function acquireDomainLockInWorker(
    profileKeyArg: string,
    key: string,
    options?: { admissionRetryDeadlineMs?: number },
  ): Promise<{ ok: boolean; elapsedMs: number }> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        (async () => {
          const { acquireDomainLock } = await import(workerData.coordinationModuleUrl);
          const started = Date.now();
          const lockOptions = workerData.admissionRetryDeadlineMs === undefined
            ? undefined
            : { admissionRetryDeadlineMs: workerData.admissionRetryDeadlineMs };
          const lock = acquireDomainLock(workerData.profileKey, workerData.key, 120_000, lockOptions);
          parentPort.postMessage({ ok: lock !== null, elapsedMs: Date.now() - started });
          lock?.release();
        })().catch((error) => parentPort.postMessage({ error: String(error) }));
      `, {
        eval: true,
        execArgv: ['--experimental-strip-types'],
        env: {
          ...process.env,
          CHATGPT_BROWSER_TURN_STATE_DIR: process.env.CHATGPT_BROWSER_TURN_STATE_DIR!,
        },
        workerData: {
          profileKey: profileKeyArg,
          key,
          coordinationModuleUrl,
          admissionRetryDeadlineMs: options?.admissionRetryDeadlineMs,
        },
      });
      worker.on('message', (message: { ok?: boolean; elapsedMs?: number; error?: string }) => {
        worker.terminate().catch(() => {});
        if (message.error) {
          reject(new Error(message.error));
          return;
        }
        resolve({ ok: message.ok === true, elapsedMs: message.elapsedMs ?? 0 });
      });
      worker.on('error', reject);
    });
  }

  it('AC2/AC3: disjoint conversation domains succeed after admission-only contention', async () => {
    const admissionKey = `scheduling-admission:${profileKey}`;
    const gate = acquireDomainLock(profileKey, admissionKey);
    expect(gate).not.toBeNull();

    const productionDeadlineMs = Date.now() + 10_000;
    const contender = acquireDomainLockInWorker(
      profileKey,
      'conversation:https://chatgpt.com/c/admission-contender',
      { admissionRetryDeadlineMs: productionDeadlineMs },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    gate!.release();

    const result = await contender;
    expect(result.ok).toBe(true);
    expect(result.elapsedMs).toBeLessThan(2_000);
  });

  it('AC3: disjoint fresh domains succeed after admission-only contention', async () => {
    const admissionKey = `scheduling-admission:${profileKey}`;
    const gate = acquireDomainLock(profileKey, admissionKey);
    expect(gate).not.toBeNull();

    const productionDeadlineMs = Date.now() + 10_000;
    const contender = acquireDomainLockInWorker(
      profileKey,
      `fresh:${randomUUID()}`,
      { admissionRetryDeadlineMs: productionDeadlineMs },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    gate!.release();

    const result = await contender;
    expect(result.ok).toBe(true);
    expect(result.elapsedMs).toBeLessThan(2_000);
  });

  it('AC4: observed same-conversation conflict is terminal without admission retry wait', () => {
    const key = 'conversation:https://chatgpt.com/c/terminal-conflict';
    const owner = acquireDomainLock(profileKey, key);
    expect(owner).not.toBeNull();

    const started = Date.now();
    const contender = acquireDomainLock(profileKey, key);
    const elapsed = Date.now() - started;

    expect(contender).toBeNull();
    expect(elapsed).toBeLessThan(250);
    owner!.release();
    const afterRelease = acquireDomainLock(profileKey, key);
    expect(afterRelease).not.toBeNull();
    afterRelease!.release();
  });

  it('AC4: observed same fresh-domain conflict is terminal without admission retry wait', () => {
    const key = `fresh:${randomUUID()}`;
    const owner = acquireDomainLock(profileKey, key);
    expect(owner).not.toBeNull();

    const started = Date.now();
    const contender = acquireDomainLock(profileKey, key);
    const elapsed = Date.now() - started;

    expect(contender).toBeNull();
    expect(elapsed).toBeLessThan(250);
    owner!.release();
  });

  it('AC5: admission retry consumes an external pre-send deadline instead of extending it', () => {
    const admissionKey = `scheduling-admission:${profileKey}`;
    const gate = acquireDomainLock(profileKey, admissionKey);
    expect(gate).not.toBeNull();

    const started = Date.now();
    const contender = acquireDomainLock(
      profileKey,
      'conversation:https://chatgpt.com/c/budget-bound',
      120_000,
      { admissionRetryDeadlineMs: started + 80 },
    );
    const elapsed = Date.now() - started;

    expect(contender).toBeNull();
    expect(elapsed).toBeLessThan(250);
    gate!.release();
  });

  it('AC5: admission retry stops at the 2,000 ms ceiling when the gate stays busy', async () => {
    const admissionKey = `scheduling-admission:${profileKey}`;
    const gate = acquireDomainLock(profileKey, admissionKey);
    expect(gate).not.toBeNull();

    const started = Date.now();
    const contender = acquireDomainLockInWorker(
      profileKey,
      'conversation:https://chatgpt.com/c/ceiling-contender',
    );
    const result = await contender;
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(1_900);
    expect(result.elapsedMs).toBeLessThanOrEqual(2_000);
    gate!.release();
  });
});

describe('issue 1188 composer readiness and insertion timing', () => {
  type ComposerOptions = {
    composerPresent?: boolean;
    visible?: boolean;
    enabled?: boolean;
    contentEditable?: boolean;
    readinessSequence?: boolean[];
    readinessDelayMs?: number;
    clickDelayMs?: number;
    fillDelayMs?: number;
    blockingOverlay?: boolean;
    clickReject?: boolean;
    fillReject?: boolean;
  };

  async function settleAction(delayMs: number, timeoutMs: number): Promise<void> {
    if (delayMs >= timeoutMs) {
      await vi.advanceTimersByTimeAsync(timeoutMs);
      throw Object.assign(new Error('Timeout exceeded'), { name: 'TimeoutError' });
    }
    await vi.advanceTimersByTimeAsync(delayMs);
  }

  function makeComposerPage(options: ComposerOptions = {}) {
    const frames = readyTurnObservationFrames('PROMPT', 'reply body');
    const messages = frames.at(-1)!.map((message) => ({
      role: message.role as 'user' | 'assistant',
      text: message.text,
      finalAction: message.finalAction,
      finalActionInTurnContainer: message.finalActionInTurnContainer,
    }));
    let readinessProbe = 0;
    const composer = scalarLocator({
      count: vi.fn(async () => options.composerPresent === false ? 0 : 1),
      isVisible: vi.fn(async () => options.visible !== false),
      isEnabled: vi.fn(async () => options.enabled !== false),
      evaluate: vi.fn(async () => {
        if (options.readinessDelayMs) await vi.advanceTimersByTimeAsync(options.readinessDelayMs);
        const sequence = options.readinessSequence;
        const ready = sequence?.[Math.min(readinessProbe, (sequence?.length ?? 1) - 1)]
          ?? true;
        readinessProbe += 1;
        return {
          visible: ready && options.visible !== false,
          enabled: ready && options.enabled !== false,
          contentEditable: ready && options.contentEditable !== false,
        };
      }),
      click: vi.fn(async (opts?: { timeout?: number }) => {
        if (options.clickReject) throw new Error('click rejected');
        await settleAction(options.clickDelayMs ?? 0, opts?.timeout ?? COMPOSER_INSERTION_WAIT_MS);
      }),
      fill: vi.fn(async (_text: string, opts?: { timeout?: number }) => {
        if (options.fillReject) throw new Error('fill rejected');
        await settleAction(options.fillDelayMs ?? 0, opts?.timeout ?? COMPOSER_INSERTION_WAIT_MS);
      }),
    });
    const page = {
      __fakeBrowserGptPage: true,
      waitForTimeout: vi.fn(async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); }),
      __productStatusText: () => (options.blockingOverlay ? 'settings modal open' : ''),
      url: vi.fn(() => 'https://chatgpt.com/c/composer-test'),
      goto: vi.fn(async () => undefined),
      locator: vi.fn((selector: string) => {
        if (selector === COMPOSER_SELECTOR) return composer;
        if (selector.includes('modal-overlay') || selector.includes('aria-modal')) {
          return scalarLocator({ count: vi.fn(async () => options.blockingOverlay ? 1 : 0) });
        }
        if (selector === SEND_BUTTON_SELECTOR) return scalarLocator({ count: vi.fn(async () => 0) });
        if (selector === MESSAGE_NODE_SELECTOR) return collectionLocator(messages);
        return scalarLocator();
      }),
    };
    return { page, composer };
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives insertion allowance from structural line count with a floor and invocation clamp', async () => {
    expect(COMPOSER_READINESS_WAIT_MS).toBe(12_000);
    expect(COMPOSER_INSERTION_WAIT_MS).toBe(3_000);
    expect(COMPOSER_INSERTION_MS_PER_LINE).toBe(120);

    const shortPayload = 'x';
    const longOneLinePayload = 'x'.repeat(19_000);
    const longMarkdownPayload = Array.from({ length: 382 }, (_, index) => `| ${index} | row |`).join('\n');
    const shortBudget = deriveComposerInsertionBudgetMs(shortPayload);
    const longOneLineBudget = deriveComposerInsertionBudgetMs(longOneLinePayload);
    const longMarkdownBudget = deriveComposerInsertionBudgetMs(longMarkdownPayload);

    expect(shortBudget).toBe(3_000);
    expect(longOneLineBudget).toBe(3_000);
    expect(longMarkdownBudget).toBe(45_840);
    expect(longMarkdownBudget).toBeGreaterThan(21_168);
    expect(shortBudget).toBeLessThanOrEqual(longOneLineBudget);
    expect(longOneLineBudget).toBeLessThan(longMarkdownBudget);

    const short = makeComposerPage();
    const long = makeComposerPage();
    const shortContext: { insertionDeadlineMs?: number } = {};
    const longContext: { insertionDeadlineMs?: number } = {};
    expect(await __testComposerMutation.mutateComposerOrCause(short.page, shortPayload, 100_000, shortContext)).toBeNull();
    expect(await __testComposerMutation.mutateComposerOrCause(long.page, longMarkdownPayload, 100_000, longContext)).toBeNull();
    expect(shortContext.insertionDeadlineMs).toBe(shortBudget);
    expect(longContext.insertionDeadlineMs).toBe(longMarkdownBudget);
    expect(short.composer.click.mock.calls[0]?.[0]?.timeout).toBe(shortBudget);
    expect(long.composer.click.mock.calls[0]?.[0]?.timeout).toBe(longMarkdownBudget);

    const clamped = makeComposerPage();
    const clampedContext: { insertionDeadlineMs?: number } = {};
    expect(await __testComposerMutation.mutateComposerOrCause(clamped.page, longMarkdownPayload, 250, clampedContext)).toBeNull();
    expect(clampedContext.insertionDeadlineMs).toBe(250);
    expect(clamped.composer.click.mock.calls[0]?.[0]?.timeout).toBe(250);
  });

  it('requires presence, visibility, enabled state, and contentEditable readiness', async () => {
    for (const option of [
      { composerPresent: false },
      { visible: false },
      { enabled: false },
      { contentEditable: false },
    ]) {
      const result = await __testComposerMutation.waitForComposer(makeComposerPage(option).page, Date.now() + 100);
      expect(result).toEqual({ state: 'ui_contract_mismatch', cause: 'composer_unavailable' });
    }
    expect(await __testComposerMutation.waitForComposer(makeComposerPage().page, Date.now() + 100)).toEqual({ state: 'ready' });
  });

  it('caps readiness at 12 seconds and does not probe at deadline equality', async () => {
    const result = await __testComposerMutation.waitForComposer(makeComposerPage({ composerPresent: false }).page, 30_000);
    expect(result).toEqual({ state: 'ui_contract_mismatch', cause: 'composer_unavailable' });
    expect(Date.now()).toBe(COMPOSER_READINESS_WAIT_MS);
  });

  it('bounds the first post-readiness probe by the insertion phase', async () => {
    const fixture = makeComposerPage({ readinessDelayMs: COMPOSER_INSERTION_WAIT_MS });
    const failure = await __testComposerMutation.mutateComposerOrCause(fixture.page, 'payload', 10_000);
    expect(failure).toBe('composer_mutation_budget_exhausted');
    expect(fixture.composer.click).not.toHaveBeenCalled();
    expect(fixture.composer.fill).not.toHaveBeenCalled();
  });

  it('maps composer readiness loss after click to zero-send mutation exhaustion without fill or re-entry', async () => {
    const fixture = makeComposerPage({ readinessSequence: [true, false] });
    const failure = await __testComposerMutation.mutateComposerOrCause(fixture.page, 'payload', 10_000);
    expect(failure).toBe('composer_mutation_budget_exhausted');
    expect(fixture.composer.click).toHaveBeenCalledTimes(1);
    expect(fixture.composer.fill).not.toHaveBeenCalled();
  });

  it('maps exact and late click/fill timeouts to mutation exhaustion', async () => {
    const clickBoundary = makeComposerPage({ clickDelayMs: COMPOSER_INSERTION_WAIT_MS });
    expect(await __testComposerMutation.mutateComposerOrCause(clickBoundary.page, 'payload', 10_000))
      .toBe('composer_mutation_budget_exhausted');
    expect(clickBoundary.composer.fill).not.toHaveBeenCalled();

    const fillLate = makeComposerPage({ fillDelayMs: COMPOSER_INSERTION_WAIT_MS + 1 });
    expect(await __testComposerMutation.mutateComposerOrCause(fillLate.page, 'payload', 10_000))
      .toBe('composer_mutation_budget_exhausted');
    expect(fillLate.composer.fill).toHaveBeenCalledTimes(1);

    const immediateClickFailure = makeComposerPage({ clickReject: true });
    expect(await __testComposerMutation.mutateComposerOrCause(immediateClickFailure.page, 'payload', 10_000))
      .toBe('composer_mutation_budget_exhausted');
    expect(immediateClickFailure.composer.fill).not.toHaveBeenCalled();

    const immediateFillFailure = makeComposerPage({ fillReject: true });
    expect(await __testComposerMutation.mutateComposerOrCause(immediateFillFailure.page, 'payload', 10_000))
      .toBe('composer_mutation_budget_exhausted');
  });

  it('does not start click or fill when the invocation deadline is already exhausted', async () => {
    const fixture = makeComposerPage();
    const failure = await __testComposerMutation.mutateComposerOrCause(fixture.page, 'payload', 0);
    expect(failure).toBe('composer_mutation_budget_exhausted');
    expect(fixture.composer.click).not.toHaveBeenCalled();
    expect(fixture.composer.fill).not.toHaveBeenCalled();
  });

  it('runTurn starts its invocation deadline before CDP connect and navigation', async () => {
    let now = 1_000;
    let connectAt = -1;
    let navigateAt = -1;
    const target = 'https://chatgpt.com/c/deadline-test';
    const input = join(root, 'deadline-input.txt');
    const output = join(root, 'deadline-output.txt');
    writeFileSync(input, 'payload');
    const fixture = makeComposerPage();
    const originalLocator = fixture.page.locator;
    fixture.composer.count = vi.fn(async () => 1);
    fixture.page.locator = vi.fn((selector: string) => (
      selector.includes('prompt-textarea') ? fixture.composer : originalLocator(selector)
    ));
    fixture.page.url = vi.fn(() => target);
    fixture.page.goto = vi.fn(async () => {
      navigateAt = now;
      now += 5_000;
    });
    const browser = {
      contexts: () => [{ newPage: async () => fixture.page }],
      close: vi.fn(async () => undefined),
      isConnected: () => true,
    };
    const connectOverCDP = vi.fn(async () => {
      connectAt = now;
      now += 6_000;
      return browser;
    });
    vi.spyOn(Date, 'now').mockImplementation(() => {
      const current = now;
      now += 1;
      return current;
    });
    vi.resetModules();
    vi.doMock('../chatgpt-browser-turn/ui-adapter.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../chatgpt-browser-turn/ui-adapter.ts')>();
      return {
        ...actual,
        verifyProfile: vi.fn(async () => ({ state: 'verified' as const, cause: 'ok' })),
        productStatusText: vi.fn(async () => ({ text: '', composer: true })),
        loadChromium: vi.fn(() => ({ connectOverCDP })),
      };
    });
    const { runStateLightTurn } = await import('../chatgpt-browser-turn/state-light-turn.ts');
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });

    const exitCode = await runStateLightTurn([
      '--profile', join(root, 'profile'),
      '--cdp', cdp,
      '--input', input,
      '--output', output,
      '--chat-url', target,
      '--timeout-ms', '10000',
    ]);
    const result = JSON.parse(writes.join(''));

    expect(exitCode).toBe(10);
    expect(result.cause).toBe('composer_unavailable');
    expect(connectAt).toBeGreaterThanOrEqual(1_000);
    expect(connectAt).toBeLessThan(2_000);
    expect(navigateAt).toBeGreaterThanOrEqual(7_000);
    expect(now).toBeGreaterThan(11_000);
    expect(fixture.composer.click).not.toHaveBeenCalled();
    expect(fixture.composer.fill).not.toHaveBeenCalled();
    vi.doUnmock('../chatgpt-browser-turn/ui-adapter.ts');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('keeps blocking overlay as a distinct timeout cause', async () => {
    const fixture = makeComposerPage({ clickDelayMs: COMPOSER_INSERTION_WAIT_MS, blockingOverlay: true });
    expect(await __testComposerMutation.mutateComposerOrCause(fixture.page, 'payload', 10_000))
      .toBe('blocking_page_overlay');
  });
});

