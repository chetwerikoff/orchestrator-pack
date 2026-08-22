// @vitest-ci-lane light
// @vitest-pre-topology-seconds 1
import { unlinkSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acquireWatchLock,
  classifyCursorComposer,
  createUnsentComposerWatchState,
  cursorComposerLooksUnsent,
  QUIET_AFTER_PRINT_MS,
  releaseWatchLock,
  submitUnsentCursorComposer,
  submitUnsentCursorComposerOnce,
  type UnsentComposerSubmitDeps,
} from './cursor-unsent-composer-submit.ts';
import type { RuntimeWorker, RuntimeWorkerIdentity } from './runtime/contracts.ts';

const POKE = 'You have 1 orchestration message. Run `orca orchestration check --run run_d613a86c140a`.';
const CURSOR_FOOTER = [
  'Cursor Grok 4.6 High · 40.6% · 22 files edited                                                                                                    Run Everything',
  '~/projects/orchestrator-pack · main',
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

  it('fails closed when an unboxed poke sits under transcript history', () => {
    expect(cursorComposerLooksUnsent(`
Почта обработана.
${POKE}
Cursor Grok 4.6 High · 40.6% · 22 files edited Run Everything
~/projects/orchestrator-pack - main
`)).toBe(false);
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

  it('does not submit an unboxed poke followed by chrome-looking user text', () => {
    expect(classifyCursorComposer(`
${POKE}
Tip: do not send this
Cursor Grok 4.6 High · 40.6% · 22 files edited Run Everything
~/projects/orchestrator-pack · main
`)).toBe('manual');
  });

  it('does not strip unboxed user text that only starts like Cursor footer chrome', () => {
    const footer = CURSOR_FOOTER.join('\n');
    expect(classifyCursorComposer(`${POKE}\nCursor please keep this\n${footer}`)).toBe('manual');
    expect(classifyCursorComposer(`${POKE}\nGPT-please keep this\n${footer}`)).toBe('manual');
    expect(classifyCursorComposer(`${POKE}\nComposer note keep this\n${footer}`)).toBe('manual');
    expect(classifyCursorComposer(`${POKE}\n~/projects/foo\n${footer}`)).toBe('manual');
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

describe('submitUnsentCursorComposer', () => {
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

  it('skips ordinary typing', () => {
    const submitted: RuntimeWorkerIdentity[] = [];
    const result = submitUnsentCursorComposer(
      { terminals: ['term_typing'] },
      depsFor(
        { term_typing: ['→ разберись почему', 'Run Everything'] },
        { submitted },
      ),
    );
    expect(submitted).toEqual([]);
    expect(result.terminals[0]?.reason).toBe('manual_input');
  });

  it('waits 10s after the poke stops changing and does not resend', () => {
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
            return { ok: true as const, lines: identity.id === 'term_unsent' ? [POKE, ...CURSOR_FOOTER] : ['→ Add a follow-up'] };
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

  it('keeps the 10s quiet window across a fresh scheduler tick process', () => {
    const sentStorePath = join(tmpdir(), `opk-unsent-watch-${process.pid}-${Date.now()}.json`);
    const submitted: RuntimeWorkerIdentity[] = [];
    let now = 0;
    const deps = depsFor(
      { term_unsent: [POKE, ...CURSOR_FOOTER] },
      { submitted, sentStorePath, now: () => now },
    );
    try {
      const first = submitUnsentCursorComposer({ watch: true }, deps, createUnsentComposerWatchState());
      now = QUIET_AFTER_PRINT_MS;
      const second = submitUnsentCursorComposer({ watch: true }, deps, createUnsentComposerWatchState());
      expect(first.terminals[0]?.reason).toBe('waiting_stable');
      expect(second.terminals[0]?.reason).toBe('enter_sent');
      expect(submitted).toHaveLength(1);
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
