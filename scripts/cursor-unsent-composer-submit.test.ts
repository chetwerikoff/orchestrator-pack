// @vitest-ci-lane light
// @vitest-pre-topology-seconds 1
import { readFileSync, unlinkSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acquireWatchLock,
  classifyCursorComposer,
  createAdapterSubmitDeps,
  createUnsentComposerWatchState,
  cursorComposerLooksUnsent,
  loadSubmittedFingerprints,
  releaseWatchLock,
  saveSubmittedFingerprints,
  submitUnsentCursorComposer,
  submitUnsentCursorComposerOnce,
  submitUnsentCursorComposerDeliveryForTerminal,
  submitOrcaMessageDeliveryPointer,
  submitUnsentCursorComposerOnceForWorker,
  runSupervisorUnsentComposerTick,
  workerKey,
  type UnsentComposerSubmitDeps,
} from './cursor-unsent-composer-submit.ts';
import type { RuntimeWorker, RuntimeWorkerIdentity } from './runtime/contracts.ts';

const POKE = 'You have 1 orchestration message. Run `orca orchestration check --run run_d613a86c140a`.';
const DISPATCH_POKE = 'You have 1 orchestration message. Run `orca orchestration check`.';
const CURSOR_FOOTER = [
  'Cursor Grok 4.6 High · 40.6% · 22 files edited                                                                                                    Run Everything',
  '~/projects/orchestrator-pack · main',
];
const EMPTY_CLAUDE_SCREEN = [
  'prior transcript line',
  'new task? /clear to save context',
  '────────────────────────────────',
  '❯',
  '────────────────────────────────',
  '⏵⏵ bypass permissions on (shift+tab to cycle)',
];

function worker(id: string, generation = 'g1', runtime: 'orca' | 'codex' = 'orca'): RuntimeWorker {
  return {
    identity: { runtime, id, generation },
    workspacePath: '/tmp',
    title: id,
    provenance: 'external',
  };
}

function depsFor(
  linesById: Record<string, string[]>,
  extra: Partial<UnsentComposerSubmitDeps> & {
    submitted?: RuntimeWorkerIdentity[];
    submitResult?: UnsentComposerSubmitDeps['submit'];
  } = {},
): UnsentComposerSubmitDeps {
  const submitted = extra.submitted ?? [];
  return {
    listWorkers: extra.listWorkers ?? (() => ({
      ok: true as const,
      workers: Object.keys(linesById).map((id) => worker(id)),
    })),
    read: extra.read ?? ((identity) => ({
      ok: true as const,
      lines: linesById[identity.id] ?? ['→ Add a follow-up'],
    })),
    liveness: extra.liveness,
    submit: extra.submitResult ?? extra.submit ?? ((identity) => {
      submitted.push(identity);
      return { status: 'dispatched' as const };
    }),
    now: extra.now,
    sleep: extra.sleep,
    sleepAsync: extra.sleepAsync,
    sentStorePath: extra.sentStorePath,
  };
}

