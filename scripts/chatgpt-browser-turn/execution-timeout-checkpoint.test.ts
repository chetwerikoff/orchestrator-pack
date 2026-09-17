import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TURN_STATES, turnExitCode } from './contracts.ts';
import {
  observeExecutionTimeoutCheckpoint,
  type ExecutionTimeoutCheckpointDependencies,
} from './execution-timeout-checkpoint.ts';
import { classifyOwnedMessageDeliveryTimeout } from './message-delivery-timeout.ts';
import { generateOwnedPromptMarker } from './owned-prompt-marker.ts';
import {
  COMPOSER_SELECTOR,
  MESSAGE_NODE_SELECTOR,
  classifyProductMessage,
} from './product-page-selectors.ts';
import {
  classifyProductWall,
  productStatusText,
  type ProductStatusSurface,
} from './ui-adapter.ts';

const marker = `OPKTURNV1${'ab'.repeat(16)}`;
const timeoutSurface: ProductStatusSurface = {
  text: 'Message delivery timed out. Please try again.',
  composer: true,
};
const conversationUrl = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
const siblingConversationUrl = 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222';
const profile = 'browser-gpt-reviewer';
const cdp = 'http://127.0.0.1:9222';
const invocationId = 'checkpoint-invocation';
const executionRunbook = readFileSync(
  new URL('../../docs/chatgpt-task-execution-runbook.md', import.meta.url),
  'utf8',
);
const executeIssueSkill = readFileSync(
  new URL('../../.cursor/skills/execute-issue-with-gpt/SKILL.md', import.meta.url),
  'utf8',
);
const stateLightSource = readFileSync(new URL('./state-light-turn.ts', import.meta.url), 'utf8');
const checkpointSource = readFileSync(new URL('./execution-timeout-checkpoint.ts', import.meta.url), 'utf8');
const uiAdapterSource = readFileSync(new URL('./ui-adapter.ts', import.meta.url), 'utf8');
const longRunChildSource = readFileSync(new URL('../flow-manager-long-running-child.ts', import.meta.url), 'utf8');

function sentRecord(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'state-light-turn-observation/v1' as const,
    version: 1 as const,
    invocation_id: invocationId,
    profile_key: 'fixture-profile-key',
    marker,
    phase: 'sent_unharvested' as const,
    send_count: 1,
    send_witness: 'numeric_send_count' as const,
    conversation_url: conversationUrl,
    transitioned_at: '2026-09-17T00:00:00.000Z',
    transition_reason: 'fixture',
    ...overrides,
  };
}

function pageObservation(input: {
  messages?: Array<{ role: 'user' | 'assistant'; text: string }>;
  generation?: boolean | 'unknown';
  completionReady?: boolean;
} = {}) {
  const messages = input.messages ?? [{ role: 'user' as const, text: `${marker}\n\nTASK` }];
  return {
    messages,
    ownedWindowCompletionReady: input.completionReady ?? false,
    transcriptIncomplete: false,
    snapshot: { complete: true, carriers: [] },
    pageTurnEvidence: {
      generationInProgress: input.generation ?? false,
      observedAssistantNodes: messages.filter((message) => message.role === 'assistant').length,
    },
  } as any;
}

function checkpointDependencies(input: {
  observations?: any[];
  surfaces?: ProductStatusSurface[];
  pages?: any[];
  record?: ReturnType<typeof sentRecord>;
} = {}): ExecutionTimeoutCheckpointDependencies & {
  readPage: ReturnType<typeof vi.fn>;
  readProductStatus: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
  releaseBrowser: ReturnType<typeof vi.fn>;
} {
  const page = { url: () => conversationUrl };
  const observations = input.observations ?? [pageObservation(), pageObservation()];
  const surfaces = input.surfaces ?? [timeoutSurface, timeoutSurface];
  const readPage = vi.fn(async () => observations.shift() ?? pageObservation());
  const readProductStatus = vi.fn(async () => surfaces.shift() ?? timeoutSurface);
  const sleep = vi.fn(async () => undefined);
  const releaseBrowser = vi.fn(async () => undefined);
  return {
    readObservation: vi.fn(() => input.record ?? sentRecord()) as any,
    verifyProfile: vi.fn(async () => ({ state: 'verified', cause: 'fixture' })) as any,
    connectOverCDP: vi.fn(async () => ({
      contexts: () => [{ pages: () => input.pages ?? [page] }],
    })),
    releaseBrowser,
    readPage: readPage as any,
    readProductStatus: readProductStatus as any,
    sleep,
    now: vi.fn(() => 1_000),
  };
}

