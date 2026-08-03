import { describe, expect, it } from 'vitest';
import type { InputSnapshot } from './input.ts';
import { COMPOSER_SELECTOR, SEND_BUTTON_SELECTOR } from './ui-adapter.ts';
import {
  runStateLightSession,
  SessionStdoutWriter,
  type SessionPayloadRecord,
  type SessionResultV1,
  type SessionWritable,
  type StateLightSessionDependencies,
} from './state-light-session.ts';
import {
  createDirectPublicationObservationState,
  directPublicationReceipt,
  observeDirectPublicationPayload,
  parseCanonicalSourceRevision,
  parseReviewerSourceIdentity,
  reviewerSourceMetadata,
  settleDirectPublication,
  validateDirectPublicationInputs,
} from './terminal-witness.ts';

class CaptureStream implements SessionWritable {
  readonly lines: unknown[] = [];
  destroyed = false;
  writable = true;
  writableEnded = false;
  writableNeedDrain = false;

  constructor(
    private readonly failWhen: (value: any) => boolean = () => false,
    private readonly afterWrite: (value: any) => void = () => undefined,
  ) {}

  write(chunk: string): boolean {
    const value = JSON.parse(chunk);
    this.lines.push(value);
    this.afterWrite(value);
    return !this.failWhen(value);
  }

  destroy(): void {
    this.destroyed = true;
    this.writable = false;
  }
}

interface Harness {
  readonly argv: string[];
  readonly stream: CaptureStream;
  readonly dependencies: Partial<StateLightSessionDependencies>;
  readonly metrics: { sends: number; pages: number; gotos: number; closes: number; releases: number };
  readonly messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  nowMs: number;
  composerText: string;
}

function digest(text: string) {
  return { byte_length: Buffer.byteLength(text), sha256: expect.any(String) };
}

