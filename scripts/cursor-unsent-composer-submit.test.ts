// @vitest-ci-lane light
// @vitest-pre-topology-seconds 1
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acquireWatchLock,
  classifyCursorComposer,
  composerPokeFingerprint,
  createAdapterSubmitDeps,
  createOrcaMessageSubmitDeps,
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
  buildDeliveryPointer,
  ORCHESTRATION_NOTICE,
  runOrchestrationMailReconcileTick,
  runSupervisorUnsentComposerTick,
  workerKey,
  type UnsentComposerSubmitDeps,
} from './cursor-unsent-composer-submit.ts';
import type { OrcaJsonResponse } from './orca-runtime/native.ts';
import type { RuntimeAdapter, RuntimeComposerControlRequest, RuntimeWorker, RuntimeWorkerIdentity } from './runtime/contracts.ts';

const POKE = 'You have 1 orchestration message. Read orchestration mail, check the fleet, and clear blockers so the fleet does not idle. Run `orca orchestration check --run run_d613a86c140a`.';
const DISPATCH_POKE = 'You have 1 orchestration message. Read and act on your orchestration message. Run `orca orchestration check`.';
const TERMINAL_HANDLE = 'term_cc95818d-ce98-465a-a806-f1a73d7d33bf';
const TERMINAL_POKE = `You have 1 orchestration message. Read and act on your orchestration message. Run \`orca orchestration check --terminal ${TERMINAL_HANDLE}\`.`;
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