describe('message-delivery timeout classifier', () => {
  it('normalizes the exact product message and keeps generic failures distinct', () => {
    expect(classifyProductMessage({
      text: '  Message\n delivery timed out.\tPlease try again.  ',
      composer: true,
    })).toEqual({
      state: 'message_delivery_timed_out',
      cause: 'message_delivery_timed_out',
    });
    expect(classifyProductMessage({
      text: 'Request timed out. Please try again later.',
      composer: true,
    })).toEqual({});
  });

  it('requires exact owned current turn, no assistant reply, and no generation', () => {
    const base = {
      surface: timeoutSurface,
      marker,
      transcriptComplete: true,
      generationInProgress: false as const,
      messages: [{ role: 'user' as const, text: `${marker}\n\nTASK` }],
    };
    expect(classifyOwnedMessageDeliveryTimeout(base)).toEqual({
      state: 'message_delivery_timed_out',
      cause: 'message_delivery_timed_out',
    });
    expect(classifyOwnedMessageDeliveryTimeout({
      ...base,
      generationInProgress: true,
    })).toEqual({});
    expect(classifyOwnedMessageDeliveryTimeout({
      ...base,
      messages: [...base.messages, { role: 'assistant', text: 'FINAL' }],
    })).toEqual({});
    expect(classifyOwnedMessageDeliveryTimeout({
      ...base,
      messages: [...base.messages, { role: 'user', text: 'foreign later user' }],
    })).toEqual({});
    expect(classifyOwnedMessageDeliveryTimeout({
      ...base,
      messages: [{ role: 'user', text: `${marker}\n\nTASK mentions ${marker}` }],
    })).toEqual({});
    const foreignMarker = `OPKTURNV1${'cd'.repeat(16)}`;
    expect(classifyOwnedMessageDeliveryTimeout({
      ...base,
      messages: [{ role: 'user', text: `${foreignMarker}\n\nFOREIGN TASK` }],
    })).toEqual({});
  });

  it('maps the terminal state to the existing no-resend/recovery exit class', () => {
    expect(TURN_STATES).toContain('message_delivery_timed_out');
    expect(turnExitCode('message_delivery_timed_out')).toBe(11);
  });
});

describe('state-light immediate product timeout confirmation', () => {
  const priorDocument = (globalThis as { document?: unknown }).document;

  afterEach(() => {
    (globalThis as { document?: unknown }).document = priorDocument;
  });

  it('requires two stable owned dead-turn reads before exposing the terminal wall', async () => {
    const ownedMarker = generateOwnedPromptMarker(() => Uint8Array.from({ length: 16 }, () => 0x7a));
    const ownedText = `${ownedMarker}\n\nTASK`;
    const elements = [{
      getAttribute: (name: string) => name === 'data-message-author-role' ? 'user' : null,
      innerText: ownedText,
    }];
    (globalThis as { document?: unknown }).document = { querySelector: () => null };

    const empty = {
      count: vi.fn(async () => 0),
      nth: vi.fn(() => ({ innerText: vi.fn(async () => '') })),
    };
    const alert = {
      count: vi.fn(async () => 1),
      nth: vi.fn(() => ({ innerText: vi.fn(async () => timeoutSurface.text) })),
    };
    const composer = { count: vi.fn(async () => 1) };
    const messageNodes = {
      evaluateAll: vi.fn(async (callback: (nodes: Element[], args: unknown) => unknown, args: unknown) => (
        callback(elements as unknown as Element[], args)
      )),
    };
    const page = {
      waitForTimeout: vi.fn(async () => undefined),
      locator: vi.fn((selector: string) => {
        if (selector === MESSAGE_NODE_SELECTOR) return messageNodes;
        if (selector === COMPOSER_SELECTOR) return composer;
        if (selector === '[role="alert"]') return alert;
        return empty;
      }),
    };

    const surface = await productStatusText(page, 2_000);
    expect(surface.owned_message_delivery_timeout_stable).toBe(true);
    expect(classifyProductWall(surface)).toEqual({
      state: 'message_delivery_timed_out',
      cause: 'message_delivery_timed_out',
    });
    expect(page.waitForTimeout).toHaveBeenCalledOnce();
    expect(messageNodes.evaluateAll).toHaveBeenCalledTimes(2);
  });
});