function makeHarness(
  payloads: readonly string[] = ['same', 'same', 'line 1\nline 2'],
  options: {
    readonly stream?: CaptureStream;
    readonly timeoutMs?: number;
    readonly cleanup?: 'confirmed' | 'unconfirmed';
    readonly profileState?: 'verified' | 'unavailable' | 'mismatch';
  } = {},
): Harness {
  const metrics = { sends: 0, pages: 0, gotos: 0, closes: 0, releases: 0 };
  const messages: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  const snapshots = new Map<string, InputSnapshot>();
  payloads.forEach((text, index) => {
    snapshots.set(`/in/${index + 1}.txt`, {
      text,
      bytes: Buffer.from(text),
      byteLength: Buffer.byteLength(text),
      dev: 1n,
      ino: BigInt(index + 1),
    });
  });

  let nowMs = 10_000;
  let composerText = '';
  const stream = options.stream ?? new CaptureStream();
  const markers = payloads.map((_, index) => `OPKTURNV1${String(index + 1).padStart(32, '0')}`);
  let markerIndex = 0;
  const page = {
    __fakeBrowserGptPage: true,
    url: () => 'https://chatgpt.com/c/11111111-1111-1111-1111-111111111111',
    goto: async () => { metrics.gotos += 1; },
    close: async () => { metrics.closes += 1; },
    waitForTimeout: async (ms: number) => { nowMs += ms; },
    locator: (selector: string) => {
      if (selector === COMPOSER_SELECTOR) {
        return {
          count: async () => 1,
          evaluate: async () => composerText,
          innerText: async () => composerText,
          press: async (key: string) => {
            expect(key).toBe('Enter');
            metrics.sends += 1;
            messages.push({ role: 'user', text: composerText });
            messages.push({ role: 'assistant', text: `reply-${metrics.sends}` });
          },
        };
      }
      if (selector === SEND_BUTTON_SELECTOR) return {
        count: async () => 1,
        click: async () => {
          metrics.sends += 1;
          messages.push({ role: 'user', text: composerText });
          messages.push({ role: 'assistant', text: `reply-${metrics.sends}` });
        },
      };
      return { count: async () => 0 };
    },
  };
  const browser = {
    contexts: () => [{
      newPage: async () => {
        metrics.pages += 1;
        return page;
      },
    }],
  };

  const argv = [
    '--profile', 'profile-a',
    '--cdp', 'http://127.0.0.1:9222',
    '--chat-url', 'https://chatgpt.com/c/11111111-1111-1111-1111-111111111111',
    '--timeout-ms', String(options.timeoutMs ?? 60_000),
    '--poll-ms', '1',
  ];
  payloads.forEach((_, index) => {
    argv.push('--input', `/in/${index + 1}.txt`, '--output', `/out/${index + 1}.txt`);
  });

  const dependencies: Partial<StateLightSessionDependencies> = {
    now: () => nowMs,
    uuid: () => 'session-invocation',
    readInput: (path) => {
      const snapshot = snapshots.get(path);
      if (!snapshot) throw new Error('input_invalid:unreadable');
      return snapshot;
    },
    resolveDestination: (path) => ({ finalPath: path, identity: path.toLowerCase() }),
    profileKey: () => 'profile-key',
    verifyProfile: async () => ({
      state: options.profileState ?? 'verified',
      cause: options.profileState === 'unavailable' ? 'chrome_not_running' : 'verified',
      evidence: 'test',
    }),
    prepareFresh: async () => ({ state: 'ready' }),
    loadChromium: () => ({ connectOverCDP: async () => browser }),
    marker: () => markers[markerIndex++]!,
    wrapPayload: (marker, text) => `${marker}\n\n${text}`,
    waitForComposer: async () => ({ state: 'ready' }),
    mutateComposer: async (_page, text, deadline, context) => {
      composerText = text;
      if (context) context.insertionDeadlineMs = deadline;
      return null;
    },
    readComposerReady: async () => true,
    readObservation: async () => ({
      messages: [...messages],
      ownedWindowCompletionReady: metrics.sends > 0,
      transcriptIncomplete: false,
    }),
    classifyObservation: (observed, _baseline, marker) => {
      const userIndex = observed.findIndex((message: { role: string; text: string }) => message.role === 'user' && message.text.startsWith(marker));
      const assistant = userIndex >= 0
        ? observed.slice(userIndex + 1).find((message: { role: string; text: string }) => message.role === 'assistant')
        : undefined;
      return assistant ? { state: 'ready', reply: assistant.text } : { state: 'waiting' };
    },
    replyStable: (left, right) => left.length > 0 && left === right,
    publishReply: (_path, _invocation, reply) => ({ state: 'committed_ok', output: {
      byte_length: Buffer.byteLength(reply),
      sha256: `hash-${reply}`,
    } }),
    cleanup: async (fn) => {
      await fn();
      return options.cleanup ?? 'confirmed';
    },
    releaseBrowser: async () => { metrics.releases += 1; },
    stdout: stream,
    sleep: async (_page, ms) => { nowMs += ms; },
  };

  return {
    argv,
    stream,
    dependencies,
    metrics,
    messages,
    get nowMs() { return nowMs; },
    set nowMs(value: number) { nowMs = value; },
    get composerText() { return composerText; },
    set composerText(value: string) { composerText = value; },
  };
}

function records(stream: CaptureStream): SessionPayloadRecord[] {
  return stream.lines.filter((value): value is SessionPayloadRecord => (value as any).schema === 'session-payload/v1');
}

function aggregate(stream: CaptureStream): SessionResultV1 | undefined {
  return stream.lines.find((value): value is SessionResultV1 => (value as any).schema === 'session-result/v1');
}