describe('classifyCursorComposer', () => {
  it('treats narrow Running chrome inside the composer box as empty', () => {
    expect(classifyCursorComposer(`
▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
→ Add a follow-up
ctrl+c to stop
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
Cursor Grok 4.6 High · 10.4% Run Everything
~/projects/orchestrator-pack · main
`)).toBe('empty');
  });

  it('treats a visible transcript plus trailing placeholder as empty', () => {
    expect(classifyCursorComposer(`
wiki: skip(direct-instruction state/action)
→ Add a follow-up
Cursor Grok 4.6 High · 40.6% · 22 files edited                                                                                                    Run Everything
~/projects/orchestrator-pack · main
`)).toBe('empty');
  });

  it('does not steal a Cursor pasted draft or ordinary typing', () => {
    expect(classifyCursorComposer(`
→ [Pasted text #1 +15 lines]
GPT-5.6 Luna 272K Low · 26.5% Run Everything
~/orca/workspaces/orchestrator-pack/mgr-agents-ctx-decomp
`)).toBe('non_empty');
    expect(classifyCursorComposer(`
→ разберись почему упал пайплайн
Cursor Grok 4.6 High · 40.6% · 22 files edited Run Everything
~/projects/orchestrator-pack · main
`)).toBe('non_empty');
  });

  it('fails closed when an unboxed poke sits under transcript history', () => {
    expect(classifyCursorComposer(`
Почта обработана.
${POKE}
Cursor Grok 4.6 High · 40.6% · 22 files edited Run Everything
~/projects/orchestrator-pack - main
`)).toBe('non_empty');
  });

  it('sees the poke in a terminal-read composer block under an arrow', () => {
    expect(cursorComposerLooksUnsent(`
  wiki: skip(direct-instruction state/action)

 ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
  →
    ${POKE}

    ${POKE}

 ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
  Cursor Grok 4.6 High · 44.7% · 22 files edited                                                                                                    Run Everything
  ~/projects/orchestrator-pack · main
    `)).toBe(true);
  });

  it('sees the poke when Cursor renders arrow and pointer on one line', () => {
    expect(cursorComposerLooksUnsent(`
 ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
  → ${POKE}
 ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
  GPT-5.6 Luna 272K High Run Everything
  ~/projects/orchestrator-pack · main
`)).toBe(true);
  });

  it('accepts one exact pointer soft-wrapped by a narrow Cursor composer', () => {
    expect(cursorComposerLooksUnsent(`
 ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
  → You have 1 orchestration message. Run \`orca orchestration check --run run_3b
d1ac011935\`.
 ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
  GPT-5.6 Luna 272K High Run Everything
  ~/projects/orchestrator-pack · main
`)).toBe(true);
  });

  it('does not submit when the composer box has a poke plus typed text', () => {
    expect(classifyCursorComposer(`
 ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
  →
    ${POKE}
    ок, глянь ещё раз
 ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
  Cursor Grok 4.6 High · 44.7% · 22 files edited                                                                                                    Run Everything
  ~/projects/orchestrator-pack · main
`)).toBe('non_empty');
  });

  it('keeps boxed multi-line content non-empty when its last line resembles the placeholder', () => {
    expect(classifyCursorComposer(`
 ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
  →
    real draft line
    Add a follow-up
 ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
  Cursor Grok 4.6 High · 44.7% · 22 files edited Run Everything
  ~/projects/orchestrator-pack · main
`)).toBe('non_empty');
  });

  it('does not treat chrome-looking typed text inside the composer box as UI chrome', () => {
    expect(classifyCursorComposer(`
 ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
  →
    ${POKE}
    Tip: do not send this
 ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
  Cursor Grok 4.6 High · 44.7% · 22 files edited                                                                                                    Run Everything
  ~/projects/orchestrator-pack · main
`)).toBe('non_empty');
  });

  it('does not submit an unboxed poke followed by chrome-looking user text', () => {
    expect(classifyCursorComposer(`
${POKE}
Tip: do not send this
Cursor Grok 4.6 High · 40.6% · 22 files edited Run Everything
~/projects/orchestrator-pack · main
`)).toBe('non_empty');
  });

  it.each([
    ['Windows', 'C:\\Users\\dev\\repo · main'],
    ['absolute Unix', '/workspaces/repo · main'],
  ])('recognizes an unboxed Cursor composer with a %s cwd footer', (_platform, cwdFooter) => {
    expect(classifyCursorComposer([
      POKE,
      'Cursor Grok 4.6 High · 40.6% · 22 files edited Run Everything',
      cwdFooter,
    ].join('\n'))).toBe('non_empty');
  });

  it('does not strip unboxed user text that only starts like Cursor footer chrome', () => {
    const footer = CURSOR_FOOTER.join('\n');
    expect(classifyCursorComposer(`${POKE}\nCursor please keep this\n${footer}`)).toBe('non_empty');
    expect(classifyCursorComposer(`${POKE}\nGPT-please keep this\n${footer}`)).toBe('non_empty');
    expect(classifyCursorComposer(`${POKE}\nComposer note keep this\n${footer}`)).toBe('non_empty');
    expect(classifyCursorComposer(`${POKE}\n~/projects/foo\n${footer}`)).toBe('non_empty');
  });

  it('does not treat a user line that starts with one box glyph as the composer border', () => {
    expect(classifyCursorComposer(`
 ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
  →
    ${POKE}
    ▀ do not send this
 ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
  Cursor Grok 4.6 High · 44.7% · 22 files edited                                                                                                    Run Everything
  ~/projects/orchestrator-pack · main
`)).toBe('non_empty');
  });

  it('does not submit an unboxed poke that still has a typed composer line above it', () => {
    expect(classifyCursorComposer(`
→ разберись почему
${POKE}
Cursor Grok 4.6 High · 40.6% · 22 files edited Run Everything
~/projects/orchestrator-pack · main
`)).toBe('non_empty');
  });
});

