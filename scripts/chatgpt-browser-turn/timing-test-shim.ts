import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { destinationIdentity, reserveDestination } from './coordination.ts';
import { turnExitCode, type TurnResultV1 } from './contracts.ts';
import { fakeTurnPage } from './fixtures/fake-turn-page.ts';
import { readStableInput } from './input.ts';
import { configuredProfileKey } from './storage-common.ts';
import { __testTiming, sendTurn, type BrowserConfig } from './ui-adapter.ts';

export interface Ac3TimingMarks {
  readonly result_produced_ms: number;
  readonly stdout_written_ms: number;
  readonly process_exit_ms: number;
}

interface TimingTurnArgs {
  readonly options: ReadonlyMap<string, string | true>;
}

let clockMs = 0;

export function installAc3TimingClock(): void {
  clockMs = 0;
  __testTiming.now = () => clockMs;
}

export function advanceAc3TimingClock(ms: number): void {
  clockMs += ms;
}

function requiredOption(args: TimingTurnArgs, key: string): string {
  const value = args.options.get(key);
  if (typeof value !== 'string') throw new Error(`argument_required:${key}`);
  return value;
}

function browserConfigFromArgs(args: TimingTurnArgs): BrowserConfig {
  const chatUrl = args.options.get('chat-url');
  return {
    cdp: requiredOption(args, 'cdp'),
    profile: requiredOption(args, 'profile'),
    newChat: false,
    timeoutMs: 60_000,
    ...(typeof chatUrl === 'string' ? { chatUrl } : {}),
  };
}

function writeMarks(marks: Ac3TimingMarks): void {
  const marksFile = process.env.CHATGPT_BROWSER_TURN_AC3_MARKS_FILE;
  if (!marksFile) return;
  writeFileSync(marksFile, `${JSON.stringify(marks)}\n`, 'utf8');
}

function emitTurnResult(result: TurnResultV1, started: number, resultProducedMs: number): number {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  writeMarks({
    result_produced_ms: resultProducedMs,
    stdout_written_ms: performance.now() - started,
    process_exit_ms: performance.now() - started,
  });
  return turnExitCode(result.state);
}

export async function runAc3TimingTurn(args: TimingTurnArgs): Promise<number> {
  const started = performance.now();
  process.env.CHATGPT_BROWSER_TURN_AC3_STARTED_MS = String(started);
  installAc3TimingClock();

  const config = browserConfigFromArgs(args);
  const profileKey = configuredProfileKey(config.profile, config.cdp);
  const snapshot = readStableInput(requiredOption(args, 'input'));
  const destination = destinationIdentity(requiredOption(args, 'output'));
  const reservation = reserveDestination(profileKey, destination.finalPath);

  const fixture = fakeTurnPage({
    dispatchCandidateIds: [],
    serviceObserveDispatch: false,
    serviceFrames: [],
    assistants: [],
  });
  fixture.page.waitForTimeout = async (ms: number) => {
    advanceAc3TimingClock(ms);
  };
  const originalContext = fixture.page.context;
  fixture.page.context = () => ({
    newCDPSession: async () => ({
      send: async () => {},
      on: () => {},
      off: () => {},
      detach: async () => {
        await new Promise<void>(() => {
          const timer = setTimeout(() => {}, 60_000);
          timer.unref();
        });
      },
    }),
  });

  const result = await sendTurn(fixture.page, snapshot.text, config);
  fixture.page.context = originalContext;
  const resultProducedMs = performance.now() - started;

  reservation.release();

  return emitTurnResult({
    schema: 'turn-result/v1',
    state: result.state,
    scope: 'conversation',
    cause: result.cause,
    invocation_id: 'ac3-timing-fixture',
    configured_profile_key: profileKey,
  }, started, resultProducedMs);
}

export function finalizeAc3TimingMarks(): void {
  const marksFile = process.env.CHATGPT_BROWSER_TURN_AC3_MARKS_FILE;
  const startedRaw = process.env.CHATGPT_BROWSER_TURN_AC3_STARTED_MS;
  if (!marksFile || !startedRaw) return;
  try {
    const started = Number(startedRaw);
    const marks = JSON.parse(readFileSync(marksFile, 'utf8').trim()) as Ac3TimingMarks;
    writeMarks({
      ...marks,
      process_exit_ms: performance.now() - started,
    });
  } catch {
    // best-effort timing artifact for subprocess tests
  }
}