describe('state-light explicit session mode', () => {
  it('uses one owned tab and one initial navigation for three ordered payloads', async () => {
    const harness = makeHarness();
    const exit = await runStateLightSession(harness.argv, harness.dependencies);

    expect(exit).toBe(0);
    expect(harness.metrics).toEqual({ sends: 3, pages: 1, gotos: 1, closes: 1, releases: 1 });
    const payloadRecords = records(harness.stream);
    expect(payloadRecords.map((record) => [record.ordinal, record.phase])).toEqual([
      [1, 'dispatch-latched'], [1, 'delivery-bound'], [1, 'terminal'],
      [2, 'dispatch-latched'], [2, 'delivery-bound'], [2, 'terminal'],
      [3, 'dispatch-latched'], [3, 'delivery-bound'], [3, 'terminal'],
    ]);
    expect(payloadRecords.filter((record) => record.phase === 'terminal').map((record) => record.state)).toEqual(['ok', 'ok', 'ok']);
    expect(new Set(payloadRecords.filter((record) => record.phase === 'dispatch-latched').map((record) => record.expected_marker)).size).toBe(3);

    const result = aggregate(harness.stream)!;
    expect(result).toMatchObject({
      schema: 'session-result/v1',
      payload_count: 3,
      attempted_payload_count: 3,
      total_send_count: 3,
      terminal_stop_ordinal: null,
      decisive_payload_ordinal: null,
      state: 'ok',
      scope: 'none',
      cause: 'completed_page_only',
      exit_code: 0,
      cleanup: 'confirmed',
      owned_tab_count: 1,
      goto_count: 1,
      new_chat_click_count: 0,
      navigation_count: 1,
    });
    expect(result.payloads.map((item) => item.input)).toEqual([
      digest('same'), digest('same'), digest('line 1\nline 2'),
    ]);
  });

  it('emits only unchanged compact turn-result shape for preflight refusal', async () => {
    const harness = makeHarness(['one']);
    const argv = [...harness.argv];
    argv.splice(argv.indexOf('--output'), 2);
    const exit = await runStateLightSession(argv, harness.dependencies);

    expect(exit).toBe(10);
    expect(harness.metrics).toEqual({ sends: 0, pages: 0, gotos: 0, closes: 0, releases: 0 });
    expect(harness.stream.lines).toHaveLength(1);
    expect(harness.stream.lines[0]).toEqual({
      schema: 'turn-result/v1',
      state: 'input_invalid',
      scope: 'invocation',
      cause: 'input_invalid:payload_pair_count_mismatch',
      invocation_id: 'session-invocation',
      configured_profile_key: 'profile-key',
      send_count: 0,
      poll_count: 0,
      goto_count: 0,
      new_chat_click_count: 0,
      navigation_count: 0,
      cleanup: 'skipped',
      incidents: [],
    });
  });

  it('materializes ordinal 1 as active when profile setup fails', async () => {
    const harness = makeHarness(['one', 'two', 'three'], { profileState: 'unavailable' });
    const exit = await runStateLightSession(harness.argv, harness.dependencies);

    expect(exit).toBe(12);
    expect(records(harness.stream)).toEqual([
      expect.objectContaining({ ordinal: 1, phase: 'terminal', delivery_state: 'not_sent', send_count: 0, state: 'chrome_not_running' }),
      expect.objectContaining({ ordinal: 2, phase: 'terminal', delivery_state: 'not_attempted', send_count: 0 }),
      expect.objectContaining({ ordinal: 3, phase: 'terminal', delivery_state: 'not_attempted', send_count: 0 }),
    ]);
    expect(aggregate(harness.stream)).toMatchObject({
      terminal_stop_ordinal: 1,
      decisive_payload_ordinal: 1,
      attempted_payload_count: 1,
      total_send_count: 0,
      owned_tab_count: 0,
      cleanup: 'skipped',
    });
  });

  it('makes pre-activation continuity failure decisive on ordinal k without copying marker count', async () => {
    const messages: Array<{ role: 'user' | 'assistant'; text: string }> = [];
    const stream = new CaptureStream(
      () => false,
      (value) => {
        if (value.schema === 'session-payload/v1' && value.ordinal === 1 && value.phase === 'terminal') {
          messages.push({ role: 'user', text: 'FOREIGN' });
        }
      },
    );
    const harness = makeHarness(['one', 'two', 'three'], { stream });
    const dependencies: Partial<StateLightSessionDependencies> = {
      ...harness.dependencies,
      readObservation: async () => ({
        messages: [...harness.messages, ...messages],
        ownedWindowCompletionReady: harness.metrics.sends > 0,
        transcriptIncomplete: false,
      }),
    };

    const exit = await runStateLightSession(harness.argv, dependencies);
    expect(exit).toBe(11);
    const terminal = records(stream).filter((record) => record.phase === 'terminal');
    expect(terminal[1]).toMatchObject({
      ordinal: 2,
      delivery_state: 'not_attempted',
      send_count: 0,
      state: 'foreign_activity',
      cause: 'foreign_user_after_predecessor',
    });
    expect(terminal[1]).not.toHaveProperty('marker_match_count');
    expect(terminal[2]).toMatchObject({ ordinal: 3, delivery_state: 'not_attempted', send_count: 0 });
    expect(aggregate(stream)).toMatchObject({ terminal_stop_ordinal: 2, decisive_payload_ordinal: 2, attempted_payload_count: 1 });
  });

  it('does not dispatch when the dispatch-latched stdout barrier fails', async () => {
    const stream = new CaptureStream((value) => value.phase === 'dispatch-latched');
    const harness = makeHarness(['one', 'two'], { stream });
    const exit = await runStateLightSession(harness.argv, harness.dependencies);

    expect(exit).toBe(13);
    expect(harness.metrics.sends).toBe(0);
    expect(stream.destroyed).toBe(true);
    expect(aggregate(stream)).toBeUndefined();
    expect(records(stream)).toEqual([
      expect.objectContaining({ ordinal: 1, phase: 'dispatch-latched', send_count: 1, delivery_state: 'delivery_unknown' }),
    ]);
  });

  it('preserves conservative delivery_unknown when delivery-bound stdout fails', async () => {
    const stream = new CaptureStream((value) => value.phase === 'delivery-bound');
    const harness = makeHarness(['one', 'two'], { stream });
    const exit = await runStateLightSession(harness.argv, harness.dependencies);

    expect(exit).toBe(13);
    expect(harness.metrics.sends).toBe(1);
    expect(aggregate(stream)).toBeUndefined();
    expect(records(stream).map((record) => record.phase)).toEqual(['dispatch-latched', 'delivery-bound']);
  });

  it('keeps the primary tuple clean when cleanup is unconfirmed', async () => {
    const harness = makeHarness(['one'], { cleanup: 'unconfirmed' });
    const exit = await runStateLightSession(harness.argv, harness.dependencies);
    expect(exit).toBe(0);
    expect(aggregate(harness.stream)).toMatchObject({
      state: 'ok', scope: 'none', cause: 'completed_page_only', cleanup: 'unconfirmed', exit_code: 0,
    });
  });

  it('preserves output-conflict state and exit semantics during preflight', async () => {
    const harness = makeHarness(['one']);
    const dependencies: Partial<StateLightSessionDependencies> = {
      ...harness.dependencies,
      resolveDestination: () => { throw new Error('output_conflict:output_exists'); },
    };

    const exit = await runStateLightSession(harness.argv, dependencies);

    expect(exit).toBe(10);
    expect(harness.metrics.pages).toBe(0);
    expect(harness.stream.lines[0]).toMatchObject({
      schema: 'turn-result/v1',
      state: 'output_conflict',
      scope: 'invocation',
      cause: 'output_conflict:output_exists',
      send_count: 0,
      cleanup: 'skipped',
    });
  });

  it('emits session-result and cleans up when the active baseline observation throws', async () => {
    const harness = makeHarness(['one', 'two']);
    const dependencies: Partial<StateLightSessionDependencies> = {
      ...harness.dependencies,
      readObservation: async () => { throw new Error('page_gone'); },
    };

    const exit = await runStateLightSession(harness.argv, dependencies);

    expect(exit).toBe(13);
    expect(harness.metrics).toMatchObject({ sends: 0, pages: 1, gotos: 1, closes: 1, releases: 1 });
    expect(records(harness.stream)).toEqual([
      expect.objectContaining({ ordinal: 1, phase: 'terminal', send_count: 0, state: 'driver_error', cause: 'baseline_observation_failed:page_gone' }),
      expect.objectContaining({ ordinal: 2, phase: 'terminal', delivery_state: 'not_attempted', send_count: 0 }),
    ]);
    expect(aggregate(harness.stream)).toMatchObject({
      state: 'driver_error',
      cause: 'baseline_observation_failed:page_gone',
      cleanup: 'confirmed',
      terminal_stop_ordinal: 1,
    });
  });

  it('passes the remaining session deadline to profile verification', async () => {
    const harness = makeHarness(['one'], { timeoutMs: 1_000 });
    const start = harness.nowMs;
    let observedBudget: { endsAtMs: number; clampOperationWaitMs: (now?: number) => number } | undefined;
    const dependencies: Partial<StateLightSessionDependencies> = {
      ...harness.dependencies,
      verifyProfile: async (_config, budget) => {
        observedBudget = budget;
        return { state: 'verified', cause: 'verified', evidence: 'test' };
      },
    };

    await runStateLightSession(harness.argv, dependencies);

    expect(observedBudget).toBeDefined();
    expect(observedBudget!.endsAtMs).toBe(start + 1_000);
    expect(observedBudget!.clampOperationWaitMs(start)).toBe(1_000);
  });

  it('settles immediately when an observation returns after the session deadline', async () => {
    const harness = makeHarness(['one'], { timeoutMs: 10 });
    const dependencies: Partial<StateLightSessionDependencies> = {
      ...harness.dependencies,
      readObservation: async () => {
        harness.nowMs += 11;
        return {
          messages: [...harness.messages],
          ownedWindowCompletionReady: false,
          transcriptIncomplete: false,
        };
      },
    };

    const exit = await runStateLightSession(harness.argv, dependencies);

    expect(exit).toBe(11);
    expect(harness.metrics.sends).toBe(0);
    expect(aggregate(harness.stream)).toMatchObject({ state: 'stream_timeout', cause: 'whole_session_deadline_exhausted' });
  });

  it('rejects duplicate output identities and the 33-payload ceiling before browser setup', async () => {
    const duplicate = makeHarness(['one', 'two']);
    duplicate.argv.splice(duplicate.argv.lastIndexOf('/out/2.txt'), 1, '/out/1.txt');
    await runStateLightSession(duplicate.argv, duplicate.dependencies);
    expect((duplicate.stream.lines[0] as any).cause).toBe('input_invalid:duplicate_output_destination');
    expect(duplicate.metrics.pages).toBe(0);

    const tooMany = makeHarness(Array.from({ length: 33 }, (_, index) => String(index)));
    await runStateLightSession(tooMany.argv, tooMany.dependencies);
    expect((tooMany.stream.lines[0] as any).cause).toBe('input_invalid:payload_count_out_of_range');
    expect(tooMany.metrics.pages).toBe(0);
  });
});