describe('submitUnsentCursorComposer', () => {
  it('submits an exact pointer in the first supervisor observation', async () => {
    const submitted: RuntimeWorkerIdentity[] = [];
    const result = await runSupervisorUnsentComposerTick(depsFor(
      { term_unsent: [POKE, ...CURSOR_FOOTER] },
      { submitted },
    ));
    expect(result.terminals[0]?.reason).toBe('enter_sent');
    expect(submitted).toHaveLength(1);
  });

  it('ignores legacy quiet-window observations for an exact pointer', async () => {
    const submitted: RuntimeWorkerIdentity[] = [];
    const state = createUnsentComposerWatchState();
    const identity = worker('term_unsent').identity;
    state.lastFingerprint.set(workerKey(identity), POKE);
    state.lastChangedAt.set(workerKey(identity), Date.now());
    await runSupervisorUnsentComposerTick(depsFor(
      { term_unsent: [POKE, ...CURSOR_FOOTER] },
      { submitted },
    ), state);
    expect(submitted).toHaveLength(1);
  });

  it('submits every exact pointer in one supervisor pass', async () => {
    const submitted: RuntimeWorkerIdentity[] = [];
    const first = worker('term_first');
    const second = worker('term_second');
    const deps: UnsentComposerSubmitDeps = {
      listWorkers: () => ({ ok: true, workers: [first, second] }),
      read: () => ({ ok: true as const, lines: [POKE, ...CURSOR_FOOTER], source: 'screen' as const }),
      submit: (identity) => {
        submitted.push(identity);
        return { status: 'dispatched' as const };
      },
    };
    await runSupervisorUnsentComposerTick(deps);
    expect(submitted.map((identity) => identity.id)).toEqual(['term_first', 'term_second']);
  });

  it('uses rendered screen observation when stream output omits the composer', () => {
    const identity = worker('term_production').identity;
    const reads: Array<{ screen?: boolean }> = [];
    const adapter = {
      listWorkers: () => ({ status: 'ok' as const, value: [worker('term_production')] }),
      readBoundedOutput: (input: { screen?: boolean }) => {
        reads.push(input);
        return {
          status: 'ok' as const,
          value: {
            worker: identity,
            lines: input.screen ? [POKE, ...CURSOR_FOOTER] : ['stream output without composer'],
            observationToken: { opaque: 'screen-frame' },
            changed: false,
            terminalState: 'running' as const,
            source: input.screen ? 'screen' as const : 'stream' as const,
          },
        };
      },
      liveness: (input: { worker: RuntimeWorkerIdentity; observationWindowMs: number }) => ({
        status: 'idle' as const,
        worker: input.worker,
      }),
      dispatchInput: () => ({ status: 'dispatched' as const }),
    } as unknown as Parameters<typeof createAdapterSubmitDeps>[0];
    const deps = createAdapterSubmitDeps(adapter, () => ({ ok: true, result: {} }));
    const result = submitUnsentCursorComposer({ watch: true }, deps);
    expect(result.terminals[0]?.reason).toBe('enter_sent');
    expect(reads.map(({ screen }) => screen)).toEqual([true]);
  });

  it('enters every unsent worker and skips empty ones', () => {
    const submitted: RuntimeWorkerIdentity[] = [];
    const result = submitUnsentCursorComposer(
      {},
      depsFor(
        {
          term_empty: ['→ Add a follow-up', ...CURSOR_FOOTER],
          term_unsent: [POKE, ...CURSOR_FOOTER],
        },
        { submitted },
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.watch).toBe(false);
    expect(submitted.map((row) => row.id)).toEqual(['term_unsent']);
    expect(submitted[0]?.generation).toBe('g1');
    expect(result.terminals.map((row) => row.reason)).toEqual(['composer_empty', 'enter_sent']);
  });

  it('submits repeated exact pointer lines as one Cursor composer', () => {
    const submitted: RuntimeWorkerIdentity[] = [];
    const result = submitUnsentCursorComposer(
      { watch: true },
      depsFor(
        { term_repeated: [POKE, POKE, POKE, ...CURSOR_FOOTER] },
        { submitted },
      ),
    );
    expect(result.terminals[0]?.reason).toBe('enter_sent');
    expect(submitted.map((row) => row.id)).toEqual(['term_repeated']);
  });

  it('never enters an idle transcript followed by the composer placeholder', () => {
    const submitted: RuntimeWorkerIdentity[] = [];
    const state = createUnsentComposerWatchState();
    const localDeps = depsFor(
      {
        term_idle: [
          'prior transcript line',
          '→ Add a follow-up',
          ...CURSOR_FOOTER,
        ],
      },
      { submitted },
    );
    const first = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    const second = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    expect(first.terminals[0]?.reason).toBe('composer_empty');
    expect(second.terminals[0]?.reason).toBe('composer_empty');
    expect(submitted).toHaveLength(0);
  });

  it('submits a filled Cursor composer but never an empty Claude composer', () => {
    const submitted: RuntimeWorkerIdentity[] = [];
    let now = 0;
    const state = createUnsentComposerWatchState();
    const localDeps = depsFor(
      {
        term_cursor: [
          '▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
          '→',
          POKE,
          '▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
          ...CURSOR_FOOTER,
        ],
        term_claude: EMPTY_CLAUDE_SCREEN,
      },
      { submitted },
    );
    const first = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    const second = submitUnsentCursorComposer({ watch: true }, localDeps, state);

    expect(first.terminals.map((row) => row.reason)).toEqual(['enter_sent', 'composer_empty']);
    expect(second.terminals.map((row) => row.reason)).toEqual(['already_submitted', 'composer_empty']);
    expect(submitted.map((row) => row.id)).toEqual(['term_cursor']);
  });

  it('never submits ordinary or mixed typing', () => {
    const submitted: RuntimeWorkerIdentity[] = [];
    const result = submitUnsentCursorComposer(
      { watch: true },
      depsFor(
        {
          term_typing: ['→ разберись почему', ...CURSOR_FOOTER],
          term_mixed_before: ['→ разберись почему', POKE, ...CURSOR_FOOTER],
          term_mixed_after: [POKE, 'не отправляй это', ...CURSOR_FOOTER],
        },
        { submitted },
      ),
    );
    expect(submitted).toEqual([]);
    expect(result.terminals.map((row) => row.reason)).toEqual([
      'composer_not_orchestration_pointer',
      'composer_not_orchestration_pointer',
      'composer_not_orchestration_pointer',
    ]);
  });

  it('submits an exact pointer immediately and does not resend', () => {
    const submitted: RuntimeWorkerIdentity[] = [];
    const state = createUnsentComposerWatchState();
    const localDeps = depsFor(
      { term_unsent: [POKE, ...CURSOR_FOOTER] },
      { submitted },
    );
    const first = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    const second = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    expect(first.terminals[0]?.reason).toBe('enter_sent');
    expect(second.terminals[0]?.reason).toBe('already_submitted');
    expect(submitted.map((row) => row.id)).toEqual(['term_unsent']);
  });

  it('does not retry Enter after an ambiguous dispatch outcome', () => {
    const submitted: RuntimeWorkerIdentity[] = [];
    const state = createUnsentComposerWatchState();
    const localDeps = depsFor(
      { term_unsent: [POKE, ...CURSOR_FOOTER] },
      {
        submitted,
        submitResult: (identity) => {
          submitted.push(identity);
          return { status: 'dispatch_unknown', reason: 'submit_witness_unavailable' };
        },
      },
    );
    submitUnsentCursorComposer({ watch: true }, localDeps, state);
    submitUnsentCursorComposer({ watch: true }, localDeps, state);
    const again = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    expect(submitted).toHaveLength(1);
    expect(again.terminals[0]?.reason).toBe('already_submitted');
  });

  it('does not resubmit the same pointer after dispatch_unknown through mixed text', () => {
    const submitted: RuntimeWorkerIdentity[] = [];
    const state = createUnsentComposerWatchState();
    const linesById = { term_unsent: [POKE, ...CURSOR_FOOTER] };
    const localDeps = depsFor(linesById, {
      submitted,
      submitResult: (identity) => {
        submitted.push(identity);
        return { status: 'dispatch_unknown', reason: 'submit_witness_unavailable' };
      },
    });

    const ambiguous = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    linesById.term_unsent = [POKE, 'не отправляй это', ...CURSOR_FOOTER];
    const mixed = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    linesById.term_unsent = [POKE, ...CURSOR_FOOTER];
    const repeated = submitUnsentCursorComposer({ watch: true }, localDeps, state);

    expect(ambiguous.terminals[0]?.reason).toBe('submit_witness_unavailable');
    expect(mixed.terminals[0]?.reason).toBe('composer_not_orchestration_pointer');
    expect(repeated.terminals[0]?.reason).toBe('already_submitted');
    expect(submitted).toHaveLength(1);
  });

  it('does not rearm the same pointer after dispatch_unknown through an empty composer', () => {
    const submitted: RuntimeWorkerIdentity[] = [];
    const state = createUnsentComposerWatchState();
    const linesById = { term_unsent: [POKE, ...CURSOR_FOOTER] };
    const localDeps = depsFor(linesById, {
      submitted,
      submitResult: (identity) => {
        submitted.push(identity);
        return { status: 'dispatch_unknown', reason: 'submit_witness_unavailable' };
      },
    });

    const ambiguous = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    linesById.term_unsent = ['→ Add a follow-up', ...CURSOR_FOOTER];
    const empty = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    linesById.term_unsent = [POKE, ...CURSOR_FOOTER];
    const repeated = submitUnsentCursorComposer({ watch: true }, localDeps, state);

    expect(ambiguous.terminals[0]?.reason).toBe('submit_witness_unavailable');
    expect(empty.terminals[0]?.reason).toBe('composer_empty');
    expect(repeated.terminals[0]?.reason).toBe('already_submitted');
    expect(submitted).toHaveLength(1);
  });

  it('preserves every ambiguous pointer across distinct pointers and fresh state', () => {
    const sentStorePath = join(tmpdir(), `opk-unsent-ambiguous-${process.pid}-${Date.now()}.json`);
    const submitted: RuntimeWorkerIdentity[] = [];
    const pointerB = 'You have 1 orchestration message. Run `orca orchestration check --run run_pointer_b`.';
    const linesById = { term_unsent: [POKE, ...CURSOR_FOOTER] };
    let dispatches = 0;
    const localDeps = depsFor(linesById, {
      submitted,
      sentStorePath,
      submitResult: (identity) => {
        submitted.push(identity);
        dispatches += 1;
        return dispatches === 1
          ? { status: 'dispatch_unknown', reason: 'submit_witness_unavailable' }
          : { status: 'dispatched' };
      },
    });

    try {
      const first = submitUnsentCursorComposer({ watch: true }, localDeps, createUnsentComposerWatchState());
      linesById.term_unsent = [pointerB, ...CURSOR_FOOTER];
      const second = submitUnsentCursorComposer({ watch: true }, localDeps, createUnsentComposerWatchState());
      const persisted = JSON.parse(readFileSync(sentStorePath, 'utf8')) as {
        submitted: Array<{ fingerprint: string; ambiguous?: boolean }>;
      };
      expect(persisted.submitted).toContainEqual(expect.objectContaining({ fingerprint: POKE, ambiguous: true }));
      linesById.term_unsent = [POKE, ...CURSOR_FOOTER];
      const repeated = submitUnsentCursorComposer({ watch: true }, localDeps, createUnsentComposerWatchState());

      expect(first.terminals[0]?.reason).toBe('submit_witness_unavailable');
      expect(second.terminals[0]?.reason).toBe('enter_sent');
      expect(repeated.terminals[0]?.reason).toBe('already_submitted');
      expect(submitted).toHaveLength(2);
    } finally {
      try { unlinkSync(sentStorePath); } catch { /* ignore */ }
    }
  });

  it('retries only a proven pre-side-effect launch failure', () => {
    const submitted: RuntimeWorkerIdentity[] = [];
    const state = createUnsentComposerWatchState();
    let now = 0;
    let launches = 0;
    const localDeps = depsFor(
      { term_unsent: [POKE, ...CURSOR_FOOTER] },
      {
        now: () => now,
        submitResult: (identity) => {
          submitted.push(identity);
          launches += 1;
          if (launches === 1) return { status: 'send_failed', reason: 'runtime_unavailable' };
          return { status: 'dispatched' };
        },
      },
    );
    const failed = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    const retry = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    expect(failed.terminals[0]?.reason).toBe('runtime_unavailable');
    expect(retry.terminals[0]?.reason).toBe('enter_sent');
    expect(submitted).toHaveLength(2);
  });

  it('submits on the first --once read without sleeping or re-reading', () => {
    const submitted: RuntimeWorkerIdentity[] = [];
    let now = 0;
    let reads = 0;
    const result = submitUnsentCursorComposerOnce(
      { terminals: ['term_unsent'] },
      depsFor(
        { term_unsent: [POKE, ...CURSOR_FOOTER] },
        {
          submitted,
          now: () => now,
          sleep: (milliseconds) => {
            now += milliseconds;
          },
          read: (identity) => {
            reads += 1;
            return { ok: true as const, lines: identity.id === 'term_unsent' ? [POKE, ...CURSOR_FOOTER] : ['→ Add a follow-up'], source: 'screen' as const };
          },
        },
      ),
    );
    expect(reads).toBe(1);
    expect(submitted.map((row) => row.id)).toEqual(['term_unsent']);
    expect(result.watch).toBe(false);
    expect(result.terminals[0]?.reason).toBe('enter_sent');
  });

  it('retries any definitive send_failed and reports dispatch_unknown without Enter', () => {
    const submitted: RuntimeWorkerIdentity[] = [];
    const state = createUnsentComposerWatchState();
    let now = 0;
    let launches = 0;
    const localDeps = depsFor(
      { term_unsent: [POKE, ...CURSOR_FOOTER] },
      {
        now: () => now,
        submitResult: (identity) => {
          submitted.push(identity);
          launches += 1;
          if (launches === 1) return { status: 'send_failed', reason: 'runtime_response_invalid' };
          return { status: 'dispatched' };
        },
      },
    );
    const failed = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    const retry = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    expect(failed.terminals[0]?.reason).toBe('runtime_response_invalid');
    expect(retry.terminals[0]?.reason).toBe('enter_sent');
    expect(submitted).toHaveLength(2);
  });

  it('keeps the no-resend watermark across fresh scheduler ticks and rearms after empty', () => {
    const sentStorePath = join(tmpdir(), `opk-unsent-watch-${process.pid}-${Date.now()}.json`);
    const submitted: RuntimeWorkerIdentity[] = [];
    let now = 0;
    const linesById = { term_unsent: [POKE, ...CURSOR_FOOTER] };
    const deps = depsFor(
      linesById,
      { submitted, sentStorePath, now: () => now },
    );
    try {
      const first = submitUnsentCursorComposer({ watch: true }, deps, createUnsentComposerWatchState());
      const second = submitUnsentCursorComposer({ watch: true }, deps, createUnsentComposerWatchState());
      linesById.term_unsent = ['→ Add a follow-up'];
      const empty = submitUnsentCursorComposer({ watch: true }, deps, createUnsentComposerWatchState());
      linesById.term_unsent = [POKE, ...CURSOR_FOOTER];
      const repeated = submitUnsentCursorComposer({ watch: true }, deps, createUnsentComposerWatchState());
      expect(first.terminals[0]?.reason).toBe('enter_sent');
      expect(second.terminals[0]?.reason).toBe('already_submitted');
      expect(empty.terminals[0]?.reason).toBe('composer_empty');
      expect(repeated.terminals[0]?.reason).toBe('enter_sent');
      expect(submitted).toHaveLength(2);
    } finally {
      try { unlinkSync(sentStorePath); } catch { /* ignore */ }
    }
  });

  it('does not resend across a fresh --once state when the fingerprint was persisted', () => {
    const sentStorePath = join(tmpdir(), `opk-unsent-sent-${process.pid}-${Date.now()}.json`);
    const submitted: RuntimeWorkerIdentity[] = [];
    let now = 0;
    const deps = depsFor(
      { term_unsent: [POKE, ...CURSOR_FOOTER] },
      {
        submitted,
        sentStorePath,
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
        },
      },
    );
    try {
      submitUnsentCursorComposerOnce({ terminals: ['term_unsent'] }, deps, createUnsentComposerWatchState());
      now = 0;
      const again = submitUnsentCursorComposerOnce(
        { terminals: ['term_unsent'] },
        deps,
        createUnsentComposerWatchState(),
      );
      expect(submitted).toHaveLength(1);
      expect(again.terminals[0]?.reason).toBe('already_submitted');
    } finally {
      try { unlinkSync(sentStorePath); } catch { /* ignore */ }
    }
  });

  it('persists a ReadonlyMap of submitted fingerprints', () => {
    const sentStorePath = join(tmpdir(), `opk-unsent-readonly-${process.pid}-${Date.now()}.json`);
    const identity = worker('term_unsent').identity;
    const submitted: ReadonlyMap<string, string> = new Map([[workerKey(identity), POKE]]);
    try {
      saveSubmittedFingerprints(sentStorePath, submitted);
      expect(loadSubmittedFingerprints(sentStorePath).get(workerKey(identity))).toBe(POKE);
    } finally {
      try { unlinkSync(sentStorePath); } catch { /* ignore */ }
    }
  });
});

