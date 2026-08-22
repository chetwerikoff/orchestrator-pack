// @vitest-ci-lane light
// @vitest-pre-topology-seconds 1
import { describe, expect, it } from 'vitest';
import {
  classifyCursorComposer,
  createUnsentComposerWatchState,
  cursorComposerLooksUnsent,
  QUIET_AFTER_PRINT_MS,
  submitUnsentCursorComposer,
  submitUnsentCursorComposerOnce,
} from './cursor-unsent-composer-submit.ts';

const POKE = 'You have 1 orchestration message. Run `orca orchestration check --run run_d613a86c140a`.';

describe('classifyCursorComposer', () => {
  it('ignores an idle follow-up placeholder', () => {
    expect(cursorComposerLooksUnsent(`
wiki: skip(direct-instruction state/action)
→ Add a follow-up
Cursor Grok 4.6 High · 40.6% · 22 files edited                                                                                                    Run Everything
~/projects/orchestrator-pack · main
`)).toBe(false);
  });

  it('does not steal a Cursor pasted draft or ordinary typing', () => {
    expect(classifyCursorComposer(`
→ [Pasted text #1 +15 lines]
GPT-5.6 Luna 272K Low · 26.5% Run Everything
~/orca/workspaces/orchestrator-pack/mgr-agents-ctx-decomp
`)).toBe('manual');
    expect(cursorComposerLooksUnsent(`
→ разберись почему упал пайплайн
Cursor Grok 4.6 High · 40.6% · 22 files edited Run Everything
~/projects/orchestrator-pack · main
`)).toBe(false);
  });

  it('sees an Orca mailbox poke sitting in the composer', () => {
    expect(cursorComposerLooksUnsent(`
Почта обработана.
${POKE}
Cursor Grok 4.6 High · 40.6% · 22 files edited Run Everything
~/projects/orchestrator-pack - main
`)).toBe(true);
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
`)).toBe('manual');
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
`)).toBe('manual');
  });

  it('does not submit an unboxed poke that still has a typed composer line above it', () => {
    expect(classifyCursorComposer(`
→ разберись почему
${POKE}
Cursor Grok 4.6 High · 40.6% · 22 files edited Run Everything
~/projects/orchestrator-pack · main
`)).toBe('manual');
  });
});

function pokeRead(handle: string) {
  return {
    ok: true as const,
    result: {
      terminal: {
        tail: handle === 'term_unsent'
          ? [POKE, 'Run Everything']
          : ['→ Add a follow-up', 'Run Everything'],
      },
    },
  };
}

describe('submitUnsentCursorComposer', () => {
  it('enters every unsent terminal and skips empty ones', () => {
    const submitted: string[] = [];
    const result = submitUnsentCursorComposer(
      {},
      {
        list: () => ({
          ok: true,
          result: { terminals: [{ handle: 'term_empty' }, { handle: 'term_unsent' }] },
        }),
        read: pokeRead,
        submit: (handle) => {
          submitted.push(handle);
          return { ok: true };
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.watch).toBe(false);
    expect(submitted).toEqual(['term_unsent']);
    expect(result.terminals.map((row) => row.reason)).toEqual(['composer_empty', 'enter_sent']);
  });

  it('skips ordinary typing even in one-shot mode', () => {
    const submitted: string[] = [];
    const result = submitUnsentCursorComposer(
      { terminals: ['term_typing'] },
      {
        list: () => ({ ok: true, result: { terminals: [] } }),
        read: () => ({
          ok: true,
          result: { terminal: { tail: ['→ разберись почему', 'Run Everything'] } },
        }),
        submit: (handle) => {
          submitted.push(handle);
          return { ok: true };
        },
      },
    );
    expect(submitted).toEqual([]);
    expect(result.terminals[0]?.reason).toBe('manual_input');
  });

  it('waits 10s after the poke stops changing and does not resend', () => {
    const submitted: string[] = [];
    const state = createUnsentComposerWatchState();
    let now = 0;
    const deps = {
      list: () => ({ ok: true, result: { terminals: [{ handle: 'term_unsent' }] } }),
      read: () => pokeRead('term_unsent'),
      now: () => now,
      submit: (handle: string) => {
        submitted.push(handle);
        return { ok: true as const };
      },
    };
    const first = submitUnsentCursorComposer({ watch: true }, deps, state);
    now = QUIET_AFTER_PRINT_MS - 1;
    const beforeQuiet = submitUnsentCursorComposer({ watch: true }, deps, state);
    now = QUIET_AFTER_PRINT_MS;
    const second = submitUnsentCursorComposer({ watch: true }, deps, state);
    const third = submitUnsentCursorComposer({ watch: true }, deps, state);
    expect(first.terminals[0]?.reason).toBe('waiting_stable');
    expect(beforeQuiet.terminals[0]?.reason).toBe('waiting_stable');
    expect(second.terminals[0]?.reason).toBe('enter_sent');
    expect(third.terminals[0]?.reason).toBe('already_submitted');
    expect(submitted).toEqual(['term_unsent']);
  });

  it('aborts a poke if the composer becomes manual before it is stable', () => {
    const submitted: string[] = [];
    const state = createUnsentComposerWatchState();
    let poke = true;
    const resultAfterTyping = (() => {
      const deps = {
        list: () => ({ ok: true, result: { terminals: [{ handle: 'term_unsent' }] } }),
        read: () => (
          poke
            ? pokeRead('term_unsent')
            : {
                ok: true as const,
                result: { terminal: { tail: ['→ разберись', 'Run Everything'] } },
              }
        ),
        submit: (handle: string) => {
          submitted.push(handle);
          return { ok: true as const };
        },
      };
      submitUnsentCursorComposer({ watch: true }, deps, state);
      poke = false;
      return submitUnsentCursorComposer({ watch: true }, deps, state);
    })();
    expect(submitted).toEqual([]);
    expect(resultAfterTyping.terminals[0]?.reason).toBe('manual_input');
  });

  it('does not submit on the first --once read; waits the quiet window then re-reads', () => {
    const submitted: string[] = [];
    let now = 0;
    let reads = 0;
    const result = submitUnsentCursorComposerOnce(
      { terminals: ['term_unsent'] },
      {
        list: () => ({ ok: true, result: { terminals: [] } }),
        read: () => {
          reads += 1;
          return pokeRead('term_unsent');
        },
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
        },
        submit: (handle) => {
          submitted.push(handle);
          return { ok: true };
        },
      },
    );
    expect(reads).toBe(2);
    expect(submitted).toEqual(['term_unsent']);
    expect(result.watch).toBe(false);
    expect(result.terminals[0]?.reason).toBe('enter_sent');
  });
});