describe('execution-only 27-minute checkpoint observation', () => {
  const argv = [
    '--profile', profile,
    '--cdp', cdp,
    '--invocation-id', invocationId,
  ];

  it('confirms only a stable exact-owned timeout and performs no resend action', async () => {
    const deps = checkpointDependencies();
    const result = await observeExecutionTimeoutCheckpoint(argv, deps);

    expect(result.classification).toBe('message_delivery_timed_out');
    expect(result.cause).toBe('message_delivery_timed_out');
    expect(result.conversation_id).toBe(conversationUrl);
    expect(deps.readPage).toHaveBeenCalledTimes(2);
    expect(deps.readProductStatus).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledOnce();
    expect(deps.releaseBrowser).toHaveBeenCalledOnce();
  });

  it('does not convert elapsed-checkpoint observation into timeout when the banner is not stable', async () => {
    const deps = checkpointDependencies({
      surfaces: [timeoutSurface, { text: '', composer: true }],
    });
    const result = await observeExecutionTimeoutCheckpoint(argv, deps);

    expect(result).toMatchObject({
      classification: 'owned_turn_unsettled',
      cause: 'owned_turn_not_terminal',
    });
    expect(deps.readProductStatus).toHaveBeenCalledTimes(2);
  });

  it('returns generation without reading product timeout state', async () => {
    const deps = checkpointDependencies({
      observations: [pageObservation({ generation: true })],
    });
    const result = await observeExecutionTimeoutCheckpoint(argv, deps);

    expect(result).toMatchObject({
      classification: 'owned_reply_generating',
      cause: 'owned_reply_still_generating',
    });
    expect(deps.readProductStatus).not.toHaveBeenCalled();
  });

  it('returns an attributable completed reply instead of timeout recovery', async () => {
    const deps = checkpointDependencies({
      observations: [pageObservation({
        messages: [
          { role: 'user', text: `${marker}\n\nTASK` },
          { role: 'assistant', text: 'FINAL' },
        ],
        generation: false,
        completionReady: true,
      })],
    });
    const result = await observeExecutionTimeoutCheckpoint(argv, deps);

    expect(result).toMatchObject({
      classification: 'owned_reply_completed',
      cause: 'attributable_completed_reply_observed',
    });
    expect(deps.readProductStatus).not.toHaveBeenCalled();
  });

  it('fails closed on foreign activity, sibling/duplicate pages, or missing bound conversation state', async () => {
    const foreign = checkpointDependencies({
      observations: [pageObservation({
        messages: [
          { role: 'user', text: `${marker}\n\nTASK` },
          { role: 'user', text: 'foreign later user' },
        ],
      })],
    });
    await expect(observeExecutionTimeoutCheckpoint(argv, foreign)).resolves.toMatchObject({
      classification: 'ambiguous',
      cause: 'checkpoint_foreign_user_after_owned_send',
    });

    const sibling = checkpointDependencies({
      pages: [{ url: () => siblingConversationUrl }],
    });
    await expect(observeExecutionTimeoutCheckpoint(argv, sibling)).resolves.toMatchObject({
      classification: 'ambiguous',
      cause: 'checkpoint_exact_page_not_unique',
    });
    expect(sibling.readProductStatus).not.toHaveBeenCalled();

    const duplicatePage = { url: () => conversationUrl };
    const duplicate = checkpointDependencies({ pages: [duplicatePage, duplicatePage] });
    await expect(observeExecutionTimeoutCheckpoint(argv, duplicate)).resolves.toMatchObject({
      classification: 'ambiguous',
      cause: 'checkpoint_exact_page_not_unique',
    });

    const unbound = checkpointDependencies({
      record: sentRecord({ phase: 'sent_unbound', conversation_url: null }),
    });
    await expect(observeExecutionTimeoutCheckpoint(argv, unbound)).resolves.toMatchObject({
      classification: 'ambiguous',
      cause: 'checkpoint_sent_turn_binding_unavailable',
    });
  });
});