function worker(
  id: string,
  generation = 'g1',
  runtime: 'orca' | 'codex' = 'orca',
  stableKey?: string,
): RuntimeWorker {
  return {
    identity: { runtime, id, generation },
    workspacePath: '/tmp',
    title: id,
    provenance: 'external',
    ...(stableKey ? { stableKey } : {}),
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
    composerControl: extra.composerControl,
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

  it('accepts a pointer when the wrapped count is reconstructed', async () => {
    const target = worker('term_wrapped_count');
    const submitted: RuntimeWorkerIdentity[] = [];
    let livenessCalls = 0;
    const result = await submitUnsentCursorComposerOnceForWorker(target, {
      ...depsFor({}, {
        submitted,
        liveness: () => livenessCalls++ === 0 ? 'idle' : 'busy',
        read: () => ({
          ok: true as const,
          lines: [
            'You have',
            '3 orchestration messages. Run `orca orchestration check --run run_wrapped_count`.',
            ...CURSOR_FOOTER,
          ],
          source: 'screen' as const,
        }),
      }),
    });
    expect(result.terminals[0]).toMatchObject({ reason: 'enter_sent', enter: true });
    expect(submitted).toEqual([target.identity]);
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
      liveness: (() => {
        let calls = 0;
        return (input: { worker: RuntimeWorkerIdentity; observationWindowMs: number }) => ({
          status: calls++ === 0 ? 'idle' as const : 'busy' as const,
          worker: input.worker,
        });
      })(),
      dispatchInput: () => ({ status: 'dispatched' as const }),
    } as unknown as Parameters<typeof createAdapterSubmitDeps>[0];
    const deps = { ...createAdapterSubmitDeps(adapter, () => ({ ok: true, result: {} })), sentStorePath: undefined };
    const result = submitUnsentCursorComposer({ watch: true }, deps);
    expect(result.terminals[0]?.reason).toBe('enter_sent');
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

  it('rejects repeated exact pointer lines as a concatenated Cursor composer', () => {
    const submitted: RuntimeWorkerIdentity[] = [];
    const result = submitUnsentCursorComposer(
      { watch: true },
      depsFor(
        { term_repeated: [POKE, POKE, POKE, ...CURSOR_FOOTER] },
        { submitted },
      ),
    );
    expect(result.terminals[0]?.reason).toBe('composer_not_orchestration_pointer');
    expect(submitted).toEqual([]);
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
      expect(persisted.submitted).toContainEqual(expect.objectContaining({ fingerprint: 'orca orchestration check --run run_d613a86c140a', ambiguous: true }));
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

describe('buildDeliveryPointer', () => {
  it('emits the bare check pointer for dispatch recipients', () => {
    expect(buildDeliveryPointer({
      id: 'msg_dispatch',
      runId: 'run_d613a86c140a',
      recipient: 'dispatch:ctx_delivery',
      consumed: false,
    })).toBe(DISPATCH_POKE);
  });

  it('emits a run-qualified pointer for run recipients', () => {
    expect(buildDeliveryPointer({
      id: 'msg_run',
      runId: 'run_d613a86c140a',
      recipient: 'run:run_d613a86c140a',
      consumed: false,
    })).toBe(POKE);
  });

  it('emits a neutral terminal-qualified pointer for unproven role recipients', () => {
    expect(buildDeliveryPointer({
      id: 'msg_terminal',
      runId: 'run_d613a86c140a',
      recipient: TERMINAL_HANDLE,
      consumed: false,
    })).toBe(TERMINAL_POKE);
  });

  it('emits neutral wording for recipients without a known prefix', () => {
    expect(buildDeliveryPointer({
      id: 'msg_fallback',
      runId: 'run_d613a86c140a',
      recipient: 'recipient_without_role',
      consumed: false,
    })).toBe('You have 1 orchestration message. Read and act on your orchestration message. Run `orca orchestration check --run run_d613a86c140a`.');
  });

  it.each([
    ['dispatch', DISPATCH_POKE],
    ['run', POKE],
    ['terminal', TERMINAL_POKE],
  ])('recognizes the %s pointer as an exact orchestration notice', (_label, pointer) => {
    expect(cursorComposerLooksUnsent(`${pointer}\n${CURSOR_FOOTER.join('\n')}`)).toBe(true);
  });

  it.each([
    ['run', buildDeliveryPointer({ id: 'msg_run_notice', runId: 'run_notice', recipient: 'run:run_notice', consumed: false })],
    ['terminal', buildDeliveryPointer({ id: 'msg_terminal_notice', runId: 'run_notice', recipient: TERMINAL_HANDLE, consumed: false })],
  ])('matches builder prose for %s recipients and the bare form', (_label, pointer) => {
    expect(ORCHESTRATION_NOTICE.test(pointer)).toBe(true);
    expect(ORCHESTRATION_NOTICE.test(pointer.replace(/\. Read[^.]+\./u, '.'))).toBe(true);
  });

  it('filters stacked builder prose notices from the composer fingerprint', () => {
    const runPointer = buildDeliveryPointer({ id: 'msg_run_stack', runId: 'run_stack', recipient: 'run:run_stack', consumed: false });
    const terminalPointer = buildDeliveryPointer({ id: 'msg_terminal_stack', runId: 'run_stack', recipient: TERMINAL_HANDLE, consumed: false });
    expect(composerPokeFingerprint(`human draft\n${runPointer}\n${terminalPointer}\n${CURSOR_FOOTER.join('\n')}`)).toBe('human draft');
  });
});

describe('delivery-triggered composer submission', () => {
  it.each([
    ['busy', 'busy', 'enter_sent'],
    ['unknown', 'unknown', 'enter_sent'],
  ] as const)('writes and presses Enter when delivery liveness is %s', async (_label, status, expectedReason) => {
    const target = worker(`term_delivery_${status}`);
    const message = {
      id: `msg_delivery_${status}`,
      runId: `run_delivery_${status}`,
      recipient: target.identity.id,
      consumed: false,
    };
    let pointerVisible = true;
    let writes = 0;
    const submitted: RuntimeWorkerIdentity[] = [];
    const result = await submitOrcaMessageDeliveryPointer(message.id, {
      lookupMessage: () => ({ ok: true as const, message }),
      resolveWorker: () => ({ ok: true as const, worker: target }),
      writePointer: () => {
        writes += 1;
        pointerVisible = true;
        return { status: 'dispatched' as const };
      },
      submitDeps: depsFor({}, {
        submitted,
        liveness: () => status,
        submitResult: (identity) => {
          submitted.push(identity);
          pointerVisible = false;
          return { status: 'dispatched' as const };
        },
        read: () => ({
          ok: true as const,
          lines: pointerVisible ? [buildDeliveryPointer(message), ...CURSOR_FOOTER] : ['→ Add a follow-up', ...CURSOR_FOOTER],
          source: 'screen' as const,
        }),
      }),
      episodeState: { messages: {}, episodes: {} },
    });

    expect(writes).toBe(0);
    expect(submitted).toEqual([target.identity]);
    expect(result.terminals[0]).toMatchObject({ reason: expectedReason, enter: expectedReason === 'enter_sent' });
  });

  it('does not write or press Enter when the delivery worker is gone', async () => {
    const target = worker('term_delivery_gone');
    const message = {
      id: 'msg_delivery_gone',
      runId: 'run_delivery_gone',
      recipient: target.identity.id,
      consumed: false,
    };
    let writes = 0;
    const submitted: RuntimeWorkerIdentity[] = [];
    const result = await submitOrcaMessageDeliveryPointer(message.id, {
      lookupMessage: () => ({ ok: true as const, message }),
      resolveWorker: () => ({ ok: true as const, worker: target }),
      writePointer: () => {
        writes += 1;
        return { status: 'dispatched' as const };
      },
      submitDeps: depsFor({}, { submitted, liveness: () => 'gone', read: () => ({ ok: true as const, lines: [buildDeliveryPointer(message), ...CURSOR_FOOTER], source: 'screen' as const }) }),
      episodeState: { messages: {}, episodes: {} },
    });

    expect(writes).toBe(0);
    expect(submitted).toHaveLength(0);
    expect(result.terminals[0]).toMatchObject({ reason: 'worker_gone', enter: false });
  });

  it('delivers through the visible OpenCode panel and proves the render', async () => {
    const target = worker('term_opencode_http');
    const actions: string[] = [];
    const requests: RuntimeComposerControlRequest[] = [];
    const humanComposerText = 'human-authored composer draft';
    let reads = 0;
    const deps = {
      lookupMessage: () => ({
        ok: true as const,
        message: { id: 'msg_opencode_http', runId: 'run_opencode_http', recipient: 'term_opencode_http', consumed: false },
      }),
      resolveWorker: () => ({ ok: true as const, worker: target }),
      writePointer: () => { throw new Error('screen pointer write must not run'); },
      submitDeps: depsFor({}, {
        read: () => {
          reads += 1;
          return { ok: true as const, lines: reads === 1 ? ['idle splash'] : ['rendered pointer'] };
        },
        composerControl: () => ({
          kind: 'opencode-http' as const,
          dispatch: (request) => {
            actions.push(request.action);
            requests.push(request);
            return { status: 'dispatched' as const };
          },
        }),
      }),
    };
    const result = await submitOrcaMessageDeliveryPointer('msg_opencode_http', deps);
    expect(actions).toEqual(['submit-prompt']);
    expect(requests[0]).toMatchObject({
      action: 'submit-prompt',
      text: expect.stringContaining('orca orchestration check'),
    });
    expect(requests[0]?.text).not.toContain(humanComposerText);
    expect(reads).toBe(2);
    expect(result.terminals[0]).toMatchObject({ reason: 'enter_sent', enter: true });
  });

  it('does not confirm OpenCode transport without observed busy liveness', async () => {
    const target = worker('term_opencode_unconfirmed');
    const episodeState = { messages: {}, episodes: {} };
    let reads = 0;
    let now = 1_000;
    const actions: string[] = [];
    const deps = {
      lookupMessage: () => ({
        ok: true as const,
        message: { id: 'msg_opencode_unconfirmed', runId: 'run_opencode_unconfirmed', recipient: target.identity.id, consumed: false },
      }),
      resolveWorker: () => ({ ok: true as const, worker: target }),
      writePointer: () => { throw new Error('screen pointer write must not run'); },
      submitDeps: depsFor({}, {
        liveness: () => 'idle' as const,
        read: () => { reads += 1; return { ok: true as const, lines: [] }; },
        composerControl: () => ({
          kind: 'opencode-http' as const,
          dispatch: () => { actions.push('submit-prompt'); return { status: 'dispatched' as const }; },
        }),
      }),
      episodeState,
      reconcileClock: () => now,
    };
    const result = await submitOrcaMessageDeliveryPointer('msg_opencode_unconfirmed', deps);
    const episode = Object.values(episodeState.episodes).find((row) => (row as { readonly messageId?: string }).messageId === 'msg_opencode_unconfirmed') as { readonly state?: string } | undefined;
    expect(result.terminals[0]).toMatchObject({ reason: 'submission_unconfirmed', enter: false, ok: false });
    expect(reads).toBe(2);
    expect(actions).toHaveLength(1);
    expect(episode?.state).toBe('pointer-visible');
    now = 61_001;
    const retry = await submitOrcaMessageDeliveryPointer('msg_opencode_unconfirmed', deps);
    expect(retry.terminals[0]?.reason).toBe('submission_unconfirmed');
    expect(actions).toHaveLength(1);
  });

  it('seals OpenCode delivery episode and does not replay an unread message', async () => {
    const target = worker('term_opencode_episode');
    const actions: string[] = [];
    const episodeState = { messages: {}, episodes: {} };
    const pointerWriteLedger = new Map<string, number>();
    const deps = {
      lookupMessage: () => ({
        ok: true as const,
        message: { id: 'msg_opencode_episode', runId: 'run_opencode_episode', recipient: target.identity.id, consumed: false },
      }),
      resolveWorker: () => ({ ok: true as const, worker: target }),
      writePointer: () => { throw new Error('screen pointer write must not run'); },
      submitDeps: depsFor({}, {
        read: (() => {
          let reads = 0;
          return () => ({
            ok: true as const,
            lines: reads++ === 0 ? ['idle splash'] : ['rendered pointer'],
          });
        })(),
        composerControl: () => ({
          kind: 'opencode-http' as const,
          dispatch: (request) => {
            actions.push(request.action);
            return { status: 'dispatched' as const };
          },
        }),
      }),
      episodeState,
      pointerWriteLedger,
    };
    const first = await submitOrcaMessageDeliveryPointer('msg_opencode_episode', deps);
    const second = await submitOrcaMessageDeliveryPointer('msg_opencode_episode', deps);
    expect(actions).toEqual(['submit-prompt']);
    expect(first.terminals[0]).toMatchObject({ reason: 'enter_sent', enter: true });
    expect(second.terminals[0]?.reason).toBe('orchestration_episode_already_claimed');
  });

  it('submits an exact pointer soft-wrapped by a narrow Cursor composer', async () => {
    const target = worker('term_wrapped_pointer');
    const submitted: RuntimeWorkerIdentity[] = [];
    const result = await submitUnsentCursorComposerOnceForWorker(target, depsFor({}, {
      submitted,
      liveness: (() => { let calls = 0; return () => calls++ === 0 ? 'idle' : 'busy'; })(),
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
    expect(submitted).toEqual([target.identity]);
  });

  it('keeps a reflowed pointer unconfirmed when its command remains visible', async () => {
    const target = worker('term_reflow_pointer');
    const submitted: RuntimeWorkerIdentity[] = [];
    let reads = 0;
    const result = await submitUnsentCursorComposerOnceForWorker(target, depsFor({}, {
      submitted,
      liveness: (() => { let calls = 0; return () => calls++ === 0 ? 'idle' : 'busy'; })(),
      read: () => ({
        ok: true as const,
        lines: reads++ === 0
          ? ['▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄', '→ You have 1 orchestration message. Read and act on your orchestration message. Run `orca orchestration check --run run_re', 'flow`.', '▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀', ...CURSOR_FOOTER]
          : ['▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄', '→ You have 1 orchestration message. Read and act on your orchestration', 'message. Run `orca orchestration check --run run_reflow`.', '▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀', ...CURSOR_FOOTER],
        source: 'screen' as const,
      }),
    }), undefined, true, true);
    expect(result.terminals[0]).toMatchObject({ reason: 'submission_unconfirmed', enter: false, ok: false });
    expect(submitted).toEqual([target.identity]);
  });
  it('keeps a wording and count change unconfirmed when the command remains visible', async () => {
    const target = worker('term_wording_pointer');
    const submitted: RuntimeWorkerIdentity[] = [];
    let reads = 0;
    const result = await submitUnsentCursorComposerOnceForWorker(target, depsFor({}, {
      submitted,
      liveness: (() => { let calls = 0; return () => calls++ === 0 ? 'idle' : 'busy'; })(),
      read: () => ({
        ok: true as const,
        lines: reads++ === 0
          ? ['▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄', '→ You have 1 orchestration message. Read and act on your orchestration message. Run `orca orchestration check --run run_wording`.', '▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀', ...CURSOR_FOOTER]
          : ['▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄', '→ You have 3 orchestration messages. Read orchestration mail and clear blockers. Run `orca orchestration check --run run_wording`.', '▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀', ...CURSOR_FOOTER],
        source: 'screen' as const,
      }),
    }), undefined, true, true);
    expect(result.terminals[0]).toMatchObject({ reason: 'submission_unconfirmed', enter: false, ok: false });
    expect(submitted).toEqual([target.identity]);
  });

  it('writes one unread Orca pointer and submits Enter', async () => {
    const target = worker('term_message_delivery');
    const submitted: RuntimeWorkerIdentity[] = [];
    let reads = 0;
    let writes = 0;
    let consumed = false;
    let rendered = true;
    let releaseRender: (() => void) | undefined;
    const renderReady = new Promise<void>((resolve) => {
      releaseRender = () => {
        rendered = true;
        resolve();
      };
    });
    const submitDeps = depsFor({}, {
      submitted,
      liveness: (() => { let calls = 0; return () => calls++ < 2 ? 'idle' : 'busy'; })(),
      submitResult: (identity) => {
        submitted.push(identity);
        rendered = false;
        return { status: 'dispatched' as const };
      },
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
    expect(reads).toBe(3);
    expect(writes).toBe(0);
    expect(submitted).toHaveLength(1);
    releaseRender?.();
    const result = await pending;

    expect(result.terminals[0]).toMatchObject({ reason: 'enter_sent', enter: true });
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(submitted.length).toBeGreaterThanOrEqual(1);

    consumed = true;
    const duplicate = await submitOrcaMessageDeliveryPointer('msg_delivery', deps);
    expect(duplicate.terminals[0]?.reason).toBe('delivery_already_consumed');
    expect(writes).toBe(0);
    expect(submitted.length).toBeGreaterThanOrEqual(1);
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
        liveness: (() => { let calls = 0; return () => calls++ < 2 ? 'idle' : 'busy'; })(),
        read: () => ({
          ok: true as const,
          lines: submitted.length === 0 ? [POKE, ...CURSOR_FOOTER] : ['→ Add a follow-up', ...CURSOR_FOOTER],
          source: 'screen' as const,
        }),
      }),
    });

    expect(written).toBe('');
    expect(result.terminals[0]).toMatchObject({ reason: 'enter_sent', enter: true });
    expect(submitted).toEqual([target.identity]);
  });

  it('writes a terminal-qualified pointer for a terminal-handle recipient', async () => {
    const target = worker(TERMINAL_HANDLE);
    const submitted: RuntimeWorkerIdentity[] = [];
    let written = '';
    let reads = 0;
    const result = await submitOrcaMessageDeliveryPointer('msg_terminal', {
      lookupMessage: () => ({
        ok: true as const,
        message: {
          id: 'msg_terminal',
          runId: 'run_d613a86c140a',
          recipient: TERMINAL_HANDLE,
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
        liveness: (() => { let calls = 0; return () => calls++ < 2 ? 'idle' : 'busy'; })(),
        read: () => ({
          ok: true as const,
          lines: submitted.length === 0 ? [TERMINAL_POKE, ...CURSOR_FOOTER] : ['→ Add a follow-up', ...CURSOR_FOOTER],
          source: 'screen' as const,
        }),
      }),
    });

    expect(written).toBe('');
    expect(result.terminals[0]).toMatchObject({ reason: 'enter_sent', enter: true });
    expect(submitted).toEqual([target.identity]);
  });

  it('accepts an explicit write witness reported with dispatch_unknown', async () => {
    const target = worker('term_write_witness');
    const submitted: RuntimeWorkerIdentity[] = [];
    let reads = 0;
    let wrote = false;
    const result = await submitOrcaMessageDeliveryPointer('msg_write_witness', {
      lookupMessage: () => ({
        ok: true as const,
        message: { id: 'msg_write_witness', runId: 'run_d613a86c140a', recipient: 'run:run_d613a86c140a', consumed: false },
      }),
      resolveWorker: () => ({ ok: true as const, worker: target }),
      writePointer: () => {
        wrote = true;
        return {
          status: 'dispatch_unknown' as const,
          reason: 'submit_witness_unavailable',
          witness: { operation: 'write' as const, accepted: true as const, source: 'runtime-response' as const },
        };
      },
      submitDeps: depsFor({}, {
        submitted,
        liveness: (() => { let calls = 0; return () => calls++ < 2 ? 'idle' : 'busy'; })(),
        read: () => ({
          ok: true as const,
          lines: submitted.length === 0 ? [POKE, ...CURSOR_FOOTER] : ['→ Add a follow-up', ...CURSOR_FOOTER],
          source: 'screen' as const,
        }),
      }),
    });

    expect(result.terminals[0]).toMatchObject({ reason: 'enter_sent', enter: true });
    expect(submitted).toEqual([target.identity]);
  });

  it('submits Enter for an already queued exact pointer for unread mail', async () => {
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
      submitDeps: depsFor({ [target.identity.id]: [POKE, ...CURSOR_FOOTER] }, {
        submitted,
        liveness: (() => { let calls = 0; return () => calls++ === 0 ? 'idle' : 'busy'; })(),
        read: () => ({
          ok: true as const,
          lines: submitted.length === 0 ? [POKE, ...CURSOR_FOOTER] : ['→ Add a follow-up', ...CURSOR_FOOTER],
          source: 'screen' as const,
        }),
      }),
    });
    expect(result.terminals[0]).toMatchObject({ reason: 'enter_sent', enter: true });
    expect(writes).toBe(0);
    expect(submitted).toEqual([target.identity]);
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

    expect(result.terminals[0]?.reason).toBe('composer_not_orchestration_pointer');
    expect(writes).toBe(0);
  });
  it('rejects concatenated Orca notices without writing or pressing Enter', async () => {
    const target = worker('term_concatenated_pointer');
    const submitted: RuntimeWorkerIdentity[] = [];
    let writes = 0;
    const message = {
      id: 'msg_concatenated_pointer',
      runId: 'run_concatenated_pointer',
      recipient: target.identity.id,
      consumed: false,
    };
    const notice = [buildDeliveryPointer(message), buildDeliveryPointer(message)];
    const result = await submitOrcaMessageDeliveryPointer(message.id, {
      lookupMessage: () => ({ ok: true as const, message }),
      resolveWorker: () => ({ ok: true as const, worker: target }),
      writePointer: () => { writes += 1; return { status: 'dispatched' as const }; },
      submitDeps: depsFor({}, {
        submitted,
        read: () => ({ ok: true as const, lines: [...notice, ...CURSOR_FOOTER], source: 'screen' as const }),
      }),
    });
    expect(result.terminals[0]).toMatchObject({ reason: 'composer_not_orchestration_pointer', enter: false });
    expect(writes).toBe(0);
    expect(submitted).toHaveLength(0);
  });

  it.each([
    ['run', 'run_current', 'run_other'],
    ['terminal', TERMINAL_HANDLE, 'term_other'],
  ] as const)('does not Enter for a pointer bound to another %s', async (kind, recipient, wrongTarget) => {
    const target = worker(kind === 'terminal' ? TERMINAL_HANDLE : 'term_binding_run');
    const submitted: RuntimeWorkerIdentity[] = [];
    const message = {
      id: `msg_binding_${kind}`,
      runId: 'run_current',
      recipient: kind === 'run' ? `run:${recipient}` : recipient,
      consumed: false,
    };
    const result = await submitOrcaMessageDeliveryPointer(message.id, {
      lookupMessage: () => ({ ok: true as const, message }),
      resolveWorker: () => ({ ok: true as const, worker: target }),
      submitDeps: depsFor({}, {
        submitted,
        liveness: () => 'idle',
        read: () => ({
          ok: true as const,
          lines: [`You have 1 orchestration message. Run \`orca orchestration check --${kind} ${wrongTarget}\`.`, ...CURSOR_FOOTER],
          source: 'screen' as const,
        }),
      }),
    });
    expect(result.terminals[0]).toMatchObject({
      reason: 'orchestration_pointer_target_mismatch',
      enter: false,
    });
    expect(submitted).toEqual([]);
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
    expect(first.terminals[0]).toMatchObject({ reason: 'worker_busy', enter: false });
    expect(reads).toBe(2);
    expect(submitted).toEqual([]);

    const duplicate = await submitUnsentCursorComposerDeliveryForTerminal(target.identity.id, resolver, deps);
    expect(duplicate.terminals[0]?.reason).toBe('worker_busy');
    expect(submitted).toHaveLength(0);
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
    expect(idle.terminals[0]).toMatchObject({ reason: 'worker_busy', enter: false });
    expect(reads).toBe(1);
    expect(submitted).toHaveLength(0);

    const duplicate = await submitUnsentCursorComposerOnceForWorker(target, deps, state);
    expect(duplicate.terminals[0]?.reason).toBe('worker_busy');
    expect(reads).toBe(2);
    expect(submitted).toHaveLength(0);
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

    expect(result.terminals[0]).toMatchObject({ reason: 'worker_busy', enter: false });
    expect(reads).toBe(2);
    expect(submitted).toEqual([]);
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

    expect(result.terminals[0]).toMatchObject({ reason: 'worker_busy', enter: false });
    expect(reads).toBe(1);
    expect(submitted).toEqual([]);
  });

  it('uses the immediate idle path for exactly one screen read and Enter', async () => {
    const target = worker('term_idle_immediate');
    const submitted: RuntimeWorkerIdentity[] = [];
    let reads = 0;
    const result = await submitUnsentCursorComposerOnceForWorker(target, depsFor(
      { [target.identity.id]: [POKE, ...CURSOR_FOOTER] },
      {
        submitted,
        liveness: (() => { let calls = 0; return () => calls++ === 0 ? 'idle' : 'busy'; })(),
        read: () => {
          reads += 1;
          return { ok: true as const, lines: [POKE, ...CURSOR_FOOTER], source: 'screen' as const };
        },
      },
    ));
    expect(result.terminals[0]?.reason).toBe('enter_sent');
    expect(reads).toBe(2);
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


  it('suppresses duplicate notification delivery for the same recipient and pointer text in one tick', async () => {
    const target = worker('term_dup_write');
    const submitted: RuntimeWorkerIdentity[] = [];
    let writes = 0;
    let wrote = false;
    const ledger = new Map<string, number>();
    const baseDeps = {
      pointerWriteLedger: ledger,
      reconcileClock: () => 1000,
      resolveWorker: () => ({ ok: true as const, worker: target }),
      writePointer: () => {
        wrote = true;
        writes += 1;
        return { status: 'dispatched' as const };
      },
      submitDeps: depsFor({}, {
        submitted,
        liveness: (() => { let calls = 0; return () => calls++ < 2 ? 'idle' : 'busy'; })(),
        read: () => ({
          ok: true as const,
          lines: submitted.length === 0 ? ['You have 1 orchestration message. Read and act on your orchestration message. Run `orca orchestration check --run run_dup`.', ...CURSOR_FOOTER] : ['→ Add a follow-up', ...CURSOR_FOOTER],
          source: 'screen' as const,
        }),
      }),
    };
    await submitOrcaMessageDeliveryPointer('msg_dup_a', {
      ...baseDeps,
      lookupMessage: () => ({
        ok: true as const,
        message: {
          id: 'msg_dup_a',
          runId: 'run_dup',
          recipient: 'run:run_dup',
          consumed: false,
        },
      }),
    });
    await submitOrcaMessageDeliveryPointer('msg_dup_b', {
      ...baseDeps,
      lookupMessage: () => ({
        ok: true as const,
        message: {
          id: 'msg_dup_b',
          runId: 'run_dup',
          recipient: 'run:run_dup',
          consumed: false,
        },
      }),
    });
    expect(writes).toBe(0);
    expect(submitted).toHaveLength(1);
  });

  it('sends only one Enter when busy liveness clears after the first keystroke', async () => {
    const target = worker('term_busy_to_idle');
    const submitted: RuntimeWorkerIdentity[] = [];
    let livenessReads = 0;
    let reads = 0;
    const result = await submitUnsentCursorComposerOnceForWorker(target, depsFor(
      { [target.identity.id]: [POKE, ...CURSOR_FOOTER] },
      {
        submitted,
        liveness: () => {
          livenessReads += 1;
          return livenessReads === 1 ? 'busy' : 'idle';
        },
        read: () => {
          reads += 1;
          return { ok: true as const, lines: [POKE, ...CURSOR_FOOTER], source: 'screen' as const };
        },
      },
    ));
    expect(result.terminals[0]).toMatchObject({ reason: 'worker_busy', enter: false });
    expect(submitted).toEqual([]);
    expect(reads).toBe(1);
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

describe('orchestration mail reconciliation', () => {
  function reconciliationDeps(
    rows: Array<{ id: string; run_id: string; to_handle: string; read: number }>,
    target: RuntimeWorker,
    options: {
      readonly retrievable?: boolean;
      readonly submitted?: RuntimeWorkerIdentity[];
    } = {},
  ) {
    let writes = 0;
    let wrote = false;
    const submitted = options.submitted ?? [];
    const targetId = target.identity.id;
    const targetRunId = rows.find((row) => row.to_handle === targetId)?.run_id ?? '';
    const pointerCount = rows.filter((row) => row.to_handle === targetId && row.run_id === targetRunId).length;
    const pointer = `You have ${pointerCount} orchestration message${pointerCount === 1 ? '' : 's'}. Run \`orca orchestration check --terminal ${targetId}\`.`;
    return {
      readInbox: () => ({ ok: true as const, result: { messages: rows } }),
      lookupMessage: () => ({ ok: false as const, reason: 'unused' }),
      resolveWorker: (message: { readonly recipient: string }) => message.recipient === targetId
        ? { ok: true as const, worker: target }
        : { ok: true as const, worker: null },
      isMessageRetrievable: () => options.retrievable === false
        ? { ok: false as const, reason: 'orchestration_message_unretrievable' }
        : { ok: true as const },
      writePointer: () => {
        writes += 1;
        wrote = true;
        return { status: 'dispatched' as const };
      },
      submitDeps: depsFor({}, {
        submitted,
        read: () => ({
          ok: true as const,
          lines: submitted.length === 0 ? [pointer, ...CURSOR_FOOTER] : ['→ Add a follow-up', ...CURSOR_FOOTER],
          source: 'screen' as const,
        }),
      }),
      get writes() {
        return writes;
      },
      pointer,
    };
  }

  it('does not emit a pointer for unread mail absent from terminal check --peek', async () => {
    const target = worker('term_unretrievable');
    const deps = reconciliationDeps([{
      id: 'msg_revoked',
      run_id: 'run_revoked',
      to_handle: target.identity.id,
      read: 0,
    }], target, { retrievable: false });
    const suffix = `${process.pid}-${Date.now()}`;

    const result = await runOrchestrationMailReconcileTick(deps, {
      ledgerPath: join(tmpdir(), `opk-reconcile-revoked-${suffix}.json`),
      lockPath: join(tmpdir(), `opk-reconcile-revoked-${suffix}.lock`),
      now: () => 1_000,
    });

    expect(deps.writes).toBe(0);
    expect(result.attempted).toBe(1);
    expect(result.reasons).toContain('msg_revoked:orchestration_message_unretrievable');
  });

  it('delivers unread Run mail after exact Run retrievability succeeds', async () => {
    const target = worker('term_run_mail_unread');
    const submitted: RuntimeWorkerIdentity[] = [];
    let retrievabilityChecks = 0;
    const message = {
      id: 'msg_run_mail_unread',
      runId: 'run_run_mail_unread',
      recipient: 'run:run_run_mail_unread',
      consumed: false,
    };
    const deps = {
      readInbox: () => ({
        ok: true as const,
        result: { messages: [{ id: message.id, run_id: message.runId, to_handle: message.recipient, read: 0 }] },
      }),
      lookupMessage: () => ({ ok: true as const, message }),
      resolveWorker: () => ({ ok: true as const, worker: target }),
      isMessageRetrievable: () => { retrievabilityChecks += 1; return { ok: true as const }; },
      submitDeps: depsFor({}, {
        submitted,
        read: () => ({ ok: true as const, lines: submitted.length === 0 ? [buildDeliveryPointer(message), ...CURSOR_FOOTER] : ['→ Add a follow-up', ...CURSOR_FOOTER], source: 'screen' as const }),
      }),
    };
    const suffix = `${process.pid}-${Date.now()}`;
    const result = await runOrchestrationMailReconcileTick(deps, {
      ledgerPath: join(tmpdir(), `opk-reconcile-run-unread-${suffix}.json`),
      lockPath: join(tmpdir(), `opk-reconcile-run-unread-${suffix}.lock`),
      now: () => 1_000,
    });

    expect(result.nudged).toBe(1);
    expect(result.deliveryEvidence).toEqual([{
      workerGeneration: target.identity.generation,
      runId: message.runId,
      messageId: message.id,
      delivery: 'delivered-looking',
      terminalReceipt: 'unproven',
    }]);
    expect(submitted).toHaveLength(1);
    expect(retrievabilityChecks).toBe(1);
  });

  it('falls back to exact terminal peek when a Run consumer is fenced', () => {
    const target = worker('term_fenced_run');
    const message = {
      id: 'msg_fenced_run',
      runId: 'run_fenced_run',
      recipient: 'run:run_fenced_run',
      consumed: false,
    };
    const calls: string[][] = [];
    const runJson = <T>(args: readonly string[]): OrcaJsonResponse<T> => {
      calls.push([...args]);
      if (args[1] === 'run-show') {
        return { ok: true, result: { run: { id: message.runId, coordinator_pane_key: 'pane-fenced' } } as T };
      }
      if (args[1] === 'check' && args.includes('--run')) {
        return { ok: false, error: { code: 'consumer_fenced' } };
      }
      if (args[1] === 'check' && args.includes('--terminal')) {
        return { ok: true, result: { messages: [{ id: message.id }] } as T };
      }
      return { ok: true, result: {} as T };
    };
    const adapter = {
      findWorkerByPaneKey: () => ({ status: 'ok' as const, value: target }),
    } as unknown as RuntimeAdapter;
    const deps = createOrcaMessageSubmitDeps(adapter, undefined, runJson);
    const resolved = deps.resolveWorker(message);
    expect(resolved).toMatchObject({ ok: true, worker: target });
    expect(deps.isMessageRetrievable?.(message, target)).toEqual({ ok: true });
    expect(calls).toEqual([
      ['orchestration', 'run-show', '--id', message.runId],
      ['orchestration', 'check', '--run', message.runId, '--peek'],
      ['orchestration', 'check', '--terminal', target.identity.id, '--peek'],
    ]);
  });

  it('falls back to the bound terminal when a successful Run peek omits the message', () => {
    const target = worker('term_run_empty_peek');
    const message = {
      id: 'msg_run_empty_peek',
      runId: 'run_empty_peek',
      recipient: 'run:run_empty_peek',
      consumed: false,
    };
    const calls: string[][] = [];
    const runJson = <T>(args: readonly string[]): OrcaJsonResponse<T> => {
      calls.push([...args]);
      if (args[1] === 'run-show') {
        return { ok: true, result: { run: { id: message.runId, coordinator_pane_key: 'pane-empty-peek' } } as T };
      }
      if (args[1] === 'check' && args.includes('--run')) {
        return { ok: true, result: { messages: [] } as T };
      }
      if (args[1] === 'check' && args.includes('--terminal')) {
        return { ok: true, result: { messages: [{ id: message.id }] } as T };
      }
      return { ok: true, result: {} as T };
    };
    const adapter = {
      findWorkerByPaneKey: () => ({ status: 'ok' as const, value: target }),
    } as unknown as RuntimeAdapter;
    const deps = createOrcaMessageSubmitDeps(adapter, undefined, runJson);
    expect(deps.isMessageRetrievable?.(message, target)).toEqual({ ok: true });
    expect(calls).toEqual([
      ['orchestration', 'check', '--run', message.runId, '--peek'],
      ['orchestration', 'check', '--terminal', target.identity.id, '--peek'],
    ]);
  });

  it('prioritizes unseen mail within a bounded recipient-group poll', async () => {
    const target = worker('term_bounded_new_mail');
    const submitted: RuntimeWorkerIdentity[] = [];
    const backlog = { id: 'msg_backlog', runId: 'run_new', recipient: 'run:run_new', consumed: false };
    const message = { id: 'msg_new', runId: 'run_new', recipient: 'run:run_new', consumed: false };
    const rows = [
      { id: backlog.id, run_id: backlog.runId, to_handle: backlog.recipient, read: 0 },
      { id: message.id, run_id: message.runId, to_handle: message.recipient, read: 0 },
    ];
    const resolvedRecipients: string[] = [];
    const deps = {
      readInbox: () => ({ ok: true as const, result: { messages: rows } }),
      lookupMessage: (id: string) => ({ ok: true as const, message: id === message.id ? message : backlog }),
      resolveWorker: (candidate: { readonly recipient: string }) => {
        resolvedRecipients.push(candidate.recipient);
        return { ok: true as const, worker: target };
      },
      isMessageRetrievable: () => ({ ok: true as const }),
      submitDeps: depsFor({ [target.identity.id]: [buildDeliveryPointer(message), ...CURSOR_FOOTER] }, {
        submitted,
        read: () => ({ ok: true as const, lines: submitted.length === 0 ? [buildDeliveryPointer(message), ...CURSOR_FOOTER] : ['→ Add a follow-up', ...CURSOR_FOOTER], source: 'screen' as const }),
      }),
    };
    const root = mkdtempSync(join(tmpdir(), 'opk-reconcile-bounded-poll-'));
    const ledgerPath = join(root, 'orchestration-mail-reconcile.json');
    const lockPath = join(root, 'orchestration-mail-reconcile.lock');
    writeFileSync(ledgerPath, JSON.stringify({ messages: { [backlog.id]: 900 }, episodes: {} }));
    try {
      const result = await runOrchestrationMailReconcileTick(deps, { ledgerPath, lockPath, now: () => 1_000, maxRecipientGroups: 1, maxMessages: 1 });
      expect(result.attempted).toBe(1);
      expect(result.nudged).toBe(1);
      expect(submitted).toHaveLength(1);
      expect(resolvedRecipients).toEqual([message.recipient]);
      expect(JSON.parse(readFileSync(ledgerPath, 'utf8')).messages).toEqual({ [backlog.id]: 900, [message.id]: 1_000 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('enters one Orca-notified message when terminal check --peek retrieves it', async () => {
    const target = worker('term_retrievable');
    const submitted: RuntimeWorkerIdentity[] = [];
    const deps = reconciliationDeps([{
      id: 'msg_live',
      run_id: 'run_live',
      to_handle: target.identity.id,
      read: 0,
    }], target, { submitted });
    const suffix = `${process.pid}-${Date.now()}`;
    const ledgerPath = join(tmpdir(), `opk-reconcile-live-${suffix}.json`);
    const lockPath = join(tmpdir(), `opk-reconcile-live-${suffix}.lock`);

    const result = await runOrchestrationMailReconcileTick(deps, {
      ledgerPath,
      lockPath,
      now: () => 1_000,
    });

    expect(deps.writes).toBe(0);
    expect(result.nudged).toBe(1);
    expect(result.deliveryEvidence).toEqual([{
      workerGeneration: target.identity.generation,
      runId: 'run_live',
      messageId: 'msg_live',
      delivery: 'delivered-looking',
      terminalReceipt: 'unproven',
    }]);

    const suppressed = await runOrchestrationMailReconcileTick(deps, {
      ledgerPath,
      lockPath,
      now: () => 1_001,
    });
    expect(suppressed.skipped).toBe(1);
    expect(suppressed.deliveryEvidence).toEqual([]);
    expect(deps.writes).toBe(0);
  });

  it('keeps multiple unread messages distinct without pack pointer writes', async () => {
    const target = worker('term_retrievable_batch');
    const submitted: RuntimeWorkerIdentity[] = [];
    const deps = reconciliationDeps([
      { id: 'msg_batch_a', run_id: 'run_batch', to_handle: target.identity.id, read: 0 },
      { id: 'msg_batch_b', run_id: 'run_batch', to_handle: target.identity.id, read: 0 },
      { id: 'msg_batch_c', run_id: 'run_batch', to_handle: target.identity.id, read: 0 },
    ], target, { submitted });
    const suffix = `${process.pid}-${Date.now()}`;

    const result = await runOrchestrationMailReconcileTick(deps, {
      ledgerPath: join(tmpdir(), `opk-reconcile-batch-${suffix}.json`),
      lockPath: join(tmpdir(), `opk-reconcile-batch-${suffix}.lock`),
      now: () => 1_000,
    });

    expect(deps.writes).toBe(0);
    expect(deps.pointer).toBe(`You have 3 orchestration messages. Run \`orca orchestration check --terminal ${target.identity.id}\`.`);
    expect(result.attempted).toBe(3);
    expect(result.nudged).toBe(1);
    expect(result.skipped).toBe(0);
    expect(submitted).toHaveLength(1);
  });

  it('migrates legacy run-scoped claims before stale-key pruning', async () => {
    const target = worker('term_legacy_claim_migration');
    const root = mkdtempSync(join(tmpdir(), 'opk-legacy-claim-migration-'));
    const statePath = join(root, 'orchestration-mail-reconcile.json');
    const lockPath = join(root, 'orchestration-mail-reconcile.lock');
    const paneKey = workerKey(target.identity);
    const legacyKey = `${paneKey}\u0000run_legacy_claim_migration`;
    writeFileSync(statePath, JSON.stringify({
      messages: {},
      episodes: {
        [legacyKey]: {
          messageId: 'msg_legacy_claim_migration',
          runId: 'run_legacy_claim_migration',
          recipient: target.identity.id,
          workerKey: paneKey,
          nextEligibleAt: 0,
          backoffMs: 60_000,
          state: 'confirmed',
        },
      },
    }));
    const deps = reconciliationDeps([{
      id: 'msg_legacy_claim_migration',
      run_id: 'run_legacy_claim_migration',
      to_handle: target.identity.id,
      read: 0,
    }], target);
    try {
      const result = await runOrchestrationMailReconcileTick(deps, { ledgerPath: statePath, lockPath, now: () => 1_000 });
      const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as { episodes: Record<string, { messageId: string; state: string }> };
      expect(result.reasons).toHaveLength(1);
      expect(deps.writes).toBe(0);
      expect(Object.values(persisted.episodes).find((row) => row.messageId === 'msg_legacy_claim_migration')?.state).toBe('confirmed');
      expect(persisted.episodes[legacyKey]).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('releases a consumed message claim while another message remains unread', async () => {
    const target = worker('term_release_pane_claim');
    const key = workerKey(target.identity);
    const state = {
      messages: {},
      episodes: {
        [key]: {
          messageId: 'msg_release_first',
          runId: 'run_release_first',
          recipient: target.identity.id,
          workerKey: key,
          nextEligibleAt: 0,
          backoffMs: 60_000,
          state: 'confirmed' as const,
        },
      },
    };
    const result = await submitOrcaMessageDeliveryPointer('msg_release_first', {
      readInbox: () => ({ ok: true as const, result: { messages: [
        { id: 'msg_release_first', run_id: 'run_release_first', to_handle: target.identity.id, read: 1 },
        { id: 'msg_release_second', run_id: 'run_release_second', to_handle: target.identity.id, read: 0 },
      ] } }),
      lookupMessage: () => ({ ok: true as const, message: {
        id: 'msg_release_first', runId: 'run_release_first', recipient: target.identity.id, consumed: true,
      } }),
      resolveWorker: () => ({ ok: true as const, worker: target }),
      writePointer: () => ({ status: 'dispatched' as const }),
      submitDeps: depsFor({}, { liveness: () => 'idle' }),
      episodeState: state,
    });
    expect(result.terminals[0]?.reason).toBe('delivery_already_consumed');
    expect(state.episodes[key]).toBeUndefined();
  });

  it('does not synthesize a pointer and records the refusal episode when Orca did not notify the composer', async () => {
    const target = worker('term_definitive_write_failure');
    const root = mkdtempSync(join(tmpdir(), 'opk-definitive-write-failure-'));
    const statePath = join(root, 'orchestration-mail-reconcile.json');
    const lockPath = join(root, 'orchestration-mail-reconcile.lock');
    let writes = 0;
    let pointerVisible = false;
    const message = { id: 'msg_definitive_write_failure', runId: 'run_definitive_write_failure', recipient: target.identity.id, consumed: false };
    const submitted: RuntimeWorkerIdentity[] = [];
    const makeDeps = () => ({
      lookupMessage: () => ({ ok: true as const, message }),
      resolveWorker: () => ({ ok: true as const, worker: target }),
      writePointer: () => {
        writes += 1;
        if (writes > 1) pointerVisible = true;
        return writes === 1
          ? { status: 'send_failed' as const, reason: 'runtime_unavailable' }
          : { status: 'dispatched' as const };
      },
      submitDeps: depsFor({}, {
        submitted,
        submitResult: (identity) => { submitted.push(identity); return { status: 'dispatched' as const }; },
        read: () => ({
          ok: true as const,
          lines: pointerVisible && submitted.length === 0 ? [buildDeliveryPointer(message), ...CURSOR_FOOTER] : ['→ Add a follow-up', ...CURSOR_FOOTER],
        }),
      }),
      episodeStatePath: statePath,
      episodeLockPath: lockPath,
    });
    try {
      const first = await submitOrcaMessageDeliveryPointer(message.id, makeDeps(), { now: () => 1_000 });
      const second = await submitOrcaMessageDeliveryPointer(message.id, makeDeps(), { now: () => 61_001 });
      const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as { episodes: Record<string, { messageId: string; reason?: string; state: string }> };
      expect(first.terminals[0]?.reason).toBe('pointer_absent_orca_did_not_notify');
      expect(second.terminals[0]?.reason).toBe('pointer_absent_orca_did_not_notify');
      expect(writes).toBe(0);
      expect(submitted).toHaveLength(0);
      expect(Object.values(persisted.episodes)).toEqual([expect.objectContaining({
        messageId: message.id,
        reason: 'pointer_absent_orca_did_not_notify',
        state: 'refused',
      })]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('releases a confirmed claim when its originating mail is no longer unread', async () => {
    const target = worker('term_stale_confirmed_claim');
    const root = mkdtempSync(join(tmpdir(), 'opk-stale-confirmed-claim-'));
    const statePath = join(root, 'orchestration-mail-reconcile.json');
    const lockPath = join(root, 'orchestration-mail-reconcile.lock');
    const paneKey = workerKey(target.identity);
    writeFileSync(statePath, JSON.stringify({
      messages: {},
      episodes: {
        [paneKey]: {
          messageId: 'msg_old_consumed', runId: 'run_old_consumed', recipient: target.identity.id,
          workerKey: paneKey, nextEligibleAt: 0, backoffMs: 60_000, state: 'confirmed',
        },
      },
    }));
    const deps = reconciliationDeps([{
      id: 'msg_new_unread', run_id: 'run_new_unread', to_handle: target.identity.id, read: 0,
    }], target);
    try {
      const result = await runOrchestrationMailReconcileTick(deps, { ledgerPath: statePath, lockPath, now: () => 1_000 });
      expect(deps.writes).toBe(0);
      expect(result.reasons).toContain('msg_new_unread:enter_sent');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed without a complete current worker identity', async () => {
    const target = worker('term_missing_generation', '');
    const deps = reconciliationDeps([{
      id: 'msg_missing_generation',
      run_id: 'run_missing_generation',
      to_handle: target.identity.id,
      read: 0,
    }], target);
    const suffix = `${process.pid}-${Date.now()}`;

    const result = await runOrchestrationMailReconcileTick(deps, {
      ledgerPath: join(tmpdir(), `opk-reconcile-missing-generation-${suffix}.json`),
      lockPath: join(tmpdir(), `opk-reconcile-missing-generation-${suffix}.lock`),
      now: () => 1_000,
    });

    expect(deps.writes).toBe(0);
    expect(result.nudged).toBe(0);
    expect(result.deliveryEvidence).toEqual([]);
    expect(result.reasons).toContain('msg_missing_generation:orchestration_worker_identity_incomplete');
  });

  it('claims one exact episode and retries the unconfirmed Enter on the next tick', async () => {
    const target = worker('term_episode_backoff');
    const root = mkdtempSync(join(tmpdir(), 'opk-episode-backoff-'));
    const statePath = join(root, 'orchestration-mail-reconcile.json');
    const lockPath = join(root, 'orchestration-mail-reconcile.lock');
    let writes = 0;
    let pointerVisible = true;
    let launches = 0;
    let livenessCalls = 0;
    const liveness = () => livenessCalls++ < 3 ? 'idle' as const : 'busy' as const;
    const submitted: RuntimeWorkerIdentity[] = [];
    const message = {
      id: 'msg_episode_backoff',
      runId: 'run_episode_backoff',
      recipient: target.identity.id,
      consumed: false,
    };
    try {
      const makeDeps = () => ({
        lookupMessage: () => ({ ok: true as const, message }),
        resolveWorker: () => ({ ok: true as const, worker: target }),
        writePointer: () => {
          writes += 1;
          pointerVisible = true;
          return { status: 'dispatched' as const };
        },
        submitDeps: depsFor({}, {
          submitted,
          read: () => ({
            ok: true as const,
            lines: pointerVisible
              ? [`You have 1 orchestration message. Read orchestration mail, check the fleet, and clear blockers so the fleet does not idle. Run \`orca orchestration check --terminal ${target.identity.id}\`.`, ...CURSOR_FOOTER]
              : ['→ Add a follow-up', ...CURSOR_FOOTER],
            source: 'screen' as const,
          }),
          liveness,
          submitResult: (identity) => {
            submitted.push(identity);
            launches += 1;
            if (launches > 1) pointerVisible = false;
            return launches === 1
              ? { status: 'send_failed' as const, reason: 'runtime_unavailable' }
              : { status: 'dispatched' as const };
          },
        }),
        episodeStatePath: statePath,
        episodeLockPath: lockPath,
      });
      const first = await submitOrcaMessageDeliveryPointer(message.id, makeDeps(), { now: () => 1_000 });
      expect(first.terminals[0]?.reason).toBe('runtime_unavailable');
      expect(writes).toBe(0);
      expect(submitted).toHaveLength(1);
      const suppressed = await submitOrcaMessageDeliveryPointer(message.id, makeDeps(), { now: () => 1_001 });
      expect(suppressed.terminals[0]?.reason).toBe('enter_sent');
      expect(writes).toBe(0);
      expect(submitted).toHaveLength(2);
      const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as { episodes: Record<string, { messageId: string; backoffMs?: unknown }> };
      expect(Object.values(persisted.episodes).find((row) => row.messageId === message.id)?.backoffMs).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('seals a delivered unread episode across later reconcile ticks', async () => {
    const target = worker('term_episode_sealed');
    const root = mkdtempSync(join(tmpdir(), 'opk-episode-sealed-'));
    const statePath = join(root, 'orchestration-mail-reconcile.json');
    const lockPath = join(root, 'orchestration-mail-reconcile.lock');
    let writes = 0;
    let pointerVisible = true;
    const submitted: RuntimeWorkerIdentity[] = [];
    const message = {
      id: 'msg_episode_sealed',
      runId: 'run_episode_sealed',
      recipient: target.identity.id,
      consumed: false,
    };
    try {
      const makeDeps = () => ({
        lookupMessage: () => ({ ok: true as const, message }),
        resolveWorker: () => ({ ok: true as const, worker: target }),
        writePointer: () => {
          writes += 1;
          pointerVisible = true;
          return { status: 'dispatched' as const };
        },
        submitDeps: depsFor({}, {
          submitted,
          read: () => ({
            ok: true as const,
            lines: pointerVisible
              ? [`You have 1 orchestration message. Read orchestration mail, check the fleet, and clear blockers so the fleet does not idle. Run \`orca orchestration check --terminal ${target.identity.id}\`.`, ...CURSOR_FOOTER]
              : ['→ Add a follow-up', ...CURSOR_FOOTER],
            source: 'screen' as const,
          }),
          liveness: (() => { let calls = 0; return () => calls++ < 2 ? 'idle' : 'busy'; })(),
          submitResult: (identity) => { submitted.push(identity); pointerVisible = false; return { status: 'dispatched' as const }; },
        }),
        episodeStatePath: statePath,
        episodeLockPath: lockPath,
      });

      const first = await submitOrcaMessageDeliveryPointer(message.id, makeDeps(), { now: () => 1_000 });
      const second = await submitOrcaMessageDeliveryPointer(message.id, makeDeps(), { now: () => 61_001 });
      const third = await submitOrcaMessageDeliveryPointer(message.id, makeDeps(), { now: () => 181_001 });

      expect(first.terminals[0]).toMatchObject({ enter: true });
      expect(second.terminals[0]?.enter).toBe(false);
      expect(third.terminals[0]?.enter).toBe(false);
      expect(writes).toBe(0);
      expect(submitted).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps an unproven Orca-notified delivery retryable', async () => {
    const target = worker('term_episode_unproven');
    const root = mkdtempSync(join(tmpdir(), 'opk-episode-unproven-'));
    const statePath = join(root, 'orchestration-mail-reconcile.json');
    const lockPath = join(root, 'orchestration-mail-reconcile.lock');
    let writes = 0;
    let pointerVisible = true;
    let liveness: 'unknown' | 'idle' = 'unknown';
    const submitted: RuntimeWorkerIdentity[] = [];
    const message = {
      id: 'msg_episode_unproven',
      runId: 'run_episode_unproven',
      recipient: target.identity.id,
      consumed: false,
    };
    try {
      const makeDeps = () => ({
        lookupMessage: () => ({ ok: true as const, message }),
        resolveWorker: () => ({ ok: true as const, worker: target }),
        writePointer: () => {
          writes += 1;
          pointerVisible = true;
          return { status: 'dispatched' as const };
        },
        submitDeps: depsFor({}, {
          submitted,
          read: () => ({
            ok: true as const,
            lines: pointerVisible
              ? [`You have 1 orchestration message. Read and act on your orchestration message. Run \`orca orchestration check --terminal ${target.identity.id}\`.`, ...CURSOR_FOOTER]
              : ['→ Add a follow-up', ...CURSOR_FOOTER],
            source: 'screen' as const,
          }),
          liveness: () => liveness,
        }),
        episodeStatePath: statePath,
        episodeLockPath: lockPath,
      });

      const first = await submitOrcaMessageDeliveryPointer(message.id, makeDeps(), { now: () => 1_000 });
      expect(first.terminals[0]).toMatchObject({ enter: false, reason: 'submission_unconfirmed' });
      expect(submitted).toHaveLength(1);

      liveness = 'idle';
      const retry = await submitOrcaMessageDeliveryPointer(message.id, makeDeps(), { now: () => 61_001 });
      expect(retry.terminals[0]).toMatchObject({ enter: false, reason: 'submission_unconfirmed' });
      expect(writes).toBe(0);
      expect(submitted).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serializes empty-state companion races before pointer and Enter effects', async () => {
    const target = worker('term_episode_race');
    const root = mkdtempSync(join(tmpdir(), 'opk-episode-race-'));
    const statePath = join(root, 'orchestration-mail-reconcile.json');
    const lockPath = join(root, 'orchestration-mail-reconcile.lock');
    let writes = 0;
    let pointerVisible = true;
    const submitted: RuntimeWorkerIdentity[] = [];
    const message = {
      id: 'msg_episode_race',
      runId: 'run_episode_race',
      recipient: target.identity.id,
      consumed: false,
    };
    try {
      const makeDeps = () => ({
        lookupMessage: () => ({ ok: true as const, message }),
        resolveWorker: () => ({ ok: true as const, worker: target }),
        writePointer: () => {
          writes += 1;
          pointerVisible = true;
          return { status: 'dispatched' as const };
        },
        submitDeps: depsFor({}, {
          submitted,
          submitResult: (identity) => { submitted.push(identity); pointerVisible = false; return { status: 'dispatched' as const }; },
          read: () => ({
            ok: true as const,
            lines: pointerVisible ? [`You have 1 orchestration message. Read orchestration mail, check the fleet, and clear blockers so the fleet does not idle. Run \`orca orchestration check --terminal ${target.identity.id}\`.`, ...CURSOR_FOOTER] : ['→ Add a follow-up', ...CURSOR_FOOTER],
            source: 'screen' as const,
          }),
          liveness: (() => { let calls = 0; return () => calls++ < 2 ? 'idle' : 'busy'; })(),
        }),
        episodeStatePath: statePath,
        episodeLockPath: lockPath,
      });
      const results = await Promise.all([
        submitOrcaMessageDeliveryPointer(message.id, makeDeps(), { now: () => 2_000 }),
        submitOrcaMessageDeliveryPointer(message.id, makeDeps(), { now: () => 2_000 }),
      ]);
      expect(writes).toBe(0);
      expect(submitted).toHaveLength(1);
      expect(results.filter((result) => result.terminals[0]?.enter)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('shares the reconcile ledger with direct delivery to suppress a second pointer', async () => {
    const target = worker('term_shared_ledger');
    let writes = 0;
    let wrote = false;
    const message = {
      id: 'msg_shared_ledger',
      runId: 'run_shared_ledger',
      recipient: target.identity.id,
      consumed: false,
    };
    const pointer = `You have 1 orchestration message. Run \`orca orchestration check --terminal ${target.identity.id}\`.`;
    const submitDeps = depsFor({}, {
      read: () => ({
        ok: true as const,
        lines: wrote ? [pointer, ...CURSOR_FOOTER] : ['→ Add a follow-up', ...CURSOR_FOOTER],
      }),
    });
    const deps = () => ({
      lookupMessage: () => ({ ok: true as const, message }),
      resolveWorker: () => ({ ok: true as const, worker: target }),
      writePointer: () => {
        writes += 1;
        wrote = true;
        return { status: 'dispatched' as const };
      },
      submitDeps,
    });
    const suffix = `${process.pid}-${Date.now()}`;
    const ledgerPath = join(tmpdir(), `opk-reconcile-shared-${suffix}.json`);
    const lockPath = join(tmpdir(), `opk-reconcile-shared-${suffix}.lock`);
    const options = { ledgerPath, lockPath, now: () => 1_000 };

    await submitOrcaMessageDeliveryPointer(message.id, deps(), options);
    await submitOrcaMessageDeliveryPointer(message.id, deps(), options);

    expect(writes).toBe(0);
  });

  it('processes an unread message beyond Orca’s default page', async () => {
    const target = worker('term_page_21');
    const rows = Array.from({ length: 20 }, (_, index) => ({
      id: `msg_page_${index}`,
      run_id: `run_page_${index}`,
      to_handle: `term_other_${index}`,
      read: 0,
    }));
    rows.push({
      id: 'msg_page_21',
      run_id: 'run_page_21',
      to_handle: target.identity.id,
      read: 0,
    });
    const deps = reconciliationDeps(rows, target);
    const suffix = `${process.pid}-${Date.now()}`;

    const result = await runOrchestrationMailReconcileTick(deps, {
      ledgerPath: join(tmpdir(), `opk-reconcile-page-${suffix}.json`),
      lockPath: join(tmpdir(), `opk-reconcile-page-${suffix}.lock`),
      now: () => 1_000,
    });

    expect(result.attempted).toBe(21);
    expect(deps.writes).toBe(0);
  });
});


  it('submits Enter for an Orca-notified busy pane', async () => {
    const target = worker('term_busy_delivery');
    const state = { messages: {}, episodes: {} };
    const submitted: RuntimeWorkerIdentity[] = [];
    let writes = 0;
    let pointerVisible = true;
    const result = await submitOrcaMessageDeliveryPointer('msg_busy_delivery', {
      lookupMessage: () => ({ ok: true as const, message: {
        id: 'msg_busy_delivery', runId: 'run_busy_delivery', recipient: target.identity.id, consumed: false,
      } }),
      resolveWorker: () => ({ ok: true as const, worker: target }),
      writePointer: () => { writes += 1; pointerVisible = true; return { status: 'dispatched' as const }; },
      submitDeps: depsFor({ [target.identity.id]: ['→ Add a follow-up', ...CURSOR_FOOTER] }, {
        submitted,
        submitResult: (identity) => { submitted.push(identity); pointerVisible = false; return { status: 'dispatched' as const }; },
        liveness: () => 'busy',
        read: () => ({
          ok: true as const,
          lines: pointerVisible ? [buildDeliveryPointer({ id: 'msg_busy_delivery', runId: 'run_busy_delivery', recipient: target.identity.id, consumed: false }), ...CURSOR_FOOTER] : ['→ Add a follow-up', ...CURSOR_FOOTER],
          source: 'screen' as const,
        }),
      }),
      episodeState: state,
    });

    expect(result.terminals[0]).toMatchObject({ reason: 'enter_sent', enter: true });
    expect(writes).toBe(0);
    expect(submitted).toEqual([target.identity]);
    const episode = Object.values(state.episodes).find((candidate) => (candidate as { readonly messageId?: string }).messageId === 'msg_busy_delivery') as { readonly state?: string } | undefined;
    expect(episode?.state).toBe('confirmed');
  });

  it('retries an unconfirmed claim despite notification wording changes', async () => {
    const target = worker('term_unconfirmed_count');
    const root = mkdtempSync(join(tmpdir(), 'opk-unconfirmed-count-'));
    const statePath = join(root, 'orchestration-mail-reconcile.json');
    const lockPath = join(root, 'orchestration-mail-reconcile.lock');
    const submitted: RuntimeWorkerIdentity[] = [];
    let writes = 0;
    let pointerVisible = true;
    let livenessCalls = 0;
    const liveness = () => livenessCalls++ >= 4 ? 'busy' as const : 'idle' as const;
    const message = {
      id: 'msg_unconfirmed_count', runId: 'run_unconfirmed_count', recipient: target.identity.id, consumed: false,
    };
    try {
      const makeDeps = () => ({
        lookupMessage: () => ({ ok: true as const, message }),
        resolveWorker: () => ({ ok: true as const, worker: target }),
        writePointer: () => { writes += 1; pointerVisible = true; return { status: 'dispatched' as const }; },
        submitDeps: depsFor({}, {
          submitted,
          submitResult: (identity) => { submitted.push(identity); if (submitted.length > 1) pointerVisible = false; return { status: 'dispatched' as const }; },
          liveness,
          read: () => ({
            ok: true as const,
            lines: pointerVisible && submitted.length < 2
              ? [`You have 1 orchestration message. Read and act on your orchestration message. Run \`orca orchestration check --terminal ${target.identity.id}\`.`, ...CURSOR_FOOTER]
              : ['→ Add a follow-up', ...CURSOR_FOOTER],
            source: 'screen' as const,
          }),
        }),
        episodeStatePath: statePath,
        episodeLockPath: lockPath,
      });
      const first = await submitOrcaMessageDeliveryPointer(message.id, makeDeps(), { now: () => 1_000 });
      expect(first.terminals[0]).toMatchObject({ reason: 'submission_unconfirmed', enter: false });
      expect(writes).toBe(0);
      expect(submitted).toHaveLength(1);

      const retry = await submitOrcaMessageDeliveryPointer(message.id, makeDeps(), { now: () => 61_001 });
      expect(retry.terminals[0]).toMatchObject({ reason: 'enter_sent', enter: true });
      expect(writes).toBe(0);
      expect(submitted).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });


  it('retries a hidden unconfirmed claim with Enter only', async () => {
    const target = worker('term_hidden_claim');
    const root = mkdtempSync(join(tmpdir(), 'opk-hidden-claim-'));
    const statePath = join(root, 'orchestration-mail-reconcile.json');
    const lockPath = join(root, 'orchestration-mail-reconcile.lock');
    const submitted: RuntimeWorkerIdentity[] = [];
    let writes = 0;
    let pointerVisible = true;
    let livenessCalls = 0;
    const liveness = () => livenessCalls++ >= 4 ? 'busy' as const : 'idle' as const;
    const message = { id: 'msg_hidden_claim', runId: 'run_hidden_claim', recipient: target.identity.id, consumed: false };
    const makeDeps = () => ({
      lookupMessage: () => ({ ok: true as const, message }),
      resolveWorker: () => ({ ok: true as const, worker: target }),
      writePointer: () => { writes += 1; pointerVisible = true; return { status: 'dispatched' as const }; },
      submitDeps: depsFor({}, {
        submitted,
        liveness,
        read: () => ({
          ok: true as const,
          lines: pointerVisible ? [buildDeliveryPointer(message), ...CURSOR_FOOTER] : ['→ Add a follow-up', ...CURSOR_FOOTER],
          source: 'screen' as const,
        }),
      }),
      episodeStatePath: statePath,
      episodeLockPath: lockPath,
    });
    try {
      const first = await submitOrcaMessageDeliveryPointer(message.id, makeDeps(), { now: () => 1_000 });
      expect(first.terminals[0]?.reason).toBe('submission_unconfirmed');
      pointerVisible = false;
      const retry = await submitOrcaMessageDeliveryPointer(message.id, makeDeps(), { now: () => 61_001 });
      expect(retry.terminals[0]).toMatchObject({ reason: 'pointer_consumed', enter: false, ok: true });
      expect(writes).toBe(0);
      expect(submitted).toHaveLength(1);
      const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as { episodes: Record<string, { messageId: string; state: string }> };
      expect(Object.values(persisted.episodes).find((row) => row.messageId === message.id)?.state).toBe('confirmed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves delivery deduplication across a stable pane-key handle rotation', async () => {
    const oldWorker = worker('term_rotated_old', 'g1', 'orca', 'tab-rotation:leaf-1');
    const newWorker = worker('term_rotated_new', 'g2', 'orca', 'tab-rotation:leaf-1');
    const state = { messages: {}, episodes: {} };
    const submitted: RuntimeWorkerIdentity[] = [];
    let writes = 0;
    let pointerVisible = true;
    let now = 1_000;
    const message = { id: 'msg_rotated_delivery', runId: 'run_rotated_delivery', recipient: 'run:run_rotated_delivery', consumed: false };
    const makeDeps = (current: RuntimeWorker) => ({
      lookupMessage: () => ({ ok: true as const, message }),
      resolveWorker: () => ({ ok: true as const, worker: current }),
      writePointer: () => { writes += 1; pointerVisible = true; return { status: 'dispatched' as const }; },
      submitDeps: depsFor({}, {
        submitted,
        liveness: () => 'idle' as const,
        submitResult: (identity) => { submitted.push(identity); return { status: 'dispatched' as const }; },
        read: () => ({
          ok: true as const,
          lines: pointerVisible ? [buildDeliveryPointer(message), ...CURSOR_FOOTER] : ['→ Add a follow-up', ...CURSOR_FOOTER],
          source: 'screen' as const,
        }),
      }),
      episodeState: state,
      reconcileClock: () => now,
    });
    const first = await submitOrcaMessageDeliveryPointer(message.id, makeDeps(oldWorker));
    expect(first.terminals[0]).toMatchObject({ reason: 'submission_unconfirmed', enter: false });
    pointerVisible = false;
    now = 61_001;
    const second = await submitOrcaMessageDeliveryPointer(message.id, makeDeps(newWorker));
    expect(second.terminals[0]).toMatchObject({ reason: 'pointer_consumed', enter: false, ok: true });
    expect(writes).toBe(0);
    expect(submitted).toEqual([oldWorker.identity]);
  });

  it.each([
    ['busy', 'enter_sent', true],
    ['unknown', 'enter_sent', true],
  ] as const)('retries a contradicted confirmed pointer when liveness is %s', async (_label, expectedReason, expectedEnter) => {
    const target = worker('term_contradicted_confirmed');
    const key = workerKey(target.identity);
    const state = {
      messages: {},
      episodes: {
        [key]: {
          messageId: 'msg_contradicted_confirmed', runId: 'run_contradicted_confirmed', recipient: target.identity.id,
          workerKey: key, nextEligibleAt: 0, backoffMs: 60_000, state: 'confirmed' as const,
        },
      },
    };
    const submitted: RuntimeWorkerIdentity[] = [];
    const result = await submitOrcaMessageDeliveryPointer('msg_contradicted_confirmed', {
      lookupMessage: () => ({ ok: true as const, message: {
        id: 'msg_contradicted_confirmed', runId: 'run_contradicted_confirmed', recipient: target.identity.id, consumed: false,
      } }),
      resolveWorker: () => ({ ok: true as const, worker: target }),
      writePointer: () => { throw new Error('contradicted pointer must not be rewritten'); },
      submitDeps: depsFor({}, {
        submitted,
        liveness: () => _label,
        read: () => ({
          ok: true as const,
          lines: submitted.length === 0 ? [`You have 1 orchestration message. Run \`orca orchestration check --terminal ${target.identity.id}\`.`, ...CURSOR_FOOTER] : ['→ Add a follow-up', ...CURSOR_FOOTER],
          source: 'screen' as const,
        }),
      }),
      episodeState: state,
    });

    expect(result.terminals[0]).toMatchObject({ reason: expectedReason, enter: expectedEnter });
    expect(submitted).toHaveLength(1);
    const episode = Object.values(state.episodes).find((candidate) => (candidate as { readonly messageId?: string }).messageId === 'msg_contradicted_confirmed') as { readonly state?: string } | undefined;
    expect(episode?.state).toBe(expectedEnter ? 'confirmed' : 'pointer-visible');
  });

  it('allows distinct messages through the same stable pane-key handle', async () => {
    const target = worker('term_pane_wide_claim');
    let currentRun = 'run_pane_a';
    let pointerVisible = true;
    let writes = 0;
    const submitted: RuntimeWorkerIdentity[] = [];
    let livenessCalls = 0;
    const liveness = () => livenessCalls++ < 2 ? 'idle' as const : 'busy' as const;
    const deps = {
      lookupMessage: () => ({ ok: true as const, message: {
        id: currentRun === 'run_pane_a' ? 'msg_pane_a' : 'msg_pane_b', runId: currentRun,
        recipient: target.identity.id, consumed: false,
      } }),
      resolveWorker: () => ({ ok: true as const, worker: target }),
      writePointer: () => { writes += 1; pointerVisible = true; return { status: 'dispatched' as const }; },
      submitDeps: depsFor({}, {
        submitted,
        liveness,
        submitResult: (identity) => {
          submitted.push(identity);
          pointerVisible = false;
          return { status: 'dispatched' as const };
        },
        read: () => ({
          ok: true as const,
          lines: pointerVisible ? [buildDeliveryPointer({ id: currentRun === 'run_pane_a' ? 'msg_pane_a' : 'msg_pane_b', runId: currentRun, recipient: target.identity.id, consumed: false }), ...CURSOR_FOOTER] : ['→ Add a follow-up', ...CURSOR_FOOTER],
          source: 'screen' as const,
        }),
      }),
      episodeState: { messages: {}, episodes: {} },
    };
    const first = await submitOrcaMessageDeliveryPointer('msg_pane_a', deps);
    currentRun = 'run_pane_b';
    pointerVisible = true;
    const second = await submitOrcaMessageDeliveryPointer('msg_pane_b', deps);

    expect(first.terminals[0]?.reason).toBe('enter_sent');
    expect(second.terminals[0]?.reason).toBe('enter_sent');
    expect(writes).toBe(0);
    expect(submitted).toHaveLength(2);
  });

  it('reports reconcile lock contention as a retryable failure', async () => {
    const target = worker('term_lock_contention');
    const lockPath = join(tmpdir(), `opk-reconcile-lock-${process.pid}-${Date.now()}.lock`);
    acquireWatchLock(lockPath);
    try {
      const result = await runOrchestrationMailReconcileTick({
        readInbox: () => ({ ok: true as const, result: { messages: [] } }),
        lookupMessage: () => ({ ok: false as const, reason: 'unused' }),
        resolveWorker: () => ({ ok: true as const, worker: target }),
        writePointer: () => ({ status: 'dispatched' as const }),
        submitDeps: depsFor({}, { liveness: () => 'idle' }),
      }, { lockPath, ledgerPath: join(tmpdir(), `opk-reconcile-lock-${process.pid}-${Date.now()}.json`) });
      expect(result.ok).toBe(false);
      expect(result.reasons).toContain('reconcile_lock_busy');
    } finally {
      releaseWatchLock();
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    }
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