describe('SessionStdoutWriter', () => {
  it('uses immediate-write-only semantics at deadline equality', async () => {
    const values: string[] = [];
    const stream: SessionWritable = {
      writable: true,
      write: (chunk) => { values.push(chunk); return true; },
    };
    const writer = new SessionStdoutWriter(stream, 100, () => 100);
    await expect(writer.write({ record: 1 })).resolves.toBe(true);
    expect(values).toHaveLength(1);
  });

  it('aborts immediately at/after expiry when write reports backpressure', async () => {
    let destroyed = false;
    const stream: SessionWritable = {
      writable: true,
      write: () => false,
      destroy: () => { destroyed = true; },
    };
    const writer = new SessionStdoutWriter(stream, 100, () => 100);
    await expect(writer.write({ record: 1 })).resolves.toBe(false);
    expect(destroyed).toBe(true);
  });
});


const target = {
  repositoryFullName: 'chetwerikoff/orchestrator-pack',
  issueNumber: 1196,
  sourceRevision: 'r18',
  invocationId: '550e8400-e29b-41d4-a716-446655440000',
  userMessageId: 'user-01',
} as const;

const successComment = [
  'Read revision: #1196 r18',
  'VERDICT: APPROVE',
  '',
  'id: F-001',
  'Finding: example',
].join('\n');