describe('delivery-triggered composer submission', () => {
  it('submits an exact pointer soft-wrapped by a narrow Cursor composer', async () => {
    const target = worker('term_wrapped_pointer');
    const submitted: RuntimeWorkerIdentity[] = [];
    const result = await submitUnsentCursorComposerOnceForWorker(target, depsFor({}, {
      submitted,
      liveness: () => 'busy',
      read: () => ({
        ok: true as const,
        lines: [
          '▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
          '→ You have 1 orchestration message. Run `orca orchestration check --run run_3b',
          'd1ac011935`.',
          '▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
          ...CURSOR_FOOTER,
        ],
        source: 'screen' as const,
      }),
    }));

    expect(result.terminals[0]).toMatchObject({ reason: 'enter_sent', enter: true });
    expect(submitted).toEqual([target.identity, target.identity]);
  });

  it('writes one unread Orca pointer without a synthetic Enter', async () => {
    const target = worker('term_message_delivery');
    const submitted: RuntimeWorkerIdentity[] = [];
    let reads = 0;
    let writes = 0;
    let consumed = false;
    let rendered = false;
    let releaseRender: (() => void) | undefined;
    const renderReady = new Promise<void>((resolve) => {
      releaseRender = () => {
        rendered = true;
        resolve();
      };
    });
    const submitDeps = depsFor({}, {
      submitted,
      liveness: () => 'busy',
      read: () => {
        reads += 1;
        return {
          ok: true as const,
          lines: rendered ? [DISPATCH_POKE, ...CURSOR_FOOTER] : ['→ Add a follow-up', ...CURSOR_FOOTER],
          source: 'screen' as const,
        };
      },
      sleepAsync: async () => renderReady,
    });
    const deps = {
      lookupMessage: () => ({
        ok: true as const,
        message: {
          id: 'msg_delivery',
          runId: 'run_d613a86c140a',
          recipient: 'dispatch:ctx_delivery',
          consumed,
        },
      }),
      resolveWorker: () => ({ ok: true as const, worker: target }),
      writePointer: (identity: RuntimeWorkerIdentity, pointer: string) => {
        expect(identity).toEqual(target.identity);
        expect(pointer).toBe(DISPATCH_POKE);
        writes += 1;
        return { status: 'dispatched' as const };
      },
      submitDeps,
    };

    const pending = submitOrcaMessageDeliveryPointer('msg_delivery', deps);
    await Promise.resolve();
    expect(reads).toBe(1);
    expect(writes).toBe(1);
    expect(submitted).toHaveLength(0);
    releaseRender?.();
    const result = await pending;

    expect(result.terminals[0]).toMatchObject({ reason: 'pointer_queued', enter: false });
    expect(reads).toBe(1);
    expect(submitted).toEqual([]);

    consumed = true;
    const duplicate = await submitOrcaMessageDeliveryPointer('msg_delivery', deps);
    expect(duplicate.terminals[0]?.reason).toBe('delivery_already_consumed');
    expect(reads).toBe(1);
    expect(writes).toBe(1);
    expect(submitted).toHaveLength(0);
  });

  it('writes a run-bound pointer for a coordinator recipient', async () => {
    const target = worker('term_run_delivery');
    const submitted: RuntimeWorkerIdentity[] = [];
    let written = '';
    let reads = 0;
    const result = await submitOrcaMessageDeliveryPointer('msg_run', {
      lookupMessage: () => ({
        ok: true as const,
        message: {
          id: 'msg_run',
          runId: 'run_d613a86c140a',
          recipient: 'run:run_d613a86c140a',
          consumed: false,
        },
      }),
      resolveWorker: () => ({ ok: true as const, worker: target }),
      writePointer: (_identity, pointer) => {
        written = pointer;
        return { status: 'dispatched' as const };
      },
      submitDeps: depsFor({}, {
        submitted,
        liveness: () => 'idle',
        read: () => ({
          ok: true as const,
          lines: reads++ === 0 ? ['→ Add a follow-up', ...CURSOR_FOOTER] : [POKE, ...CURSOR_FOOTER],
          source: 'screen' as const,
        }),
      }),
    });

    expect(written).toBe(POKE);
    expect(result.terminals[0]).toMatchObject({ reason: 'pointer_queued', enter: false });
    expect(submitted).toEqual([]);
  });

  it('accepts an explicit write witness reported with dispatch_unknown', async () => {
    const target = worker('term_write_witness');
    const submitted: RuntimeWorkerIdentity[] = [];
    const result = await submitOrcaMessageDeliveryPointer('msg_write_witness', {
      lookupMessage: () => ({
        ok: true as const,
        message: { id: 'msg_write_witness', runId: 'run_d613a86c140a', recipient: 'run:run_d613a86c140a', consumed: false },
      }),
      resolveWorker: () => ({ ok: true as const, worker: target }),
      writePointer: () => ({
        status: 'dispatch_unknown' as const,
        reason: 'submit_witness_unavailable',
        witness: { operation: 'write' as const, accepted: true as const, source: 'runtime-response' as const },
      }),
      submitDeps: depsFor({ [target.identity.id]: ['→ Add a follow-up', ...CURSOR_FOOTER] }, { submitted }),
    });

    expect(result.terminals[0]).toMatchObject({ reason: 'pointer_queued', enter: false });
    expect(submitted).toEqual([]);
  });

  it('does not re-Enter an already queued native pointer for unread mail', async () => {
    const target = worker('term_native_queued');
    const submitted: RuntimeWorkerIdentity[] = [];
    let writes = 0;
    const result = await submitOrcaMessageDeliveryPointer('msg_native_queued', {
      lookupMessage: () => ({
        ok: true as const,
        message: { id: 'msg_native_queued', runId: 'run_d613a86c140a', recipient: 'run:run_d613a86c140a', consumed: false },
      }),
      resolveWorker: () => ({ ok: true as const, worker: target }),
      writePointer: () => { writes += 1; return { status: 'dispatched' as const }; },
      submitDeps: depsFor({ [target.identity.id]: [POKE, ...CURSOR_FOOTER] }, { submitted }),
    });
    expect(result.terminals[0]).toMatchObject({ reason: 'already_submitted', enter: false });
    expect(writes).toBe(0);
    expect(submitted).toHaveLength(0);
  });

  it('does not write a pointer over human composer text for an unread message', async () => {
    const target = worker('term_message_human');
    let writes = 0;
    const result = await submitOrcaMessageDeliveryPointer('msg_human', {
      lookupMessage: () => ({
        ok: true as const,
        message: { id: 'msg_human', runId: 'run_human', recipient: 'run:run_human', consumed: false },
      }),
      resolveWorker: () => ({ ok: true as const, worker: target }),
      writePointer: () => {
        writes += 1;
        return { status: 'dispatched' as const };
      },
      submitDeps: depsFor({ [target.identity.id]: ['→ operator draft', ...CURSOR_FOOTER] }),
    });

    expect(result.terminals[0]?.reason).toBe('composer_not_empty_before_delivery');
    expect(writes).toBe(0);
  });

  it('resolves one exact terminal before asynchronous rendering and duplicate no-effect', async () => {
    const target = worker('term_exact_delivery');
    const submitted: RuntimeWorkerIdentity[] = [];
    const resolved: string[] = [];
    let reads = 0;
    let releaseRender: (() => void) | undefined;
    let pointerVisible = true;
    const renderReady = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const deps = depsFor(
      { [target.identity.id]: [] },
      {
        submitted,
        liveness: () => 'busy',
        read: (identity) => {
          reads += 1;
          expect(identity).toEqual(target.identity);
          return {
            ok: true as const,
            lines: reads === 1 || !pointerVisible
              ? ['→ Add a follow-up', ...CURSOR_FOOTER]
              : [POKE, ...CURSOR_FOOTER],
            source: 'screen' as const,
          };
        },
        sleepAsync: async () => renderReady,
        submitResult: (identity) => {
          submitted.push(identity);
          if (submitted.length === 2) pointerVisible = false;
          return { status: 'dispatched' as const };
        },
      },
    );
    const resolver = {
      findWorkerById: (id: string) => {
        resolved.push(id);
        return { status: 'ok' as const, value: target };
      },
    };

    const pending = submitUnsentCursorComposerDeliveryForTerminal(target.identity.id, resolver, deps);
    await Promise.resolve();
    expect(resolved).toEqual([target.identity.id]);
    expect(reads).toBe(1);
    expect(submitted).toHaveLength(0);
    releaseRender?.();
    const first = await pending;
    expect(first.terminals[0]).toMatchObject({ reason: 'enter_sent', enter: true });
    expect(reads).toBe(2);
    expect(submitted).toEqual([target.identity, target.identity]);

    const duplicate = await submitUnsentCursorComposerDeliveryForTerminal(target.identity.id, resolver, deps);
    expect(duplicate.terminals[0]?.reason).toBe('composer_empty');
    expect(submitted).toHaveLength(2);
  });

  it('refuses unresolved exact-terminal identity before screen or Enter effects', async () => {
    let reads = 0;
    const submitted: RuntimeWorkerIdentity[] = [];
    const result = await submitUnsentCursorComposerDeliveryForTerminal('term_replaced', {
      findWorkerById: () => ({ status: 'failed', reason: 'runtime_identity_ambiguous' }),
    }, depsFor({}, {
      submitted,
      read: () => {
        reads += 1;
        return { ok: true as const, lines: [POKE, ...CURSOR_FOOTER], source: 'screen' as const };
      },
    }));

    expect(result).toMatchObject({
      ok: false,
      terminals: [{ terminal: 'term_replaced', enter: false, reason: 'runtime_identity_ambiguous' }],
    });
    expect(reads).toBe(0);
    expect(submitted).toHaveLength(0);
  });

  it('refuses human or mixed composer text through the exact-terminal boundary', async () => {
    const human = worker('term_exact_human');
    const mixed = worker('term_exact_mixed');
    const submitted: RuntimeWorkerIdentity[] = [];
    const resolver = {
      findWorkerById: (id: string) => ({
        status: 'ok' as const,
        value: id === human.identity.id ? human : mixed,
      }),
    };
    const deps = depsFor({
      [human.identity.id]: ['→ operator draft', ...CURSOR_FOOTER],
      [mixed.identity.id]: [POKE, 'operator draft', ...CURSOR_FOOTER],
    }, { submitted });

    const humanResult = await submitUnsentCursorComposerDeliveryForTerminal(human.identity.id, resolver, deps);
    const mixedResult = await submitUnsentCursorComposerDeliveryForTerminal(mixed.identity.id, resolver, deps);

    expect(humanResult.terminals[0]?.reason).toBe('composer_not_orchestration_pointer');
    expect(mixedResult.terminals[0]?.reason).toBe('composer_not_orchestration_pointer');
    expect(submitted).toHaveLength(0);
  });

  it('reads and submits immediately while the target is Running', async () => {
    const target = worker('term_busy_transition');
    const submitted: RuntimeWorkerIdentity[] = [];
    let reads = 0;
    const deps = depsFor(
      { [target.identity.id]: [POKE, ...CURSOR_FOOTER] },
      {
        submitted,
        liveness: () => 'busy',
        read: () => {
          reads += 1;
          return { ok: true as const, lines: [POKE, ...CURSOR_FOOTER], source: 'screen' as const };
        },
      },
    );
    const state = createUnsentComposerWatchState();

    const pending = submitUnsentCursorComposerOnceForWorker(target, deps, state);
    const idle = await pending;
    expect(idle.terminals[0]).toMatchObject({ reason: 'enter_sent', enter: true });
    expect(reads).toBe(1);
    expect(submitted).toHaveLength(2);

    const duplicate = await submitUnsentCursorComposerOnceForWorker(target, deps, state);
    expect(duplicate.terminals[0]?.reason).toBe('already_submitted');
    expect(reads).toBe(2);
    expect(submitted).toHaveLength(2);
  });

  it('retries once after asynchronous Cursor rendering, then queues while Running', async () => {
    const target = worker('term_busy_render_race');
    const submitted: RuntimeWorkerIdentity[] = [];
    let reads = 0;
    let releaseRender: (() => void) | undefined;
    const renderReady = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const pending = submitUnsentCursorComposerOnceForWorker(target, depsFor(
      { [target.identity.id]: [] },
      {
        submitted,
        liveness: () => 'busy',
        read: () => {
          reads += 1;
          return {
            ok: true as const,
            lines: reads === 1 ? ['→ Add a follow-up', ...CURSOR_FOOTER] : [POKE, ...CURSOR_FOOTER],
            source: 'screen' as const,
          };
        },
        sleepAsync: async () => renderReady,
      },
    ));

    await Promise.resolve();
    expect(reads).toBe(1);
    expect(submitted).toHaveLength(0);
    releaseRender?.();
    const result = await pending;

    expect(result.terminals[0]).toMatchObject({ reason: 'enter_sent', enter: true });
    expect(reads).toBe(2);
    expect(submitted).toEqual([target.identity, target.identity]);
  });

  it('applies the same immediate busy-queue contract to Codex', async () => {
    const target = worker('term_codex_busy', 'codex-generation', 'codex');
    const submitted: RuntimeWorkerIdentity[] = [];
    let reads = 0;
    const result = await submitUnsentCursorComposerOnceForWorker(target, depsFor(
      { [target.identity.id]: [POKE, ...CURSOR_FOOTER] },
      {
        submitted,
        liveness: () => 'busy',
        read: (identity) => {
          expect(identity).toEqual(target.identity);
          reads += 1;
          return { ok: true as const, lines: [POKE, ...CURSOR_FOOTER], source: 'screen' as const };
        },
      },
    ));

    expect(result.terminals[0]).toMatchObject({ reason: 'enter_sent', enter: true });
    expect(reads).toBe(1);
    expect(submitted).toEqual([target.identity, target.identity]);
  });

  it('uses the immediate idle path for exactly one screen read and Enter', async () => {
    const target = worker('term_idle_immediate');
    const submitted: RuntimeWorkerIdentity[] = [];
    let reads = 0;
    const result = await submitUnsentCursorComposerOnceForWorker(target, depsFor(
      { [target.identity.id]: [POKE, ...CURSOR_FOOTER] },
      {
        submitted,
        liveness: () => 'idle',
        read: () => {
          reads += 1;
          return { ok: true as const, lines: [POKE, ...CURSOR_FOOTER], source: 'screen' as const };
        },
      },
    ));
    expect(result.terminals[0]?.reason).toBe('enter_sent');
    expect(reads).toBe(1);
    expect(submitted).toHaveLength(1);
  });

  it('does not submit when exact-worker liveness becomes unknown', async () => {
    const target = worker('term_identity_unknown');
    const submitted: RuntimeWorkerIdentity[] = [];
    const result = await submitUnsentCursorComposerOnceForWorker(target, depsFor(
      { [target.identity.id]: [POKE, ...CURSOR_FOOTER] },
      { submitted, liveness: () => 'unknown' },
    ));

    expect(result.terminals[0]).toMatchObject({ reason: 'worker_unknown', enter: false });
    expect(submitted).toHaveLength(0);
  });

  it('refuses human and mixed composer text after idle without Enter', async () => {
    const submitted: RuntimeWorkerIdentity[] = [];
    const human = worker('term_human_idle');
    const mixed = worker('term_mixed_idle');
    const result = await submitUnsentCursorComposerOnceForWorker(human, {
      ...depsFor({ [human.identity.id]: ['→ разберись почему', ...CURSOR_FOOTER] }, { submitted }),
    });
    const mixedResult = await submitUnsentCursorComposerOnceForWorker(mixed, {
      ...depsFor({ [mixed.identity.id]: [POKE, 'не отправляй это', ...CURSOR_FOOTER] }, { submitted }),
    });
    expect(result.terminals[0]?.reason).toBe('composer_not_orchestration_pointer');
    expect(mixedResult.terminals[0]?.reason).toBe('composer_not_orchestration_pointer');
    expect(submitted).toHaveLength(0);
  });

  it('releases a persisted ambiguous pointer only after an exact idle identity', async () => {
    const target = worker('term_legacy_ambiguous');
    const submitted: RuntimeWorkerIdentity[] = [];
    const state = createUnsentComposerWatchState();
    state.submittedFingerprint.set(workerKey(target.identity), POKE);
    state.ambiguousSubmittedFingerprints.set(workerKey(target.identity), new Set([POKE]));
    const result = await submitUnsentCursorComposerOnceForWorker(target, {
      ...depsFor({ [target.identity.id]: [POKE, ...CURSOR_FOOTER] }, { submitted }),
    }, state);
    expect(result.terminals[0]?.reason).toBe('enter_sent');
    expect(submitted).toHaveLength(1);
  });
});

describe('acquireWatchLock', () => {
  it('fails closed when another live process holds the lock', () => {
    const lockPath = join(tmpdir(), `opk-unsent-lock-${process.pid}-${Date.now()}.lock`);
    acquireWatchLock(lockPath);
    try {
      expect(() => acquireWatchLock(lockPath)).toThrow(/already running/);
    } finally {
      releaseWatchLock();
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    }
  });
});
