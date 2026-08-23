// @vitest-ci-lane light
// @vitest-pre-topology-seconds 1
import { unlinkSync } from 'node:fs';
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
  QUIET_AFTER_PRINT_MS,
  releaseWatchLock,
  saveSubmittedFingerprints,
  submitUnsentCursorComposer,
  submitUnsentCursorComposerOnce,
  runSupervisorUnsentComposerTick,
  workerKey,
  type UnsentComposerSubmitDeps,
} from './cursor-unsent-composer-submit.ts';
import type { RuntimeWorker, RuntimeWorkerIdentity } from './runtime/contracts.ts';

const POKE = 'You have 1 orchestration message. Run `orca orchestration check --run run_d613a86c140a`.';
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

function worker(id: string, generation = 'g1'): RuntimeWorker {
  return {
    identity: { runtime: 'orca', id, generation },
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
    submit: extra.submitResult ?? extra.submit ?? ((identity) => {
      submitted.push(identity);
      return { status: 'dispatched' as const };
    }),
    now: extra.now,
    sleep: extra.sleep,
    sentStorePath: extra.sentStorePath,
  };
}

describe('classifyCursorComposer', () => {
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
  it('runs one bounded second observation for the supervisor child', async () => {
    vi.useFakeTimers();
    try {
      const submitted: RuntimeWorkerIdentity[] = [];
      const state = createUnsentComposerWatchState();
      const deps = depsFor(
        { term_unsent: [POKE, ...CURSOR_FOOTER] },
        { submitted },
      );
      const pass = runSupervisorUnsentComposerTick(deps, state);
      await vi.advanceTimersByTimeAsync(QUIET_AFTER_PRINT_MS);
      const result = await pass;
      expect(result.terminals[0]?.reason).toBe('enter_sent');
      expect(submitted).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sleeps only for the remaining persisted quiet window', async () => {
    vi.useFakeTimers();
    try {
      const submitted: RuntimeWorkerIdentity[] = [];
      const state = createUnsentComposerWatchState();
      const identity = worker('term_unsent').identity;
      state.lastFingerprint.set(workerKey(identity), POKE);
      state.lastChangedAt.set(workerKey(identity), Date.now() - 4_000);
      const deps = depsFor(
        { term_unsent: [POKE, ...CURSOR_FOOTER] },
        { submitted },
      );
      const pass = runSupervisorUnsentComposerTick(deps, state);
      await vi.advanceTimersByTimeAsync(999);
      expect(submitted).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await pass;
      expect(submitted).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('services staggered terminal deadlines independently in one supervisor pass', async () => {
    vi.useFakeTimers();
    try {
      const submitted: RuntimeWorkerIdentity[] = [];
      const first = worker('term_first');
      const second = worker('term_second');
      const state = createUnsentComposerWatchState();
      state.lastFingerprint.set(workerKey(first.identity), POKE);
      state.lastChangedAt.set(workerKey(first.identity), Date.now() - 4_000);
      let firstReads = 0;
      const deps: UnsentComposerSubmitDeps = {
        listWorkers: () => ({ ok: true, workers: [first, second] }),
        read: (identity) => {
          if (identity.id === first.identity.id) {
            firstReads += 1;
            return {
              ok: true as const,
              lines: firstReads === 1 ? [POKE, ...CURSOR_FOOTER] : ['→ changed payload', ...CURSOR_FOOTER],
              source: 'screen' as const,
            };
          }
          return { ok: true as const, lines: [POKE, ...CURSOR_FOOTER], source: 'screen' as const };
        },
        submit: (identity) => {
          submitted.push(identity);
          return { status: 'dispatched' as const };
        },
      };
      const pass = runSupervisorUnsentComposerTick(deps, state);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(submitted.map((identity) => identity.id)).toEqual(['term_second']);
      await vi.advanceTimersByTimeAsync(1_000);
      await pass;
      expect(submitted.map((identity) => identity.id)).toEqual(['term_second', 'term_first']);
    } finally {
      vi.useRealTimers();
    }
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
      dispatchInput: () => ({ status: 'dispatched' as const }),
    } as unknown as Parameters<typeof createAdapterSubmitDeps>[0];
    let now = 0;
    const deps = createAdapterSubmitDeps(adapter, () => ({ ok: true, result: {} }));
    const state = createUnsentComposerWatchState();
    const first = submitUnsentCursorComposer({ watch: true }, { ...deps, now: () => now }, state);
    now = QUIET_AFTER_PRINT_MS;
    const second = submitUnsentCursorComposer({ watch: true }, { ...deps, now: () => now }, state);
    expect(first.terminals[0]?.reason).toBe('waiting_stable');
    expect(second.terminals[0]?.reason).toBe('enter_sent');
    expect(reads.map(({ screen }) => screen)).toEqual([true, true]);
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

  it('never enters an idle transcript followed by the composer placeholder', () => {
    const submitted: RuntimeWorkerIdentity[] = [];
    let now = 0;
    const state = createUnsentComposerWatchState();
    const localDeps = depsFor(
      {
        term_idle: [
          'prior transcript line',
          '→ Add a follow-up',
          ...CURSOR_FOOTER,
        ],
      },
      { submitted, now: () => now },
    );
    const first = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    now = QUIET_AFTER_PRINT_MS;
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
      { submitted, now: () => now },
    );
    const first = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    now = QUIET_AFTER_PRINT_MS;
    const second = submitUnsentCursorComposer({ watch: true }, localDeps, state);

    expect(first.terminals.map((row) => row.reason)).toEqual(['waiting_stable', 'composer_empty']);
    expect(second.terminals.map((row) => row.reason)).toEqual(['enter_sent', 'composer_empty']);
    expect(submitted.map((row) => row.id)).toEqual(['term_cursor']);
  });

  it('waits before submitting ordinary typing', () => {
    const submitted: RuntimeWorkerIdentity[] = [];
    const result = submitUnsentCursorComposer(
      { terminals: ['term_typing'], watch: true },
      depsFor(
        { term_typing: ['→ разберись почему', ...CURSOR_FOOTER] },
        { submitted },
      ),
    );
    expect(submitted).toEqual([]);
    expect(result.terminals[0]?.reason).toBe('waiting_stable');
  });

  it('waits 5s after the poke stops changing and does not resend', () => {
    const submitted: RuntimeWorkerIdentity[] = [];
    const state = createUnsentComposerWatchState();
    let now = 0;
    const localDeps = depsFor(
      { term_unsent: [POKE, ...CURSOR_FOOTER] },
      { submitted, now: () => now },
    );
    const first = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    now = QUIET_AFTER_PRINT_MS - 1;
    const beforeQuiet = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    now = QUIET_AFTER_PRINT_MS;
    const second = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    const third = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    expect(first.terminals[0]?.reason).toBe('waiting_stable');
    expect(beforeQuiet.terminals[0]?.reason).toBe('waiting_stable');
    expect(second.terminals[0]?.reason).toBe('enter_sent');
    expect(third.terminals[0]?.reason).toBe('already_submitted');
    expect(submitted.map((row) => row.id)).toEqual(['term_unsent']);
  });

  it('does not retry Enter after an ambiguous dispatch outcome', () => {
    const submitted: RuntimeWorkerIdentity[] = [];
    const state = createUnsentComposerWatchState();
    let now = 0;
    const localDeps = depsFor(
      { term_unsent: [POKE, ...CURSOR_FOOTER] },
      {
        submitted,
        now: () => now,
        submitResult: (identity) => {
          submitted.push(identity);
          return { status: 'dispatch_unknown', reason: 'submit_witness_unavailable' };
        },
      },
    );
    submitUnsentCursorComposer({ watch: true }, localDeps, state);
    now = QUIET_AFTER_PRINT_MS;
    submitUnsentCursorComposer({ watch: true }, localDeps, state);
    const again = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    expect(submitted).toHaveLength(1);
    expect(again.terminals[0]?.reason).toBe('already_submitted');
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
    submitUnsentCursorComposer({ watch: true }, localDeps, state);
    now = QUIET_AFTER_PRINT_MS;
    const failed = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    const retry = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    expect(failed.terminals[0]?.reason).toBe('runtime_unavailable');
    expect(retry.terminals[0]?.reason).toBe('enter_sent');
    expect(submitted).toHaveLength(2);
  });

  it('does not submit on the first --once read; waits the quiet window then re-reads', () => {
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
    expect(reads).toBe(2);
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
    submitUnsentCursorComposer({ watch: true }, localDeps, state);
    now = QUIET_AFTER_PRINT_MS;
    const failed = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    const retry = submitUnsentCursorComposer({ watch: true }, localDeps, state);
    expect(failed.terminals[0]?.reason).toBe('runtime_response_invalid');
    expect(retry.terminals[0]?.reason).toBe('enter_sent');
    expect(submitted).toHaveLength(2);
  });

  it('keeps the 5s quiet window and no-resend watermark across fresh scheduler ticks', () => {
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
      now = QUIET_AFTER_PRINT_MS;
      const second = submitUnsentCursorComposer({ watch: true }, deps, createUnsentComposerWatchState());
      linesById.term_unsent = ['→ Add a follow-up'];
      const empty = submitUnsentCursorComposer({ watch: true }, deps, createUnsentComposerWatchState());
      linesById.term_unsent = [POKE, ...CURSOR_FOOTER];
      const repeated = submitUnsentCursorComposer({ watch: true }, deps, createUnsentComposerWatchState());
      expect(first.terminals[0]?.reason).toBe('waiting_stable');
      expect(second.terminals[0]?.reason).toBe('enter_sent');
      expect(empty.terminals[0]?.reason).toBe('composer_empty');
      expect(repeated.terminals[0]?.reason).toBe('waiting_stable');
      now += QUIET_AFTER_PRINT_MS;
      const rearmed = submitUnsentCursorComposer({ watch: true }, deps, createUnsentComposerWatchState());
      expect(rearmed.terminals[0]?.reason).toBe('enter_sent');
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