function observeSuccess() {
  const state = createDirectPublicationObservationState();
  observeDirectPublicationPayload(state, {
    type: 'tool_call',
    action: 'add_comment_to_issue',
    tool_call_id: 'call-01',
    assistant_message_id: 'assistant-01',
    parent_user_message_id: 'user-01',
    arguments: {
      repository: target.repositoryFullName,
      issue_number: target.issueNumber,
      comment: successComment,
    },
  });
  observeDirectPublicationPayload(state, {
    type: 'tool_result',
    action: 'add_comment_to_issue',
    tool_call_id: 'call-01',
    parent_user_message_id: 'user-01',
    repository: target.repositoryFullName,
    issue_number: target.issueNumber,
    response: {
      status: 201,
      comment_id: '987',
      comment_url: 'https://github.com/chetwerikoff/orchestrator-pack/issues/1196#issuecomment-987',
    },
    success: true,
  });
  return state;
}

describe('direct-publication terminal matrix', () => {
  it('captures exact decoded comment bytes and emits the five-line receipt', () => {
    const settlement = settleDirectPublication(observeSuccess(), target);
    expect(settlement.state).toBe('success');
    expect(settlement.sourceBytes).toBe(successComment);

    const metadata = reviewerSourceMetadata(settlement, target);
    expect(metadata?.kind).toBe('service-observed-issue-comment/v1');
    expect(metadata?.byte_length).toBe(Buffer.byteLength(successComment));
    expect(metadata?.comment_id).toBe('987');
    expect(metadata?.finding_count).toBe(1);
    expect(directPublicationReceipt(settlement, target)).toBe([
      'VERDICT: APPROVE',
      'COMMENT_URL: https://github.com/chetwerikoff/orchestrator-pack/issues/1196#issuecomment-987',
      'REVISION: r18',
      `INVOCATION_ID: ${target.invocationId}`,
      'FINDING_COUNT: 1',
    ].join('\n'));
  });

  it.each([401, 403, 404, 410, 422])('accepts only definitive GitHub rejection %s as no-commit', (status) => {
    const state = createDirectPublicationObservationState();
    observeDirectPublicationPayload(state, {
      action: 'add_comment_to_issue',
      tool_call_id: `call-${status}`,
      parent_user_message_id: 'user-01',
      arguments: {
        repository: target.repositoryFullName,
        issue_number: target.issueNumber,
        comment: successComment,
      },
    });
    observeDirectPublicationPayload(state, {
      action: 'add_comment_to_issue',
      tool_call_id: `call-${status}`,
      parent_user_message_id: 'user-01',
      repository: target.repositoryFullName,
      issue_number: target.issueNumber,
      response_complete: true,
      response: { status },
    });
    const finalAssistant = `${successComment}\nFull fallback findings`;
    const settlement = settleDirectPublication(state, target, finalAssistant);
    expect(settlement.state).toBe('failed-write');
    expect(settlement.result?.noCommitClass).toBe('github-create-comment-definitive-rejection');
    expect(reviewerSourceMetadata(settlement, target)?.kind).toBe('failed-write-final-assistant/v1');
    expect(reviewerSourceMetadata(settlement, target)?.comment_url).toBeUndefined();
  });

  it('accepts adapter no-dispatch and rejects timeout or ambiguous results', () => {
    const noDispatch = createDirectPublicationObservationState();
    observeDirectPublicationPayload(noDispatch, {
      action: 'add_comment_to_issue',
      tool_call_id: 'call-adapter',
      parent_user_message_id: 'user-01',
      arguments: {
        repository: target.repositoryFullName,
        issue_number: target.issueNumber,
        comment: successComment,
      },
    });
    observeDirectPublicationPayload(noDispatch, {
      action: 'add_comment_to_issue',
      tool_call_id: 'call-adapter',
      parent_user_message_id: 'user-01',
      repository: target.repositoryFullName,
      issue_number: target.issueNumber,
      no_external_request: true,
    });
    expect(settleDirectPublication(noDispatch, target, successComment).state).toBe('failed-write');

    const timeout = observeSuccess();
    observeDirectPublicationPayload(timeout, {
      action: 'add_comment_to_issue',
      tool_call_id: 'call-01',
      repository: target.repositoryFullName,
      issue_number: target.issueNumber,
      error: 'timeout',
    });
    expect(settleDirectPublication(timeout, target).state).toBe('possible-delivery');

    const ambiguous = observeSuccess();
    observeDirectPublicationPayload(ambiguous, {
      action: 'add_comment_to_issue',
      tool_call_id: 'call-01',
      repository: target.repositoryFullName,
      issue_number: target.issueNumber,
      response_complete: true,
      response: { status: 503 },
    });
    expect(settleDirectPublication(ambiguous, target).state).toBe('possible-delivery');

    const unpaired = observeSuccess();
    observeDirectPublicationPayload(unpaired, {
      action: 'add_comment_to_issue',
      tool_call_id: 'call-unpaired',
      parent_user_message_id: 'user-01',
      repository: target.repositoryFullName,
      issue_number: target.issueNumber,
      response_complete: true,
      response: { status: 201, comment_id: '988', comment_url: 'https://github.com/example/unpaired' },
      success: true,
    });
    expect(settleDirectPublication(unpaired, target).cause).toBe('direct_publication_result_ambiguous');
  });

});

