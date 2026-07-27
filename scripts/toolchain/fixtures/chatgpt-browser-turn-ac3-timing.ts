import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { destinationIdentity, reserveDestination } from '../../chatgpt-browser-turn/coordination.ts';
import { turnExitCode, type TurnResultV1 } from '../../chatgpt-browser-turn/contracts.ts';
import { fakeTurnPage } from '../../chatgpt-browser-turn/fixtures/fake-turn-page.ts';
import { readStableInput } from '../../chatgpt-browser-turn/input.ts';
import { configuredProfileKey } from '../../chatgpt-browser-turn/storage-common.ts';
import { __testTiming, sendTurn, type BrowserConfig } from '../../chatgpt-browser-turn/ui-adapter.ts';
import { runProcessSync } from '../../kernel/subprocess.ts';

export interface Ac3TimingMarks {
  readonly result_produced_ms: number;
  readonly stdout_written_ms: number;
}

interface TimingTurnArgs {
  readonly options: ReadonlyMap<string, string | true>;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
let clockMs = 0;

function assertStructuredTurnCliRejection(): void {
  const entry = join(repoRoot, 'scripts', 'chatgpt-browser-turn.ts');
  const observed = runProcessSync({
    command: process.execPath,
    args: ['--experimental-strip-types', entry, 'turn', '--unsupported-option', 'value'],
    cwd: repoRoot,
    inheritParentEnv: true,
  });
  const lines = observed.stdout.trim().split('\n').filter(Boolean);
  if (observed.exitCode !== 22 || lines.length !== 1) {
    throw new Error(`cli_rejection_protocol_mismatch:exit=${observed.exitCode}:lines=${lines.length}`);
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
  } catch {
    throw new Error('cli_rejection_protocol_mismatch:invalid_json');
  }
  if (
    body.schema !== 'control-result/v1'
    || body.operation !== 'status/list'
    || body.state !== 'driver_error'
    || body.configured_profile_key !== 'profile-unresolved'
    || body.cause !== 'command_failed'
  ) {
    throw new Error('cli_rejection_protocol_mismatch:unexpected_result');
  }
}

function installAc3TimingClock(): void {
  clockMs = 0;
  __testTiming.now = () => clockMs;
}

function advanceAc3TimingClock(ms: number): void {
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
  });
  return turnExitCode(result.state);
}

async function runAc3TimingTurn(args: TimingTurnArgs): Promise<number> {
  assertStructuredTurnCliRejection();
  const started = performance.now();
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

  const result = await sendTurn(fixture.page, snapshot.text, config);
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

function parseArgs(argv: readonly string[]): TimingTurnArgs {
  const options = new Map<string, string | true>();
  for (let index = 2; index < argv.length; index++) {
    const token = argv[index] ?? '';
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options.set(key, next);
      index++;
    } else {
      options.set(key, true);
    }
  }
  return { options };
}

async function main(): Promise<void> {
  const code = await runAc3TimingTurn(parseArgs(process.argv));
  process.exit(code);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(22);
});