describe('execute-Issue GitHub-first timeout recovery contract', () => {
  const compactRunbook = executionRunbook.replace(/\s+/g, ' ');
  const compactSkill = executeIssueSkill.replace(/\s+/g, ' ');

  it('propagates the immediate terminal state through the existing result authority', () => {
    expect(stateLightSource).toMatch(/if \(wall\.state\)[\s\S]{0,1000}compactResult\(\s*wall\.state,/);
    expect(longRunChildSource).toContain('TURN_STATES');
    expect(longRunChildSource).toMatch(/function isTurnState[\s\S]{0,240}TURN_STATES/);
    expect(compactRunbook).toContain('An authoritative `turn-result/v1` whose exact owned state is `message_delivery_timed_out`');
  });

  it('requires an exact timeout proof and GitHub reconciliation before any replacement send', () => {
    expect(compactRunbook).toContain('This section is entered only after either:');
    expect(compactRunbook).toContain('an authoritative immediate `turn-result/v1` for the exact owned invocation reports `state: message_delivery_timed_out`');
    expect(compactRunbook).toContain('the mandatory 27-minute checkpoint independently reports exact `message_delivery_timed_out`');
    expect(compactRunbook).toContain('Generic helper timeout, launcher timeout, `stream_timeout`, `no_reply`, browser loss');
    expect(compactRunbook).toContain('elapsed 27 minutes by itself **never** enters this section');
    expect(compactRunbook).toContain('before any replacement ChatGPT send, perform a fresh live GitHub reconciliation for the exact Issue');
    expect(compactRunbook).toContain('find an existing PR only through authoritative Issue/PR identity and record its current head');
    expect(compactRunbook).toContain('otherwise find an unambiguous Issue-owned task branch/current commits through authoritative repository identity');
    expect(compactRunbook).toContain('independently check whether current GitHub/repository state already satisfies Definition of Done');
    expect(compactRunbook).toContain('if candidate ownership is ambiguous, fail closed');
  });

  it('defines PR, branch-only, no-work, already-complete, and ambiguous-candidate outcomes', () => {
    expect(compactRunbook).toContain('**Existing PR and work remains:**');
    expect(compactRunbook).toContain('include the Issue URL + PR URL + exact current head');
    expect(compactRunbook).toContain('**No PR, but one unambiguous Issue-owned task branch/current head and work remains:**');
    expect(compactRunbook).toContain('include the Issue URL + branch + exact current head');
    expect(compactRunbook).toContain('**No observed task work:**');
    expect(compactRunbook).toContain('use the ordinary initial Issue URL + `выполни задачу` prompt');
    expect(compactRunbook).toContain('**Definition of Done already independently satisfied:** do not open another ChatGPT conversation');
    expect(compactRunbook).toContain('Ambiguous PR/branch candidates do not authorize guessing or a fresh execution send');
  });

  it('keeps the recovery observation-only and scoped to the exact failed conversation', () => {
    expect(checkpointSource).not.toMatch(/\.click\s*\(/);
    expect(checkpointSource).not.toContain('SEND_BUTTON_SELECTOR');
    expect(uiAdapterSource).not.toMatch(/\.click\s*\(/);
    expect(compactRunbook).toContain('Never press the product Retry button. Never resend into the failed conversation.');
    expect(compactRunbook).toContain('Never close a sibling/foreign tab by focus, age, URL similarity, or timeout text.');
    expect(compactRunbook).toContain('Fresh-chat authority exists only for the two exact timeout proofs above');
  });

  it('keeps the supervisor skill routed to the execution runbook instead of adding a second manager runtime', () => {
    expect(compactSkill).toContain('docs/chatgpt-task-execution-runbook.md');
    expect(compactSkill).toContain('The execution runbook owns first-session initialization, same-conversation continuations, the execution-only 27-minute live-chat checkpoint');
    expect(compactSkill).toContain('Merge is never implicit.');
  });
});