describe('direct-publication input and source bindings', () => {
  it('requires one caller-minted UUID echo and a complete policy identity', () => {
    expect(parseReviewerSourceIdentity('slot-01#capture=direct-publication/v1')?.policy)
      .toBe('direct-publication/v1');
    expect(parseReviewerSourceIdentity('slot-01#capture=service-observed-issue-comment/v1')).toBeNull();
    expect(validateDirectPublicationInputs({
      invocationId: target.invocationId,
      prompt: `INVOCATION_ID_TO_ECHO: ${target.invocationId}`,
      reviewerSource: 'slot-01#capture=direct-publication/v1',
      repositoryFullName: target.repositoryFullName,
      issueNumber: target.issueNumber,
      sourceRevision: target.sourceRevision,
    })).toBeNull();
    expect(validateDirectPublicationInputs({
      invocationId: target.invocationId,
      prompt: `INVOCATION_ID_TO_ECHO: ${target.invocationId}\nINVOCATION_ID_TO_ECHO: ${target.invocationId}`,
      reviewerSource: 'slot-01#capture=direct-publication/v1',
      repositoryFullName: target.repositoryFullName,
      issueNumber: target.issueNumber,
      sourceRevision: target.sourceRevision,
    })).toBe('invocation_id_prompt_mismatch');
  });

  it('requires exactly one leading issue/revision declaration', () => {
    expect(parseCanonicalSourceRevision(successComment, target)).toEqual({
      issueNumber: 1196,
      sourceRevision: 'r18',
      findingCount: 1,
    });
    expect(parseCanonicalSourceRevision(
      `${successComment}\nRead revision: #1196 r18`,
      target,
    )).toBeNull();
    expect(parseCanonicalSourceRevision(
      successComment.replace('#1196 r18', '#1195 r18'),
      target,
    )).toBeNull();
  });
});
