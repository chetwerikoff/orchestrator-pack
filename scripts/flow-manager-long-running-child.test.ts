import { createHash } from 'node:crypto';
import { runProcess } from './kernel/subprocess.ts';
import {
  chmodSync,
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  COMPLETION_MODE,
  GITHUB_EFFECT_BASELINE_SCHEMA,
  HANDOFF_SCHEMA,
  RECEIPT_LOCATOR_SCHEMA,
  REFUSAL_COMPANION_ENV,
  REFUSAL_COMPANION_SCHEMA,
  TERMINAL_ENVELOPE_NAME_SUFFIX,
  TERMINAL_ENVELOPE_ROOT,
  TERMINAL_SCHEMA,
  classifyGithubEffect,
  deriveDelivery,
  ensureDurableArtifactRoot,
  isWakeableTerminalEnvelopePath,
  launchConfigFromArgv,
  observeOriginalLauncher,
  observeOwnerCurrency,
  parseGithubEffectBaseline,
  procProcessWitnessProbe,
  readPredecessorReceiptLocator,
  refusalCompanionPath,
  resolveDurableArtifactPath,
  resolveDurableArtifactRoot,
  sameHandoffIdentity,
  validateLaunchPreSpawn,
  invocationReceiptLocatorPath,
  pathsAlias,
  readInvocationReceiptLocator,
  readHandoffReceipt,
  readTerminalEnvelope,
  runLaunch,
  runWait,
  type GithubEffectBaseline,
  type GithubEffectReaders,
  type HandoffReceipt,
  type LaunchConfig,
  type LaunchDeadlineTestControl,
  type OwnerWaitDependencies,
  type OwnerWaitPageReader,
  type ParsedTurnResult,
  type ProcessWitnessProbe,
} from './flow-manager-long-running-child.ts';
import {
  ADAPTER_PACKAGE_COMMAND,
  LAUNCHER_PACKAGE_COMMAND,
  type BrowserAdapterDependencies,
  runBrowserAdapter,
  spawnDetachedLauncher,
} from './flow-manager-browser-gpt-long-run.ts';
import type { TurnResultV1 } from './chatgpt-browser-turn/contracts.ts';
import { buildBrowserTurnCancellationReceipt } from './chatgpt-browser-turn/state-light-cancellation.ts';
import { configuredProfileKey } from './chatgpt-browser-turn/storage-common.ts';
import {
  resolveBrowserTurnLivenessTiming,
  validateBrowserTurnLivenessTiming,
} from './chatgpt-browser-turn/liveness-contract.ts';
import {
  admitStateLightTurnObservation,
  bindStateLightOwnedTarget,
  bindPrimaryPublication,
  observationRecordPath,
  readStateLightTurnObservation,
  transitionStateLightTurnObservation,
  type StateLightTurnObservationRecord,
} from './chatgpt-browser-turn/state-light-turn-observation.ts';
import {
  prAuthorClaimReason,
  prAuthorDurableArtifactRoot,
  scanPrAuthorCandidates,
  writeGithubEffectBaselineToReceipt,
} from './chatgpt-browser-turn/state-light-turn-base.ts';
import { listTerminalEnvelopes } from './fleet/fleet-wake.ts';
import {
  WORKER_ASSIGNMENT_SCHEMA,
  WORKER_ASSIGNMENT_STORE_SCHEMA,
  resolveWorkerAssignmentStorePath,
  workerAssignmentKey,
} from './lib/worker-assignment-store.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const launcherPath = join(repoRoot, 'scripts/flow-manager-long-running-child.ts');
const adapterPath = join(repoRoot, 'scripts/flow-manager-browser-gpt-long-run.ts');
const skillPath = join(repoRoot, '.cursor/skills/create-issue-draft/SKILL.md');
const rulePath = join(repoRoot, '.cursor/rules/flow-manager-browser-turn-monitoring.mdc');
const runbookPath = join(repoRoot, 'docs/flow-manager-long-running-child-runbook.md');
const browserReadmePath = join(repoRoot, 'scripts/chatgpt-browser-turn/README.md');
const livenessContractUrl = pathToFileURL(join(repoRoot, 'scripts/chatgpt-browser-turn/liveness-contract.ts')).href;
const packageJsonPath = join(repoRoot, 'package.json');

// Module-evaluation preflight: a legacy live-root allocator must fail before any fixture is created.
// Inspect this source file only; never stat, list or resolve the live wake-root itself.
function assertAllocatorSourceSafe(source: string): void {
  if (/function\s+tempDir\s*\([^)]*\bbase\s*:\s*string\s*=\s*TERMINAL_ENVELOPE_ROOT/u.test(source)
    || /mkdtempSync\s*\(\s*join\s*\(\s*TERMINAL_ENVELOPE_ROOT/u.test(source)) {
    throw new Error('unsafe_fixture_allocator_live_wake_root');
  }
}
assertAllocatorSourceSafe(readFileSync(fileURLToPath(import.meta.url), 'utf8'));

const CLI_FIXTURE_GATE_ENV = 'OPK_FM_LONG_CHILD_TEST_GATE';
const CLI_FIXTURE_ROOT_ENV = 'OPK_FM_LONG_CHILD_TEST_TERMINAL_ROOT';
function cliFixtureEnv(root: string): Record<string, string> {
  return { [CLI_FIXTURE_GATE_ENV]: 'fixture-root-v1', [CLI_FIXTURE_ROOT_ENV]: root };
}

// Validate the full mkdtemp prefix (including the effective parent) before any filesystem mutation.
// Canonicalize only the wake root's safe parent, not the live wake root or its artifacts.
function plannedFixturePrefix(prefix: string, parent: string, protectedRoot = TERMINAL_ENVELOPE_ROOT): string {
  if (!prefix || prefix === '.' || prefix === '..' || isAbsolute(prefix) || /[/\\]/u.test(prefix)
    || basename(prefix) !== prefix) {
    throw new Error('unsafe_fixture_prefix');
  }
  const protectedPath = resolve(protectedRoot);
  const parentPath = resolve(parent);
  const plannedPath = resolve(parentPath, prefix);
  const inside = (candidate: string, root: string): boolean =>
    candidate === root || candidate.startsWith(root + sep);
  if (inside(parentPath, protectedPath) || inside(plannedPath, protectedPath)) {
    throw new Error('unsafe_fixture_live_wake_destination');
  }
  const canonicalProtected = protectedRoot === TERMINAL_ENVELOPE_ROOT
    ? join(realpathSync(dirname(protectedPath)), basename(protectedPath))
    : realpathSync(protectedPath);
  const canonicalParent = realpathSync(parentPath);
  if (inside(canonicalParent, canonicalProtected)
    || inside(resolve(canonicalParent, prefix), canonicalProtected)) {
    throw new Error('unsafe_fixture_canonical_wake_destination');
  }
  return join(canonicalParent, prefix);
}

const cleanupDirs: string[] = [];

beforeEach(() => {
  process.env.OPK_BROWSER_TURN_STARTUP_ALLOWANCE_MS = '500';
  process.env.OPK_BROWSER_TURN_MAX_HEALTHY_HEARTBEAT_GAP_MS = '50';
  process.env.OPK_BROWSER_TURN_LIVE_CHILD_IDLE_WINDOW_MS = '150';
});

function tempDir(prefix = 'opk-fm-long-child-'): string {
  const dir = mkdtempSync(plannedFixturePrefix(prefix, tmpdir()));
  cleanupDirs.push(dir);
  return dir;
}

function runFixtureLaunch(root: string, config: LaunchConfig): Promise<number> {
  if (!cleanupDirs.includes(root) || !resolve(config.terminalEnvelopePath).startsWith(resolve(root) + sep)) {
    throw new Error('launcher_fixture_root_not_allocated');
  }
  return runLaunch({ ...config, terminalEnvelopeRoot: root });
}

afterEach(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs.length = 0;
  delete process.env.OPK_FM_LONG_CHILD_FORCE_RECEIPT_CREATE_FAIL;
  delete process.env.OPK_FM_LONG_CHILD_FORCE_ENVELOPE_CREATE_FAIL;
  delete process.env.OPK_FM_LONG_CHILD_DISABLE_DETACH;
  delete process.env.OPK_FM_LONG_CHILD_CANDIDATE_GRACE_MS;
  delete process.env.OPK_FM_LONG_CHILD_NO_CANDIDATE_GRACE_MS;
  delete process.env.OPK_FM_LONG_CHILD_HARD_DEADLINE_MS;
  delete process.env.OPK_BROWSER_TURN_STARTUP_ALLOWANCE_MS;
  vi.unstubAllEnvs();
  delete process.env.OPK_BROWSER_TURN_MAX_HEALTHY_HEARTBEAT_GAP_MS;
  delete process.env.OPK_BROWSER_TURN_LIVE_CHILD_IDLE_WINDOW_MS;
});

function makeTurnResult(overrides: Partial<TurnResultV1> = {}): TurnResultV1 {
  return {
    schema: 'turn-result/v1',
    state: 'ok',
    scope: 'none',
    cause: 'ok',
    invocation_id: 'fixture-inv',
    configured_profile_key: 'fixture-profile',
    conversation_id: 'conv-uuid',
    witness: {
      user_message_id: 'u1',
      assistant_message_id: 'a1',
      relation: 'reply_to',
      source: 'service',
    },
    observation_uncertainty_diagnostics: {
      cause: 'ok',
      send_count: 1,
      owned_prompt_seen: true,
    },
    ...overrides,
  };
}

function nodeFixture(source: string): { command: string; args: string[] } {
  return { command: process.execPath, args: ['-e', source] };
}

type ControlledDeadlineEvent = Parameters<NonNullable<LaunchDeadlineTestControl['onEvent']>>[0];

function controlledDeadlineClock(): {
  control: LaunchDeadlineTestControl;
  setTime: (time: number) => void;
  pulseWatchdog: () => void;
  observed: (kind: ControlledDeadlineEvent['kind'], ordinal?: number) => Promise<ControlledDeadlineEvent>;
} {
  let time = Date.parse('2026-10-20T00:00:00.000Z');
  const history: ControlledDeadlineEvent[] = [];
  const changed: Array<() => void> = [];
  const waitingWatchdog: Array<() => void> = [];
  let permits = 0;
  return {
    control: {
      now: () => time,
      onEvent(event) {
        history.push(event);
        for (const notify of changed.splice(0)) notify();
      },
      awaitWatchdogTurn: () => new Promise<void>((resolve) => {
        if (permits > 0) { permits -= 1; resolve(); }
        else waitingWatchdog.push(resolve);
      }),
    },
    setTime: (value) => { time = value; },
    pulseWatchdog: () => {
      const wake = waitingWatchdog.shift();
      if (wake) wake();
      else permits += 1;
    },
    async observed(kind, ordinal = 1) {
      const deadline = Date.now() + 10_000; // safety timeout only; never pass evidence
      while (true) {
        const matches = history.filter((event) => event.kind === kind);
        if (matches.length >= ordinal) return matches[ordinal - 1]!;
        if (Date.now() >= deadline) throw new Error('parent did not observe ' + kind + '#' + ordinal);
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 50);
          changed.push(() => { clearTimeout(timeout); resolve(); });
        });
      }
    },
  };
}

// A real Node child acknowledges its own start and waits for each explicit emit.
function controlledNodeFixture(root: string, lines: string[]): {
  fixture: ReturnType<typeof nodeFixture>;
  ready: string;
  emit: (ordinal: number) => void;
} {
  const ready = join(root, 'controlled-child-ready');
  const gates = lines.map((_, index) => join(root, 'controlled-child-emit-' + (index + 1)));
  const script = [
    "const fs = require('node:fs');",
    `const ready = ${JSON.stringify(ready)};`,
    `const gates = ${JSON.stringify(gates)};`,
    `const lines = ${JSON.stringify(lines)};`,
    "fs.writeFileSync(ready, 'ready');",
    "(async () => {",
    "  for (let index = 0; index < lines.length; index += 1) {",
    "    while (!fs.existsSync(gates[index])) await new Promise((resolve) => setTimeout(resolve, 5));",
    "    process.stdout.write(lines[index] + '\\n');",
    "  }",
    "  setInterval(() => {}, 1000);",
    "})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });",
  ].join('\n');
  return {
    fixture: nodeFixture(script),
    ready,
    emit(ordinal) {
      if (ordinal < 1 || ordinal > gates.length) throw new Error('invalid child emit step');
      writeFileSync(gates[ordinal - 1]!, 'emit');
    },
  };
}

async function awaitControlledChildReady(path: string): Promise<void> {
  const deadline = Date.now() + 10_000; // failure bound, not an ordering assertion
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error('real child never signalled readiness');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function launchControlledDeadlineScenario(root: string, id: string, lines: string[]) {
  const paths = launchPaths(root, id);
  const child = controlledNodeFixture(root, lines);
  const clock = controlledDeadlineClock();
  const completion = runFixtureLaunch(root, {
    runIdentity: 'run-' + id, attemptIdentity: 'attempt-' + id,
    handoffReceiptPath: paths.receipt, terminalEnvelopePath: paths.envelope,
    browserOutputPath: paths.output, cwd: repoRoot,
    childCommand: child.fixture.command, childArgs: child.fixture.args,
    deadlineTestControl: clock.control,
  });
  return { paths, child, clock, completion };
}

async function cleanupControlledDeadlineScenario(
  scenario: ReturnType<typeof launchControlledDeadlineScenario>,
): Promise<void> {
  scenario.clock.setTime(Date.parse('2100-01-01T00:00:00.000Z'));
  scenario.clock.pulseWatchdog();
  try { await scenario.completion; } catch { /* Preserve the assertion error. */ }
}

function launchPaths(root: string, id: string): {
  receipt: string;
  envelope: string;
  output: string;
} {
  const attempt = join(root, id);
  return {
    receipt: join(attempt, 'handoff-receipt.json'),
    envelope: join(attempt, 'turn-terminal.json'),
    output: join(attempt, 'browser-output.txt'),
  };
}

async function runLauncherCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await runProcess({
    command: process.execPath,
    args: ['--experimental-strip-types', launcherPath, ...args],
    cwd: repoRoot,
    env,
    inheritParentEnv: false, // drop inherited fixture gates, NODE_OPTIONS and test-runner signals
    allowEmptyStdout: true,
    timeoutMs: 120_000,
  });
  return { code: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function cliLaunchArgs(paths: ReturnType<typeof launchPaths>, fixture: ReturnType<typeof nodeFixture>): string[] {
  return [
    'launch', '--run-identity', 'run-2440', '--attempt-identity', 'attempt-2440',
    '--handoff-receipt', paths.receipt, '--terminal-envelope', paths.envelope,
    '--browser-output', paths.output, '--cwd', repoRoot, '--child-command', fixture.command,
    '--', ...fixture.args,
  ];
}

function markedChildFixture(marker: string, result: TurnResultV1): ReturnType<typeof nodeFixture> {
  return nodeFixture('require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "started");'
    + 'process.stdout.write(JSON.stringify(' + JSON.stringify(result) + ') + "\\n", () => process.exit(0));');
}

function expectNoLauncherEffects(paths: ReturnType<typeof launchPaths>, marker: string, envelope = paths.envelope): void {
  for (const artifact of [paths.receipt, envelope, paths.output, marker]) {
    expect(existsSync(artifact)).toBe(false);
  }
}

function makeParsedTurnResult(
  overrides: Partial<TurnResultV1> & { resolved_send_count?: number } = {},
): ParsedTurnResult {
  const { resolved_send_count: explicitSendCount, ...turnOverrides } = overrides;
  const base = makeTurnResult(turnOverrides);
  const resolved_send_count =
    explicitSendCount ??
    turnOverrides.observation_uncertainty_diagnostics?.send_count ??
    base.observation_uncertainty_diagnostics?.send_count ??
    0;
  return { ...base, resolved_send_count };
}

async function launchReceiptScenario(input: {
  id: string;
  receipt: object;
  cdp: string;
  profile: string;
  invocation: string;
  childProfile?: string;
  childInvocation?: string;
}): Promise<ReturnType<typeof readTerminalEnvelope>> {
  const root = tempDir(`opk-1377-${input.id}-`);
  const paths = launchPaths(root, input.id);
  const fixture = nodeFixture(`
    process.stdout.write(JSON.stringify(${JSON.stringify(input.receipt)}) + '\\n', () => process.exit(0));
  `);
  process.env.OPK_FM_LONG_CHILD_NO_CANDIDATE_GRACE_MS = '200';
  const code = await runFixtureLaunch(root, {
    runIdentity: `run-${input.id}`,
    attemptIdentity: `attempt-${input.id}`,
    handoffReceiptPath: paths.receipt,
    terminalEnvelopePath: paths.envelope,
    browserOutputPath: paths.output,
    cwd: repoRoot,
    childCommand: fixture.command,
    childArgs: [
      ...fixture.args,
      '--',
      '--cdp', input.cdp,
      '--profile', input.childProfile ?? input.profile,
      '--invocation-id', input.childInvocation ?? input.invocation,
    ],
  });
  expect(code).toBe(1);
  return readTerminalEnvelope(paths.envelope);
}

describe('safe fixture allocator preflight (#2440)', () => {
  // Simulated mutation stage: rejected destinations must never reach any filesystem-writing operation.
  function expectRejectedWithoutWrites(validate: () => string): void {
    const mkdir = vi.fn();
    const mkdtemp = vi.fn();
    const write = vi.fn();
    const cleanup = vi.fn();
    expect(() => {
      const planned = validate();
      mkdir(planned); mkdtemp(planned); write(planned); cleanup(planned);
    }).toThrow(/unsafe_fixture_/u);
    for (const op of [mkdir, mkdtemp, write, cleanup]) expect(op).not.toHaveBeenCalled();
  }

  it('rejects the legacy default and direct live-root mkdtemp by read-only source inspection', () => {
    const oldDefault = 'function tempDir(prefix = "old-", base: string = '
      + 'TERMINAL_ENVELOPE_ROOT) { return mkdtempSync(join(base, prefix)); }';
    const directRoot = 'function tempDir(prefix: string) { return '
      + 'mkdtempSync(join(' + 'TERMINAL_ENVELOPE_ROOT, prefix)); }';
    expect(() => assertAllocatorSourceSafe(oldDefault)).toThrow('unsafe_fixture_allocator_live_wake_root');
    expect(() => assertAllocatorSourceSafe(directRoot)).toThrow('unsafe_fixture_allocator_live_wake_root');
    expect(() => assertAllocatorSourceSafe(readFileSync(fileURLToPath(import.meta.url), 'utf8'))).not.toThrow();
  });

  it.each(['', '.', '..', '/tmp/opencode/fixture-', 'opencode/fixture-', '../opencode/fixture-', '\\opencode\\fixture-'])(
    'rejects a non-basename allocation prefix without any write: %s', (prefix) => {
      expectRejectedWithoutWrites(() => plannedFixturePrefix(prefix, tmpdir()));
    },
  );

  it('rejects a literal live wake-root parent lexically, without inspecting that directory', () => {
    expectRejectedWithoutWrites(() => plannedFixturePrefix('fixture-', TERMINAL_ENVELOPE_ROOT));
    expectRejectedWithoutWrites(() => plannedFixturePrefix('fixture-', join(TERMINAL_ENVELOPE_ROOT, 'nested')));
  });

  it('rejects a synthetic protected destination and symlink-parent aliases canonically', () => {
    const root = tempDir('opk-2440-guard-');
    const protectedRoot = join(root, 'protected');
    const alias = join(root, 'alias');
    const suppliedParent = join(root, 'supplied-parent');
    mkdirSync(protectedRoot);
    symlinkSync(protectedRoot, alias);
    symlinkSync(alias, suppliedParent);
    expectRejectedWithoutWrites(() => plannedFixturePrefix('protected', root, protectedRoot));
    expectRejectedWithoutWrites(() => plannedFixturePrefix('fixture-', protectedRoot, protectedRoot));
    expectRejectedWithoutWrites(() => plannedFixturePrefix('fixture-', alias, protectedRoot));
    expectRejectedWithoutWrites(() => plannedFixturePrefix('fixture-', suppliedParent, protectedRoot));
  });
});

describe('observable post-send exits (#2416)', () => {
  it.each(['throw', 'SIGTERM', 'SIGKILL', 'timeout', 'launcher-SIGTERM'] as const)('preserves persisted sent_unbound evidence after %s', async (exit) => {
    const root = tempDir('opk-2416-');
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', join(root, 'state'));
    // Leave room for cold module startup and filesystem-backed observation writes under parallel CI load.
    // A post-send heartbeat distinguishes the persistence scenario from startup timeout behavior.
    vi.stubEnv('OPK_BROWSER_TURN_STARTUP_ALLOWANCE_MS', '5000');
    const paths = launchPaths(root, exit);
    const profile = join(root, 'profile');
    const cdp = 'http://127.0.0.1:1';
    const invocation = `inv-2416-${exit}`;
    const profileKey = configuredProfileKey(profile, cdp);
    const observationUrl = pathToFileURL(join(repoRoot, 'scripts/chatgpt-browser-turn/state-light-turn-observation.ts')).href;
    const terminate = exit === 'throw' ? 'throw new Error("post_send_fixture_throw");'
      : exit === 'timeout' ? 'setInterval(() => {}, 1000);'
      : exit === 'launcher-SIGTERM' ? 'process.kill(process.ppid, "SIGTERM"); setInterval(() => {}, 1000);'
      : `process.kill(process.pid, '${exit}');`;
    const fixture = nodeFixture(`(async () => {
      const { admitStateLightTurnObservation, transitionStateLightTurnObservation } = await import(${JSON.stringify(observationUrl)});
      const profileKey = ${JSON.stringify(profileKey)}; const invocationId = ${JSON.stringify(invocation)};
      admitStateLightTurnObservation({ profileKey, invocationId, marker: 'OPKTURNV1a97e3f70e9c07fa75c0f03840c0528a2' });
      // Deterministic synchronous preparation/descheduling stall.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
      transitionStateLightTurnObservation({ profileKey, invocationId, phase: 'dispatching', reason: 'fixture_dispatch' });
      transitionStateLightTurnObservation({ profileKey, invocationId, phase: 'sent_unbound', reason: 'send_observed_fresh_chat', sendCount: 1, sendWitness: 'numeric_send_count' });
      const heartbeat = { schema: 'observation-heartbeat/v1', phase: 'post_send_observation', poll_count: 1, observation_state: 'busy', stable_reads: 0, completion_ready: false };
      process.stdout.write(JSON.stringify(heartbeat) + '\\n', () => { ${terminate} });
    })();`);
    const config = {
      runIdentity: 'run-2416', attemptIdentity: `attempt-${exit}`,
      handoffReceiptPath: paths.receipt, terminalEnvelopePath: paths.envelope,
      terminalEnvelopeRoot: root, browserOutputPath: paths.output, cwd: repoRoot,
      childCommand: fixture.command, childArgs: [...fixture.args, '--', '--profile', profile, '--cdp', cdp, '--invocation-id', invocation],
    };
    if (exit === 'launcher-SIGTERM') {
      const wrapper = join(root, 'launcher.mjs');
      const launcherUrl = pathToFileURL(launcherPath).href;
      writeFileSync(wrapper, `import { runLaunch } from ${JSON.stringify(launcherUrl)}; process.exitCode = await runLaunch(${JSON.stringify(config)});`);
      const result = await runProcess({ command: process.execPath, args: ['--experimental-strip-types', wrapper],
        inheritParentEnv: true, allowEmptyStdout: true, timeoutMs: 10_000 });
      expect(result.exitCode).toBe(1);
    } else {
      expect(await runLaunch(config)).toBe(1);
    }
    expect(readTerminalEnvelope(paths.envelope)).toMatchObject({
      schema: TERMINAL_SCHEMA, lifecycle_outcome: 'incident', delivery: 'POSSIBLY_DELIVERED',
      incident: exit === 'timeout' ? 'child_liveness_timeout'
        : exit === 'launcher-SIGTERM' ? 'launcher_signal:SIGTERM' : 'child_terminal_result_missing',
      send_count: 1, observed_invocation_id: invocation, recovery_available: false,
      diagnostics: { persisted_observation: { phase: 'sent_unbound', send_count: 1 } },
    });
  });

  it.each(['unique', 'unrelated', 'duplicate', 'closed', 'incomplete', 'launcher-exception'])('recovery requires unique exact owned-tab proof: %s', async (mode) => {
    const owned = mode === 'unique' || mode === 'launcher-exception';
    const root = tempDir('opk-2416-owned-');
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', join(root, 'state'));
    const paths = launchPaths(root, 'owned');
    const profile = join(root, 'profile');
    const cdp = 'http://127.0.0.1:1';
    const invocationId = 'inv-owned';
    const profileKey = configuredProfileKey(profile, cdp);
    const marker = 'OPKTURNV1a97e3f70e9c07fa75c0f03840c0528a2';
    admitStateLightTurnObservation({ profileKey, invocationId, marker });
    transitionStateLightTurnObservation({ profileKey, invocationId, phase: 'dispatching', reason: 'fixture' });
    transitionStateLightTurnObservation({ profileKey, invocationId, phase: 'sent_unbound', reason: 'fixture', sendCount: 1, sendWitness: 'numeric_send_count' });
    const url = 'https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc';
    const stop = vi.fn();
    const releaseBrowser = vi.fn(async () => {});
    const fixture = nodeFixture('throw new Error("post-send");');
    await runFixtureLaunch(root, { runIdentity: 'run', attemptIdentity: 'attempt', handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope, terminalEnvelopeRoot: root, browserOutputPath: paths.output,
      cwd: repoRoot, childCommand: mode === 'launcher-exception' ? '' : fixture.command,
      childArgs: [...fixture.args, '--', '--profile', profile, '--cdp', cdp, '--invocation-id', invocationId],
      conversationLocator: url, cancellationDependencies: {
        connect: async () => ({ contexts: () => [] }), releaseBrowser, stop,
        enumeratePages: async () => Array.from({ length: mode === 'duplicate' ? 2 : 1 }, () => ({ url: () => url, isClosed: () => mode === 'closed' })),
        readUserMessages: async () => ({ messages: [{ role: 'user', text: mode === 'unrelated' ? 'unrelated' : marker }], incomplete: mode === 'incomplete' }),
      },
    });
    const envelope = readTerminalEnvelope(paths.envelope);
    expect(envelope?.recovery_available).toBe(owned);
    expect(envelope?.conversation_locator).toBe(owned ? url : undefined);
    expect(envelope?.incident).toBe(mode === 'launcher-exception' ? 'launcher_exception' : 'child_terminal_result_missing');
    expect(envelope).toMatchObject({ delivery: 'POSSIBLY_DELIVERED', send_count: 1, diagnostics: { persisted_observation: { phase: 'sent_unbound' } } });
    expect(stop).not.toHaveBeenCalled();
    expect(releaseBrowser).toHaveBeenCalledOnce();
  });

  it('preserves an authoritative result completing across launcher SIGTERM (review race)', async () => {
    const root = tempDir('opk-2416-race-');
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', join(root, 'state'));
    vi.stubEnv('OPK_FM_LONG_CHILD_CANDIDATE_GRACE_MS', '300');
    vi.stubEnv('OPK_FM_LONG_CHILD_NO_CANDIDATE_GRACE_MS', '300');
    const paths = launchPaths(root, 'signal-race');
    const profile = join(root, 'profile');
    const cdp = 'http://127.0.0.1:1';
    const invocationId = 'inv-signal-race';
    const profileKey = configuredProfileKey(profile, cdp);
    admitStateLightTurnObservation({ profileKey, invocationId, marker: 'OPKTURNV1a97e3f70e9c07fa75c0f03840c0528a2' });
    transitionStateLightTurnObservation({ profileKey, invocationId, phase: 'dispatching', reason: 'fixture' });
    transitionStateLightTurnObservation({ profileKey, invocationId, phase: 'sent_unbound', reason: 'fixture', sendCount: 1, sendWitness: 'numeric_send_count' });
    const result = makeTurnResult({ invocation_id: invocationId });
    const fixture = nodeFixture(`
      let termReceived = false;
      process.on('SIGTERM', () => { termReceived = true; });
      setTimeout(() => process.kill(process.ppid, 'SIGTERM'), 200);
      setTimeout(() => { process.stdout.write(JSON.stringify({ ...${JSON.stringify(result)}, cause: termReceived ? 'signal_received' : 'signal_missing' }) + '\\n'); process.exit(0); }, 260);
    `);
    const config = { runIdentity: 'run-race', attemptIdentity: 'attempt-race', handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope, terminalEnvelopeRoot: root, browserOutputPath: paths.output, cwd: repoRoot,
      childCommand: fixture.command, childArgs: [...fixture.args, '--', '--profile', profile, '--cdp', cdp, '--invocation-id', invocationId] };
    const wrapper = join(root, 'launcher.mjs');
    writeFileSync(wrapper, `
      import { runLaunch } from ${JSON.stringify(pathToFileURL(launcherPath).href)};
      process.exitCode = await runLaunch({ ...${JSON.stringify(config)}, cancellationDependencies: {
        connect: async () => { await new Promise(done => setTimeout(done, 150)); return { contexts: () => [] }; },
        releaseBrowser: async () => {}, enumeratePages: async () => [],
      } });
    `);
    const launched = await runProcess({ command: process.execPath, args: ['--experimental-strip-types', wrapper],
      inheritParentEnv: true, allowEmptyStdout: true, timeoutMs: 10_000 });
    expect(launched.exitCode).toBe(0);
    expect(readTerminalEnvelope(paths.envelope)).toMatchObject({
      lifecycle_outcome: 'success', delivery: 'landed', turn_result_state: 'ok', observed_invocation_id: invocationId,
      turn_result_cause: 'signal_received',
    });
  });

  it('retains cancellation and heartbeat witnesses alongside the exact persisted phase', async () => {
    const root = tempDir('opk-2416-combined-');
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', join(root, 'state'));
    const paths = launchPaths(root, 'combined');
    const profile = join(root, 'profile');
    const cdp = 'http://127.0.0.1:1';
    const invocationId = 'inv-combined';
    const profileKey = configuredProfileKey(profile, cdp);
    const marker = 'OPKTURNV1a97e3f70e9c07fa75c0f03840c0528a2';
    const conversationUrl = 'https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc';
    admitStateLightTurnObservation({ profileKey, invocationId, marker });
    transitionStateLightTurnObservation({ profileKey, invocationId, phase: 'dispatching', reason: 'fixture' });
    transitionStateLightTurnObservation({ profileKey, invocationId, phase: 'sent_unharvested', reason: 'fixture', sendCount: 1, sendWitness: 'numeric_send_count', conversationUrl });
    const receipt = buildBrowserTurnCancellationReceipt({ invocationId, profileKey, marker, conversationUrl, sendCount: 1 });
    const heartbeat = { schema: 'observation-heartbeat/v1', phase: 'post_send_observation', poll_count: 1, observation_state: 'busy', stable_reads: 0, completion_ready: false };
    const fixture = nodeFixture(`process.stdout.write(${JSON.stringify(JSON.stringify(receipt) + '\n' + JSON.stringify(heartbeat) + '\n')});`);
    await runFixtureLaunch(root, { runIdentity: 'run', attemptIdentity: 'attempt', handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope, terminalEnvelopeRoot: root, browserOutputPath: paths.output, cwd: repoRoot,
      childCommand: fixture.command, childArgs: [...fixture.args, '--', '--profile', profile, '--cdp', cdp, '--invocation-id', invocationId] });
    expect(readTerminalEnvelope(paths.envelope)).toMatchObject({
      delivery: 'POSSIBLY_DELIVERED', send_count: 1, recovery_available: false,
      turn_result_cause: 'child_terminal_result_missing_cancellation_authority_absent',
      diagnostics: { persisted_observation: { phase: 'sent_unharvested', send_count: 1 },
        last_heartbeat: { phase: 'post_send_observation' },
        cancellation: { stop_outcome: 'not_attempted_authority_absent', identity_proven: false } },
    });
  });

});

describe('Issue #2641 counted unbound fresh Page manager terminal projection', () => {
  it.each([
    ['local-alert', 'recovery_required', 'product_network_error'],
    ['silent-local', 'observation_uncertain', 'fresh_conversation_owner_unproven'],
  ] as const)('forwards operator next_action and POSSIBLY_DELIVERED for %s (#2641 AC6)', async (scenario, state, cause) => {
    const root = tempDir('opk-2641-local-');
    const paths = launchPaths(root, scenario);
    const nextAction =
      'Delivery is POSSIBLY_DELIVERED. Reconcile the original invocation against its exact bound GitHub target and original Page; '
      + 'use page-probe only as a diagnostic, never as proof of completion or no Send. Do not retry or create a replacement invocation; '
      + 'if exact target or Page evidence is unavailable, ask the original Task/Dispatch owner to continue reconciliation.';
    const raw = {
      ...makeTurnResult({
        state, cause, scope: 'invocation', conversation_id: undefined,
        witness: undefined, next_action: nextAction,
        observation_uncertainty_diagnostics: {
          cause, send_count: 1, owned_prompt_seen: false,
        },
      }),
      send_count: 1,
      ...(scenario === 'local-alert' ? { product_banner_text: 'Network error' } : {}),
    };
    const fixture = nodeFixture('process.stdout.write(JSON.stringify('
      + JSON.stringify(raw) + ') + "\\n", () => process.exit(11));');
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-2641-' + scenario,
      attemptIdentity: 'attempt-2641-' + scenario,
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(1);
    const envelope = readTerminalEnvelope(paths.envelope);
    expect(envelope).toMatchObject({
      schema: TERMINAL_SCHEMA,
      lifecycle_outcome: 'incident',
      incident: 'child_turn_state:' + state,
      delivery: 'POSSIBLY_DELIVERED',
      turn_result_state: state,
      turn_result_cause: cause,
      send_count: 1,
      next_action: nextAction,
      recovery_available: false,
    });
    expect(envelope).not.toHaveProperty('conversation_locator');
    expect(envelope?.next_action).toContain('exact bound GitHub target and original Page');
    expect(envelope?.next_action).toContain('page-probe only as a diagnostic');
    expect(envelope?.next_action).toContain('Do not retry or create a replacement invocation');
    expect(envelope?.next_action).toContain('original Task/Dispatch owner');
    expect(existsSync(paths.envelope)).toBe(true);
  });
});

describe('flow-manager long-running child (#1164)', () => {
  it('projects only bounded holder diagnostics through the persisted terminal (#2487)', async () => {
    for (const [label, extras, expected] of [
      ['stable', {
        send_slot_holder_invocation_id: 'holder-2487',
        send_slot_holder_phase: 'prepared',
      }, {
        send_slot_holder_invocation_id: 'holder-2487',
        send_slot_holder_phase: 'prepared',
      }],
      ['uncorrelatable', {
        send_slot_holder_invocation_id: 'invalid holder: private path',
        send_slot_holder_phase: 'user supplied text',
      }, {
        send_slot_holder_invocation_id: 'unknown',
        send_slot_holder_phase: 'unknown',
      }],
    ] as const) {
      const root = tempDir('opk-2487-projection-');
      const paths = launchPaths(root, label);
      const result = makeTurnResult({
        state: 'send_failed', scope: 'invocation',
        cause: 'state_light_new_chat_send_slot_timeout',
        invocation_id: 'waiter-2487',
        observation_uncertainty_diagnostics: {
          cause: 'state_light_new_chat_send_slot_timeout',
          send_count: 0,
          owned_prompt_seen: false,
        },
        ...extras,
      });
      const fixture = nodeFixture(`process.stdout.write(${JSON.stringify(JSON.stringify(result) + '\n')})`);
      const code = await runFixtureLaunch(root, {
        runIdentity: `run-2487-${label}`,
        attemptIdentity: `attempt-2487-${label}`,
        handoffReceiptPath: paths.receipt,
        terminalEnvelopePath: paths.envelope,
        browserOutputPath: paths.output,
        cwd: repoRoot,
        childCommand: fixture.command,
        childArgs: fixture.args,
      });
      expect(code).toBe(1);
      expect(readTerminalEnvelope(paths.envelope)).toMatchObject({
        schema: TERMINAL_SCHEMA,
        delivery: 'not-sent',
        observed_invocation_id: 'waiter-2487',
        turn_result_cause: 'state_light_new_chat_send_slot_timeout',
        send_count: 0,
        ...expected,
      });
      expect(readTerminalEnvelope(paths.envelope)?.send_slot_holder_invocation_id).not.toBe('waiter-2487');
    }
  });

  it('validates the shared startup/heartbeat/idle relation fail-closed (#1752)', () => {
    const timing = resolveBrowserTurnLivenessTiming();
    expect(timing.maxHealthyHeartbeatGapMs).toBeLessThan(timing.liveChildIdleWindowMs);
    expect(timing.schedulerIntervalMs).toBeLessThanOrEqual(timing.maxHealthyHeartbeatGapMs);
    expect(() => validateBrowserTurnLivenessTiming({
      startupAllowanceMs: 100,
      maxHealthyHeartbeatGapMs: 100,
      liveChildIdleWindowMs: 100,
    })).toThrow(/heartbeat_gap_not_inside_idle_window/);
  });

  it('static adoption references package commands and policy surfaces', () => {
    const packageJson = readFileSync(packageJsonPath, 'utf8');
    expect(packageJson).toContain('flow-manager-long-running-child');
    expect(packageJson).toContain('flow-manager-browser-gpt-long-run');
    const skill = readFileSync(skillPath, 'utf8');
    expect(skill).toContain('docs/browser-gpt-turn-runbook.md');
    expect(skill).toContain('flow-manager-browser-gpt-long-run');
    expect(skill).toContain('browser-turn-result-v1');
    expect(readFileSync(rulePath, 'utf8')).toContain('docs/browser-gpt-turn-runbook.md');
    expect(readFileSync(runbookPath, 'utf8')).toContain(ADAPTER_PACKAGE_COMMAND);
    expect(readFileSync(runbookPath, 'utf8')).toContain(LAUNCHER_PACKAGE_COMMAND);
    expect(readFileSync(browserReadmePath, 'utf8')).toContain('docs/browser-gpt-turn-runbook.md');
    expect(readFileSync(adapterPath, 'utf8')).toContain('spawnDetachedLauncher');
    expect(readFileSync(adapterPath, 'utf8')).toContain('forbidden_authority_selector');
    expect(readFileSync(launcherPath, 'utf8')).toContain(COMPLETION_MODE);
  });

  it('adapter rejects completion-mode selector', async () => {
    const code = await runBrowserAdapter(['--completion-mode', 'other', '--run-identity', 'r', '--attempt-identity', 'a']);
    expect(code).toBe(2);
  });

  it('spawnDetachedLauncher runs canonical launcher with fixture child', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'detach-launcher');
    const result = makeTurnResult();
    const childMarker = join(root, 'detach-child-started.txt');
    const fixture = markedChildFixture(childMarker, result);
    process.env.OPK_FM_LONG_CHILD_DISABLE_DETACH = '1';
    for (const [key, value] of Object.entries(cliFixtureEnv(root))) vi.stubEnv(key, value);
    vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term_launcher');
    const spawned = await spawnDetachedLauncher([
      'launch',
      '--run-identity', 'run-detach',
      '--attempt-identity', 'attempt-detach',
      '--handoff-receipt', paths.receipt,
      '--terminal-envelope', paths.envelope,
      '--browser-output', paths.output,
      '--cwd', repoRoot,
      '--child-command', fixture.command,
      '--', ...fixture.args,
    ]);
    expect(spawned.exitCode).toBe(0);
    expect(spawned.launcherPid).toBe(readHandoffReceipt(paths.receipt)?.launcher_pid);
    expect(readHandoffReceipt(paths.receipt)?.schema).toBe(HANDOFF_SCHEMA);
    expect(existsSync(childMarker)).toBe(true);
    expect(isWakeableTerminalEnvelopePath(paths.envelope, root)).toBe(true);
    expect(readTerminalEnvelope(paths.envelope)?.lifecycle_outcome).toBe('success');
    expect(readTerminalEnvelope(paths.envelope)?.cwd).toBe(repoRoot);
    expect(readTerminalEnvelope(paths.envelope)?.terminal_handle).toBe('term_launcher');
  });

  it('refuses before handoff when artifact paths alias', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'alias');
    const childMarker = join(root, 'alias-child-started.txt');
    const fixture = markedChildFixture(childMarker, makeTurnResult());
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run',
      attemptIdentity: 'attempt',
      handoffReceiptPath: paths.envelope,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    const refusal = stderr.mock.calls.map((call) => String(call[0])).join('');
    stderr.mockRestore();
    expect(code).toBe(2);
    expect(refusal).toContain('preflight_failed');
    expect(refusal).toContain('artifact_path_alias');
    expectNoLauncherEffects(paths, childMarker);
  });

  it('refuses an envelope name fleet-wake cannot discover before any effect (#2378)', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'unwakeable');
    const envelope = join(root, 'unwakeable', 'issue-2376-envelope.json');
    const fixture = nodeFixture('process.exit(0)');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run',
      attemptIdentity: 'attempt',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    const refusal = stderr.mock.calls.map((call) => String(call[0])).join('');
    stderr.mockRestore();
    expect(code).toBe(2);
    expect(refusal).toContain('terminal_envelope_name_not_wakeable');
    expect(refusal).toContain(TERMINAL_ENVELOPE_NAME_SUFFIX);
    expect(refusal).toContain(join(TERMINAL_ENVELOPE_ROOT, 'issue-2376-envelope-terminal.json'));
    expect(existsSync(paths.receipt)).toBe(false);
    expect(existsSync(envelope)).toBe(false);
  });

  it('adapter refuses an unwakeable envelope name without spawning the launcher (#2378)', async () => {
    const root = tempDir();
    const spawnLauncher = vi.fn(async () => ({ launcherPid: process.pid }));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runBrowserAdapter([
      '--run-identity', 'r',
      '--attempt-identity', 'a',
      '--handoff-receipt', join(root, 'handoff.json'),
      '--invocation-id', 'inv',
      '--terminal-envelope', join(root, 'envelope.json'),
      '--output', join(root, 'reply.txt'),
      '--profile', 'p',
      '--cdp', 'http://127.0.0.1:9222',
      '--input', join(root, 'prompt.txt'),
      '--owner-task-id', 'task-2378', '--owner-dispatch-id', 'dispatch-2378',
    ], { spawnLauncher });
    const refusal = stderr.mock.calls.map((call) => String(call[0])).join('');
    stderr.mockRestore();
    expect(code).toBe(2);
    expect(refusal).toContain('terminal_envelope_name_not_wakeable');
    expect(refusal).toContain('--terminal-envelope ' + join(TERMINAL_ENVELOPE_ROOT, 'envelope-terminal.json'));
    expect(spawnLauncher).not.toHaveBeenCalled();
  });

  it('wakeable envelope rule matches fleet-wake discovery names (#2378)', () => {
    expect(isWakeableTerminalEnvelopePath(join(TERMINAL_ENVELOPE_ROOT, 'issue-2376-inv-terminal.json'))).toBe(true);
    expect(isWakeableTerminalEnvelopePath(join(TERMINAL_ENVELOPE_ROOT, 'issue-2376-envelope.json'))).toBe(false);
    expect(isWakeableTerminalEnvelopePath(join(TERMINAL_ENVELOPE_ROOT, 'terminal-envelope.json'))).toBe(false);
  });
  it('relocates a legacy caller terminal path by basename into the durable root', async () => {
    const root = tempDir('legacy-artifact-path-');
    vi.stubEnv('XDG_STATE_HOME', join(root, 'state'));
    const paths = launchPaths(root, 'legacy');
    const envelope = join(root, 'legacy', 'issue-terminal.json');
    const durableRoot = join(root, 'state', 'orchestrator-pack');
    const fixture = nodeFixture('process.exit(0)');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runLaunch({
      runIdentity: 'run', attemptIdentity: 'attempt',
      handoffReceiptPath: paths.receipt, terminalEnvelopePath: envelope,
      browserOutputPath: paths.output, cwd: repoRoot,
      childCommand: fixture.command, childArgs: fixture.args,
    });
    stderr.mockRestore();
    expect(code).toBe(1);
    expect(isWakeableTerminalEnvelopePath(envelope)).toBe(false);
    expect(isWakeableTerminalEnvelopePath(join(durableRoot, 'issue-terminal.json'))).toBe(true);
    expect(existsSync(join(durableRoot, basename(paths.receipt)))).toBe(true);
    expect(readTerminalEnvelope(join(durableRoot, 'issue-terminal.json'))).toMatchObject({
      run_identity: 'run', attempt_identity: 'attempt', lifecycle_outcome: 'incident',
    });
    expect(existsSync(paths.receipt)).toBe(false);
    expect(existsSync(envelope)).toBe(false);
  });

  it.each([
    ['unoverridden', 'none'],
    ['root-only', 'root'],
    ['gate-only', 'gate'],
  ] as const)('accepts suffix-valid legacy paths and uses XDG_STATE_HOME for durable artifacts: %s', async (id, mode) => {
    const root = tempDir('opk-2440-legacy-root-');
    const paths = launchPaths(root, id);
    const marker = join(root, 'should-start.txt');
    const fixture = markedChildFixture(marker, makeTurnResult());
    const xdgStateHome = join(root, 'xdg-state');
    const env: Record<string, string> = { XDG_STATE_HOME: xdgStateHome, ...(mode === 'root' ? { [CLI_FIXTURE_ROOT_ENV]: root }
      : mode === 'gate' ? { [CLI_FIXTURE_GATE_ENV]: 'fixture-root-v1' } : {}) };
    const outcome = await runLauncherCli(cliLaunchArgs(paths, fixture), env);
    const durableRoot = join(xdgStateHome, 'orchestrator-pack');
    expect(outcome.code).toBe(0);
    expect(existsSync(join(durableRoot, basename(paths.receipt)))).toBe(true);
    expect(readTerminalEnvelope(join(durableRoot, basename(paths.envelope)))).toMatchObject({
      lifecycle_outcome: 'success', delivery: 'landed', turn_result_state: 'ok',
    });
    expect(existsSync(paths.receipt)).toBe(false);
    expect(existsSync(paths.envelope)).toBe(false);
    expect(existsSync(marker)).toBe(true);
  });

  it('accepts a real native CLI launch only with the discriminator and disposable root pair', async () => {
    const root = tempDir('opk-2440-gated-');
    const paths = launchPaths(root, 'gated');
    const marker = join(root, 'child-started.txt');
    const outcome = await runLauncherCli(cliLaunchArgs(paths, markedChildFixture(marker, makeTurnResult())), cliFixtureEnv(root));
    expect(outcome.code).toBe(0);
    expect(readHandoffReceipt(paths.receipt)?.schema).toBe(HANDOFF_SCHEMA);
    expect(readTerminalEnvelope(paths.envelope)).toMatchObject({
      lifecycle_outcome: 'success', delivery: 'landed', turn_result_state: 'ok',
    });
    expect(isWakeableTerminalEnvelopePath(paths.envelope, root)).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });

  it('keeps suffix refusal ahead of effects even with both real CLI fixture gates set', async () => {
    const root = tempDir('opk-2440-bad-suffix-');
    const paths = launchPaths(root, 'invalid-suffix');
    const invalidEnvelope = join(root, 'invalid-suffix', 'not-wakeable.json');
    const marker = join(root, 'should-not-start.txt');
    const outcome = await runLauncherCli(
      cliLaunchArgs({ ...paths, envelope: invalidEnvelope }, markedChildFixture(marker, makeTurnResult())),
      cliFixtureEnv(root),
    );
    expect(outcome.code).toBe(2);
    expect(outcome.stderr).toContain('terminal_envelope_name_not_wakeable');
    expectNoLauncherEffects(paths, marker, invalidEnvelope);
  });

  it('refuses when receipt create fails after preflight', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'receipt-fail');
    const childMarker = join(root, 'receipt-fail-child-started.txt');
    const fixture = markedChildFixture(childMarker, makeTurnResult());
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.env.OPK_FM_LONG_CHILD_FORCE_RECEIPT_CREATE_FAIL = '1';
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run',
      attemptIdentity: 'attempt',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    const refusal = stderr.mock.calls.map((call) => String(call[0])).join('');
    stderr.mockRestore();
    expect(code).toBe(2);
    expect(refusal).toContain('receipt_create_failed');
    expectNoLauncherEffects(paths, childMarker);
  });

  it('creates receipt before child start and succeeds on valid turn-result', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'success');
    const result = makeTurnResult();
    const fixture = nodeFixture(`
      process.stdout.write(JSON.stringify(${JSON.stringify(result)}) + '\\n');
      process.exit(0);
    `);
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-ok',
      attemptIdentity: 'attempt-ok',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(0);
    const receipt = readHandoffReceipt(paths.receipt);
    expect(receipt?.completion_mode).toBe(COMPLETION_MODE);
    const envelope = readTerminalEnvelope(paths.envelope);
    expect(envelope?.lifecycle_outcome).toBe('success');
    expect(envelope?.delivery).toBe('landed');
    expect(envelope?.child_exit_diagnostic).toBe('exited_within_grace');
    expect(envelope?.child_exit_code).toBe(0);
  });

  it.each([
    ['ok', 0, 'success', undefined],
    ['no_reply', 11, 'incident', 'child_turn_state:no_reply'],
    ['driver_error', 13, 'incident', 'child_turn_state:driver_error'],
  ] as const)(
    'projects one accepted %s child result to the unchanged launcher terminal envelope (#2494)',
    async (state, exitCode, outcome, expectedIncident) => {
      const root = tempDir('opk-2494-envelope-');
      const paths = launchPaths(root, 'terminal-' + state);
      const turnResult = makeTurnResult({
        state,
        cause: state === 'ok' ? 'completed_page_only' : 'synthetic_owned_page_lost',
        scope: state === 'ok' ? 'none' : 'invocation',
      });
      const fixture = nodeFixture(
        'process.stdout.write(JSON.stringify(' + JSON.stringify(turnResult)
        + ') + "\\n", () => process.exit(' + String(exitCode) + '));',
      );
      const code = await runFixtureLaunch(root, {
        runIdentity: 'run-2494-' + state,
        attemptIdentity: 'attempt-2494-' + state,
        handoffReceiptPath: paths.receipt,
        terminalEnvelopePath: paths.envelope,
        browserOutputPath: paths.output,
        cwd: repoRoot,
        childCommand: fixture.command,
        childArgs: fixture.args,
      });

      expect(code).toBe(state === 'ok' ? 0 : 1);
      const terminal = readTerminalEnvelope(paths.envelope);
      expect(terminal).toMatchObject({
        schema: TERMINAL_SCHEMA,
        lifecycle_outcome: outcome,
        turn_result_state: state,
        child_exit_code: exitCode,
      });
      expect(terminal?.incident).toBe(expectedIncident);
      // The child result and the real launcher terminal are separate owners.
      // Do not claim a page-loss-relative launcher deadline from this fixture.
      expect(existsSync(paths.envelope)).toBe(true);
    },
  );

  it('treats exit zero without turn-result as missing after stdout EOF', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'missing');
    const fixture = nodeFixture('process.exit(0)');
    process.env.OPK_FM_LONG_CHILD_NO_CANDIDATE_GRACE_MS = '500';
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-miss',
      attemptIdentity: 'attempt-miss',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(1);
    expect(readTerminalEnvelope(paths.envelope)?.incident).toBe('child_terminal_result_missing');
  });

  it('classifies duplicate turn-results as child_terminal_result_duplicate', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'dup');
    const result = makeTurnResult();
    const fixture = nodeFixture(`
      const r = ${JSON.stringify(result)};
      process.stdout.write(JSON.stringify(r) + '\\n');
      process.stdout.write(JSON.stringify(r) + '\\n');
      process.exit(0);
    `);
    process.env.OPK_FM_LONG_CHILD_CANDIDATE_GRACE_MS = '1000';
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-dup',
      attemptIdentity: 'attempt-dup',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(1);
    expect(readTerminalEnvelope(paths.envelope)?.incident).toBe('child_terminal_result_duplicate');
  });

  it('settles an ok result as success when the child retains its page past grace', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'hang');
    const result = makeTurnResult();
    const fixture = nodeFixture(`
      const r = ${JSON.stringify(result)};
      process.stdout.write(JSON.stringify(r) + '\\n');
      setInterval(() => {}, 1000);
    `);
    process.env.OPK_FM_LONG_CHILD_CANDIDATE_GRACE_MS = '300';
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-hang',
      attemptIdentity: 'attempt-hang',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(0);
    const envelope = readTerminalEnvelope(paths.envelope);
    expect(envelope?.lifecycle_outcome).toBe('success');
    expect(envelope?.incident).toBeUndefined();
    expect(envelope?.child_exit_diagnostic).toBe('retained_after_result');
    expect(envelope?.child_exit_code).toBeNull();
    expect(envelope?.turn_result_state).toBe('ok');
  });

  it('keeps a non-ok result an incident when the child retains its page past grace', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'driver-error-retain');
    const result = makeTurnResult({
      state: 'driver_error',
      cause: 'fixture_driver_error',
      scope: 'invocation',
    });
    const fixture = nodeFixture(`
      const r = ${JSON.stringify(result)};
      process.stdout.write(JSON.stringify(r) + '\\n');
      setInterval(() => {}, 1000);
    `);
    process.env.OPK_FM_LONG_CHILD_CANDIDATE_GRACE_MS = '300';
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-driver-error-retain',
      attemptIdentity: 'attempt-driver-error-retain',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(1);
    const envelope = readTerminalEnvelope(paths.envelope);
    expect(envelope?.incident).toBe('child_turn_state:driver_error');
    expect(envelope?.child_exit_diagnostic).toBe('retained_after_result');
  });

  it('reproduces the real 2026-09-15 ok/retained-page envelope shape as success', async () => {
    const replay = JSON.parse(
      readFileSync(join(repoRoot, 'tests/external-output-references/flow-manager-long-child-ok-retained-page.json'), 'utf8'),
    ) as {
      expected_after_fix: {
        lifecycle_outcome: string;
        delivery: string;
        child_exit_diagnostic: string;
        child_exit_code: number | null;
        turn_result_state: string;
        send_count: number;
      };
    };
    const root = tempDir();
    const paths = launchPaths(root, 'ok-retained-page');
    const result = {
      ...makeTurnResult({
        cause: 'completed_page_only',
        witness: undefined,
      }),
      send_count: 1,
    };
    const fixture = nodeFixture(`
      const r = ${JSON.stringify(result)};
      process.stdout.write(JSON.stringify(r) + '\\n');
      setInterval(() => {}, 1000);
    `);
    process.env.OPK_FM_LONG_CHILD_CANDIDATE_GRACE_MS = '300';
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-ok-retained-page',
      attemptIdentity: 'attempt-ok-retained-page',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(0);
    const envelope = readTerminalEnvelope(paths.envelope);
    expect(envelope).toMatchObject(replay.expected_after_fix);
    expect(envelope?.incident).toBeUndefined();
  });

  it('parses delayed turn-result during post-exit drain', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'delayed');
    const result = makeTurnResult();
    const fixture = nodeFixture(`
      setTimeout(() => {
        process.stdout.write(JSON.stringify(${JSON.stringify(result)}) + '\\n');
        process.exit(0);
      }, 80);
    `);
    process.env.OPK_FM_LONG_CHILD_NO_CANDIDATE_GRACE_MS = '2000';
    process.env.OPK_FM_LONG_CHILD_CANDIDATE_GRACE_MS = '2000';
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-delay',
      attemptIdentity: 'attempt-delay',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(0);
    expect(readTerminalEnvelope(paths.envelope)?.lifecycle_outcome).toBe('success');
  });

  it('keeps a contract-scheduled heartbeating child alive and the unref timer cannot hold it past result', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'heartbeat-success');
    const result = makeTurnResult();
    const fixture = {
      command: process.execPath,
      args: ['--experimental-strip-types', '-e', `
        (async () => {
          const { resolveBrowserTurnLivenessTiming, startTurnScopedHeartbeatScheduler } =
            await import(${JSON.stringify(livenessContractUrl)});
          let pollCount = 0;
          startTurnScopedHeartbeatScheduler({
            timing: resolveBrowserTurnLivenessTiming(),
            emit: () => process.stdout.write(JSON.stringify({
              schema: 'observation-heartbeat/v1',
              phase: 'post_send_observation',
              poll_count: ++pollCount,
              observation_state: 'busy',
              stable_reads: 0,
              completion_ready: false,
            }) + '\\n'),
          });
          setTimeout(() => {
            process.stdout.write(JSON.stringify(${JSON.stringify(result)}) + '\\n');
          }, 350);
        })().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
      `],
    };
    process.env.OPK_FM_LONG_CHILD_NO_CANDIDATE_GRACE_MS = '100';
    process.env.OPK_FM_LONG_CHILD_CANDIDATE_GRACE_MS = '100';
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-heartbeat-success',
      attemptIdentity: 'attempt-heartbeat-success',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(0);
    const envelope = readTerminalEnvelope(paths.envelope);
    expect(envelope?.lifecycle_outcome).toBe('success');
    expect(envelope).not.toHaveProperty('incident');
  });

  it('refreshes recurring deadline from each heartbeat arrival near the prior deadline', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'heartbeat-refresh-from-arrival');
    const result = makeTurnResult();
    const heartbeat = {
      schema: 'observation-heartbeat/v1',
      phase: 'post_send_observation',
      poll_count: 1,
      observation_state: 'busy',
      stable_reads: 0,
      completion_ready: false,
    };
    const fixture = nodeFixture(`
      const heartbeat = ${JSON.stringify(heartbeat)};
      process.stdout.write(JSON.stringify(heartbeat) + '\\n');
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ ...heartbeat, poll_count: 2 }) + '\\n');
      }, 120);
      setTimeout(() => {
        process.stdout.write(JSON.stringify(${JSON.stringify(result)}) + '\\n', () => process.exit(0));
      }, 240);
    `);
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-heartbeat-refresh-arrival',
      attemptIdentity: 'attempt-heartbeat-refresh-arrival',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(0);
    expect(readTerminalEnvelope(paths.envelope)).toMatchObject({
      lifecycle_outcome: 'success',
      delivery: 'landed',
    });
  });

  it.each([
    ['just before', -1, true],
    ['at', 0, false],
    ['after', 1, false],
  ] as const)('does not admit a first heartbeat that arrives after the startup deadline (%s)', async (_case, offset, admitted) => {
    const root = tempDir();
    const heartbeat = {"schema":"observation-heartbeat/v1","phase":"admitted_pre_send","poll_count":0,"observation_state":"admitted","stable_reads":0,"completion_ready":false};
    process.env.OPK_BROWSER_TURN_STARTUP_ALLOWANCE_MS = '20';
    process.env.OPK_BROWSER_TURN_MAX_HEALTHY_HEARTBEAT_GAP_MS = '10';
    process.env.OPK_BROWSER_TURN_LIVE_CHILD_IDLE_WINDOW_MS = '30';
    const scenario = launchControlledDeadlineScenario(root, 'startup-' + offset, [JSON.stringify(heartbeat)]);
    try {
      const initialized = await scenario.clock.observed('initialized');
      await awaitControlledChildReady(scenario.child.ready);
      scenario.clock.setTime(initialized.deadline + offset);
      scenario.child.emit(1);
      const parsed = await scenario.clock.observed('heartbeat');
      expect(parsed).toMatchObject({ observedAt: initialized.deadline + offset, accepted: admitted });
      scenario.clock.setTime(parsed.deadline); // expire only after the parent parsed the line
      scenario.clock.pulseWatchdog();
      const code = await scenario.completion;
      expect(code).toBe(1);
      const envelope = readTerminalEnvelope(scenario.paths.envelope);
      expect(envelope?.incident).toBe(admitted ? 'child_liveness_timeout' : 'child_startup_timeout');
      expect(envelope?.child_exit_code).toBeNull();
      if (admitted) expect(envelope?.diagnostics).toHaveProperty('last_heartbeat');
      else expect(envelope?.diagnostics ?? {}).not.toHaveProperty('last_heartbeat');
      expect(await scenario.clock.observed('child_exit')).toHaveProperty('exitCode');
    } finally {
      await cleanupControlledDeadlineScenario(scenario);
    }
  });

  it.each([
    ['just before', -1, true],
    ['at', 0, false],
    ['after', 1, false],
  ] as const)('does not refresh an expired recurring deadline from a late heartbeat (%s)', async (_case, offset, admitted) => {
    const root = tempDir();
    const first = {"schema":"observation-heartbeat/v1","phase":"post_send_observation","poll_count":1,"observation_state":"busy","stable_reads":0,"completion_ready":false};
    process.env.OPK_BROWSER_TURN_MAX_HEALTHY_HEARTBEAT_GAP_MS = '10';
    process.env.OPK_BROWSER_TURN_LIVE_CHILD_IDLE_WINDOW_MS = '30';
    const scenario = launchControlledDeadlineScenario(root, 'recurring-' + offset, [
      JSON.stringify(first), JSON.stringify({ ...first, poll_count: 2 }),
    ]);
    try {
      await scenario.clock.observed('initialized');
      await awaitControlledChildReady(scenario.child.ready);
      scenario.child.emit(1);
      const firstParsed = await scenario.clock.observed('heartbeat', 1);
      expect(firstParsed.accepted).toBe(true);
      scenario.clock.setTime(firstParsed.deadline + offset);
      scenario.child.emit(2);
      const secondParsed = await scenario.clock.observed('heartbeat', 2);
      expect(secondParsed).toMatchObject({ observedAt: firstParsed.deadline + offset, accepted: admitted });
      scenario.clock.setTime(secondParsed.deadline);
      scenario.clock.pulseWatchdog();
      const code = await scenario.completion;
      expect(code).toBe(1);
      const envelope = readTerminalEnvelope(scenario.paths.envelope);
      expect(envelope?.incident).toBe('child_liveness_timeout');
      expect(envelope?.diagnostics).toMatchObject({
        last_heartbeat: { poll_count: admitted ? 2 : 1 },
      });
      expect(await scenario.clock.observed('child_exit')).toHaveProperty('exitCode');
    } finally {
      await cleanupControlledDeadlineScenario(scenario);
    }
  });

  it.each([
    ['just before', -1, true],
    ['at', 0, false],
    ['after', 1, false],
  ] as const)('does not accept a terminal result that arrives after the recurring deadline (%s)', async (_case, offset, admitted) => {
    const root = tempDir();
    const heartbeat = {"schema":"observation-heartbeat/v1","phase":"post_send_observation","poll_count":1,"observation_state":"busy","stable_reads":0,"completion_ready":false};
    process.env.OPK_BROWSER_TURN_MAX_HEALTHY_HEARTBEAT_GAP_MS = '10';
    process.env.OPK_BROWSER_TURN_LIVE_CHILD_IDLE_WINDOW_MS = '30';
    const scenario = launchControlledDeadlineScenario(root, 'result-' + offset, [
      JSON.stringify(heartbeat), JSON.stringify(makeTurnResult()),
    ]);
    try {
      await scenario.clock.observed('initialized');
      await awaitControlledChildReady(scenario.child.ready);
      scenario.child.emit(1);
      const firstParsed = await scenario.clock.observed('heartbeat');
      expect(firstParsed.accepted).toBe(true);
      scenario.clock.setTime(firstParsed.deadline + offset);
      scenario.child.emit(2);
      const resultParsed = await scenario.clock.observed('result');
      expect(resultParsed).toMatchObject({ observedAt: firstParsed.deadline + offset, accepted: admitted });
      scenario.clock.pulseWatchdog();
      const code = await scenario.completion;
      expect(code).toBe(admitted ? 0 : 1);
      expect(readTerminalEnvelope(scenario.paths.envelope)).toMatchObject(admitted
        ? { lifecycle_outcome: 'success' }
        : { lifecycle_outcome: 'incident', incident: 'child_liveness_timeout', child_exit_code: null });
      await scenario.clock.observed('child_exit');
    } finally {
      await cleanupControlledDeadlineScenario(scenario);
    }
  });

  it('accepts an already-complete reply when the browser completion signal was not detected', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'complete-without-signal');
    const result = makeTurnResult({ cause: 'completed_page_only', witness: undefined });
    const heartbeat = {
      schema: 'observation-heartbeat/v1',
      phase: 'post_send_observation',
      poll_count: 1,
      observation_state: 'busy',
      stable_reads: 0,
      completion_ready: false,
    };
    const fixture = nodeFixture(`
      process.stdout.write(JSON.stringify(${JSON.stringify(heartbeat)}) + '\\n');
      process.stdout.write(JSON.stringify(${JSON.stringify(result)}) + '\\n');
      setInterval(() => {}, 1000);
    `);
    process.env.OPK_FM_LONG_CHILD_CANDIDATE_GRACE_MS = '30';
    process.env.OPK_FM_LONG_CHILD_HARD_DEADLINE_MS = '300';
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-complete-without-signal',
      attemptIdentity: 'attempt-complete-without-signal',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(0);
    expect(readTerminalEnvelope(paths.envelope)).toMatchObject({
      lifecycle_outcome: 'success',
      turn_result_cause: 'completed_page_only',
      diagnostics: { completion_ready: false },
    });
  });

  it.each([
    ['heartbeats without completion', 'heartbeat', -1, false],
    ['terminal just before hard limit', 'result', -1, true],
    ['terminal at hard limit', 'result', 0, false],
    ['terminal after hard limit', 'result', 1, false],
  ] as const)('publishes a timeout envelope when ongoing heartbeats never produce a completion signal (%s)', async (_case, secondKind, offset, admitted) => {
    const root = tempDir();
    const heartbeat = {"schema":"observation-heartbeat/v1","phase":"post_send_observation","poll_count":1,"observation_state":"busy","stable_reads":0,"completion_ready":false};
    process.env.OPK_BROWSER_TURN_STARTUP_ALLOWANCE_MS = '100';
    process.env.OPK_BROWSER_TURN_MAX_HEALTHY_HEARTBEAT_GAP_MS = '50';
    process.env.OPK_BROWSER_TURN_LIVE_CHILD_IDLE_WINDOW_MS = '300';
    process.env.OPK_FM_LONG_CHILD_HARD_DEADLINE_MS = '160';
    const scenario = launchControlledDeadlineScenario(root, 'hard-' + secondKind + '-' + offset, [
      JSON.stringify(heartbeat), secondKind === 'heartbeat'
        ? JSON.stringify({ ...heartbeat, poll_count: 2 })
        : JSON.stringify(makeTurnResult()),
    ]);
    try {
      const initialized = await scenario.clock.observed('initialized');
      await awaitControlledChildReady(scenario.child.ready);
      scenario.child.emit(1);
      const firstParsed = await scenario.clock.observed('heartbeat');
      expect(firstParsed).toMatchObject({ accepted: true, deadline: initialized.hardDeadline });
      scenario.clock.setTime(initialized.hardDeadline + offset);
      scenario.child.emit(2);
      const secondParsed = await scenario.clock.observed(secondKind === 'heartbeat' ? 'heartbeat' : 'result', secondKind === 'heartbeat' ? 2 : 1);
      expect(secondParsed).toMatchObject({ observedAt: initialized.hardDeadline + offset, accepted: secondKind === 'heartbeat' || admitted });
      if (!admitted) scenario.clock.setTime(initialized.hardDeadline);
      scenario.clock.pulseWatchdog();
      const code = await scenario.completion;
      expect(code).toBe(admitted ? 0 : 1);
      expect(readTerminalEnvelope(scenario.paths.envelope)).toMatchObject(admitted
        ? { lifecycle_outcome: 'success' }
        : { lifecycle_outcome: 'incident', incident: 'child_liveness_timeout', child_exit_code: null, delivery: 'POSSIBLY_DELIVERED' });
      await scenario.clock.observed('child_exit');
    } finally {
      await cleanupControlledDeadlineScenario(scenario);
    }
  });

  it('classifies a live child with no first heartbeat as child_startup_timeout', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'silent-timeout');
    const fixture = nodeFixture('setInterval(() => {}, 1000);');
    process.env.OPK_FM_LONG_CHILD_NO_CANDIDATE_GRACE_MS = '100';
    process.env.OPK_FM_LONG_CHILD_CANDIDATE_GRACE_MS = '100';
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-silent',
      attemptIdentity: 'attempt-silent',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(1);
    const envelope = readTerminalEnvelope(paths.envelope);
    expect(envelope?.incident).toBe('child_startup_timeout');
    expect(envelope?.child_exit_code).toBeNull();
    expect(JSON.stringify(envelope)).not.toContain('child_stdout_eof_timeout');
  });

  it('times out a child after heartbeats go silent past the idle window', async () => {
    const root = tempDir();
    const heartbeat = {"schema":"observation-heartbeat/v1","phase":"post_send_observation","poll_count":1,"observation_state":"busy","stable_reads":0,"completion_ready":false};
    process.env.OPK_FM_LONG_CHILD_NO_CANDIDATE_GRACE_MS = '100';
    process.env.OPK_FM_LONG_CHILD_CANDIDATE_GRACE_MS = '100';
    const scenario = launchControlledDeadlineScenario(root, 'heartbeat-idle-timeout', [JSON.stringify(heartbeat)]);
    try {
      await scenario.clock.observed('initialized');
      await awaitControlledChildReady(scenario.child.ready);
      scenario.child.emit(1);
      const firstParsed = await scenario.clock.observed('heartbeat');
      expect(firstParsed.accepted).toBe(true);
      scenario.clock.setTime(firstParsed.deadline);
      scenario.clock.pulseWatchdog();
      const code = await scenario.completion;
      expect(code).toBe(1);
      const envelope = readTerminalEnvelope(scenario.paths.envelope);
      expect(envelope?.incident).toBe('child_liveness_timeout');
      expect(envelope?.child_exit_code).toBeNull();
      expect(envelope?.diagnostics).toHaveProperty('last_heartbeat');
      expect(envelope).toMatchObject({ delivery: 'POSSIBLY_DELIVERED', send_count: 1 });
      expect(JSON.stringify(envelope)).not.toContain('child_stdout_eof_timeout');
      expect(await scenario.clock.observed('child_exit')).toHaveProperty('exitCode');
    } finally {
      await cleanupControlledDeadlineScenario(scenario);
    }
  });

  it('does not refresh recurring liveness from malformed heartbeat stdout', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'malformed-heartbeat');
    const valid = {
      schema: 'observation-heartbeat/v1',
      phase: 'post_send_observation',
      poll_count: 1,
      observation_state: 'busy',
      stable_reads: 0,
      completion_ready: false,
    };
    const malformed = { ...valid, phase: 'not-a-phase' };
    const fixture = nodeFixture(`
      process.stdout.write(JSON.stringify(${JSON.stringify(valid)}) + '\\n');
      setInterval(() => process.stdout.write(JSON.stringify(${JSON.stringify(malformed)}) + '\\n'), 25);
    `);
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-malformed-heartbeat',
      attemptIdentity: 'attempt-malformed-heartbeat',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(1);
    const envelope = readTerminalEnvelope(paths.envelope);
    expect(envelope?.incident).toBe('child_liveness_timeout');
    expect(envelope?.diagnostics).toMatchObject({
      last_heartbeat: { phase: 'post_send_observation' },
    });
  });

  it('preserves POSSIBLY_DELIVERED when a started new-chat child times out before its cancellation receipt', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'new-chat-before-receipt');
    const fixture = nodeFixture('setInterval(() => {}, 1000);');
    process.env.OPK_FM_LONG_CHILD_NO_CANDIDATE_GRACE_MS = '200';
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-new-chat-before-receipt',
      attemptIdentity: 'attempt-new-chat-before-receipt',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: [
        ...fixture.args,
        '--',
        '--new-chat',
        '--cdp', 'http://127.0.0.1:9222',
        '--profile', join(root, 'profile'),
        '--invocation-id', 'invocation-before-receipt',
      ],
    });
    expect(code).toBe(1);
    const envelope = readTerminalEnvelope(paths.envelope);
    expect(envelope).toMatchObject({
      incident: 'child_startup_timeout',
      delivery: 'POSSIBLY_DELIVERED',
      recovery_available: false,
    });
    expect(envelope).not.toHaveProperty('send_count');
    expect(envelope).not.toHaveProperty('conversation_locator');
  });

  it('waiter is non-terminal before envelope exists', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'wait');
    const waitResult = await runProcess({
      command: process.execPath,
      args: [
        '--experimental-strip-types', launcherPath, 'wait',
        '--run-identity', 'run-w',
        '--attempt-identity', 'attempt-w',
        '--terminal-envelope', paths.envelope,
        '--handoff-receipt', paths.receipt,
        '--deadline-ms', '200',
      ],
      cwd: repoRoot,
      inheritParentEnv: true,
      allowEmptyStdout: true,
      timeoutMs: 10_000,
    });
    const waitStdout = waitResult.stdout;
    const body = JSON.parse(waitStdout.trim());
    expect(body.envelope_absent).toBe(true);
    expect(body.no_retry_authority).toBe(true);
    expect(body.no_success_authority).toBe(true);
  });

  it('does not persist secret canaries in launcher-owned artifacts', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'canary');
    const canary = 'OPK_CANARY_SECRET_1164';
    const result = makeTurnResult();
    const fixture = nodeFixture(`
      process.stdout.write(JSON.stringify(${JSON.stringify(result)}) + '\\n');
      process.stderr.write('${canary}');
      process.exit(0);
    `);
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-canary',
      attemptIdentity: 'attempt-canary',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
      secretCanaries: [canary],
    });
    expect(code).toBe(0);
    const receiptText = readFileSync(paths.receipt, 'utf8');
    const envelopeText = readFileSync(paths.envelope, 'utf8');
    expect(receiptText.includes(canary)).toBe(false);
    expect(envelopeText.includes(canary)).toBe(false);
  });

  it('leaves envelope absent when post-handoff envelope storage fails', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'store-fail');
    const result = makeTurnResult();
    const fixture = nodeFixture(`
      process.stdout.write(JSON.stringify(${JSON.stringify(result)}) + '\\n');
      process.exit(0);
    `);
    process.env.OPK_FM_LONG_CHILD_FORCE_ENVELOPE_CREATE_FAIL = '1';
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-store',
      attemptIdentity: 'attempt-store',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(0);
    expect(existsSync(paths.envelope)).toBe(false);
  });

  it('treats an exact-run occupant as the authoritative event and a wrong or unreadable one as no event (#2731)', async () => {
    const result = makeTurnResult();
    const occupant = (run: string) => JSON.stringify({
      schema: TERMINAL_SCHEMA, run_identity: run, attempt_identity: 'attempt-occ', lifecycle_outcome: 'incident',
    });
    // Launch refuses a pre-existing envelope, so a racing writer is the child itself.
    const launch = async (name: string, body: string) => {
      const root = tempDir();
      const paths = launchPaths(root, name);
      const fixture = nodeFixture(`
        require('node:fs').writeFileSync(${JSON.stringify(paths.envelope)}, ${JSON.stringify(body)});
        process.stdout.write(JSON.stringify(${JSON.stringify(result)}) + '\\n');
        process.exit(0);
      `);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const code = await runFixtureLaunch(root, {
          runIdentity: 'run-occ', attemptIdentity: 'attempt-occ',
          handoffReceiptPath: paths.receipt, terminalEnvelopePath: paths.envelope,
          browserOutputPath: paths.output, cwd: repoRoot,
          childCommand: fixture.command, childArgs: fixture.args,
        });
        const lines = stderr.mock.calls.map((call) => String(call[0])).join('');
        return { code, lines, envelope: readFileSync(paths.envelope, 'utf8') };
      } finally { stderr.mockRestore(); }
    };
    const exact = await launch('occupied-exact', occupant('run-occ'));
    expect(exact.code).toBe(1); // the incident that already owns the path outranks this launch's success
    expect(exact.lines).toContain('terminal_envelope_occupied_by_exact_event');
    expect(exact.envelope).toBe(occupant('run-occ'));
    for (const [name, body] of [['occupied-wrong', occupant('other-run')], ['occupied-garbage', '{not json']] as const) {
      const wrong = await launch(name, body);
      expect(wrong.code).toBe(0);
      expect(wrong.lines).toContain('terminal_envelope_not_published');
      expect(wrong.lines).not.toContain('occupied_by_exact_event');
      expect(wrong.envelope).toBe(body); // never overwritten
    }
  });

  it('reports a failed child-start publication as no event (#2731)', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'start-fail');
    process.env.OPK_FM_LONG_CHILD_FORCE_ENVELOPE_CREATE_FAIL = '1';
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await runFixtureLaunch(root, {
        runIdentity: 'run-start', attemptIdentity: 'attempt-start',
        handoffReceiptPath: paths.receipt, terminalEnvelopePath: paths.envelope,
        browserOutputPath: paths.output, cwd: repoRoot,
        childCommand: join(root, 'missing-child-binary'), childArgs: [],
      });
      expect(code).toBe(1);
      expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain('terminal_envelope_not_published');
      expect(existsSync(paths.envelope)).toBe(false);
    } finally { stderr.mockRestore(); }
  });

  it('derives three-state delivery semantics', () => {
    expect(deriveDelivery(makeParsedTurnResult({ state: 'output_conflict', observation_uncertainty_diagnostics: { cause: 'output_conflict:exists', send_count: 0, owned_prompt_seen: false }, resolved_send_count: 0 }), false)).toBe('not-sent');
    expect(deriveDelivery(makeParsedTurnResult({ observation_uncertainty_diagnostics: { cause: 'sent', send_count: 1, owned_prompt_seen: false }, witness: undefined }), false)).toBe('POSSIBLY_DELIVERED');
    expect(deriveDelivery(makeParsedTurnResult(), false)).toBe('landed');
  });

  it('admits a settled predecessor across its original Task and Run without predecessor effects (#2750 AC14-15)', async () => {
    const root = tempDir('opk-predecessor-child-');
    const stateDir = tempDir('opk-predecessor-observation-');
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', stateDir);
    const profile = join(root, 'profile');
    const cdp = 'http://127.0.0.1:9222';
    const profileKey = configuredProfileKey(profile, cdp);
    const run = 'run-predecessor-2678-old';
    const currentRun = 'run-predecessor-2678-new';
    const ownerTask = 'task-predecessor-2678-old';
    const ownerDispatch = 'dispatch-predecessor-2678-old';
    const previousInvocation = 'previous-invocation-2678';
    const previousAttempt = 'previous-attempt-2678';
    const previousTarget = 'own-previous-target-2678';
    const marker = `OPKTURNV1${'cd'.repeat(16)}`;
    const previousPaths = launchPaths(root, 'prior-exact');
    const priorResult = makeTurnResult({
      state: 'ok', scope: 'none', cause: 'ok',
      invocation_id: previousInvocation, configured_profile_key: profileKey,
      conversation_id: undefined, send_count: 1, send_attempted: true,
      send_witness: 'owned_marker', owned_marker_confirmed: true,
      owned_prompt_marker: marker, owned_target_id: previousTarget,
      owned_target_created: true,
    });
    const priorFixture = nodeFixture('process.stdout.write(JSON.stringify('
      + JSON.stringify(priorResult) + ') + "\\n");');
    const priorCode = await runFixtureLaunch(root, {
      runIdentity: run, attemptIdentity: previousAttempt,
      invocationId: previousInvocation, ownerTaskId: ownerTask, ownerDispatchId: ownerDispatch,
      profile, cdp,
      handoffReceiptPath: previousPaths.receipt,
      terminalEnvelopePath: previousPaths.envelope,
      browserOutputPath: previousPaths.output, cwd: repoRoot,
      childCommand: priorFixture.command, childArgs: priorFixture.args,
    });
    expect(priorCode).toBe(0);
    expect(readTerminalEnvelope(previousPaths.envelope)).toMatchObject({
      lifecycle_outcome: 'success', delivery: 'landed', turn_result_state: 'ok',
      observed_invocation_id: previousInvocation,
      owned_target_id: previousTarget,
      owned_target_created: true,
      owned_prompt_marker: marker,
    });
    admitStateLightTurnObservation({ profileKey, invocationId: previousInvocation, marker });
    bindStateLightOwnedTarget({
      profileKey, invocationId: previousInvocation, targetId: previousTarget,
      created: true, cdp,
      initialRoute: 'https://chatgpt.com/g/g-p-11111111111111111111111111111111-test',
    });
    const settledTerminalBytes = readFileSync(previousPaths.envelope, 'utf8');
    const currentInvocation = 'next-invocation-2678';
    const actualStarted = join(root, 'current-child-started');
    const child = nodeFixture('require("node:fs").writeFileSync('
      + JSON.stringify(actualStarted) + ', "started"); process.exit(0);');
    const selectors = [
      '--invocation-id', currentInvocation, '--profile', profile, '--cdp', cdp,
      '--predecessor-invocation-id', previousInvocation,
      '--predecessor-attempt-identity', previousAttempt,
    ];
    const currentConfig = (id: string, childArgs: string[], overrides: Partial<LaunchConfig> = {}): LaunchConfig => {
      const paths = launchPaths(root, id);
      return {
        runIdentity: currentRun, attemptIdentity: 'next-attempt-2678',
        invocationId: currentInvocation, ownerTaskId: 'task-predecessor-2678-new',
        ownerDispatchId: 'dispatch-predecessor-2678-new', profile, cdp,
        handoffReceiptPath: paths.receipt, terminalEnvelopePath: paths.envelope,
        browserOutputPath: paths.output, cwd: repoRoot,
        childCommand: child.command, childArgs: [...child.args, '--', ...childArgs],
        ...overrides,
      };
    };
    for (const [id, args, override] of [
      ['half-pair', selectors.slice(0, -2), {}],
      ['wrong-cdp', selectors, { cdp: 'http://127.0.0.1:9333' }],
      ['wrong-prior-attempt',
        selectors.map((value, index) => index === 9 ? 'foreign-attempt' : value), {}],
    ] as const) {
      const paths = launchPaths(root, id);
      const code = await runFixtureLaunch(root, currentConfig(id, [...args], override));
      expect(code, id).toBe(2);
      expect(existsSync(paths.receipt), id).toBe(false);
      expect(existsSync(paths.envelope), id).toBe(false);
      expect(existsSync(actualStarted), id).toBe(false);
    }
    const acceptedPaths = launchPaths(root, 'validated-predecessor');
    const admitted = await runFixtureLaunch(root, currentConfig('validated-predecessor', selectors));
    // Deliberately no browser Send or Page: this fixture isolates child admission
    // and proves the ordinary child spawns only after the exact old proof.
    expect(admitted).toBe(1);
    expect(existsSync(acceptedPaths.receipt)).toBe(true);
    expect(existsSync(actualStarted)).toBe(true);
    expect(readFileSync(previousPaths.envelope, 'utf8')).toBe(settledTerminalBytes);
  });

  it('admits an exact never-created predecessor only on positive no-Send v1/terminal proof (#2685)', async () => {
    const root = tempDir('opk-never-created-2685-');
    const stateDir = tempDir('opk-never-created-observation-2685-');
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', stateDir);
    const profile = join(root, 'profile');
    const cdp = 'http://127.0.0.1:9222';
    const profileKey = configuredProfileKey(profile, cdp);
    const run = 'run-never-created-2685-old';
    const currentRun = 'run-never-created-2685-new';
    const ownerTask = 'task-never-created-2685-old';
    const ownerDispatch = 'dispatch-never-created-2685-old';
    const predecessor = 'previous-never-created-2685';
    const attempt = 'previous-never-created-attempt-2685';
    const targetId = 'selected-existing-never-created-2685';
    const marker = 'OPKTURNV1' + 'dc'.repeat(16);
    const previousPaths = launchPaths(root, 'positive-noncreated');
    const result = makeTurnResult({
      state: 'send_failed', scope: 'invocation', cause: 'terminal_pre_send',
      invocation_id: predecessor, configured_profile_key: profileKey,
      conversation_id: undefined, witness: undefined,
      observation_uncertainty_diagnostics: { cause: 'terminal_pre_send', send_count: 0, owned_prompt_seen: false },
      send_count: 0, send_attempted: undefined,
      owned_target_id: targetId, owned_target_created: false, owned_prompt_marker: marker,
    });
    const fixture = nodeFixture('process.stdout.write(JSON.stringify('
      + JSON.stringify(result) + ') + "\\n");');
    const priorCode = await runFixtureLaunch(root, {
      runIdentity: run, attemptIdentity: attempt, ownerTaskId: ownerTask,
      ownerDispatchId: ownerDispatch, invocationId: predecessor, profile, cdp,
      handoffReceiptPath: previousPaths.receipt, terminalEnvelopePath: previousPaths.envelope,
      browserOutputPath: previousPaths.output, cwd: repoRoot,
      childCommand: fixture.command, childArgs: fixture.args,
    });
    expect(priorCode).toBe(1);
    expect(readTerminalEnvelope(previousPaths.envelope)).toMatchObject({
      delivery: 'not-sent', send_count: 0, owned_target_created: false,
      owned_target_id: targetId, owned_prompt_marker: marker,
    });
    admitStateLightTurnObservation({ profileKey, invocationId: predecessor, marker });
    bindStateLightOwnedTarget({
      profileKey, invocationId: predecessor, targetId, created: false, cdp,
      initialRoute: 'https://chatgpt.com/g/g-p-11111111111111111111111111111111-test',
    });
    transitionStateLightTurnObservation({
      profileKey, invocationId: predecessor, phase: 'not_sent', reason: 'terminal_pre_send',
      sendCount: 0, sendWitness: 'numeric_send_count',
    });
    const childStarted = join(root, 'admitted-child-started');
    const child = nodeFixture('require("node:fs").writeFileSync('
      + JSON.stringify(childStarted) + ', "started"); process.exit(0);');
    const selectors = [
      '--invocation-id', 'next-invocation-2685', '--profile', profile, '--cdp', cdp,
      '--predecessor-invocation-id', predecessor,
      '--predecessor-attempt-identity', attempt,
    ];
    const next = (id: string, values: string[]) => {
      const paths = launchPaths(root, id);
      return runFixtureLaunch(root, {
        runIdentity: currentRun, attemptIdentity: 'next-attempt-2685',
        ownerTaskId: 'task-never-created-2685-new', ownerDispatchId: 'dispatch-never-created-2685-new',
        invocationId: 'next-invocation-2685', profile, cdp,
        handoffReceiptPath: paths.receipt, terminalEnvelopePath: paths.envelope,
        browserOutputPath: paths.output, cwd: repoRoot,
        childCommand: child.command, childArgs: [...child.args, '--', ...values],
      });
    };
    expect(await next('wrong-previous-id', selectors.map((x, i) =>
      i === 7 ? 'foreign-predecessor' : x))).toBe(2);
    expect(existsSync(childStarted)).toBe(false);
    // A past not_sent observation cannot turn a contrary terminal delivery
    // into affirmative proof of zero dispatch at launcher admission.
    const savedTerminal = readFileSync(previousPaths.envelope, 'utf8');
    const terminalJson = JSON.parse(savedTerminal) as Record<string, unknown>;
    writeFileSync(previousPaths.envelope, JSON.stringify({
      ...terminalJson, delivery: 'POSSIBLY_DELIVERED',
    }) + '\n');
    expect(await next('contradictory-delivery', selectors)).toBe(2);
    expect(existsSync(childStarted)).toBe(false);
    // Omitted creation metadata is not created:false. No terminal ambiguity
    // may reach the driver as a positive noncreation handoff.
    writeFileSync(previousPaths.envelope, JSON.stringify({
      ...terminalJson, owned_target_created: undefined,
    }) + '\n');
    expect(await next('missing-creation-boolean', selectors)).toBe(2);
    expect(existsSync(childStarted)).toBe(false);
    writeFileSync(previousPaths.envelope, savedTerminal);
    expect(await next('proven-not-created', selectors)).toBe(1);
    expect(existsSync(childStarted)).toBe(true);
    // This launcher fixture never attaches or closes the selected Page.
  });

  it('distinguishes original unique marker landing from positive POST and unknown attempt (#2678)', () => {
    const pending = makeParsedTurnResult({
      state: 'observation_uncertain', scope: 'invocation', cause: 'local_unbound',
      witness: undefined, conversation_id: undefined,
      resolved_send_count: 1, send_witness: 'numeric_send_count',
    });
    expect(deriveDelivery(pending, false)).toBe('POSSIBLY_DELIVERED');
    expect(deriveDelivery({ ...pending, owned_marker_confirmed: true }, false)).toBe('landed');
    expect(deriveDelivery({ ...pending, send_witness: 'owned_marker' }, false)).toBe('landed');
    expect(deriveDelivery({
      ...pending, resolved_send_count: 0, send_attempted: true,
      owned_target_id: 'target-2678', owned_prompt_marker: 'OPKTURNV1abcdef012345',
      owned_marker_confirmed: undefined,
    }, false)).toBe('POSSIBLY_DELIVERED');
  });

  it('keeps marker-proven delivery landed during an output conflict without masking that state (#2678 AC8)', () => {
    const conflict = makeParsedTurnResult({
      state: 'output_conflict', scope: 'invocation', cause: 'output_conflict:existing_bytes',
      resolved_send_count: 1, send_attempted: true, owned_marker_confirmed: true,
      send_witness: 'owned_marker', witness: undefined, conversation_id: undefined,
    });
    expect(conflict.state).toBe('output_conflict');
    expect(deriveDelivery(conflict, false)).toBe('landed');
    expect(deriveDelivery({
      ...conflict, owned_marker_confirmed: undefined, send_witness: 'numeric_send_count',
    }, false)).toBe('POSSIBLY_DELIVERED');
    expect(deriveDelivery({
      ...conflict, resolved_send_count: 0, owned_marker_confirmed: undefined,
      send_witness: 'none',
    }, false)).toBe('POSSIBLY_DELIVERED');
  });

  it('uses top-level send_count for post-send failure delivery (P1)', () => {
    const parsed = makeParsedTurnResult({
      state: 'foreign_activity',
      scope: 'conversation',
      cause: 'foreign_activity:interleaved',
      observation_uncertainty_diagnostics: undefined,
      witness: undefined,
      resolved_send_count: 1,
    });
    expect(deriveDelivery(parsed, false)).toBe('POSSIBLY_DELIVERED');
    expect(deriveDelivery(makeParsedTurnResult({
      state: 'driver_error',
      scope: 'invocation',
      cause: 'driver_error:timeout',
      observation_uncertainty_diagnostics: undefined,
      witness: undefined,
      conversation_id: undefined,
      resolved_send_count: 1,
    }), false)).toBe('POSSIBLY_DELIVERED');
  });

  it('records POSSIBLY_DELIVERED when child exits without turn-result (P1)', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'missing-result');
    const fixture = nodeFixture('process.exit(0);');
    process.env.OPK_FM_LONG_CHILD_NO_CANDIDATE_GRACE_MS = '200';
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-missing',
      attemptIdentity: 'attempt-missing',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(1);
    const envelope = readTerminalEnvelope(paths.envelope);
    expect(envelope?.incident).toBe('child_terminal_result_missing');
    expect(envelope?.delivery).toBe('POSSIBLY_DELIVERED');
    expect(envelope).not.toHaveProperty('send_count');
  });

  it('persists send_count 1 after post_send_observation when the child exits without a turn-result', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'post-send-missing');
    const heartbeat = {
      schema: 'observation-heartbeat/v1',
      phase: 'post_send_observation',
      poll_count: 1,
      observation_state: 'busy',
      stable_reads: 0,
      completion_ready: false,
    };
    const fixture = nodeFixture(`
      process.stdout.write(JSON.stringify(${JSON.stringify(heartbeat)}) + '\\n');
      process.exit(1);
    `);
    process.env.OPK_FM_LONG_CHILD_NO_CANDIDATE_GRACE_MS = '200';
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-post-send-missing',
      attemptIdentity: 'attempt-post-send-missing',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(1);
    const envelope = readTerminalEnvelope(paths.envelope);
    expect(envelope).toMatchObject({
      incident: 'child_terminal_result_missing',
      delivery: 'POSSIBLY_DELIVERED',
      send_count: 1,
    });
    expect(envelope?.diagnostics).toMatchObject({
      last_heartbeat: { phase: 'post_send_observation' },
    });
  });

  it('re-checks stdout after child exit before publishing missing result (P1)', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'post-exit-eof');
    const result = makeTurnResult();
    const fixture = nodeFixture(`
      process.nextTick(() => {
        process.stdout.write(JSON.stringify(${JSON.stringify(result)}) + '\\n');
        process.exit(0);
      });
    `);
    process.env.OPK_FM_LONG_CHILD_NO_CANDIDATE_GRACE_MS = '2000';
    process.env.OPK_FM_LONG_CHILD_CANDIDATE_GRACE_MS = '2000';
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-post-exit',
      attemptIdentity: 'attempt-post-exit',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(0);
    expect(readTerminalEnvelope(paths.envelope)?.lifecycle_outcome).toBe('success');
  });

  it('commits exactly one receipt and starts one child when launchers race (P1)', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'concurrent-launch');
    const counterPath = join(root, 'child-start-count.txt');
    const result = makeTurnResult();
    const counterPortable = counterPath.replace(/\\/g, '/');
    const fixture = nodeFixture([
      'const fs = require("fs");',
      `const counter = "${counterPortable}";`,
      'const prior = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;',
      'fs.writeFileSync(counter, String(prior + 1));',
      `process.stdout.write(JSON.stringify(${JSON.stringify(result)}) + '\\n');`,
      'process.exit(0);',
    ].join(''));
    const launchConfig = {
      runIdentity: 'run-concurrent',
      attemptIdentity: 'attempt-concurrent',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    };
    process.env.OPK_FM_LONG_CHILD_DISABLE_DETACH = '1';
    const [firstCode, secondCode] = await Promise.all([
      runFixtureLaunch(root, launchConfig),
      runFixtureLaunch(root, launchConfig),
    ]);
    expect(existsSync(paths.receipt)).toBe(true);
    expect(readHandoffReceipt(paths.receipt)?.schema).toBe(HANDOFF_SCHEMA);
    expect(readFileSync(counterPath, 'utf8')).toBe('1');
    expect([firstCode, secondCode].sort()).toEqual([0, 2]);
    expect(existsSync(paths.envelope)).toBe(true);
    expect(readTerminalEnvelope(paths.envelope)?.lifecycle_outcome).toBe('success');
  });

  it('carries conversation locator on fresh-chat non-ok incident when recovery is available (P1)', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'fresh-chat-locator');
    const conversationUrl = 'https://chatgpt.com/c/fresh-uuid-1164';
    const result = makeTurnResult({
      state: 'login',
      scope: 'profile',
      cause: 'challenge_wall',
      conversation_id: conversationUrl,
      witness: undefined,
      observation_uncertainty_diagnostics: {
        cause: 'challenge_wall',
        send_count: 1,
        owned_prompt_seen: false,
      },
    });
    const fixture = nodeFixture(`
      process.stdout.write(JSON.stringify(${JSON.stringify(result)}) + '\\n');
      process.exit(0);
    `);
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-fresh',
      attemptIdentity: 'attempt-fresh',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(1);
    const envelope = readTerminalEnvelope(paths.envelope);
    expect(envelope?.recovery_available).toBe(true);
    expect(envelope?.conversation_locator).toBe(conversationUrl);
    expect(envelope?.lifecycle_outcome).toBe('incident');
    expect(envelope?.incident).toBe('child_turn_state:login');
    expect(envelope?.delivery).toBe('POSSIBLY_DELIVERED');
  });

  it('seals the exact observed zero-send turn-result identity into the terminal envelope (#1977)', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'zero-send-observed-result');
    const result = makeTurnResult({
      state: 'output_conflict',
      scope: 'invocation',
      cause: 'observation_marker_conflict',
      witness: undefined,
      observation_uncertainty_diagnostics: {
        cause: 'observation_marker_conflict',
        send_count: 0,
        owned_prompt_seen: false,
      },
    });
    const serialized = JSON.stringify(result);
    const expectedIdentity = `sha256:${createHash('sha256').update(serialized, 'utf8').digest('hex')}:turn-result-v1`;
    const fixture = nodeFixture(`
      process.stdout.write(JSON.stringify(${JSON.stringify(result)}) + '\\n');
      process.exit(0);
    `);
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-zero-send-observed-result',
      attemptIdentity: 'attempt-zero-send-observed-result',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(1);
    expect(readTerminalEnvelope(paths.envelope)).toMatchObject({
      lifecycle_outcome: 'incident',
      incident: 'child_turn_state:output_conflict',
      delivery: 'not-sent',
      send_count: 0,
      observed_invocation_id: result.invocation_id,
      observed_turn_result_identity: expectedIdentity,
    });
  });

  it('rejects stale handoff receipt from a prior attempt (P1)', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'stale-receipt');
    mkdirSync(dirname(paths.receipt), { recursive: true });
    writeFileSync(paths.receipt, JSON.stringify({
      schema: HANDOFF_SCHEMA,
      run_identity: 'stale-run',
      attempt_identity: 'stale-attempt',
      launcher_started_at: '2026-01-01T00:00:00.000Z',
      handoff_committed_at: '2026-01-01T00:00:00.000Z',
      completion_mode: COMPLETION_MODE,
    }));
    for (const [key, value] of Object.entries(cliFixtureEnv(root))) vi.stubEnv(key, value);
    const code = await runBrowserAdapter([
      '--run-identity', 'fresh-run',
      '--attempt-identity', 'fresh-attempt',
      '--handoff-receipt', paths.receipt,
      '--terminal-envelope', paths.envelope,
      '--output', paths.output,
      '--profile', 'fixture-profile',
      '--cdp', 'http://127.0.0.1:9222',
      '--input', join(repoRoot, 'scripts/chatgpt-browser-turn/README.md'),
    ]);
    expect(code).toBe(2);
  });

  it('waiter ignores terminal envelope from a prior attempt (P1)', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'stale-envelope');
    mkdirSync(dirname(paths.envelope), { recursive: true });
    writeFileSync(paths.envelope, JSON.stringify({
      schema: TERMINAL_SCHEMA,
      run_identity: 'stale-run',
      attempt_identity: 'stale-attempt',
      completion_mode: COMPLETION_MODE,
      handoff_receipt_path: paths.receipt,
      launcher_started_at: '2026-01-01T00:00:00.000Z',
      handoff_committed_at: '2026-01-01T00:00:00.000Z',
      terminal_at: '2026-01-01T00:00:01.000Z',
      lifecycle_outcome: 'success',
      delivery: 'landed',
      recovery_available: false,
    }));
    const waitResult = await runProcess({
      command: process.execPath,
      args: [
        '--experimental-strip-types', launcherPath, 'wait',
        '--run-identity', 'fresh-run',
        '--attempt-identity', 'fresh-attempt',
        '--terminal-envelope', paths.envelope,
        '--handoff-receipt', paths.receipt,
        '--deadline-ms', '200',
      ],
      cwd: repoRoot,
      inheritParentEnv: true,
      allowEmptyStdout: true,
      timeoutMs: 10_000,
    });
    const body = JSON.parse(waitResult.stdout.trim());
    expect(body.envelope_absent).toBe(true);
    expect(body.terminal).toBe(false);
  });

  it('detects duplicate turn-results arriving during finalization grace (P2)', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'dup-grace');
    const result = makeTurnResult();
    const fixture = nodeFixture(`
      const r = ${JSON.stringify(result)};
      process.stdout.write(JSON.stringify(r) + '\\n');
      setTimeout(() => {
        process.stdout.write(JSON.stringify(r) + '\\n');
        process.exit(0);
      }, 200);
    `);
    process.env.OPK_FM_LONG_CHILD_CANDIDATE_GRACE_MS = '500';
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-dup-grace',
      attemptIdentity: 'attempt-dup-grace',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(1);
    expect(readTerminalEnvelope(paths.envelope)?.incident).toBe('child_terminal_result_duplicate');
  });

  it('detects symlink-parent path aliases', () => {
    const root = tempDir();
    const realDir = join(root, 'real');
    const linkDir = join(root, 'link');
    mkdirSync(realDir);
    symlinkSync(realDir, linkDir);
    const left = join(linkDir, 'receipt.json');
    const right = join(realDir, 'receipt.json');
    expect(pathsAlias(left, right)).toBe(true);
  });

  it('survives initiating caller exit after handoff commit', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'survival');
    const result = makeTurnResult();
    const childMarker = join(root, 'survival-child-started.txt');
    const fixture = markedChildFixture(childMarker, result);
    const detachResult = await runProcess({
      command: '/bin/sh',
      args: [
        '-c',
        'node_bin="$1"; launcher="$2"; shift 2; trap "" HUP; "$node_bin" --experimental-strip-types "$launcher" "$@" </dev/null >/dev/null 2>&1 & printf "%s\\n" "$!"',
        'opk-fm-survival-detach',
        process.execPath,
        launcherPath,
        'launch',
        '--run-identity', 'survive-run',
        '--attempt-identity', 'survive-attempt',
        '--handoff-receipt', paths.receipt,
        '--terminal-envelope', paths.envelope,
        '--browser-output', paths.output,
        '--cwd', repoRoot,
        '--child-command', fixture.command,
        '--', ...fixture.args,
      ],
      cwd: repoRoot,
      env: cliFixtureEnv(root),
      inheritParentEnv: true,
      allowEmptyStdout: false,
      timeoutMs: 10_000,
    });
    expect(detachResult.ok).toBe(true);
    expect(detachResult.stdout.trim()).toMatch(/^\d+$/u);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const envelope = readTerminalEnvelope(paths.envelope);
      if (envelope?.lifecycle_outcome === 'success') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(readHandoffReceipt(paths.receipt)?.schema).toBe(HANDOFF_SCHEMA);
    expect(readTerminalEnvelope(paths.envelope)).toMatchObject({
      lifecycle_outcome: 'success', delivery: 'landed', turn_result_state: 'ok',
    });
    expect(isWakeableTerminalEnvelopePath(paths.envelope, root)).toBe(true);
    expect(existsSync(childMarker)).toBe(true);
  });
});


describe('Issue #2478: invocation-addressable launcher evidence', () => {
  const profile = '/synthetic/browser-profile';
  const cdp = 'http://127.0.0.1:9222';

  it('commits one private index, exact owner metadata, child cwd and real PID; native wait resolves from another cwd', async () => {
    const root = tempDir('opk-2478-index-');
    const paths = launchPaths(root, 'first');
    const marker = join(root, 'started.txt');
    const invocation = 'inv-42';
    const fixture = markedChildFixture(marker, makeTurnResult({ invocation_id: invocation }));
    const outcome = await runLauncherCli([
      ...cliLaunchArgs(paths, fixture).slice(0, -fixture.args.length - 1),
      '--invocation-id', invocation, '--profile', profile, '--cdp', cdp,
      '--owner-task-id', 'task-42', '--owner-dispatch-id', 'dispatch-9',
      '--', ...fixture.args,
    ], { ...cliFixtureEnv(root), CHATGPT_BROWSER_TURN_STATE_DIR: join(root, 'state') });
    expect(outcome.code).toBe(0);
    const locatorPath = invocationReceiptLocatorPath(invocation, root);
    const indexed = readInvocationReceiptLocator({
      invocationId: invocation, runIdentity: 'run-2440', attemptIdentity: 'attempt-2440',
      terminalEnvelopeRoot: root,
    });
    expect(indexed.path).toBe(locatorPath);
    expect(indexed.locator.handoff_receipt_path).toBe(paths.receipt);
    expect(indexed.locator.terminal_envelope_path).toBe(paths.envelope);
    expect(indexed.receipt).toMatchObject({
      schema: HANDOFF_SCHEMA, invocation_id: invocation,
      owner_task_id: 'task-42', owner_dispatch_id: 'dispatch-9',
      child_cwd: repoRoot, launcher_pid: expect.any(Number),
    });
    expect(indexed.receipt.launcher_pid).toBeGreaterThan(1);
    expect(indexed.receipt).not.toHaveProperty('launching_terminal_incarnation');
    if (process.platform !== 'win32') {
      expect(statSync(locatorPath).mode & 0o077).toBe(0);
      expect(statSync(dirname(locatorPath)).mode & 0o077).toBe(0);
    }
    const waiter = await runProcess({
      command: process.execPath,
      args: ['--experimental-strip-types', launcherPath, 'wait',
        '--run-identity', 'run-2440', '--attempt-identity', 'attempt-2440',
        '--receipt-locator', locatorPath, '--deadline-ms', '300'],
      cwd: root, env: cliFixtureEnv(root), inheritParentEnv: true,
      allowEmptyStdout: false, timeoutMs: 10_000,
    });
    expect(waiter.ok).toBe(true);
    const body = JSON.parse(waiter.stdout.trim()) as Record<string, unknown>;
    expect(body.terminal).toBe(true);
    expect((body.envelope as { lifecycle_outcome: string }).lifecycle_outcome).toBe('success');
    expect(existsSync(marker)).toBe(true);
  });

  it('keeps legacy direct launch unindexed and refuses reused IDs across attempts or profiles before child start', async () => {
    const root = tempDir('opk-2478-reuse-');
    const original = launchPaths(root, 'original');
    const invocationId = 'inv-reuse';
    const first = await runFixtureLaunch(root, {
      runIdentity: 'run-1', attemptIdentity: 'attempt-1', invocationId, profile, cdp,
      handoffReceiptPath: original.receipt, terminalEnvelopePath: original.envelope,
      browserOutputPath: original.output, cwd: repoRoot, childCommand: process.execPath,
      childArgs: nodeFixture('process.exit(0)').args,
    });
    expect(first).toBe(1); // no turn result; the ID must still remain occupied
    const retry = launchPaths(root, 'different-attempt');
    const marker = join(root, 'retry-sent.txt');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-2', attemptIdentity: 'attempt-2', invocationId,
      profile: '/different/profile', cdp,
      handoffReceiptPath: retry.receipt, terminalEnvelopePath: retry.envelope,
      browserOutputPath: retry.output, cwd: repoRoot, childCommand: process.execPath,
      childArgs: markedChildFixture(marker, makeTurnResult()).args,
    });
    const refusal = stderr.mock.calls.map((call) => String(call[0])).join('');
    stderr.mockRestore();
    expect(code).toBe(2);
    expect(refusal).toContain('invocation_admission_failed_use_fresh_id');
    expectNoLauncherEffects(retry, marker);
    const legacy = launchPaths(root, 'legacy');
    const legacyCode = await runFixtureLaunch(root, {
      runIdentity: 'legacy-run', attemptIdentity: 'legacy-attempt',
      handoffReceiptPath: legacy.receipt, terminalEnvelopePath: legacy.envelope,
      browserOutputPath: legacy.output, cwd: repoRoot, childCommand: process.execPath,
      childArgs: nodeFixture('process.exit(0)').args,
    });
    expect(legacyCode).toBe(1);
    expect(readHandoffReceipt(legacy.receipt)).not.toHaveProperty('invocation_id');
    expect(existsSync(invocationReceiptLocatorPath('legacy-run', root))).toBe(false);
  });

  it('refuses a same-profile pre-index durable observation even with no locator', async () => {
    const root = tempDir('opk-2478-observation-');
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', join(root, 'state'));
    const invocationId = 'preindexed-42';
    admitStateLightTurnObservation({
      profileKey: configuredProfileKey(profile, cdp), invocationId, marker: 'owned-marker-42',
    });
    const paths = launchPaths(root, 'refused-observation');
    const marker = join(root, 'must-not-send.txt');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-observation', attemptIdentity: 'attempt-1',
      invocationId, profile, cdp,
      handoffReceiptPath: paths.receipt, terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output, cwd: repoRoot, childCommand: process.execPath,
      childArgs: markedChildFixture(marker, makeTurnResult()).args,
    });
    const refusal = stderr.mock.calls.map((call) => String(call[0])).join('');
    stderr.mockRestore();
    expect(code).toBe(2);
    expect(refusal).toContain('invocation_observation_occupied');
    expectNoLauncherEffects(paths, marker);
    expect(existsSync(invocationReceiptLocatorPath(invocationId, root))).toBe(false);
  });

  it('rejects index symlinks, malformed contents, absent original receipts and identity mismatch', async () => {
    const root = tempDir('opk-2478-index-invalid-');
    const invocationId = 'index-negative';
    const paths = launchPaths(root, 'negative');
    const indexPath = invocationReceiptLocatorPath(invocationId, root);
    mkdirSync(dirname(indexPath), { recursive: true, mode: 0o700 });
    symlinkSync(join(root, 'non-existent.json'), indexPath);
    const marker = join(root, 'must-not-start.txt');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-negative', attemptIdentity: 'attempt-negative', invocationId, profile, cdp,
      handoffReceiptPath: paths.receipt, terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output, cwd: repoRoot, childCommand: process.execPath,
      childArgs: markedChildFixture(marker, makeTurnResult()).args,
    });
    stderr.mockRestore();
    expect(code).toBe(2);
    expectNoLauncherEffects(paths, marker);
    rmSync(indexPath);
    const good = await runFixtureLaunch(root, {
      runIdentity: 'run-negative', attemptIdentity: 'attempt-negative', invocationId, profile, cdp,
      handoffReceiptPath: paths.receipt, terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output, cwd: repoRoot, childCommand: process.execPath,
      childArgs: nodeFixture('process.exit(0)').args,
    });
    expect(good).toBe(1);
    expect(() => readInvocationReceiptLocator({
      invocationId, runIdentity: 'wrong-run', attemptIdentity: 'attempt-negative',
      terminalEnvelopeRoot: root,
    })).toThrow();
    writeFileSync(indexPath, '{"wrong":"schema"}');
    expect(() => readInvocationReceiptLocator({
      invocationId, runIdentity: 'run-negative', attemptIdentity: 'attempt-negative',
      terminalEnvelopeRoot: root,
    })).toThrow();
    const preserved = JSON.stringify({
      schema: 'flow-manager-long-running-child-locator/v1', invocation_id: invocationId,
      run_identity: 'run-negative', attempt_identity: 'attempt-negative',
      handoff_receipt_path: paths.receipt, terminal_envelope_path: paths.envelope,
    });
    writeFileSync(indexPath, preserved);
    rmSync(paths.receipt);
    expect(() => readInvocationReceiptLocator({
      invocationId, runIdentity: 'run-negative', attemptIdentity: 'attempt-negative',
      terminalEnvelopeRoot: root,
    })).toThrow(/receipt_locator_handoff_missing|ENOENT/u);
  });

  it.each([
    ['detached-success', false, false],
    ['synchronous-success', true, false],
    ['synchronous-failing-child', true, true],
  ] as const)('adapter %s publishes the real child-launcher process PID, not shell PID or exit status', async (mode, synchronous, childFails) => {
    const root = tempDir('opk-2478-adapter-');
    const paths = launchPaths(root, mode);
    const invocationId = 'adapter-' + mode;
    for (const [key, value] of Object.entries(cliFixtureEnv(root))) vi.stubEnv(key, value);
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', join(root, 'state'));
    vi.stubEnv('ORCA_TERMINAL_HANDLE', 'synthetic-terminal-handle');
    if (synchronous) vi.stubEnv('OPK_FM_LONG_CHILD_DISABLE_DETACH', '1');
    const child = childFails
      ? nodeFixture('process.exit(7)')
      : markedChildFixture(join(root, 'adapter-started.txt'), makeTurnResult({ invocation_id: invocationId }));
    // Preserve the actual launcher/adapter/receipt behavior; substitute only synthetic Browser child.
    const launch = vi.fn(async (args: readonly string[]) => {
      expect(args).toContain('--invocation-id');
      expect(args).toContain(invocationId);
      expect(args).toContain('--owner-task-id');
      expect(args).toContain('--owner-dispatch-id');
      const childCommandIndex = args.indexOf('--child-command');
      expect(childCommandIndex).toBeGreaterThan(0);
      return await spawnDetachedLauncher([
        ...args.slice(0, childCommandIndex),
        '--child-command', child.command, '--', ...child.args,
      ]);
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runBrowserAdapter([
      '--run-identity', 'adapter-run', '--attempt-identity', 'adapter-attempt',
      '--invocation-id', invocationId, '--owner-task-id', 'owner-42', '--owner-dispatch-id', 'dispatch-42',
      '--handoff-receipt', paths.receipt, '--terminal-envelope', paths.envelope,
      '--output', paths.output, '--profile', profile, '--cdp', cdp,
      '--input', join(root, 'synthetic-prompt.txt'), '--cwd', root,
    ], { spawnLauncher: launch });
    const out = stdout.mock.calls.map((call) => String(call[0])).join('');
    stdout.mockRestore();
    expect(code).toBe(0);
    const ack = JSON.parse(out.trim()) as Record<string, unknown>;
    const receipt = readHandoffReceipt(paths.receipt)!;
    expect(ack.schema).toBe('flow-manager-browser-gpt-long-run-accepted/v1');
    expect(ack.receipt_locator).toBe(invocationReceiptLocatorPath(invocationId, root));
    expect(ack.launcher_pid).toBe(receipt.launcher_pid);
    expect(receipt.launcher_pid).toBeGreaterThan(1);
    expect(receipt.launcher_pid).not.toBe(process.pid); // real separate launcher process
    expect(ack.child_cwd).toBe(realpathSync(root));
    expect(ack.owner_task_id).toBe('owner-42');
    expect(ack.owner_dispatch_id).toBe('dispatch-42');
    expect(receipt.launching_terminal_handle).toBe('synthetic-terminal-handle');
    expect(receipt).not.toHaveProperty('launching_terminal_incarnation');
    if (synchronous) {
      expect(readTerminalEnvelope(paths.envelope)?.lifecycle_outcome)
        .toBe(childFails ? 'incident' : 'success');
      expect(readTerminalEnvelope(paths.envelope)?.child_exit_code)
        .toBe(childFails ? 7 : 0);
    } else {
      // Acceptance precedes detached completion; wait before afterEach removes its fixture.
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const terminal = readTerminalEnvelope(paths.envelope, {
          runIdentity: 'adapter-run', attemptIdentity: 'adapter-attempt',
        });
        if (terminal?.lifecycle_outcome === 'success'
          && terminal.launcher_started_at === receipt.launcher_started_at
          && terminal.handoff_committed_at === receipt.handoff_committed_at
          && terminal.observed_invocation_id === invocationId) break;
        await new Promise((done) => setTimeout(done, 50));
      }
      expect(readTerminalEnvelope(paths.envelope, {
        runIdentity: 'adapter-run', attemptIdentity: 'adapter-attempt',
      })).toMatchObject({
        lifecycle_outcome: 'success',
        handoff_receipt_path: paths.receipt,
        launcher_started_at: receipt.launcher_started_at,
        handoff_committed_at: receipt.handoff_committed_at,
        observed_invocation_id: invocationId,
      });
    }
  });


  it.each(['detached', 'synchronous'] as const)(
    'refuses exact replay and changed profile/output/receipt for %s before a second Browser spawn',
    async (mode) => {
      const root = tempDir('opk-2478-replay-');
      const paths = launchPaths(root, mode);
      const invocationId = 'invocation-replay-' + mode;
      const childMarker = join(root, 'original-child-started.txt');
      for (const [key, value] of Object.entries(cliFixtureEnv(root))) vi.stubEnv(key, value);
      vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', join(root, 'state'));
      if (mode === 'synchronous') vi.stubEnv('OPK_FM_LONG_CHILD_DISABLE_DETACH', '1');
      const fixture = markedChildFixture(childMarker, makeTurnResult({ invocation_id: invocationId }));
      const launch = vi.fn(async (args: readonly string[]) => {
        const childCommandIndex = args.indexOf('--child-command');
        return await spawnDetachedLauncher([
          ...args.slice(0, childCommandIndex),
          '--child-command', fixture.command, '--', ...fixture.args,
        ]);
      });
      const args = [
        '--run-identity', 'same-run', '--attempt-identity', 'same-attempt',
        '--invocation-id', invocationId,
        '--owner-task-id', 'same-task', '--owner-dispatch-id', 'same-dispatch',
        '--handoff-receipt', paths.receipt, '--terminal-envelope', paths.envelope,
        '--output', paths.output, '--profile', profile, '--cdp', cdp,
        '--input', join(root, 'synthetic-prompt.txt'), '--cwd', root,
      ];
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        expect(await runBrowserAdapter(args, { spawnLauncher: launch })).toBe(0);
        const firstAck = stdout.mock.calls.map((call) => String(call[0])).join('');
        expect(JSON.parse(firstAck.trim()).launcher_pid).toBe(readHandoffReceipt(paths.receipt)?.launcher_pid);
        stdout.mockClear();
        // Detached acceptance may precede the original Browser child terminal.
        const terminalDeadline = Date.now() + 10_000;
        while (Date.now() < terminalDeadline && !readTerminalEnvelope(paths.envelope, {
          runIdentity: 'same-run', attemptIdentity: 'same-attempt',
        })) {
          await new Promise((done) => setTimeout(done, 50));
        }
        expect(readTerminalEnvelope(paths.envelope, {
          runIdentity: 'same-run', attemptIdentity: 'same-attempt',
        })?.lifecycle_outcome).toBe('success');
        const firstPid = readHandoffReceipt(paths.receipt)?.launcher_pid;
        const originalBytes = readFileSync(paths.receipt, 'utf8');
        const alternateReceipt = launchPaths(root, 'new-receipt');
        const scenarios = [
          args,
          args.map((token, i) => i === args.indexOf('--profile') + 1 ? profile + '-changed' : token),
          args.map((token, i) => i === args.indexOf('--output') + 1 ? join(root, 'changed-output.txt') : token),
          args.map((token, i) => i === args.indexOf('--handoff-receipt') + 1 ? alternateReceipt.receipt : token),
        ];
        for (const replayArgs of scenarios) {
          expect(await runBrowserAdapter(replayArgs, { spawnLauncher: launch })).toBe(2);
          expect(stdout.mock.calls.map((call) => String(call[0])).join('')).not.toContain(
            'flow-manager-browser-gpt-long-run-accepted/v1',
          );
          stdout.mockClear();
        }
        expect(launch).toHaveBeenCalledTimes(1);
        expect(readFileSync(paths.receipt, 'utf8')).toBe(originalBytes);
        expect(readHandoffReceipt(paths.receipt)?.launcher_pid).toBe(firstPid);
        expect(readFileSync(childMarker, 'utf8')).toBe('started');
        expect(existsSync(alternateReceipt.receipt)).toBe(false);
        expect(existsSync(join(root, 'changed-output.txt'))).toBe(false);
        // The shared in-process launcher validator names the actual occupied path with a nextStep.
        const refusals = stderr.mock.calls.map((call) => String(call[0])).filter((line) => line.trim());
        expect(refusals).toHaveLength(scenarios.length);
        for (const line of refusals) expect(line).toMatch(/: occupied_launcher_owned_path; nextStep: \S/u);
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
      }
    },
  );

  it('resolves an indexed direct-launch terminal with an original relative receipt from another cwd', async () => {
    const root = tempDir('opk-2478-relative-receipt-');
    const paths = launchPaths(root, 'relative');
    const invocationId = 'relative-receipt-invocation';
    const relativeReceipt = relative(repoRoot, paths.receipt);
    expect(isAbsolute(relativeReceipt)).toBe(false);
    const fixture = nodeFixture(
      'process.stdout.write(JSON.stringify(' +
      JSON.stringify(makeTurnResult({ invocation_id: invocationId })) +
      ') + "\\n", () => process.exit(0));',
    );
    const launched = await runLauncherCli([
      ...cliLaunchArgs({ ...paths, receipt: relativeReceipt }, fixture).slice(0, -fixture.args.length - 1),
      '--invocation-id', invocationId, '--profile', profile, '--cdp', cdp, '--', ...fixture.args,
    ], { ...cliFixtureEnv(root), CHATGPT_BROWSER_TURN_STATE_DIR: join(root, 'state') });
    expect(launched.code).toBe(0);
    expect(readHandoffReceipt(paths.receipt)?.invocation_id).toBe(invocationId);
    expect(readTerminalEnvelope(paths.envelope)?.handoff_receipt_path).toBe(relativeReceipt);
    const waited = await runProcess({
      command: process.execPath,
      args: [
        '--experimental-strip-types', launcherPath, 'wait',
        '--run-identity', 'run-2440', '--attempt-identity', 'attempt-2440',
        '--invocation-id', invocationId, '--deadline-ms', '300',
      ],
      cwd: root,
      env: { ...cliFixtureEnv(root), CHATGPT_BROWSER_TURN_STATE_DIR: join(root, 'state') },
      inheritParentEnv: false,
      allowEmptyStdout: false,
      timeoutMs: 10_000,
    });
    expect(waited.ok).toBe(true);
    const response = JSON.parse(waited.stdout.trim());
    expect(response.terminal).toBe(true);
    expect(response.envelope.handoff_receipt_path).toBe(relativeReceipt);
    expect(response.envelope.lifecycle_outcome).toBe('success');
    expect(response.no_success_authority).toBe(false);
    expect(response.no_retry_authority).toBe(true);
  });

  it('keeps an indexed key occupied after the original handoff write fails before send', async () => {
    const root = tempDir('opk-2478-partial-');
    const invocationId = 'partial-reservation-invocation';
    const paths = launchPaths(root, 'reservation');
    const childMarker = join(root, 'should-not-send.txt');
    process.env.OPK_FM_LONG_CHILD_FORCE_RECEIPT_CREATE_FAIL = '1';
    const input = {
      runIdentity: 'reservation-run', attemptIdentity: 'reservation-attempt',
      invocationId, profile, cdp,
      handoffReceiptPath: paths.receipt, terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output, cwd: repoRoot, childCommand: process.execPath,
      childArgs: markedChildFixture(childMarker, makeTurnResult()).args,
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const initial = await runFixtureLaunch(root, input);
    expect(initial).toBe(2);
    expect(existsSync(invocationReceiptLocatorPath(invocationId, root))).toBe(true);
    expectNoLauncherEffects(paths, childMarker);
    delete process.env.OPK_FM_LONG_CHILD_FORCE_RECEIPT_CREATE_FAIL;
    const second = await runFixtureLaunch(root, {
      ...input, ...launchPaths(root, 'second'),
      handoffReceiptPath: launchPaths(root, 'second').receipt,
      terminalEnvelopePath: launchPaths(root, 'second').envelope,
      browserOutputPath: launchPaths(root, 'second').output,
    });
    stderr.mockRestore();
    expect(second).toBe(2);
    expect(existsSync(childMarker)).toBe(false);
  });

  it('does not preempt healthy recovery after the old page closed; late owned successor result wins', async () => {
    const root = tempDir('opk-2478-recovery-');
    const paths = launchPaths(root, 'recovery');
    const invocationId = 'recovery-invocation';
    const result = makeTurnResult({ invocation_id: invocationId });
    const child = nodeFixture(`
      let ticks = 0;
      const tick = setInterval(() => {
        process.stdout.write(JSON.stringify({
          schema: 'observation-heartbeat/v1', phase: 'post_send_observation',
          poll_count: ++ticks, observation_state: 'busy', stable_reads: 0,
          completion_ready: false, original_page_closed: true, recovery_census_pending: true,
        }) + '\\n');
      }, 25);
      setTimeout(() => {
        clearInterval(tick);
        process.stdout.write(JSON.stringify({ ...${JSON.stringify(result)}, owned_successor: true }) + '\\n',
          () => process.exit(0));
      }, 700);
    `);
    const code = await runFixtureLaunch(root, {
      runIdentity: 'recovery-run', attemptIdentity: 'recovery-attempt',
      invocationId, profile, cdp,
      handoffReceiptPath: paths.receipt, terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output, cwd: repoRoot, childCommand: process.execPath,
      childArgs: child.args,
    });
    expect(code).toBe(0);
    const envelope = readTerminalEnvelope(paths.envelope);
    expect(envelope?.lifecycle_outcome).toBe('success');
    expect(envelope?.turn_result_state).toBe('ok');
    expect(envelope?.observed_invocation_id).toBe(invocationId);
    expect(envelope).not.toHaveProperty('incident');
    expect(JSON.stringify(envelope)).not.toContain('chat_page_gone');
  });

  it('invocation wait before terminal is nonterminal, then returns the same original envelope', async () => {
    const root = tempDir('opk-2478-wait-');
    const paths = launchPaths(root, 'pending');
    const invocationId = 'pending-invocation';
    const result = makeTurnResult({ invocation_id: invocationId });
    const child = nodeFixture(`
      let count = 0;
      const timer = setInterval(() => {
        process.stdout.write(JSON.stringify({
          schema: 'observation-heartbeat/v1', phase: 'post_send_observation',
          poll_count: ++count, observation_state: 'busy', stable_reads: 0, completion_ready: false,
        }) + '\\n');
      }, 25);
      setTimeout(() => { clearInterval(timer); process.stdout.write(JSON.stringify(${JSON.stringify(result)}) + '\\n',
        () => process.exit(0)); }, 600);
    `);
    const launch = runFixtureLaunch(root, {
      runIdentity: 'wait-run', attemptIdentity: 'wait-attempt', invocationId, profile, cdp,
      handoffReceiptPath: paths.receipt, terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output, cwd: repoRoot, childCommand: process.execPath,
      childArgs: child.args,
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runWait({ runIdentity: 'wait-run', attemptIdentity: 'wait-attempt',
      invocationId, terminalEnvelopeRoot: root, deadlineMs: 80 });
    const before = stdout.mock.calls.map((call) => String(call[0])).join('');
    stdout.mockClear();
    expect(JSON.parse(before.trim())).toMatchObject({
      terminal: false, non_terminal: true, envelope_absent: true,
      no_success_authority: true, no_retry_authority: true,
    });
    expect(await launch).toBe(0);
    await runWait({ runIdentity: 'wait-run', attemptIdentity: 'wait-attempt',
      receiptLocator: invocationReceiptLocatorPath(invocationId, root),
      terminalEnvelopeRoot: root, deadlineMs: 100 });
    const after = stdout.mock.calls.map((call) => String(call[0])).join('');
    stdout.mockRestore();
    expect(JSON.parse(after.trim()).envelope.lifecycle_outcome).toBe('success');
  });
});
describe('Issue #2750 owner-wait pair validation', () => {
  it('rejects a one-sided Task/Dispatch identity before locator or receipt lookup', async () => {
    await expect(runWait({
      runIdentity: 'pair-run', attemptIdentity: 'pair-attempt',
      invocationId: 'pair-invocation', ownerTaskId: 'task-only', deadlineMs: 1,
    })).rejects.toThrow('wait_owner_identity_required');

    await expect(runWait({
      runIdentity: 'pair-run', attemptIdentity: 'pair-attempt',
      invocationId: 'pair-invocation', ownerDispatchId: 'dispatch-only', deadlineMs: 1,
    })).rejects.toThrow('wait_owner_identity_required');
  });
  it('rejects a Dispatch without its Task at the shared invocation locator reader', () => {
    // Task-only correlation stays legal here for exact retire-owned; owner-wait authority above needs both.
    expect(() => readInvocationReceiptLocator({
      runIdentity: 'pair-run', attemptIdentity: 'pair-attempt',
      invocationId: 'pair-invocation', ownerDispatchId: 'dispatch-only',
    })).toThrow('wait_owner_identity_required');
    expect(() => readInvocationReceiptLocator({
      runIdentity: 'pair-run', attemptIdentity: 'pair-attempt',
      invocationId: 'pair-invocation', ownerTaskId: 'task-only', ownerDispatchId: ' ',
    })).toThrow('wait_owner_identity_required');
  });
});

// ---------------------------------------------------------------------------
// Issue #2750 shared fixtures. Hand-written receipts, locators and observation records under
// disposable roots: no real browser, network, GitHub or live state directory is ever touched.
// ---------------------------------------------------------------------------
const OWNER_PROJECT = 'proj-2750';
const OWNER_TASK = 'task-2750';
const OWNER_DISPATCH = 'dispatch-2750';
const WITNESS_BOOT = 'boot-aaaaaaaa';
const WITNESS_NAMESPACE = 'pid:[4026531836]';
const WITNESS_STARTTICKS = '123456';
const OBSERVATION_MARKER = 'OPKTURNV1a97e3f70e9c07fa75c0f03840c0528a2';
const HEAD_BEFORE = 'a'.repeat(40);
const HEAD_AFTER = 'b'.repeat(40);
const ISSUE_BODY_BEFORE = createHash('sha256').update('issue body before', 'utf8').digest('hex');
const ISSUE_BODY_AFTER = createHash('sha256').update('issue body after', 'utf8').digest('hex');
const ADAPTER_PREFIX = 'flow-manager-browser-gpt-long-run: ';

type WaitOptions = Parameters<typeof runWait>[0];

function dropUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function writePrivateJson(path: string, body: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(body) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

function ownerEnvFor(root: string): NodeJS.ProcessEnv {
  return { HOME: root, OPK_BASE_DIR: join(root, 'opk-base'), OPK_PROJECT_ID: OWNER_PROJECT };
}

/** The existing selected-assignment store (worker-assignments.json) under an isolated base dir. */
function writeAssignmentStore(
  env: NodeJS.ProcessEnv,
  rows: ReadonlyArray<{ taskId: string; dispatchId: string }>,
): string {
  const file = resolveWorkerAssignmentStorePath(env.OPK_PROJECT_ID, env);
  mkdirSync(dirname(file), { recursive: true });
  const assignments: Record<string, unknown> = {};
  rows.forEach((row, index) => {
    assignments[workerAssignmentKey(row.taskId, row.dispatchId)] = {
      schema: WORKER_ASSIGNMENT_SCHEMA, projectId: OWNER_PROJECT, repository: 'acme/widgets',
      issueNumber: 2750 + index, taskId: row.taskId, assignmentId: 'assignment-' + index, generation: 1,
      kind: 'local', provider: 'orca', bindingKey: row.dispatchId, role: 'worker',
      createdAtUtc: '2026-11-02T00:00:00.000Z',
    };
  });
  writeFileSync(file, JSON.stringify({ schema: WORKER_ASSIGNMENT_STORE_SCHEMA, revision: 1, assignments }) + '\n');
  return file;
}

function stubOwnerStoreEnv(root: string): NodeJS.ProcessEnv {
  const env = ownerEnvFor(root);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, String(value));
  return env;
}

interface HandoffArtifacts {
  receiptPath: string;
  envelopePath: string;
  locatorPath: string;
  receipt: Record<string, unknown>;
}

function writeHandoffArtifacts(input: {
  terminalRoot: string; dir: string; invocation: string; run: string; attempt: string;
  receiptPath?: string; envelopePath?: string;
  receipt?: Record<string, unknown>; terminal?: Record<string, unknown>; skipLocator?: boolean;
}): HandoffArtifacts {
  const receiptPath = input.receiptPath ?? join(input.dir, 'handoff-receipt.json');
  const envelopePath = input.envelopePath ?? join(input.dir, 'turn-terminal.json');
  const receipt = dropUndefined({
    schema: HANDOFF_SCHEMA, run_identity: input.run, attempt_identity: input.attempt,
    launcher_started_at: '2026-11-02T00:00:00.000Z', handoff_committed_at: '2026-11-02T00:00:01.000Z',
    completion_mode: COMPLETION_MODE, invocation_id: input.invocation,
    owner_task_id: OWNER_TASK, owner_dispatch_id: OWNER_DISPATCH,
    child_cwd: input.dir, launcher_pid: 4242,
    launcher_startticks: WITNESS_STARTTICKS, launcher_pid_namespace: WITNESS_NAMESPACE,
    launcher_boot_id: WITNESS_BOOT, launcher_hard_deadline_ms: Date.now() + 3_600_000,
    ...input.receipt,
  });
  writePrivateJson(receiptPath, receipt);
  const locatorPath = invocationReceiptLocatorPath(input.invocation, input.terminalRoot);
  if (!input.skipLocator) {
    mkdirSync(dirname(locatorPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(locatorPath), 0o700);
    writePrivateJson(locatorPath, {
      schema: RECEIPT_LOCATOR_SCHEMA, invocation_id: input.invocation,
      run_identity: input.run, attempt_identity: input.attempt,
      handoff_receipt_path: receiptPath, terminal_envelope_path: envelopePath,
    });
  }
  if (input.terminal) writePrivateJson(envelopePath, input.terminal);
  return { receiptPath, envelopePath, locatorPath, receipt };
}

function launcherTerminal(artifacts: HandoffArtifacts, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return dropUndefined({
    schema: TERMINAL_SCHEMA, run_identity: artifacts.receipt.run_identity,
    attempt_identity: artifacts.receipt.attempt_identity, completion_mode: COMPLETION_MODE,
    handoff_receipt_path: artifacts.receiptPath, launcher_started_at: artifacts.receipt.launcher_started_at,
    handoff_committed_at: artifacts.receipt.handoff_committed_at, terminal_at: '2026-11-02T00:10:00.000Z',
    lifecycle_outcome: 'success', delivery: 'landed', turn_result_state: 'ok',
    observed_invocation_id: artifacts.receipt.invocation_id, recovery_available: false,
    ...overrides,
  });
}

function fixtureIds(id: string): { run: string; attempt: string; invocation: string } {
  return { run: 'run-' + id, attempt: 'attempt-' + id, invocation: 'inv-2750-' + id };
}

function issueBaselineFor(id: string, overrides: Record<string, unknown> = {}): GithubEffectBaseline {
  const ids = fixtureIds(id);
  return {
    schema: GITHUB_EFFECT_BASELINE_SCHEMA, invocation_id: ids.invocation, run_identity: ids.run,
    attempt_identity: ids.attempt, repo: 'acme/widgets', kind: 'issue', number: 2750,
    body_sha256: ISSUE_BODY_BEFORE, captured_at: '2026-11-02T00:00:00.500Z', ...overrides,
  } as GithubEffectBaseline;
}

function prBaselineFor(id: string, overrides: Record<string, unknown> = {}): GithubEffectBaseline {
  const ids = fixtureIds(id);
  return {
    schema: GITHUB_EFFECT_BASELINE_SCHEMA, invocation_id: ids.invocation, run_identity: ids.run,
    attempt_identity: ids.attempt, repo: 'acme/widgets', kind: 'pr', number: 7,
    head_sha: HEAD_BEFORE, captured_at: '2026-11-02T00:00:00.500Z', ...overrides,
  } as GithubEffectBaseline;
}

interface OwnerWaitFixture extends HandoffArtifacts {
  root: string; run: string; attempt: string; invocation: string;
  profile: string; cdp: string; profileKey: string; ownerEnv: NodeJS.ProcessEnv;
}

function ownerWaitFixture(id: string, options: {
  receipt?: Record<string, unknown>; baseline?: GithubEffectBaseline;
  store?: 'current' | 'replaced' | 'other-task' | 'absent';
} = {}): OwnerWaitFixture {
  const root = tempDir(`opk-2750-${id}-`);
  vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', join(root, 'state'));
  const ids = fixtureIds(id);
  const profile = join(root, 'profile');
  const cdp = 'http://127.0.0.1:9222';
  const ownerEnv = ownerEnvFor(root);
  const artifacts = writeHandoffArtifacts({
    terminalRoot: root, dir: join(root, id), invocation: ids.invocation, run: ids.run, attempt: ids.attempt,
    receipt: { ...(options.baseline ? { github_effect_baseline: options.baseline } : {}), ...options.receipt },
  });
  const store = options.store ?? 'current';
  if (store === 'current') writeAssignmentStore(ownerEnv, [{ taskId: OWNER_TASK, dispatchId: OWNER_DISPATCH }]);
  else if (store === 'replaced') writeAssignmentStore(ownerEnv, [{ taskId: OWNER_TASK, dispatchId: 'dispatch-other' }]);
  else if (store === 'other-task') writeAssignmentStore(ownerEnv, [{ taskId: 'task-other', dispatchId: OWNER_DISPATCH }]);
  return {
    ...artifacts, root, run: ids.run, attempt: ids.attempt, invocation: ids.invocation,
    profile, cdp, profileKey: configuredProfileKey(profile, cdp), ownerEnv,
  };
}

function witnessProbe(overrides: {
  boot?: string | undefined; namespace?: string | undefined; stat?: ReturnType<ProcessWitnessProbe['stat']>;
} = {}): ProcessWitnessProbe & { stat: ReturnType<typeof vi.fn> } {
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(overrides, key);
  const stat = vi.fn((_pid: number): ReturnType<ProcessWitnessProbe['stat']> =>
    overrides.stat ?? { kind: 'ok', startticks: WITNESS_STARTTICKS, state: 'S' });
  return {
    bootId: () => has('boot') ? overrides.boot : WITNESS_BOOT,
    pidNamespace: () => has('namespace') ? overrides.namespace : WITNESS_NAMESPACE,
    stat,
  };
}

const deadProbe = (): ReturnType<typeof witnessProbe> => witnessProbe({ stat: { kind: 'absent' } });

const finishedPage: OwnerWaitPageReader = async () => ({
  state: 'page_finished', evidence: 'stable_finished_generation', reply_length: 24_012,
});

function githubReaders(overrides: Partial<GithubEffectReaders> = {}): GithubEffectReaders {
  return { prHead: async () => HEAD_AFTER, issueBodySha256: async () => ISSUE_BODY_AFTER, ...overrides };
}

function ownerWaitOptions(
  fx: OwnerWaitFixture, deps: OwnerWaitDependencies = {}, extra: Partial<WaitOptions> = {},
): WaitOptions {
  return {
    runIdentity: fx.run, attemptIdentity: fx.attempt, invocationId: fx.invocation,
    ownerTaskId: OWNER_TASK, ownerDispatchId: OWNER_DISPATCH, terminalEnvelopeRoot: fx.root, deadlineMs: 1,
    ownerWaitDependencies: {
      launcherProbe: deadProbe(), githubReaders: githubReaders(), ownerEnv: fx.ownerEnv, ...deps,
    },
    ...extra,
  };
}

const pageInputs = (fx: OwnerWaitFixture): Partial<WaitOptions> => ({ profile: fx.profile, cdp: fx.cdp });

async function captureWaits(runs: ReadonlyArray<() => Promise<void>>): Promise<Record<string, any>[]> {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await Promise.all(runs.map((run) => run()));
    return stdout.mock.calls.map((call) => String(call[0])).join('').split('\n')
      .filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, any>);
  } finally {
    stdout.mockRestore();
  }
}

async function captureWait(options: WaitOptions): Promise<Record<string, any>> {
  const [body] = await captureWaits([() => runWait(options)]);
  return body!;
}

function envelopeArtifacts(fx: OwnerWaitFixture): string[] {
  return readdirSync(dirname(fx.envelopePath)).filter((name) => name !== basename(fx.receiptPath));
}

function expectDiagnosticOnly(fx: OwnerWaitFixture, out: Record<string, any>): void {
  expect(out.terminal).toBe(false);
  expect(out.non_terminal).toBe(true);
  expect(out.no_retry_authority).toBe(true);
  expect(out.owner_wait).toMatchObject({ effect: 'none', no_signal_sent: true });
  expect(String(out.owner_wait.nextStep)).toMatch(/\S/u);
  expect(existsSync(fx.envelopePath)).toBe(false);
  expect(envelopeArtifacts(fx)).toEqual([]);
}

function expectUncertaintyEnvelope(fx: OwnerWaitFixture, envelope: Record<string, any>): void {
  expect(envelope).toMatchObject({
    schema: TERMINAL_SCHEMA, run_identity: fx.run, attempt_identity: fx.attempt,
    completion_mode: COMPLETION_MODE, handoff_receipt_path: fx.receiptPath,
    lifecycle_outcome: 'incident', incident: 'launcher_lost_owner_wait_uncertain',
    delivery: 'POSSIBLY_DELIVERED', recovery_available: false, observed_invocation_id: fx.invocation,
  });
  expect(envelope.diagnostics).toHaveProperty('page');
  expect(envelope.diagnostics).toHaveProperty('github_effect');
}

function seedObservation(
  fx: Pick<OwnerWaitFixture, 'profileKey' | 'invocation' | 'cdp' | 'root'>,
  kind: 'prepared' | 'sent' | 'harvested' | 'harvested-tampered' | 'harvested-no-primary',
): StateLightTurnObservationRecord {
  const { profileKey, invocation: invocationId } = fx;
  admitStateLightTurnObservation({ profileKey, invocationId, marker: OBSERVATION_MARKER });
  bindStateLightOwnedTarget({
    profileKey, invocationId, targetId: 'target-2750', created: true, cdp: fx.cdp,
    initialRoute: 'https://chatgpt.com/',
  });
  if (kind === 'prepared') return readStateLightTurnObservation(profileKey, invocationId);
  transitionStateLightTurnObservation({ profileKey, invocationId, phase: 'dispatching', reason: 'fixture_dispatch' });
  transitionStateLightTurnObservation({
    profileKey, invocationId, phase: 'sent_unharvested', reason: 'fixture_sent', sendCount: 1,
    sendWitness: 'numeric_send_count', conversationUrl: 'https://chatgpt.com/c/33333333-3333-4333-8333-333333333333',
  });
  if (kind === 'sent') return readStateLightTurnObservation(profileKey, invocationId);
  if (kind !== 'harvested-no-primary') {
    const target = join(fx.root, 'primary-reply.txt');
    const bytes = Buffer.from('synthetic harvested reply', 'utf8');
    writeFileSync(target, bytes);
    bindPrimaryPublication({ profileKey, invocationId, target, bytes });
    if (kind === 'harvested-tampered') writeFileSync(target, 'synthetic tampered reply!');
  }
  return transitionStateLightTurnObservation({
    profileKey, invocationId, phase: 'harvested', reason: 'fixture_harvested',
  });
}

describe('Issue #2750 owner-wait reaper matrix (AC1-AC3)', () => {
  let kill: MockInstance;
  beforeEach(() => {
    // Any SIGTERM/kill(pid) by an owner wait is a failure; the spy also keeps a bug harmless.
    kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });
  afterEach(() => { kill.mockRestore(); });

  describe('observeOriginalLauncher and observeOwnerCurrency (observational only)', () => {
    const receipt = (overrides: Record<string, unknown> = {}): HandoffReceipt => dropUndefined({
      schema: HANDOFF_SCHEMA, run_identity: 'r', attempt_identity: 'a', launcher_started_at: 't0',
      handoff_committed_at: 't1', completion_mode: COMPLETION_MODE, launcher_pid: 4242,
      launcher_startticks: WITNESS_STARTTICKS, launcher_pid_namespace: WITNESS_NAMESPACE,
      launcher_boot_id: WITNESS_BOOT, launcher_hard_deadline_ms: Date.now() + 1000, ...overrides,
    }) as unknown as HandoffReceipt;
    const rows: ReadonlyArray<{
      name: string; probe: ProcessWitnessProbe; receipt?: Record<string, unknown>;
      state: 'alive' | 'dead' | 'unknown'; evidence: string;
    }> = [
      { name: 'same boot, same startticks, state S', probe: witnessProbe(), state: 'alive', evidence: 'launcher_live' },
      { name: 'different boot id', probe: witnessProbe({ boot: 'boot-bbbbbbbb' }), state: 'dead', evidence: 'host_rebooted' },
      { name: 'pid absent', probe: witnessProbe({ stat: { kind: 'absent' } }), state: 'dead', evidence: 'pid_absent' },
      { name: 'zombie', probe: witnessProbe({ stat: { kind: 'ok', startticks: WITNESS_STARTTICKS, state: 'Z' } }), state: 'dead', evidence: 'launcher_zombie' },
      { name: 'different startticks', probe: witnessProbe({ stat: { kind: 'ok', startticks: '1', state: 'S' } }), state: 'dead', evidence: 'pid_reused_distinct_startticks' },
      { name: 'stat error', probe: witnessProbe({ stat: { kind: 'error' } }), state: 'unknown', evidence: 'proc_unreadable' },
      { name: 'namespace mismatch', probe: witnessProbe({ namespace: 'pid:[1]' }), state: 'unknown', evidence: 'pid_namespace_unproven' },
      { name: 'namespace unreadable', probe: witnessProbe({ namespace: undefined }), state: 'unknown', evidence: 'pid_namespace_unproven' },
      { name: 'boot id unreadable', probe: witnessProbe({ boot: undefined }), state: 'unknown', evidence: 'boot_id_unreadable' },
      { name: 'startticks witness absent', probe: deadProbe(), receipt: { launcher_startticks: undefined }, state: 'unknown', evidence: 'witness_missing' },
      { name: 'boot witness absent', probe: deadProbe(), receipt: { launcher_boot_id: undefined }, state: 'unknown', evidence: 'witness_missing' },
      { name: 'pid-only receipt', probe: deadProbe(), receipt: { launcher_startticks: undefined, launcher_pid_namespace: undefined, launcher_boot_id: undefined, launcher_hard_deadline_ms: undefined }, state: 'unknown', evidence: 'witness_missing' },
      { name: 'hard deadline absent', probe: deadProbe(), receipt: { launcher_hard_deadline_ms: undefined }, state: 'unknown', evidence: 'hard_deadline_missing' },
    ];
    it.each(rows)('classifies launcher liveness: $name', ({ probe, receipt: overrides, state, evidence }) => {
      expect(observeOriginalLauncher(receipt(overrides), probe)).toEqual({ state, evidence });
      expect(kill).not.toHaveBeenCalled();
    });

    it('reads the exact current Task+Dispatch record from the selected assignment store only', () => {
      const root = tempDir('opk-2750-currency-');
      const env = ownerEnvFor(root);
      expect(observeOwnerCurrency(OWNER_TASK, OWNER_DISPATCH, env))
        .toEqual({ state: 'unverified', evidence: 'assignment_store_absent' });
      writeAssignmentStore(env, [{ taskId: OWNER_TASK, dispatchId: OWNER_DISPATCH }]);
      expect(observeOwnerCurrency(OWNER_TASK, OWNER_DISPATCH, env))
        .toEqual({ state: 'current', evidence: 'assignment_current' });
      expect(observeOwnerCurrency(OWNER_TASK, 'dispatch-stale', env))
        .toEqual({ state: 'not_current', evidence: 'task_dispatch_replaced' });
      expect(observeOwnerCurrency('task-unknown', OWNER_DISPATCH, env))
        .toEqual({ state: 'unverified', evidence: 'task_not_in_selected_store' });
      writeFileSync(resolveWorkerAssignmentStorePath(OWNER_PROJECT, env), '{ not json');
      expect(observeOwnerCurrency(OWNER_TASK, OWNER_DISPATCH, env))
        .toEqual({ state: 'unverified', evidence: 'assignment_store_unreadable' });
    });
  });

  describe('effect-authorized publication', () => {
    const deadRows: ReadonlyArray<{ name: string; probe: () => ReturnType<typeof witnessProbe>; evidence: string }> = [
      { name: 'different boot id', probe: () => witnessProbe({ boot: 'boot-bbbbbbbb' }), evidence: 'host_rebooted' },
      { name: 'absent pid', probe: () => witnessProbe({ stat: { kind: 'absent' } }), evidence: 'pid_absent' },
      { name: 'zombie', probe: () => witnessProbe({ stat: { kind: 'ok', startticks: WITNESS_STARTTICKS, state: 'Z' } }), evidence: 'launcher_zombie' },
      { name: 'different startticks', probe: () => witnessProbe({ stat: { kind: 'ok', startticks: '777', state: 'S' } }), evidence: 'pid_reused_distinct_startticks' },
    ];

    it.each(deadRows)('publishes exactly one incident envelope after positive launcher death: $name', async ({ probe, evidence }) => {
      const fx = ownerWaitFixture('publish-' + evidence);
      const launcherProbe = probe();
      const out = await captureWait(ownerWaitOptions(fx, { launcherProbe }));
      expect(out).toMatchObject({ terminal: true, non_terminal: false, owner_wait: { effect: 'published', no_signal_sent: true } });
      const onDisk = readTerminalEnvelope(fx.envelopePath, { runIdentity: fx.run, attemptIdentity: fx.attempt })!;
      expectUncertaintyEnvelope(fx, onDisk);
      expect(out.envelope).toEqual(onDisk);
      expect(onDisk.diagnostics).toMatchObject({ owner_wait: { owner: 'assignment_current', launcher: evidence } });
      expect(envelopeArtifacts(fx)).toEqual([basename(fx.envelopePath)]); // no stage file survives
      if (process.platform !== 'win32') expect(statSync(fx.envelopePath).mode & 0o777).toBe(0o600);
      if (evidence !== 'host_rebooted') expect(launcherProbe.stat).toHaveBeenCalledWith(4242); // boot mismatch decides without /proc
      expect(kill).not.toHaveBeenCalled();
      // A repeated wait reads the same single terminal and never republishes.
      const before = readFileSync(fx.envelopePath, 'utf8');
      const again = await captureWait(ownerWaitOptions(fx, { launcherProbe: deadProbe() }));
      expect(again).toMatchObject({ terminal: true });
      expect(again).not.toHaveProperty('owner_wait');
      expect(readFileSync(fx.envelopePath, 'utf8')).toBe(before);
    });
  });

  describe('diagnostic-only waits (no signal, no envelope)', () => {
    const rows: ReadonlyArray<{
      name: string; reason: RegExp; fixture?: Parameters<typeof ownerWaitFixture>[1];
      probe?: () => ReturnType<typeof witnessProbe>; nextStep?: RegExp;
    }> = [
      { name: 'launcher alive', probe: () => witnessProbe(), reason: /^launcher_alive:launcher_live$/u, nextStep: /never signals a PID/u },
      {
        name: 'live launcher past its hard deadline (sustained heartbeat, divergent deadlines)',
        fixture: { receipt: { launcher_hard_deadline_ms: Date.now() - 60_000 } },
        probe: () => witnessProbe(), reason: /^launcher_alive:launcher_live$/u, nextStep: /native supervisor/u,
      },
      { name: 'launcher unknown: stat error', probe: () => witnessProbe({ stat: { kind: 'error' } }), reason: /^launcher_unknown:proc_unreadable$/u },
      { name: 'launcher unknown: namespace mismatch', probe: () => witnessProbe({ namespace: 'pid:[2]' }), reason: /^launcher_unknown:pid_namespace_unproven$/u },
      { name: 'launcher unknown: boot id unreadable', probe: () => witnessProbe({ boot: undefined }), reason: /^launcher_unknown:boot_id_unreadable$/u },
      { name: 'launcher unknown: startticks witness absent', fixture: { receipt: { launcher_startticks: undefined } }, reason: /^launcher_unknown:witness_missing$/u },
      { name: 'launcher unknown: hard deadline absent', fixture: { receipt: { launcher_hard_deadline_ms: undefined } }, reason: /^launcher_unknown:hard_deadline_missing$/u },
      { name: 'Task replaced by another Dispatch (not_current)', fixture: { store: 'replaced' }, reason: /^owner_not_current:task_dispatch_replaced$/u },
      { name: 'assignment store absent (unverified)', fixture: { store: 'absent' }, reason: /^owner_not_current:assignment_store_absent$/u },
      { name: 'Task unknown to the selected store (unverified)', fixture: { store: 'other-task' }, reason: /^owner_not_current:task_not_in_selected_store$/u },
    ];

    it.each(rows)('$name', async ({ fixture, probe, reason, nextStep }) => {
      const fx = ownerWaitFixture('diag', fixture);
      const launcherProbe = (probe ?? deadProbe)();
      const out = await captureWait(ownerWaitOptions(fx, { launcherProbe }, pageInputs(fx)));
      expectDiagnosticOnly(fx, out);
      expect(out.owner_wait.reason).toMatch(reason);
      if (nextStep) expect(out.owner_wait.nextStep).toMatch(nextStep);
      expect(kill).not.toHaveBeenCalled();
      expect(readFileSync(fx.receiptPath, 'utf8')).toContain('"launcher_pid":4242'); // receipt untouched
    });

    it('does not consult the launcher or publish when both owner flags are omitted (indexed read-only wait)', async () => {
      const fx = ownerWaitFixture('flags-omitted');
      const launcherProbe = deadProbe();
      const out = await captureWait({
        runIdentity: fx.run, attemptIdentity: fx.attempt, invocationId: fx.invocation,
        terminalEnvelopeRoot: fx.root, deadlineMs: 1, profile: fx.profile, cdp: fx.cdp,
        ownerWaitDependencies: { launcherProbe, githubReaders: githubReaders(), ownerEnv: fx.ownerEnv },
      });
      expect(out).toMatchObject({ terminal: false, non_terminal: true, handoff_receipt_observed: true });
      expect(out).not.toHaveProperty('owner_wait');
      expect(launcherProbe.stat).not.toHaveBeenCalled();
      expect(existsSync(fx.envelopePath)).toBe(false);
      expect(kill).not.toHaveBeenCalled();
    });

    it('keeps a legacy direct explicit-path wait read-only even with a dead launcher', async () => {
      const fx = ownerWaitFixture('legacy-direct');
      const launcherProbe = deadProbe();
      const out = await captureWait({
        runIdentity: fx.run, attemptIdentity: fx.attempt, terminalEnvelopeRoot: fx.root,
        terminalEnvelopePath: fx.envelopePath, handoffReceiptPath: fx.receiptPath, deadlineMs: 1,
        ownerWaitDependencies: { launcherProbe, githubReaders: githubReaders(), ownerEnv: fx.ownerEnv },
      });
      expect(out).toMatchObject({ terminal: false, non_terminal: true });
      expect(out).not.toHaveProperty('owner_wait');
      expect(launcherProbe.stat).not.toHaveBeenCalled();
      expect(existsSync(fx.envelopePath)).toBe(false);
    });

    it('keeps a genuinely ownerless receipt diagnostic-only; a managed pair against it is a mismatch', async () => {
      const fx = ownerWaitFixture('ownerless', { receipt: { owner_task_id: undefined, owner_dispatch_id: undefined } });
      const launcherProbe = deadProbe();
      await expect(runWait(ownerWaitOptions(fx, { launcherProbe }))).rejects.toThrow('wait_receipt_owner_mismatch');
      const out = await captureWait({
        runIdentity: fx.run, attemptIdentity: fx.attempt, invocationId: fx.invocation,
        terminalEnvelopeRoot: fx.root, deadlineMs: 1,
      });
      expect(out).toMatchObject({ terminal: false });
      expect(out).not.toHaveProperty('owner_wait');
      expect(launcherProbe.stat).not.toHaveBeenCalled();
      expect(existsSync(fx.envelopePath)).toBe(false);
    });

    const rejected: ReadonlyArray<{ name: string; extra: Partial<WaitOptions>; message: string }> = [
      { name: 'wrong Task', extra: { ownerTaskId: 'task-wrong' }, message: 'wait_receipt_owner_mismatch' },
      { name: 'wrong Dispatch', extra: { ownerDispatchId: 'dispatch-wrong' }, message: 'wait_receipt_owner_mismatch' },
      { name: 'swapped pair', extra: { ownerTaskId: OWNER_DISPATCH, ownerDispatchId: OWNER_TASK }, message: 'wait_receipt_owner_mismatch' },
      { name: 'Task without Dispatch', extra: { ownerDispatchId: undefined as unknown as string }, message: 'wait_owner_identity_required' },
      { name: 'blank Dispatch', extra: { ownerDispatchId: '  ' }, message: 'wait_owner_identity_required' },
      { name: 'owner pair without the retained invocation id', extra: { invocationId: undefined as unknown as string }, message: 'wait_invocation_identity_required' },
    ];
    it.each(rejected)('rejects a $name before any launcher observation or effect', async ({ extra, message }) => {
      const fx = ownerWaitFixture('pair');
      const launcherProbe = deadProbe();
      const base = ownerWaitOptions(fx, { launcherProbe });
      const options = Object.fromEntries(Object.entries({ ...base, ...extra }).filter(([, v]) => v !== undefined)) as WaitOptions;
      await expect(runWait(options)).rejects.toThrow(message);
      expect(launcherProbe.stat).not.toHaveBeenCalled();
      expect(existsSync(fx.envelopePath)).toBe(false);
      expect(kill).not.toHaveBeenCalled();
    });

    it('rejects a foreign Run/attempt and a locator selector of another invocation', async () => {
      const fx = ownerWaitFixture('foreign-run');
      const other = ownerWaitFixture('foreign-other');
      const launcherProbe = deadProbe();
      await expect(runWait(ownerWaitOptions(fx, { launcherProbe }, { runIdentity: 'run-foreign' }))).rejects.toThrow();
      await expect(runWait(ownerWaitOptions(fx, { launcherProbe }, { attemptIdentity: 'attempt-foreign' }))).rejects.toThrow();
      await expect(runWait(ownerWaitOptions(fx, { launcherProbe }, {
        invocationId: fx.invocation, receiptLocator: other.locatorPath, terminalEnvelopeRoot: fx.root,
      }))).rejects.toThrow();
      expect(launcherProbe.stat).not.toHaveBeenCalled();
      expect(existsSync(fx.envelopePath)).toBe(false);
      expect(existsSync(other.envelopePath)).toBe(false);
    });

    it('returns an existing valid envelope untouched and consults nothing', async () => {
      const fx = ownerWaitFixture('existing-envelope');
      writePrivateJson(fx.envelopePath, launcherTerminal(fx));
      const before = readFileSync(fx.envelopePath, 'utf8');
      const launcherProbe = deadProbe();
      const out = await captureWait(ownerWaitOptions(fx, { launcherProbe }));
      expect(out).toMatchObject({ terminal: true, envelope: { lifecycle_outcome: 'success', delivery: 'landed' } });
      expect(out).not.toHaveProperty('owner_wait');
      expect(launcherProbe.stat).not.toHaveBeenCalled();
      expect(readFileSync(fx.envelopePath, 'utf8')).toBe(before);
    });

    it('does not overwrite a terminal the launcher publishes while the owner wait observes it', async () => {
      const fx = ownerWaitFixture('terminal-appears');
      const launcherBody = JSON.stringify(launcherTerminal(fx)) + '\n';
      const launcherProbe = witnessProbe({ stat: { kind: 'absent' } });
      launcherProbe.stat.mockImplementation(() => {
        writeFileSync(fx.envelopePath, launcherBody, { mode: 0o600 });
        return { kind: 'absent' };
      });
      const out = await captureWait(ownerWaitOptions(fx, { launcherProbe }));
      expect(out.owner_wait).toMatchObject({ effect: 'occupied_by_winner', no_signal_sent: true });
      expect(out).toMatchObject({ terminal: true, envelope: { lifecycle_outcome: 'success', delivery: 'landed' } });
      expect(readFileSync(fx.envelopePath, 'utf8')).toBe(launcherBody);
      expect(envelopeArtifacts(fx)).toEqual([basename(fx.envelopePath)]);
    });

    it.each([
      ['corrupt occupant', 'not json at all'],
      ['foreign Run occupant', JSON.stringify({ schema: TERMINAL_SCHEMA, run_identity: 'run-foreign', attempt_identity: 'x' })],
      ['truncated partial occupant', '{"schema":"flow-manager-long-running-child-terminal/v1","run_ide'],
    ] as const)('treats a %s as uncertain and never republishes over it', async (_name, occupant) => {
      const fx = ownerWaitFixture('occupant');
      writeFileSync(fx.envelopePath, occupant, { mode: 0o600 });
      const out = await captureWait(ownerWaitOptions(fx));
      expect(out).toMatchObject({ terminal: false, owner_wait: { effect: 'none', reason: 'terminal_publication_uncertain', no_signal_sent: true } });
      expect(String(out.owner_wait.nextStep)).toMatch(/never republish/u);
      expect(readFileSync(fx.envelopePath, 'utf8')).toBe(occupant);
      expect(envelopeArtifacts(fx)).toEqual([basename(fx.envelopePath)]);
    });

    it('reports a failed publication as uncertain without a partial or staged file', async () => {
      const fx = ownerWaitFixture('publish-fails');
      vi.stubEnv('OPK_FM_LONG_CHILD_FORCE_ENVELOPE_CREATE_FAIL', '1');
      const out = await captureWait(ownerWaitOptions(fx));
      expect(out).toMatchObject({ terminal: false, owner_wait: { effect: 'none', reason: 'terminal_publication_uncertain' } });
      expect(existsSync(fx.envelopePath)).toBe(false);
      expect(envelopeArtifacts(fx)).toEqual([]);
    });

    it('keeps an interrupted stage file invisible to readers and non-blocking for the later exclusive publish', async () => {
      const fx = ownerWaitFixture('stage');
      const stage = join(dirname(fx.envelopePath), `.${basename(fx.envelopePath)}.999999.interrupted.tmp`);
      writeFileSync(stage, '{"schema":"flow-manager-long-running-child-terminal/v1","run_ide', { mode: 0o600 });
      expect(readTerminalEnvelope(fx.envelopePath, { runIdentity: fx.run, attemptIdentity: fx.attempt })).toBeNull();
      expect(isWakeableTerminalEnvelopePath(stage, fx.root)).toBe(false);
      const out = await captureWait(ownerWaitOptions(fx));
      expect(out.owner_wait).toMatchObject({ effect: 'published' });
      expectUncertaintyEnvelope(fx, readTerminalEnvelope(fx.envelopePath)!);
    });
  });

  describe('GitHub task-progress classes', () => {
    const readers = (head?: string | undefined, second: string | undefined = head, digest?: string | undefined): GithubEffectReaders => {
      let call = 0;
      return {
        prHead: async () => (++call === 1 ? head : second),
        issueBodySha256: async () => digest,
      };
    };
    const rows: ReadonlyArray<{
      name: string; baseline: GithubEffectBaseline | undefined; readers: GithubEffectReaders;
      class: 'target_progress_observed' | 'effect_unverified'; evidence: string;
    }> = [
      { name: 'baseline absent', baseline: undefined, readers: readers(HEAD_AFTER), class: 'effect_unverified', evidence: 'baseline_absent' },
      { name: 'PR head changed and stable over two reads', baseline: prBaselineFor('g'), readers: readers(HEAD_AFTER), class: 'target_progress_observed', evidence: 'pr_head_advanced_stable' },
      { name: 'PR head unchanged', baseline: prBaselineFor('g'), readers: readers(HEAD_BEFORE), class: 'effect_unverified', evidence: 'pr_head_unchanged' },
      { name: 'PR heads differ between reads', baseline: prBaselineFor('g'), readers: readers(HEAD_AFTER, 'c'.repeat(40)), class: 'effect_unverified', evidence: 'pr_head_not_stable' },
      { name: 'PR head unreadable', baseline: prBaselineFor('g'), readers: readers(undefined), class: 'effect_unverified', evidence: 'pr_head_unreadable' },
      { name: 'PR second read unreadable', baseline: prBaselineFor('g'), readers: { prHead: vi.fn().mockResolvedValueOnce(HEAD_AFTER).mockResolvedValueOnce(undefined), issueBodySha256: async () => ISSUE_BODY_AFTER }, class: 'effect_unverified', evidence: 'pr_head_unreadable' },
      { name: 'Issue body digest changed', baseline: issueBaselineFor('g'), readers: readers(undefined, undefined, ISSUE_BODY_AFTER), class: 'target_progress_observed', evidence: 'issue_body_digest_changed' },
      { name: 'Issue body digest unchanged', baseline: issueBaselineFor('g'), readers: readers(undefined, undefined, ISSUE_BODY_BEFORE), class: 'effect_unverified', evidence: 'issue_body_unchanged' },
      { name: 'Issue body unreadable', baseline: issueBaselineFor('g'), readers: readers(undefined, undefined, undefined), class: 'effect_unverified', evidence: 'issue_body_unreadable' },
      {
        name: 'PR reader throws', baseline: prBaselineFor('g'),
        readers: { prHead: async () => { throw new Error('gh failed'); }, issueBodySha256: async () => ISSUE_BODY_AFTER },
        class: 'effect_unverified', evidence: 'github_read_failed',
      },
      {
        name: 'Issue reader throws', baseline: issueBaselineFor('g'),
        readers: { prHead: async () => HEAD_AFTER, issueBodySha256: async () => { throw new Error('gh failed'); } },
        class: 'effect_unverified', evidence: 'github_read_failed',
      },
    ];

    it.each(rows)('classifyGithubEffect: $name', async (row) => {
      const result = await classifyGithubEffect(row.baseline, row.readers);
      expect(result).toMatchObject({ class: row.class, attribution: 'unverified', evidence: row.evidence });
      // Exactly one class and never any send/author/acceptance claim.
      expect(Object.keys(result).sort()).toEqual(
        row.baseline ? ['attribution', 'class', 'evidence', 'target'] : ['attribution', 'class', 'evidence']);
      expect(JSON.stringify(result)).not.toMatch(/landed|authored|accepted/u);
    });

    it('reads only the exact baseline-bound target', async () => {
      const prHead = vi.fn(async () => HEAD_AFTER);
      const issueBodySha256 = vi.fn(async () => ISSUE_BODY_AFTER);
      await classifyGithubEffect(prBaselineFor('g', { repo: 'acme/other', number: 91 }), { prHead, issueBodySha256 });
      expect(prHead.mock.calls).toEqual([['acme/other', 91], ['acme/other', 91]]);
      expect(issueBodySha256).not.toHaveBeenCalled();
      await classifyGithubEffect(issueBaselineFor('g', { repo: 'acme/other', number: 55 }), { prHead, issueBodySha256 });
      expect(issueBodySha256.mock.calls).toEqual([['acme/other', 55]]);
    });

    it('parseGithubEffectBaseline accepts only the exact invocation/Run/attempt-bound well-formed baseline', () => {
      const ids = fixtureIds('g');
      const expected = { invocationId: ids.invocation, runIdentity: ids.run, attemptIdentity: ids.attempt };
      expect(parseGithubEffectBaseline(prBaselineFor('g'), expected)).toMatchObject({ kind: 'pr', head_sha: HEAD_BEFORE });
      expect(parseGithubEffectBaseline(issueBaselineFor('g'), expected)).toMatchObject({ kind: 'issue' });
      const bad: unknown[] = [
        undefined, null, 'x', {},
        issueBaselineFor('g', { schema: 'other/v1' }),
        issueBaselineFor('g', { invocation_id: 'inv-foreign' }),
        issueBaselineFor('g', { run_identity: 'run-foreign' }),
        issueBaselineFor('g', { attempt_identity: 'attempt-foreign' }),
        issueBaselineFor('g', { body_sha256: 'abc' }),
        issueBaselineFor('g', { repo: 'not a repo' }),
        issueBaselineFor('g', { number: 0 }),
        prBaselineFor('g', { head_sha: 'abc' }),
        prBaselineFor('g', { kind: 'commit' }),
      ];
      for (const value of bad) expect(parseGithubEffectBaseline(value, expected)).toBeUndefined();
    });

    const e2e: ReadonlyArray<{
      name: string; baseline?: GithubEffectBaseline; readers?: GithubEffectReaders;
      class: string; evidence: string; attribution?: string;
    }> = [
      { name: 'PR head advanced and stable (a concurrent same-target writer is not excluded)', baseline: prBaselineFor('e2e'), class: 'target_progress_observed', evidence: 'pr_head_advanced_stable' },
      { name: 'Issue body digest changed', baseline: issueBaselineFor('e2e'), class: 'target_progress_observed', evidence: 'issue_body_digest_changed' },
      { name: 'PR head unchanged', baseline: prBaselineFor('e2e'), readers: githubReaders({ prHead: async () => HEAD_BEFORE }), class: 'effect_unverified', evidence: 'pr_head_unchanged' },
      { name: 'Issue body unchanged', baseline: issueBaselineFor('e2e'), readers: githubReaders({ issueBodySha256: async () => ISSUE_BODY_BEFORE }), class: 'effect_unverified', evidence: 'issue_body_unchanged' },
      { name: 'baseline absent (legacy receipt)', class: 'effect_unverified', evidence: 'baseline_absent' },
      { name: 'baseline retargeted to a foreign invocation', baseline: issueBaselineFor('e2e', { invocation_id: 'inv-foreign' }), class: 'effect_unverified', evidence: 'baseline_absent' },
      { name: 'reader throws', baseline: prBaselineFor('e2e'), readers: githubReaders({ prHead: async () => { throw new Error('gh failed'); } }), class: 'effect_unverified', evidence: 'github_read_failed' },
    ];
    it.each(e2e)('owner wait records one class end to end: $name', async (row) => {
      const fx = ownerWaitFixture('e2e', row.baseline ? { baseline: row.baseline } : {});
      const out = await captureWait(ownerWaitOptions(fx, { githubReaders: row.readers ?? githubReaders() }));
      expect(out.owner_wait).toMatchObject({ effect: 'published' });
      const envelope = readTerminalEnvelope(fx.envelopePath)!;
      expectUncertaintyEnvelope(fx, envelope);
      expect((envelope.diagnostics as Record<string, any>).github_effect).toMatchObject({
        class: row.class, evidence: row.evidence, attribution: 'unverified',
      });
      // GitHub progress never upgrades delivery or the Page claim.
      expect(envelope.delivery).toBe('POSSIBLY_DELIVERED');
      expect((envelope.diagnostics as Record<string, any>).page).toMatchObject({ state: 'page_unverified' });
    });
  });

  describe('original Page evidence', () => {
    const pageRows: ReadonlyArray<{
      name: string; reader: OwnerWaitPageReader; state: string; evidence?: string; fresh?: boolean;
    }> = [
      { name: 'finished attributable generation', reader: finishedPage, state: 'page_finished', evidence: 'stable_finished_generation' },
      { name: 'unverified (generation still active)', reader: async () => ({ state: 'page_unverified', evidence: 'generation_active' }), state: 'page_unverified', evidence: 'generation_active' },
      { name: 'redirected conversation', reader: async () => ({ state: 'conversation_unavailable', evidence: 'conversation_redirected' }), state: 'conversation_unavailable', evidence: 'conversation_redirected', fresh: true },
      { name: 'unreachable endpoint', reader: async () => { throw new Error('ECONNREFUSED'); }, state: 'page_unverified', evidence: 'original_page_unreachable' },
    ];
    it.each(pageRows)('records the separately observed Page: $name', async (row) => {
      const fx = ownerWaitFixture('page');
      seedObservation(fx, 'sent');
      const reader = vi.fn(row.reader);
      const out = await captureWait(ownerWaitOptions(fx, { pageReader: reader }, pageInputs(fx)));
      expect(out.owner_wait).toMatchObject({ effect: 'published' });
      const envelope = readTerminalEnvelope(fx.envelopePath)!;
      expectUncertaintyEnvelope(fx, envelope);
      expect((envelope.diagnostics as Record<string, any>).page).toMatchObject({
        state: row.state, ...(row.evidence ? { evidence: row.evidence } : {}),
      });
      // The reader is handed the original private record, exact profile key and caller CDP only.
      expect(reader).toHaveBeenCalledTimes(1);
      const call = reader.mock.calls[0]![0];
      expect(call.profileKey).toBe(fx.profileKey);
      expect(call.cdp).toBe(fx.cdp);
      expect(call.record).toMatchObject({
        invocation_id: fx.invocation, marker: OBSERVATION_MARKER, phase: 'sent_unharvested',
        owned_target: { id: 'target-2750', cdp_sha256: createHash('sha256').update(fx.cdp, 'utf8').digest('hex') },
      });
      // A finished Page is not delivery proof; nothing is fabricated.
      expect(envelope.delivery).toBe('POSSIBLY_DELIVERED');
      expect(envelope.recovery_available).toBe(false);
      expect(String(envelope.next_action)).toMatch(row.fresh ? /fresh chat/u : /reconcile the exact original invocation/u);
      if (!row.fresh) expect(String(envelope.next_action)).not.toMatch(/fresh chat/u);
      expect(envelope.owned_target_id).toBe('target-2750');
    });

    it('is page_unverified without calling any reader when --profile/--cdp are omitted', async () => {
      const fx = ownerWaitFixture('page-omitted');
      seedObservation(fx, 'sent');
      const reader = vi.fn(finishedPage);
      await captureWait(ownerWaitOptions(fx, { pageReader: reader }));
      expect(reader).not.toHaveBeenCalled();
      expect((readTerminalEnvelope(fx.envelopePath)!.diagnostics as Record<string, any>).page)
        .toEqual({ state: 'page_unverified', evidence: 'profile_cdp_not_supplied' });
    });

    it.each([
      ['profile only', (fx: OwnerWaitFixture) => ({ profile: fx.profile })],
      ['cdp only', (fx: OwnerWaitFixture) => ({ cdp: fx.cdp })],
    ] as const)('is page_unverified when only %s is supplied', async (_name, inputs) => {
      const fx = ownerWaitFixture('page-half');
      seedObservation(fx, 'sent');
      const reader = vi.fn(finishedPage);
      await captureWait(ownerWaitOptions(fx, { pageReader: reader }, inputs(fx)));
      expect(reader).not.toHaveBeenCalled();
      expect((readTerminalEnvelope(fx.envelopePath)!.diagnostics as Record<string, any>).page)
        .toEqual({ state: 'page_unverified', evidence: 'profile_cdp_not_supplied' });
    });

    it('is page_unverified for a wrong profile or CDP (no original record under that key) and never reads the Page', async () => {
      const fx = ownerWaitFixture('page-wrong');
      seedObservation(fx, 'sent');
      for (const wrong of [{ profile: join(fx.root, 'other-profile'), cdp: fx.cdp }, { profile: fx.profile, cdp: 'http://127.0.0.1:9333' }]) {
        const reader = vi.fn(finishedPage);
        const wrongFx = { ...fx };
        rmSync(fx.envelopePath, { force: true });
        await captureWait(ownerWaitOptions(wrongFx, { pageReader: reader }, wrong));
        expect(reader).not.toHaveBeenCalled();
        expect((readTerminalEnvelope(fx.envelopePath)!.diagnostics as Record<string, any>).page)
          .toEqual({ state: 'page_unverified', evidence: 'original_observation_missing_or_foreign' });
      }
    });

    it('is page_unverified when the original observation record is missing', async () => {
      const fx = ownerWaitFixture('page-norecord');
      const reader = vi.fn(finishedPage);
      await captureWait(ownerWaitOptions(fx, { pageReader: reader }, pageInputs(fx)));
      expect(reader).not.toHaveBeenCalled();
      const envelope = readTerminalEnvelope(fx.envelopePath)!;
      expect((envelope.diagnostics as Record<string, any>).page).toMatchObject({ evidence: 'original_observation_missing_or_foreign' });
      expect(envelope.delivery).toBe('POSSIBLY_DELIVERED');
      expect(envelope).not.toHaveProperty('owned_target_id');
    });

    const deliveryRows: ReadonlyArray<{ name: string; kind: Parameters<typeof seedObservation>[1]; delivery: string }> = [
      { name: 'harvested with verified primary bytes', kind: 'harvested', delivery: 'landed' },
      { name: 'harvested but primary bytes tampered', kind: 'harvested-tampered', delivery: 'POSSIBLY_DELIVERED' },
      { name: 'harvested without a bound primary', kind: 'harvested-no-primary', delivery: 'POSSIBLY_DELIVERED' },
      { name: 'sent but unharvested', kind: 'sent', delivery: 'POSSIBLY_DELIVERED' },
      { name: 'prepared only (never claim not-sent)', kind: 'prepared', delivery: 'POSSIBLY_DELIVERED' },
    ];
    it.each(deliveryRows)('delivery for $name is $delivery', async ({ kind, delivery }) => {
      const fx = ownerWaitFixture('delivery');
      seedObservation(fx, kind);
      await captureWait(ownerWaitOptions(fx, { pageReader: finishedPage }, pageInputs(fx)));
      const envelope = readTerminalEnvelope(fx.envelopePath)!;
      expect(envelope.lifecycle_outcome).toBe('incident');
      expect(envelope.delivery).toBe(delivery);
      expect(envelope.delivery).not.toBe('not-sent');
      expect(envelope.recovery_available).toBe(false);
    });
  });

  describe('exclusive publication races', () => {
    function barrier(count: number): () => Promise<void> {
      let arrived = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
      return async () => { arrived += 1; if (arrived >= count) release(); await gate; };
    }

    it.each([2, 6])('%i concurrent owner-wait reapers publish exactly one envelope; every loser reads the winner', async (count) => {
      const fx = ownerWaitFixture('race', { baseline: issueBaselineFor('race') });
      const arrive = barrier(count);
      // Every reaper has passed the "no terminal yet" check before any of them may commit.
      const issueBodySha256 = async (): Promise<string> => { await arrive(); return ISSUE_BODY_AFTER; };
      const outputs = await captureWaits(Array.from({ length: count }, () => () => runWait(ownerWaitOptions(
        fx, { githubReaders: githubReaders({ issueBodySha256 }), launcherProbe: deadProbe() },
      ))));
      expect(outputs).toHaveLength(count);
      const effects = outputs.map((output) => output.owner_wait.effect).sort();
      expect(effects).toEqual([...Array(count - 1).fill('occupied_by_winner'), 'published'].sort());
      for (const output of outputs) expect(output).toMatchObject({ terminal: true, non_terminal: false });
      const onDisk = readTerminalEnvelope(fx.envelopePath)!;
      expectUncertaintyEnvelope(fx, onDisk);
      for (const output of outputs) expect(output.envelope).toEqual(onDisk); // identical winner envelope
      expect(envelopeArtifacts(fx)).toEqual([basename(fx.envelopePath)]); // one file, no stage leftovers
      expect(kill).not.toHaveBeenCalled();
    });

    it('never replaces a launcher terminal committed while the owner-wait reaper is mid-flight', async () => {
      const fx = ownerWaitFixture('launcher-wins', { baseline: issueBaselineFor('launcher-wins') });
      const launcherBody = JSON.stringify(launcherTerminal(fx)) + '\n';
      const issueBodySha256 = async (): Promise<string> => {
        writeFileSync(fx.envelopePath, launcherBody, { mode: 0o600 }); // the live launcher publishes first
        return ISSUE_BODY_AFTER;
      };
      const out = await captureWait(ownerWaitOptions(fx, { githubReaders: githubReaders({ issueBodySha256 }) }));
      expect(out).toMatchObject({
        terminal: true, owner_wait: { effect: 'occupied_by_winner', no_signal_sent: true },
        envelope: { lifecycle_outcome: 'success', delivery: 'landed' },
      });
      expect(readFileSync(fx.envelopePath, 'utf8')).toBe(launcherBody);
      expect(envelopeArtifacts(fx)).toEqual([basename(fx.envelopePath)]);
    });
  });
});

describe('Issue #2750 durable artifact root and permissions (AC19/AC20)', () => {
  beforeEach(() => {
    vi.stubEnv('OPK_FM_LONG_CHILD_TEST_GATE', undefined);
    vi.stubEnv('OPK_FM_LONG_CHILD_TEST_TERMINAL_ROOT', undefined);
  });

  const absoluteXdg = '/synthetic/xdg-state';
  const resolverRows: ReadonlyArray<{ name: string; env: NodeJS.ProcessEnv; expected?: string; throws?: string }> = [
    { name: 'absolute XDG_STATE_HOME', env: { XDG_STATE_HOME: absoluteXdg, HOME: '/synthetic/home' }, expected: '/synthetic/xdg-state/orchestrator-pack' },
    { name: 'XDG_STATE_HOME with dot segments', env: { XDG_STATE_HOME: '/synthetic/a/../xdg-state/./', HOME: '/synthetic/home' }, expected: '/synthetic/xdg-state/orchestrator-pack' },
    { name: 'XDG_STATE_HOME unset', env: { HOME: '/synthetic/home' }, expected: '/synthetic/home/.local/state/orchestrator-pack' },
    { name: 'XDG_STATE_HOME empty', env: { XDG_STATE_HOME: '', HOME: '/synthetic/home' }, expected: '/synthetic/home/.local/state/orchestrator-pack' },
    { name: 'relative XDG_STATE_HOME (never silently falls back to HOME)', env: { XDG_STATE_HOME: 'relative/state', HOME: '/synthetic/home' }, throws: 'durable_root_xdg_state_home_not_absolute' },
    { name: 'dot XDG_STATE_HOME', env: { XDG_STATE_HOME: '.', HOME: '/synthetic/home' }, throws: 'durable_root_xdg_state_home_not_absolute' },
    { name: 'HOME missing', env: {}, throws: 'durable_root_home_unavailable' },
    { name: 'HOME blank', env: { HOME: '   ' }, throws: 'durable_root_home_unavailable' },
    { name: 'HOME relative', env: { HOME: 'home/che' }, throws: 'durable_root_home_unavailable' },
    { name: 'fixture gate without a root is inert', env: { OPK_FM_LONG_CHILD_TEST_GATE: 'fixture-root-v1', HOME: '/synthetic/home' }, expected: '/synthetic/home/.local/state/orchestrator-pack' },
    { name: 'fixture root without the gate is inert', env: { OPK_FM_LONG_CHILD_TEST_TERMINAL_ROOT: '/synthetic/fixture', HOME: '/synthetic/home' }, expected: '/synthetic/home/.local/state/orchestrator-pack' },
    { name: 'wrong gate value is inert', env: { OPK_FM_LONG_CHILD_TEST_GATE: '1', OPK_FM_LONG_CHILD_TEST_TERMINAL_ROOT: '/synthetic/fixture', HOME: '/synthetic/home' }, expected: '/synthetic/home/.local/state/orchestrator-pack' },
    { name: 'gate with a relative fixture root is inert', env: { OPK_FM_LONG_CHILD_TEST_GATE: 'fixture-root-v1', OPK_FM_LONG_CHILD_TEST_TERMINAL_ROOT: 'fixture', HOME: '/synthetic/home' }, expected: '/synthetic/home/.local/state/orchestrator-pack' },
    { name: 'two-part fixture gate', env: { OPK_FM_LONG_CHILD_TEST_GATE: 'fixture-root-v1', OPK_FM_LONG_CHILD_TEST_TERMINAL_ROOT: '/synthetic/fixture', XDG_STATE_HOME: absoluteXdg }, expected: '/synthetic/fixture' },
  ];

  it.each(resolverRows)('resolveDurableArtifactRoot and prAuthorDurableArtifactRoot agree: $name', ({ env, expected, throws }) => {
    if (throws) {
      expect(() => resolveDurableArtifactRoot(env)).toThrow(throws);
      expect(() => resolveDurableArtifactRoot(env)).toThrow(/nextStep: /u);
      expect(() => prAuthorDurableArtifactRoot(env)).toThrow(throws);
      return;
    }
    expect(resolveDurableArtifactRoot(env)).toBe(expected);
    expect(prAuthorDurableArtifactRoot(env)).toBe(expected);
    expect(resolveDurableArtifactRoot(env)).not.toContain('/tmp/opencode');
  });

  const pathRows: ReadonlyArray<{ input: string; expected?: string }> = [
    { input: '/tmp/opencode/issue-12-inv-terminal.json', expected: 'issue-12-inv-terminal.json' },
    { input: '/tmp/opencode/nested/dir/x-handoff.json', expected: 'x-handoff.json' },
    { input: 'relative/dir/x-terminal.json', expected: 'x-terminal.json' },
    { input: 'x-terminal.json', expected: 'x-terminal.json' },
    { input: '/var/tmp/../tmp/opencode/y-handoff.json', expected: 'y-handoff.json' },
    { input: '/tmp/opencode/..' },
    { input: '..' },
    { input: '.' },
    { input: '' },
    { input: '/tmp/opencode/.hidden-terminal.json' },
    { input: '.hidden-terminal.json' },
  ];
  it.each(pathRows)('resolveDurableArtifactPath contributes only the basename: "$input"', ({ input, expected }) => {
    const root = '/synthetic/durable/orchestrator-pack';
    if (expected === undefined) {
      expect(() => resolveDurableArtifactPath(input, root)).toThrow(/artifact_basename_invalid; nextStep: \S/u);
      return;
    }
    expect(resolveDurableArtifactPath(input, root)).toBe(join(root, expected));
  });

  it('keeps nested fixture paths only for the exact two-part gated root', () => {
    const root = tempDir('opk-2750-gated-path-');
    const nested = join(root, 'case', 'x-terminal.json');
    expect(resolveDurableArtifactPath(nested, root)).toBe(join(root, 'x-terminal.json')); // gate unset: basename
    for (const [key, value] of Object.entries(cliFixtureEnv(root))) vi.stubEnv(key, value);
    expect(resolveDurableArtifactPath(nested, root)).toBe(nested);
    expect(resolveDurableArtifactPath(join(tmpdir(), 'elsewhere', 'x-terminal.json'), root)).toBe(join(root, 'x-terminal.json'));
  });

  it('creates the app root 0700 under a permissive umask and refuses aliased or non-private roots', () => {
    const base = tempDir('opk-2750-ensure-');
    const previous = process.umask(0o000);
    try {
      const root = join(base, 'state', 'orchestrator-pack');
      expect(ensureDurableArtifactRoot(root)).toBe(root);
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(ensureDurableArtifactRoot(root)).toBe(root); // idempotent for the private root

      const real = join(base, 'real-root');
      mkdirSync(real, { mode: 0o700 });
      const alias = join(base, 'alias-root');
      symlinkSync(real, alias);
      expect(() => ensureDurableArtifactRoot(alias)).toThrow(/durable_root_unsafe: .*nextStep: \S/u);

      const open = join(base, 'open-root');
      mkdirSync(open, { mode: 0o755 });
      chmodSync(open, 0o755);
      expect(() => ensureDurableArtifactRoot(open)).toThrow(/durable_root_unsafe: .*nextStep: \S/u);

      const viaAliasedParent = join(alias, 'child');
      expect(() => ensureDurableArtifactRoot(viaAliasedParent)).toThrow(/durable_root_unsafe/u);
    } finally {
      process.umask(previous);
    }
  });

  it('writes receipt, locator and terminal 0600 (locator directory 0700) even under umask 000, with no staged leftovers', async () => {
    const root = tempDir('opk-2750-modes-');
    const paths = launchPaths(root, 'modes');
    const invocation = 'inv-2750-modes';
    const profile = join(root, 'profile');
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', join(root, 'state'));
    const fixture = nodeFixture('process.stdout.write(JSON.stringify('
      + JSON.stringify(makeTurnResult({ invocation_id: invocation })) + ') + "\\n", () => process.exit(0));');
    const previous = process.umask(0o000);
    try {
      expect(await runFixtureLaunch(root, {
        runIdentity: 'run-modes', attemptIdentity: 'attempt-modes', invocationId: invocation,
        profile, cdp: 'http://127.0.0.1:9222', handoffReceiptPath: paths.receipt,
        terminalEnvelopePath: paths.envelope, browserOutputPath: paths.output, cwd: repoRoot,
        childCommand: fixture.command, childArgs: fixture.args,
      })).toBe(0);
    } finally {
      process.umask(previous);
    }
    const locator = invocationReceiptLocatorPath(invocation, root);
    for (const file of [paths.receipt, paths.envelope, locator]) expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(locator)).mode & 0o777).toBe(0o700);
    for (const directory of [dirname(paths.receipt), dirname(locator)]) {
      expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    }
    expect(readTerminalEnvelope(paths.envelope, { runIdentity: 'run-modes', attemptIdentity: 'attempt-modes' })?.lifecycle_outcome).toBe('success');
  });

  it('shares one resolved root between the producer, the wait reader, fleet-wake and the PR-author self-reader across an emptied TMPDIR', async () => {
    const root = tempDir('opk-2750-production-');
    const home = join(root, 'home');
    const xdg = join(root, 'custom-xdg');
    const tmpBefore = join(root, 'tmp-before');
    const tmpAfter = join(root, 'tmp-after');
    for (const directory of [home, xdg, tmpBefore, tmpAfter]) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const durable = join(xdg, 'orchestrator-pack');
    const invocation = 'inv-2750-production';
    const profile = join(root, 'profile');
    const cdp = 'http://127.0.0.1:9222';
    const processEnv = {
      HOME: home, XDG_STATE_HOME: xdg, TMPDIR: tmpBefore, OPK_BASE_DIR: join(root, 'opk-base'),
      OPK_PROJECT_ID: OWNER_PROJECT, CHATGPT_BROWSER_TURN_STATE_DIR: join(root, 'state'),
    };
    // Legacy-style caller paths: only the basename survives; the directory is never created or used.
    const legacy = join(root, 'legacy-scratch', 'opencode');
    const fixture = markedChildFixture(join(root, 'child-started.txt'), makeTurnResult({ invocation_id: invocation }));
    const launched = await runLauncherCli([
      'launch', '--run-identity', 'run-prod', '--attempt-identity', 'attempt-prod',
      '--invocation-id', invocation, '--profile', profile, '--cdp', cdp,
      '--owner-task-id', OWNER_TASK, '--owner-dispatch-id', OWNER_DISPATCH,
      '--handoff-receipt', join(legacy, 'prod-handoff.json'),
      '--terminal-envelope', join(legacy, 'prod-terminal.json'),
      '--browser-output', join(root, 'out', 'browser-output.txt'), '--cwd', repoRoot,
      '--child-command', fixture.command, '--', ...fixture.args,
    ], processEnv);
    expect(launched.code).toBe(0);
    expect(existsSync(join(root, 'legacy-scratch'))).toBe(false);
    const handoff = join(durable, 'prod-handoff.json');
    const terminal = join(durable, 'prod-terminal.json');
    const locator = invocationReceiptLocatorPath(invocation, durable);
    for (const file of [handoff, terminal, locator]) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(statSync(durable).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(locator)).mode & 0o777).toBe(0o700);
    expect(readdirSync(durable).sort()).toEqual(['browser-gpt-receipts', 'prod-handoff.json', 'prod-terminal.json']);

    // Fresh in-process reader: fixture override unset, TMPDIR emptied (the old scratch dir is gone).
    rmSync(tmpBefore, { recursive: true, force: true });
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_STATE_HOME', xdg);
    vi.stubEnv('TMPDIR', tmpAfter);
    const waited = await captureWait({
      runIdentity: 'run-prod', attemptIdentity: 'attempt-prod', invocationId: invocation, deadlineMs: 500,
    });
    expect(waited).toMatchObject({
      terminal: true, envelope: { lifecycle_outcome: 'success', handoff_receipt_path: handoff, observed_invocation_id: invocation },
    });
    // Fresh process wait over the same private root, with only TMPDIR changed.
    const processWait = await runLauncherCli(['wait', '--run-identity', 'run-prod', '--attempt-identity', 'attempt-prod',
      '--invocation-id', invocation, '--deadline-ms', '500'], { ...processEnv, TMPDIR: tmpAfter });
    expect(processWait.code).toBe(0);
    expect(JSON.parse(processWait.stdout.trim())).toMatchObject({ terminal: true, envelope: { handoff_receipt_path: handoff } });
    // Default fleet-wake root lists the same complete invocation.
    const diagnostics: string[] = [];
    expect(listTerminalEnvelopes(undefined, (message) => diagnostics.push(message))).toEqual([
      expect.objectContaining({
        path: terminal, invocationId: invocation, runIdentity: 'run-prod', attemptIdentity: 'attempt-prod',
        handoffReceiptPath: handoff, lifecycleOutcome: 'success',
      }),
    ]);
    expect(diagnostics).toEqual([]);
    expect(prAuthorDurableArtifactRoot()).toBe(durable);

    // PR-author self-reader: an orphaned claim written under the same root is its own candidate.
    const binding = { repo: 'acme/widgets', pr: 7 };
    const orphanInvocation = 'inv-2750-orphan';
    const orphanProfileKey = configuredProfileKey(profile, cdp);
    const orphan = writeHandoffArtifacts({
      terminalRoot: durable, dir: join(durable, 'orphan'), invocation: orphanInvocation,
      run: 'run-orphan', attempt: 'attempt-orphan', receipt: { child_cwd: realpathSync(root) },
    });
    admitStateLightTurnObservation({ profileKey: orphanProfileKey, invocationId: orphanInvocation, marker: OBSERVATION_MARKER });
    transitionStateLightTurnObservation({
      profileKey: orphanProfileKey, invocationId: orphanInvocation, phase: 'sending', reason: prAuthorClaimReason(binding),
    });
    const deadReader = { cmdline: () => undefined, startTimeMs: () => undefined };
    const candidates = scanPrAuthorCandidates({ binding, profileKey: orphanProfileKey, worktree: root, reader: deadReader });
    expect(candidates).toEqual([expect.objectContaining({
      invocationId: orphanInvocation, claimOnly: true, launcherLive: false, profileKey: orphanProfileKey,
    })]);
    expect(existsSync(orphan.envelopePath)).toBe(false); // it is a candidate precisely because no terminal exists
    // The finished, enveloped invocation is not a candidate; nothing was read from a legacy root.
    expect(candidates.some((candidate) => candidate.invocationId === invocation)).toBe(false);
  });

  const itLinux = process.platform === 'linux' ? it : it.skip;
  itLinux('a fresh owner-wait process publishes once after positive launcher loss, and fleet-wake lists it (no signal, authority from the assignment store)', async () => {
    const root = tempDir('opk-2750-process-');
    const home = join(root, 'home');
    const xdg = join(root, 'xdg');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const durable = ensureDurableArtifactRoot(join(xdg, 'orchestrator-pack'));
    const env = {
      HOME: home, XDG_STATE_HOME: xdg, TMPDIR: join(root, 'emptied-tmp'), OPK_BASE_DIR: join(root, 'opk-base'),
      OPK_PROJECT_ID: OWNER_PROJECT, CHATGPT_BROWSER_TURN_STATE_DIR: join(root, 'state'),
    };
    // A genuinely dead launcher: a real short-lived process whose PID is gone from /proc.
    const gone = await runProcess({
      command: process.execPath, args: ['-e', 'process.stdout.write(String(process.pid))'], cwd: repoRoot,
      env: {}, inheritParentEnv: false, allowEmptyStdout: false, timeoutMs: 30_000,
    });
    const deadPid = Number(gone.stdout.trim());
    expect(procProcessWitnessProbe.stat(deadPid)).toEqual({ kind: 'absent' });
    const invocation = 'inv-2750-proc-wait';
    const artifacts = writeHandoffArtifacts({
      terminalRoot: durable, dir: join(durable, 'proc'), invocation, run: 'run-proc', attempt: 'attempt-proc',
      receiptPath: join(durable, 'proc-handoff.json'), envelopePath: join(durable, 'proc-terminal.json'),
      receipt: {
        launcher_pid: deadPid, launcher_boot_id: procProcessWitnessProbe.bootId(),
        launcher_pid_namespace: procProcessWitnessProbe.pidNamespace(), launcher_startticks: '1',
        child_cwd: realpathSync(root),
      },
    });
    const waitArgs = (...extra: string[]): string[] => ['wait', '--run-identity', 'run-proc', '--attempt-identity', 'attempt-proc',
      '--invocation-id', invocation, '--deadline-ms', '100', ...extra];
    const owner = ['--owner-task-id', OWNER_TASK, '--owner-dispatch-id', OWNER_DISPATCH];
    const baseEnv = ownerEnvFor(root);

    // No assignment store yet, omitted flags, wrong pair: all read-only; no file appears.
    const unverified = await runLauncherCli(waitArgs(...owner), env);
    expect(JSON.parse(unverified.stdout.trim()).owner_wait).toMatchObject({ effect: 'none', reason: 'owner_not_current:assignment_store_absent', no_signal_sent: true });
    const omitted = await runLauncherCli(waitArgs(), env);
    expect(JSON.parse(omitted.stdout.trim())).toMatchObject({ terminal: false });
    expect(JSON.parse(omitted.stdout.trim())).not.toHaveProperty('owner_wait');
    const wrong = await runLauncherCli(waitArgs('--owner-task-id', OWNER_TASK, '--owner-dispatch-id', 'dispatch-wrong'), env);
    expect(wrong.code).not.toBe(0);
    expect(wrong.stderr).toContain('wait_receipt_owner_mismatch');
    expect(existsSync(artifacts.envelopePath)).toBe(false);

    // The same Task bound to another Dispatch (replaced owner) is read-only too.
    writeAssignmentStore(baseEnv, [{ taskId: OWNER_TASK, dispatchId: 'dispatch-replacement' }]);
    const replaced = await runLauncherCli(waitArgs(...owner), env);
    expect(JSON.parse(replaced.stdout.trim()).owner_wait.reason).toBe('owner_not_current:task_dispatch_replaced');
    expect(existsSync(artifacts.envelopePath)).toBe(false);

    // The currently approved original Task+Dispatch publishes once; --profile/--cdp with no original record stays unverified.
    writeAssignmentStore(baseEnv, [{ taskId: OWNER_TASK, dispatchId: OWNER_DISPATCH }]);
    const published = await runLauncherCli(waitArgs(...owner, '--profile', join(root, 'profile'), '--cdp', 'http://127.0.0.1:9222'), env);
    expect(published.code).toBe(0);
    const body = JSON.parse(published.stdout.trim());
    expect(body).toMatchObject({ terminal: true, owner_wait: { effect: 'published', no_signal_sent: true } });
    expect(body.envelope).toMatchObject({
      lifecycle_outcome: 'incident', incident: 'launcher_lost_owner_wait_uncertain', delivery: 'POSSIBLY_DELIVERED',
      diagnostics: { page: { evidence: 'original_observation_missing_or_foreign' }, github_effect: { class: 'effect_unverified', evidence: 'baseline_absent' } },
    });
    expect(statSync(artifacts.envelopePath).mode & 0o777).toBe(0o600);
    expect(readdirSync(durable).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const secondRun = await runLauncherCli(waitArgs(...owner), env);
    expect(JSON.parse(secondRun.stdout.trim())).toMatchObject({ terminal: true });
    expect(JSON.parse(secondRun.stdout.trim())).not.toHaveProperty('owner_wait');

    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_STATE_HOME', xdg);
    expect(listTerminalEnvelopes(undefined, () => undefined)).toEqual([
      expect.objectContaining({
        path: artifacts.envelopePath, invocationId: invocation, lifecycleOutcome: 'incident', delivery: 'POSSIBLY_DELIVERED',
      }),
    ]);
  });
});

describe('Issue #2750 managed adapter refusal matrix (AC10-AC13, AC17)', () => {
  const cdp = 'http://127.0.0.1:9222';
  const SELECTED = 'acme/widgets';

  interface MatrixContext {
    root: string; paths: ReturnType<typeof launchPaths>; args: string[]; profile: string;
  }

  function matrixContext(): MatrixContext {
    const root = tempDir('opk-2750-matrix-');
    const paths = launchPaths(root, 'row');
    for (const [key, value] of Object.entries(cliFixtureEnv(root))) vi.stubEnv(key, value);
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', join(root, 'state'));
    stubOwnerStoreEnv(root);
    const profile = join(root, 'profile');
    return {
      root, paths, profile,
      args: [
        '--run-identity', 'run-m', '--attempt-identity', 'attempt-m', '--invocation-id', 'inv-m',
        '--owner-task-id', OWNER_TASK, '--owner-dispatch-id', OWNER_DISPATCH,
        '--handoff-receipt', paths.receipt, '--terminal-envelope', paths.envelope, '--output', paths.output,
        '--profile', profile, '--cdp', cdp, '--input', join(root, 'prompt.txt'), '--cwd', root,
      ],
    };
  }

  const without = (args: string[], flag: string): string[] => {
    const index = args.indexOf(flag);
    return index < 0 ? args : [...args.slice(0, index), ...args.slice(index + 2)];
  };
  const withValue = (args: string[], flag: string, value: string): string[] => {
    const index = args.indexOf(flag);
    return index < 0 ? [...args, flag, value] : args.map((token, i) => i === index + 1 ? value : token);
  };

  async function runAdapter(args: string[], deps: BrowserAdapterDependencies) {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await runBrowserAdapter(args, deps);
      const err = stderr.mock.calls.map((call) => String(call[0])).join('');
      return {
        code, stdout: stdout.mock.calls.map((call) => String(call[0])).join(''), stderr: err,
        lines: err.split('\n').filter((line) => line.startsWith(ADAPTER_PREFIX)),
      };
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }

  const baseDeps = (spawnLauncher: BrowserAdapterDependencies['spawnLauncher'], extra: BrowserAdapterDependencies = {}): BrowserAdapterDependencies => ({
    spawnLauncher, selectedRepository: () => SELECTED, readPrAuthorHead: async () => undefined,
    readWorktreeBranch: async () => undefined, processReader: { cmdline: () => undefined, startTimeMs: () => undefined },
    ...extra,
  });

  const preChildRows: ReadonlyArray<{
    name: string; code: string; build: (ctx: MatrixContext) => string[]; setup?: (ctx: MatrixContext) => void;
    deps?: BrowserAdapterDependencies;
  }> = [
    { name: 'owner_task_id missing', code: 'owner_task_id_required', build: (ctx) => without(ctx.args, '--owner-task-id') },
    { name: 'owner_dispatch_id missing', code: 'owner_dispatch_id_required', build: (ctx) => without(ctx.args, '--owner-dispatch-id') },
    {
      name: 'predecessor_handoff_unproven (no such predecessor locator)', code: 'predecessor_handoff_unproven',
      build: (ctx) => [...ctx.args, '--predecessor-invocation-id', 'inv-missing', '--predecessor-attempt-identity', 'attempt-missing'],
    },
    { name: 'invalid_cwd', code: 'invalid_cwd', build: (ctx) => withValue(ctx.args, '--cwd', join(ctx.root, 'no-such-worktree')) },
    {
      name: 'terminal_envelope_name_not_wakeable', code: 'terminal_envelope_name_not_wakeable',
      build: (ctx) => withValue(ctx.args, '--terminal-envelope', join(ctx.root, 'row', 'turn-final.json')),
    },
    {
      name: 'occupied_launcher_owned_path', code: 'occupied_launcher_owned_path',
      build: (ctx) => ctx.args,
      setup: (ctx) => { mkdirSync(dirname(ctx.paths.receipt), { recursive: true }); writeFileSync(ctx.paths.receipt, 'occupied'); },
    },
    {
      name: 'preflight_failed (unwritable browser-output parent)', code: 'preflight_failed',
      build: (ctx) => withValue(ctx.args, '--output', join(ctx.root, 'afile', 'out.txt')),
      setup: (ctx) => writeFileSync(join(ctx.root, 'afile'), 'a regular file, not a directory'),
    },
    {
      name: 'liveness_contract_invalid', code: 'liveness_contract_invalid', build: (ctx) => ctx.args,
      setup: () => vi.stubEnv('OPK_BROWSER_TURN_LIVE_CHILD_IDLE_WINDOW_MS', 'not-a-number'),
    },
    {
      name: 'invocation_admission_failed_use_fresh_id (pre-existing observation record)', code: 'invocation_admission_failed_use_fresh_id',
      build: (ctx) => ctx.args,
      setup: (ctx) => { admitStateLightTurnObservation({ profileKey: configuredProfileKey(ctx.profile, cdp), invocationId: 'inv-m', marker: OBSERVATION_MARKER }); },
    },
    {
      name: 'invocation_admission_failed_use_fresh_id (pre-existing locator)', code: 'invocation_admission_failed_use_fresh_id',
      build: (ctx) => ctx.args,
      setup: (ctx) => {
        const locator = invocationReceiptLocatorPath('inv-m', ctx.root);
        mkdirSync(dirname(locator), { recursive: true, mode: 0o700 });
        writeFileSync(locator, '{}', { mode: 0o600 });
      },
    },
    {
      name: 'owner_dispatch_not_current (Task bound to another Dispatch)', code: 'owner_dispatch_not_current',
      build: (ctx) => ctx.args,
      setup: (ctx) => { writeAssignmentStore(ownerEnvFor(ctx.root), [{ taskId: OWNER_TASK, dispatchId: 'dispatch-replacement' }]); },
    },
    { name: 'bound_issue_selector_invalid', code: 'bound_issue_selector_invalid', build: (ctx) => [...ctx.args, '--bound-issue', 'not-a-selector'] },
    {
      name: 'bound_issue_repository_not_selected_card', code: 'bound_issue_repository_not_selected_card',
      build: (ctx) => [...ctx.args, '--bound-issue', 'other/repo#5'],
    },
    {
      name: 'bound_issue_conflicts_with_pr_author', code: 'bound_issue_conflicts_with_pr_author',
      build: (ctx) => [...ctx.args, '--bound-issue', `${SELECTED}#5`, '--repo', SELECTED, '--pr', '7'],
    },
    { name: 'PR-author pair: --repo without --pr', code: 'pr_author_binding_pair_partial', build: (ctx) => [...ctx.args, '--repo', SELECTED] },
    { name: 'PR-author pair: --pr without --repo', code: 'pr_author_binding_pair_partial', build: (ctx) => [...ctx.args, '--pr', '7'] },
    {
      name: 'PR-author pair: card repository mismatch', code: 'pr_author_repository_not_selected_card',
      build: (ctx) => [...ctx.args, '--repo', 'other/repo', '--pr', '7'],
    },
    {
      name: 'durable_artifact_root_invalid (relative XDG_STATE_HOME)', code: 'durable_artifact_root_invalid', build: (ctx) => ctx.args,
      setup: () => { vi.stubEnv('OPK_FM_LONG_CHILD_TEST_GATE', undefined); vi.stubEnv('OPK_FM_LONG_CHILD_TEST_TERMINAL_ROOT', undefined); vi.stubEnv('XDG_STATE_HOME', 'relative/state'); },
    },
  ];

  it.each(preChildRows)('pre-child refusal $name: exit 2, actual code + executable nextStep on stderr, no accepted/v1, no spawn', async (row) => {
    const ctx = matrixContext();
    row.setup?.(ctx);
    const spawnLauncher = vi.fn(async () => { throw new Error('must_not_spawn'); });
    const result = await runAdapter(row.build(ctx), baseDeps(spawnLauncher, row.deps));
    expect(result.code).toBe(2);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain(row.code);
    expect(result.lines[0]).toMatch(/; nextStep: \S/u);
    expect(result.stdout).not.toContain('accepted/v1');
    expect(result.stdout).toBe('');
    expect(spawnLauncher).not.toHaveBeenCalled();
    // A proven pre-child refusal: no terminal, no browser output, no physical SEND artifacts.
    expect(existsSync(ctx.paths.envelope)).toBe(false);
    expect(existsSync(ctx.paths.output)).toBe(false);
    expect(existsSync(refusalCompanionPath(ctx.paths.receipt))).toBe(false);
  });

  describe('post-spawn evidence tiers (a launcher may already have run: SEND unknown)', () => {
    const SEND_UNKNOWN = /physical SEND unknown \(POSSIBLY_DELIVERED; no resend license\)/u;

    function companion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return dropUndefined({
        schema: REFUSAL_COMPANION_SCHEMA, run_identity: 'run-m', attempt_identity: 'attempt-m', invocation_id: 'inv-m',
        launcher_pid: 4321, code: 'canary_in_receipt', nextStep: 'remove secret-bearing values from launch arguments',
        physical_send: 'none', ...overrides,
      });
    }

    async function postSpawn(
      spawn: (ctx: MatrixContext, args: readonly string[]) => Promise<{ launcherPid: number; exitCode?: number }>,
      options: { fakeTimers?: boolean } = {},
    ) {
      const ctx = matrixContext();
      const spawnLauncher = vi.fn(async (args: readonly string[]) => await spawn(ctx, args));
      let result: Awaited<ReturnType<typeof runAdapter>>;
      if (options.fakeTimers) {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
        try {
          const pending = runAdapter(ctx.args, baseDeps(spawnLauncher));
          await vi.advanceTimersByTimeAsync(31_000);
          result = await pending;
        } finally {
          vi.useRealTimers();
        }
      } else {
        result = await runAdapter(ctx.args, baseDeps(spawnLauncher));
      }
      return { ctx, spawnLauncher, result };
    }

    it('relays an authenticated same-run/attempt/invocation/pid companion code and nextStep (exit 2, no accepted/v1)', async () => {
      const { ctx, spawnLauncher, result } = await postSpawn(async (c) => {
        writePrivateJson(refusalCompanionPath(c.paths.receipt), companion());
        return { launcherPid: 4321, exitCode: 2 };
      });
      expect(spawnLauncher).toHaveBeenCalledTimes(1);
      expect(result.code).toBe(2);
      expect(result.lines).toEqual([`${ADAPTER_PREFIX}canary_in_receipt; nextStep: remove secret-bearing values from launch arguments`]);
      expect(result.stdout).toBe('');
      expect(existsSync(ctx.paths.envelope)).toBe(false);
    });

    it('relays the code a real in-process launcher refusal produced, not a hidden or invented one', async () => {
      vi.stubEnv(REFUSAL_COMPANION_ENV, 'v1');
      const { result } = await postSpawn(async (c, args) => {
        // The launcher's own admission race: the key becomes occupied after the adapter's validation.
        admitStateLightTurnObservation({ profileKey: configuredProfileKey(c.profile, cdp), invocationId: 'inv-m', marker: OBSERVATION_MARKER });
        const config = { ...launchConfigFromArgv(args.slice(1)), childCommand: process.execPath, childArgs: ['-e', 'process.exit(0)'] };
        return { launcherPid: process.pid, exitCode: await runLaunch(config) };
      });
      expect(result.code).toBe(2);
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0]).toMatch(/invocation_admission_failed_use_fresh_id; nextStep: relaunch with a fresh --invocation-id/u);
      expect(result.lines[0]).not.toMatch(SEND_UNKNOWN);
      expect(result.stdout).toBe('');
    });

    const untrustedCompanions: ReadonlyArray<{ name: string; write: (path: string) => void }> = [
      { name: 'foreign launcher pid', write: (path) => writePrivateJson(path, companion({ launcher_pid: 9999 })) },
      { name: 'foreign Run', write: (path) => writePrivateJson(path, companion({ run_identity: 'run-foreign' })) },
      { name: 'foreign attempt', write: (path) => writePrivateJson(path, companion({ attempt_identity: 'attempt-foreign' })) },
      { name: 'foreign invocation', write: (path) => writePrivateJson(path, companion({ invocation_id: 'inv-foreign' })) },
      { name: 'claims a physical send', write: (path) => writePrivateJson(path, companion({ physical_send: 'one' })) },
      { name: 'empty nextStep', write: (path) => writePrivateJson(path, companion({ nextStep: '   ' })) },
      { name: 'invented non-code', write: (path) => writePrivateJson(path, companion({ code: 'Not A Code!' })) },
      { name: 'unparseable', write: (path) => writeFileSync(path, 'garbage', { mode: 0o600 }) },
      { name: 'oversized', write: (path) => writePrivateJson(path, companion({ nextStep: 'x'.repeat(4_096) })) },
      { name: 'not private (0644)', write: (path) => { writePrivateJson(path, companion()); chmodSync(path, 0o644); } },
      { name: 'absent', write: () => undefined },
    ];
    it.each(untrustedCompanions)('prints only the known wrapper code with SEND unknown for a $name companion', async ({ write }) => {
      const { ctx, result } = await postSpawn(async (c) => {
        mkdirSync(dirname(c.paths.receipt), { recursive: true });
        write(refusalCompanionPath(c.paths.receipt));
        return { launcherPid: 4321, exitCode: 2 };
      });
      expect(result.code).toBe(2);
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0]).toContain('launcher_refused_without_companion; nextStep: ');
      expect(result.lines[0]).toMatch(SEND_UNKNOWN);
      expect(result.lines[0]).not.toContain('canary_in_receipt'); // never a borrowed or hidden child code
      expect(result.lines[0]).not.toContain('remove secret-bearing');
      expect(result.stdout).toBe('');
      expect(existsSync(ctx.paths.envelope)).toBe(false);
    });

    it('reports handoff_receipt_missing with SEND unknown when a detached launcher never commits its receipt', async () => {
      const { result } = await postSpawn(async () => ({ launcherPid: 4321 }), { fakeTimers: true });
      expect(result.code).toBe(2);
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0]).toContain('handoff_receipt_missing; nextStep: ');
      expect(result.lines[0]).toMatch(SEND_UNKNOWN);
      expect(result.stdout).toBe('');
    });

    it('reports handoff_new_launcher_pid_mismatch when the receipt names a different launcher PID', async () => {
      const { result } = await postSpawn(async (c) => {
        writeHandoffArtifacts({
          terminalRoot: c.root, dir: join(c.root, 'row'), invocation: 'inv-m', run: 'run-m', attempt: 'attempt-m',
          receiptPath: c.paths.receipt, envelopePath: c.paths.envelope, receipt: { launcher_pid: 5555, child_cwd: realpathSync(c.root) },
        });
        return { launcherPid: 6666 };
      });
      expect(result.code).toBe(2);
      expect(result.lines[0]).toContain('handoff_new_launcher_pid_mismatch; nextStep: ');
      expect(result.lines[0]).toMatch(SEND_UNKNOWN);
      expect(result.stdout).not.toContain('accepted/v1');
    });

    it('reports receipt_locator_readback_failed with SEND unknown when the child sent before the locator could be read back', async () => {
      const { result } = await postSpawn(async (c) => {
        writeHandoffArtifacts({
          terminalRoot: c.root, dir: join(c.root, 'row'), invocation: 'inv-m', run: 'run-m', attempt: 'attempt-m',
          receiptPath: c.paths.receipt, envelopePath: c.paths.envelope, skipLocator: true,
          receipt: { launcher_pid: 4321, child_cwd: realpathSync(c.root) },
        });
        return { launcherPid: 4321 };
      });
      expect(result.code).toBe(2);
      expect(result.lines[0]).toContain('receipt_locator_readback_failed: ');
      expect(result.lines[0]).toMatch(SEND_UNKNOWN);
      expect(result.stdout).not.toContain('accepted/v1');
    });

    it('reports a stale locator (different terminal path or owner) as readback failure, not as acceptance', async () => {
      const { result } = await postSpawn(async (c) => {
        writeHandoffArtifacts({
          terminalRoot: c.root, dir: join(c.root, 'row'), invocation: 'inv-m', run: 'run-m', attempt: 'attempt-m',
          receiptPath: c.paths.receipt, envelopePath: join(c.root, 'row', 'someone-elses-terminal.json'),
          receipt: { launcher_pid: 4321, child_cwd: realpathSync(c.root) },
        });
        return { launcherPid: 4321 };
      });
      expect(result.code).toBe(2);
      expect(result.lines[0]).toContain('receipt_locator_readback_failed: ');
      expect(result.lines[0]).toMatch(SEND_UNKNOWN);
      expect(result.stdout).not.toContain('accepted/v1');
    });

    it.each([
      ['launcher spawn throws', async () => { throw new Error('spawn exploded'); }, 'launcher_start_failed: spawn exploded'],
      ['launcher PID unavailable', async () => ({ launcherPid: 1 }), 'launcher_process_identity_unavailable'],
    ] as const)('reports %s with its own wrapper code and SEND unknown', async (_name, spawn, code) => {
      const { result } = await postSpawn(spawn as never);
      expect(result.code).toBe(2);
      expect(result.lines[0]).toContain(code);
      expect(result.lines[0]).toMatch(SEND_UNKNOWN);
      expect(result.stdout).toBe('');
    });

    it('accepts only a newly observed launcher PID with the matching original handoff, locator, Run/attempt and owner pair', async () => {
      const { ctx, result } = await postSpawn(async (c) => {
        writeHandoffArtifacts({
          terminalRoot: c.root, dir: join(c.root, 'row'), invocation: 'inv-m', run: 'run-m', attempt: 'attempt-m',
          receiptPath: c.paths.receipt, envelopePath: c.paths.envelope,
          receipt: { launcher_pid: 4321, child_cwd: realpathSync(c.root) },
        });
        return { launcherPid: 4321 };
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout.trim())).toMatchObject({
        schema: 'flow-manager-browser-gpt-long-run-accepted/v1', run_identity: 'run-m', attempt_identity: 'attempt-m',
        invocation_id: 'inv-m', launcher_pid: 4321, handoff_receipt: ctx.paths.receipt,
        receipt_locator: invocationReceiptLocatorPath('inv-m', ctx.root), terminal_envelope: ctx.paths.envelope,
        owner_task_id: OWNER_TASK, owner_dispatch_id: OWNER_DISPATCH, child_cwd: realpathSync(ctx.root),
      });
    });

    it('accepts a different owner pair in the receipt as readback failure (an old receipt is not authority)', async () => {
      const { result } = await postSpawn(async (c) => {
        writeHandoffArtifacts({
          terminalRoot: c.root, dir: join(c.root, 'row'), invocation: 'inv-m', run: 'run-m', attempt: 'attempt-m',
          receiptPath: c.paths.receipt, envelopePath: c.paths.envelope,
          receipt: { launcher_pid: 4321, child_cwd: realpathSync(c.root), owner_dispatch_id: 'dispatch-old' },
        });
        return { launcherPid: 4321 };
      });
      expect(result.code).toBe(2);
      expect(result.lines[0]).toContain('receipt_locator_readback_failed: ');
      expect(result.stdout).not.toContain('accepted/v1');
    });

    it('resolves a legacy /tmp/opencode-style caller path to its basename under the XDG durable root in accepted/v1', async () => {
      const root = tempDir('opk-2750-accept-prod-');
      const xdg = join(root, 'xdg');
      const durable = join(xdg, 'orchestrator-pack');
      vi.stubEnv('OPK_FM_LONG_CHILD_TEST_GATE', undefined);
      vi.stubEnv('OPK_FM_LONG_CHILD_TEST_TERMINAL_ROOT', undefined);
      vi.stubEnv('XDG_STATE_HOME', xdg);
      vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', join(root, 'state'));
      stubOwnerStoreEnv(root);
      const legacy = join(root, 'legacy', 'opencode');
      const args = [
        '--run-identity', 'run-d', '--attempt-identity', 'attempt-d', '--invocation-id', 'inv-d',
        '--owner-task-id', OWNER_TASK, '--owner-dispatch-id', OWNER_DISPATCH,
        '--handoff-receipt', join(legacy, 'd-handoff.json'), '--terminal-envelope', join(legacy, 'd-terminal.json'),
        '--output', join(root, 'out', 'reply.txt'), '--profile', join(root, 'profile'), '--cdp', cdp,
        '--input', join(root, 'prompt.txt'), '--cwd', root,
      ];
      const spawnLauncher = vi.fn(async (launcherArgs: readonly string[]) => {
        const at = (flag: string): string => launcherArgs[launcherArgs.indexOf(flag) + 1]!;
        // The adapter hands the launcher the resolved durable paths, never the legacy directory.
        expect(at('--handoff-receipt')).toBe(join(durable, 'd-handoff.json'));
        expect(at('--terminal-envelope')).toBe(join(durable, 'd-terminal.json'));
        writeHandoffArtifacts({
          terminalRoot: durable, dir: join(durable, 'd'), invocation: 'inv-d', run: 'run-d', attempt: 'attempt-d',
          receiptPath: at('--handoff-receipt'), envelopePath: at('--terminal-envelope'),
          receipt: { launcher_pid: 4321, child_cwd: realpathSync(root) },
        });
        return { launcherPid: 4321 };
      });
      const result = await runAdapter(args, baseDeps(spawnLauncher));
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({
        handoff_receipt: join(durable, 'd-handoff.json'), terminal_envelope: join(durable, 'd-terminal.json'),
        receipt_locator: invocationReceiptLocatorPath('inv-d', durable),
      });
      expect(statSync(durable).mode & 0o777).toBe(0o700);
      expect(existsSync(join(root, 'legacy'))).toBe(false);
    });
  });

  describe('direct-launch-only rows (unreachable through the native adapter)', () => {
    async function directLaunch(config: Omit<LaunchConfig, 'terminalEnvelopeRoot'>, root: string) {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const code = await runFixtureLaunch(root, config);
        return { code, stderr: stderr.mock.calls.map((call) => String(call[0])).join('') };
      } finally {
        stderr.mockRestore();
      }
    }

    it('receipt_create_failed: exit 2 with an executable nextStep and the Browser child never started', async () => {
      const root = tempDir('opk-2750-direct-receipt-');
      const paths = launchPaths(root, 'direct');
      const marker = join(root, 'must-not-start.txt');
      vi.stubEnv('OPK_FM_LONG_CHILD_FORCE_RECEIPT_CREATE_FAIL', '1');
      const result = await directLaunch({
        runIdentity: 'run-direct', attemptIdentity: 'attempt-direct', handoffReceiptPath: paths.receipt,
        terminalEnvelopePath: paths.envelope, browserOutputPath: paths.output, cwd: repoRoot,
        childCommand: process.execPath, childArgs: markedChildFixture(marker, makeTurnResult()).args,
      }, root);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('"reason":"receipt_create_failed"');
      expect(result.stderr).toMatch(/"nextStep":"[^"]+\S/u);
      expectNoLauncherEffects(paths, marker);
    });

    it('canary_in_receipt: exit 2 with an executable nextStep and the Browser child never started', async () => {
      const root = tempDir('opk-2750-direct-canary-');
      const paths = launchPaths(root, 'canary');
      const marker = join(root, 'must-not-start.txt');
      const result = await directLaunch({
        runIdentity: 'run-SECRETCANARY', attemptIdentity: 'attempt-canary', handoffReceiptPath: paths.receipt,
        terminalEnvelopePath: paths.envelope, browserOutputPath: paths.output, cwd: repoRoot,
        childCommand: process.execPath, childArgs: markedChildFixture(marker, makeTurnResult()).args,
        secretCanaries: ['SECRETCANARY'],
      }, root);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('"reason":"canary_in_receipt"');
      expect(result.stderr).toMatch(/"nextStep":"remove secret-bearing values/u);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(paths.envelope)).toBe(false);
      expect(existsSync(paths.output)).toBe(false);
    });
  });
});

describe('Issue #2750 predecessor identity and continuity (AC14-AC15)', () => {
  const cdp = 'http://127.0.0.1:9222';
  const OLD = { run: 'old-run', attempt: 'old-attempt', invocation: 'inv-old', task: 'old-task', dispatch: 'old-dispatch' };

  interface PredecessorScenario {
    root: string; profile: string; config: LaunchConfig; old: HandoffArtifacts;
    protectedFiles: () => Record<string, string | null>;
  }

  function predecessorScenario(options: {
    terminal?: Record<string, unknown> | null; receipt?: Record<string, unknown>;
    observation?: 'created' | 'not-created' | 'none'; profile?: string; skipLocator?: boolean;
    childArgsExtra?: string[]; ownerPair?: boolean; currentInvocation?: string;
  } = {}): PredecessorScenario {
    const root = tempDir('opk-2750-pred-');
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', join(root, 'state'));
    stubOwnerStoreEnv(root);
    const profile = options.profile ?? join(root, 'profile');
    const profileKey = configuredProfileKey(profile, cdp);
    const old = writeHandoffArtifacts({
      terminalRoot: root, dir: join(root, 'old'), invocation: OLD.invocation, run: OLD.run, attempt: OLD.attempt,
      receipt: { owner_task_id: OLD.task, owner_dispatch_id: OLD.dispatch, ...options.receipt },
      skipLocator: options.skipLocator,
    });
    if ((options.observation ?? 'created') !== 'none') {
      admitStateLightTurnObservation({ profileKey, invocationId: OLD.invocation, marker: OBSERVATION_MARKER });
      bindStateLightOwnedTarget({
        profileKey, invocationId: OLD.invocation, targetId: 'target-old',
        created: (options.observation ?? 'created') === 'created', cdp, initialRoute: 'https://chatgpt.com/',
      });
    }
    if (options.terminal !== null) {
      writePrivateJson(old.envelopePath, launcherTerminal(old, {
        owned_target_id: 'target-old', owned_target_created: true, owned_prompt_marker: OBSERVATION_MARKER,
        ...options.terminal,
      }));
    }
    const fresh = launchPaths(root, 'fresh');
    const invocation = options.currentInvocation ?? 'inv-new';
    const config: LaunchConfig = {
      runIdentity: 'new-run', attemptIdentity: 'new-attempt', terminalEnvelopeRoot: root,
      handoffReceiptPath: fresh.receipt, terminalEnvelopePath: fresh.envelope, browserOutputPath: fresh.output,
      cwd: repoRoot, childCommand: process.execPath, invocationId: invocation, profile, cdp,
      ...(options.ownerPair === false ? {} : { ownerTaskId: 'new-task', ownerDispatchId: 'new-dispatch' }),
      childArgs: [
        'turn', '--invocation-id', invocation, '--profile', profile, '--cdp', cdp,
        '--predecessor-invocation-id', OLD.invocation, '--predecessor-attempt-identity', OLD.attempt,
        '--input', 'prompt.txt', ...(options.childArgsExtra ?? []),
      ],
    };
    const observationFile = observationRecordPath(profileKey, OLD.invocation);
    const protectedFiles = (): Record<string, string | null> => Object.fromEntries(
      [old.receiptPath, old.envelopePath, old.locatorPath, observationFile]
        .map((path) => [path, existsSync(path) ? readFileSync(path, 'utf8') : null]));
    return { root, profile, config, old, protectedFiles };
  }

  describe('readPredecessorReceiptLocator', () => {
    it('authenticates through the locator\'s own Run/attempt/owner, never the current ones', () => {
      const { root, old } = predecessorScenario();
      const bound = readPredecessorReceiptLocator({
        invocationId: OLD.invocation, expectedAttemptIdentity: OLD.attempt, terminalEnvelopeRoot: root,
      });
      expect(bound.path).toBe(old.locatorPath);
      expect(bound.locator).toMatchObject({ invocation_id: OLD.invocation, run_identity: OLD.run, attempt_identity: OLD.attempt });
      expect(bound.receipt).toMatchObject({ owner_task_id: OLD.task, owner_dispatch_id: OLD.dispatch, invocation_id: OLD.invocation });
      expect(bound.receipt.owner_task_id).not.toBe('new-task');
      // Without an attempt selector the locator's own attempt is still the authority.
      expect(readPredecessorReceiptLocator({ invocationId: OLD.invocation, terminalEnvelopeRoot: root }).locator.attempt_identity).toBe(OLD.attempt);
    });

    it('accepts a pre-#2750 Task-only receipt at the reader (the launch gate separately requires a Dispatch)', () => {
      const { root } = predecessorScenario({ receipt: { owner_dispatch_id: undefined } });
      expect(readPredecessorReceiptLocator({ invocationId: OLD.invocation, terminalEnvelopeRoot: root }).receipt.owner_dispatch_id).toBeUndefined();
    });

    it('throws predecessor_attempt_identity_mismatch for a foreign attempt selector', () => {
      const { root } = predecessorScenario();
      expect(() => readPredecessorReceiptLocator({
        invocationId: OLD.invocation, expectedAttemptIdentity: 'attempt-foreign', terminalEnvelopeRoot: root,
      })).toThrow('predecessor_attempt_identity_mismatch');
    });

    it('throws for a missing locator, a blank invocation and an unowned receipt', () => {
      const { root } = predecessorScenario();
      expect(() => readPredecessorReceiptLocator({ invocationId: 'inv-never-launched', terminalEnvelopeRoot: root })).toThrow();
      expect(() => readPredecessorReceiptLocator({ invocationId: '  ', terminalEnvelopeRoot: root })).toThrow('predecessor_invocation_required');
      const ownerless = predecessorScenario({ receipt: { owner_task_id: undefined, owner_dispatch_id: undefined } });
      expect(() => readPredecessorReceiptLocator({ invocationId: OLD.invocation, terminalEnvelopeRoot: ownerless.root }))
        .toThrow('predecessor_owner_bound_handoff_missing_or_mismatched');
    });

    it('throws for a foreign locator planted under another invocation\'s key, a symlinked locator and a foreign receipt', () => {
      const { root, old } = predecessorScenario();
      const planted = invocationReceiptLocatorPath('inv-victim', root);
      writePrivateJson(planted, JSON.parse(readFileSync(old.locatorPath, 'utf8')));
      expect(() => readPredecessorReceiptLocator({ invocationId: 'inv-victim', terminalEnvelopeRoot: root })).toThrow('receipt_locator_identity_mismatch');
      const linked = invocationReceiptLocatorPath('inv-linked', root);
      symlinkSync(old.locatorPath, linked);
      expect(() => readPredecessorReceiptLocator({ invocationId: 'inv-linked', terminalEnvelopeRoot: root })).toThrow();
      writePrivateJson(old.receiptPath, { ...JSON.parse(readFileSync(old.receiptPath, 'utf8')), invocation_id: 'inv-someone-else' });
      expect(() => readPredecessorReceiptLocator({ invocationId: OLD.invocation, terminalEnvelopeRoot: root }))
        .toThrow('predecessor_owner_bound_handoff_missing_or_mismatched');
    });
  });

  describe('validateLaunchPreSpawn with a predecessor selector', () => {
    it('returns ok/settled_noop for a settled ok/landed predecessor of a different Task and Run, with no side effects', () => {
      const scenario = predecessorScenario();
      const before = scenario.protectedFiles();
      const validation = validateLaunchPreSpawn(scenario.config);
      expect(validation.ok).toBe(true);
      if (!validation.ok) return;
      expect(validation.predecessor).toBe('settled_noop');
      expect(validation.ownerCurrency).toBe('unverified'); // freshness stays upstream; nothing is borrowed from the old pair
      // The predecessor selector never reaches the driver; everything else is unchanged.
      expect(validation.config.childArgs).not.toContain('--predecessor-invocation-id');
      expect(validation.config.childArgs).not.toContain('--predecessor-attempt-identity');
      expect(validation.config.childArgs).not.toContain(OLD.invocation);
      expect(validation.config.childArgs).toEqual([
        'turn', '--invocation-id', 'inv-new', '--profile', scenario.profile, '--cdp', cdp, '--input', 'prompt.txt',
      ]);
      expect(validation.config).toMatchObject({ runIdentity: 'new-run', ownerTaskId: 'new-task', ownerDispatchId: 'new-dispatch' });
      expect(scenario.protectedFiles()).toEqual(before); // no Stop, cleanup, rewrite or republish of old evidence
      expect(existsSync(invocationReceiptLocatorPath('inv-new', scenario.root))).toBe(false);
      expect(existsSync(scenario.config.handoffReceiptPath)).toBe(false);
      expect(existsSync(scenario.config.terminalEnvelopePath)).toBe(false);
    });

    it('does not let a settled predecessor admit the new Send: current admission is still independent', () => {
      const scenario = predecessorScenario();
      writeAssignmentStore(ownerEnvFor(scenario.root), [{ taskId: 'new-task', dispatchId: 'dispatch-replacement' }]);
      const refused = validateLaunchPreSpawn(scenario.config);
      expect(refused).toMatchObject({ ok: false, code: 'owner_dispatch_not_current' });
      mkdirSync(dirname(scenario.config.handoffReceiptPath), { recursive: true });
      writeFileSync(scenario.config.handoffReceiptPath, 'occupied', { flag: 'wx' });
      writeAssignmentStore(ownerEnvFor(scenario.root), [{ taskId: 'new-task', dispatchId: 'new-dispatch' }]);
      expect(validateLaunchPreSpawn(scenario.config)).toMatchObject({ ok: false, code: 'occupied_launcher_owned_path' });
    });

    it('accepts the explicitly current Task+Dispatch of the new Run when the store records it', () => {
      const scenario = predecessorScenario();
      writeAssignmentStore(ownerEnvFor(scenario.root), [{ taskId: 'new-task', dispatchId: 'new-dispatch' }]);
      expect(validateLaunchPreSpawn(scenario.config)).toMatchObject({ ok: true, predecessor: 'settled_noop', ownerCurrency: 'current' });
    });

    const negatives: ReadonlyArray<{ name: string; options: Parameters<typeof predecessorScenario>[0]; message: RegExp }> = [
      { name: 'terminal envelope missing', options: { terminal: null }, message: /predecessor_terminal_or_target_unproven/u },
      { name: 'original observation record missing (foreign profile/CDP)', options: { observation: 'none' }, message: /predecessor_terminal_or_target_unproven|ENOENT/u },
      { name: 'owned target was not created by the predecessor', options: { observation: 'not-created' }, message: /predecessor_terminal_owner_profile_or_target_mismatch/u },
      { name: 'terminal is not ok/landed (possibly delivered)', options: { terminal: { lifecycle_outcome: 'incident', delivery: 'POSSIBLY_DELIVERED', turn_result_state: 'rate_limit' } }, message: /predecessor_terminal_owner_profile_or_target_mismatch/u },
      { name: 'terminal ok but not landed', options: { terminal: { delivery: 'POSSIBLY_DELIVERED' } }, message: /predecessor_terminal_owner_profile_or_target_mismatch/u },
      { name: 'terminal marker differs from the original record', options: { terminal: { owned_prompt_marker: 'OPKTURNV1ffffffffffffffffffffffffffffffff' } }, message: /predecessor_terminal_owner_profile_or_target_mismatch/u },
      { name: 'terminal target differs from the original record', options: { terminal: { owned_target_id: 'target-foreign' } }, message: /predecessor_terminal_owner_profile_or_target_mismatch/u },
      { name: 'terminal names another invocation', options: { terminal: { observed_invocation_id: 'inv-foreign' } }, message: /predecessor_terminal_owner_profile_or_target_mismatch/u },
      { name: 'terminal points at another handoff receipt', options: { terminal: { handoff_receipt_path: '/synthetic/foreign-handoff.json' } }, message: /predecessor_terminal_owner_profile_or_target_mismatch/u },
      { name: 'terminal belongs to another Run', options: { terminal: { run_identity: 'foreign-run' } }, message: /predecessor_terminal_or_target_unproven/u },
      { name: 'old receipt has only the Task (no Dispatch)', options: { receipt: { owner_dispatch_id: undefined } }, message: /predecessor_terminal_owner_profile_or_target_mismatch/u },
      { name: 'old receipt has no owner at all', options: { receipt: { owner_task_id: undefined, owner_dispatch_id: undefined } }, message: /predecessor_owner_bound_handoff_missing_or_mismatched/u },
      { name: 'no locator for the predecessor', options: { skipLocator: true }, message: /ENOENT|receipt_locator/u },
      { name: 'current launch lacks its own owner pair', options: { ownerPair: false }, message: /predecessor_identity_and_current_owner_required/u },
      { name: 'predecessor is the current invocation', options: { currentInvocation: OLD.invocation }, message: /predecessor_identity_and_current_owner_required/u },
    ];
    it.each(negatives)('refuses before the current SEND: $name', ({ options, message }) => {
      const scenario = predecessorScenario(options);
      const before = scenario.protectedFiles();
      const validation = validateLaunchPreSpawn(scenario.config);
      expect(validation.ok).toBe(false);
      if (validation.ok) return;
      expect(validation.code).toBe('predecessor_handoff_unproven');
      expect(String(validation.details.message)).toMatch(message);
      expect(String(validation.details.nextStep)).toMatch(/reconcile the exact predecessor invocation/u);
      expect(scenario.protectedFiles()).toEqual(before);
      expect(existsSync(scenario.config.handoffReceiptPath)).toBe(false);
      expect(existsSync(scenario.config.terminalEnvelopePath)).toBe(false);
    });

    it('refuses a foreign attempt selector and a foreign profile/CDP selector', () => {
      const attempt = predecessorScenario({
        childArgsExtra: [],
      });
      const tampered = {
        ...attempt.config,
        childArgs: attempt.config.childArgs.map((token) => token === OLD.attempt ? 'attempt-foreign' : token),
      };
      const refusedAttempt = validateLaunchPreSpawn(tampered);
      expect(refusedAttempt).toMatchObject({ ok: false, code: 'predecessor_handoff_unproven' });
      if (!refusedAttempt.ok) expect(String(refusedAttempt.details.message)).toContain('predecessor_attempt_identity_mismatch');

      const foreign = predecessorScenario();
      const otherProfile = join(foreign.root, 'other-profile');
      const swapped = {
        ...foreign.config, profile: otherProfile,
        childArgs: foreign.config.childArgs.map((token) => token === foreign.profile ? otherProfile : token),
      };
      expect(validateLaunchPreSpawn(swapped)).toMatchObject({ ok: false, code: 'predecessor_handoff_unproven' });
    });

    it('treats an unresolved owned target as a retire disposition owned by the driver, not a no-op', () => {
      const scenario = predecessorScenario({
        terminal: { lifecycle_outcome: 'incident', delivery: 'POSSIBLY_DELIVERED', turn_result_state: undefined, cleanup_status: 'cleanup_unconfirmed' },
      });
      const validation = validateLaunchPreSpawn(scenario.config);
      expect(validation).toMatchObject({ ok: true, predecessor: 'retire_owned_target' });
      if (validation.ok) expect(validation.config.childArgs).toContain('--predecessor-invocation-id'); // the driver keeps the selector
    });
  });
});

describe('Issue #2750 github_effect_baseline receipt writer (AC2/AC3)', () => {
  function baselineFixture(id: string) {
    const root = tempDir(`opk-2750-baseline-${id}-`);
    const ids = fixtureIds(id);
    const artifacts = writeHandoffArtifacts({
      terminalRoot: root, dir: join(root, id), invocation: ids.invocation, run: ids.run, attempt: ids.attempt,
    });
    return { root, ids, artifacts };
  }

  it('adds the optional baseline to the existing receipt, keeps every other field byte-equal and stays 0600', () => {
    const { root, ids, artifacts } = baselineFixture('writer');
    const beforeText = readFileSync(artifacts.receiptPath, 'utf8');
    const before = JSON.parse(beforeText) as Record<string, unknown>;
    const beforeReceipt = readHandoffReceipt(artifacts.receiptPath)!;
    const locatorBefore = readFileSync(artifacts.locatorPath, 'utf8');
    expect(writeGithubEffectBaselineToReceipt({
      receiptPath: artifacts.receiptPath, invocationId: ids.invocation,
      target: { repo: 'acme/widgets', kind: 'issue', number: 2750, bodySha256: ISSUE_BODY_BEFORE },
    })).toBe(true);
    const after = JSON.parse(readFileSync(artifacts.receiptPath, 'utf8')) as Record<string, unknown>;
    for (const key of Object.keys(before)) expect(JSON.stringify(after[key])).toBe(JSON.stringify(before[key]));
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before), 'github_effect_baseline'].sort());
    expect(after.github_effect_baseline).toMatchObject({
      schema: GITHUB_EFFECT_BASELINE_SCHEMA, invocation_id: ids.invocation, run_identity: ids.run, attempt_identity: ids.attempt,
      repo: 'acme/widgets', kind: 'issue', number: 2750, body_sha256: ISSUE_BODY_BEFORE,
    });
    expect(Number.isFinite(Date.parse(String((after.github_effect_baseline as Record<string, unknown>).captured_at)))).toBe(true);
    if (process.platform !== 'win32') expect(statSync(artifacts.receiptPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(artifacts.receiptPath)).filter((name) => name.includes('baseline') || name.endsWith('.tmp'))).toEqual([]);
    // Immutable identity is unchanged; the extra field is ignored for handoff equality.
    const afterReceipt = readHandoffReceipt(artifacts.receiptPath)!;
    expect(sameHandoffIdentity(beforeReceipt, afterReceipt)).toBe(true);
    expect(sameHandoffIdentity(afterReceipt, beforeReceipt)).toBe(true);
    expect(afterReceipt.github_effect_baseline).toBeDefined();
    expect(readFileSync(artifacts.locatorPath, 'utf8')).toBe(locatorBefore); // locator v1 unchanged
    expect(readInvocationReceiptLocator({
      invocationId: ids.invocation, runIdentity: ids.run, attemptIdentity: ids.attempt, terminalEnvelopeRoot: root,
    }).receipt.invocation_id).toBe(ids.invocation);
    expect(parseGithubEffectBaseline(afterReceipt.github_effect_baseline, {
      invocationId: ids.invocation, runIdentity: ids.run, attemptIdentity: ids.attempt,
    })).toMatchObject({ kind: 'issue', body_sha256: ISSUE_BODY_BEFORE });
  });

  it('writes a PR head baseline and refuses a second write, preserving the first', () => {
    const { ids, artifacts } = baselineFixture('writer-pr');
    expect(writeGithubEffectBaselineToReceipt({
      receiptPath: artifacts.receiptPath, invocationId: ids.invocation,
      target: { repo: 'acme/widgets', kind: 'pr', number: 7, headSha: HEAD_BEFORE },
    })).toBe(true);
    const first = readFileSync(artifacts.receiptPath, 'utf8');
    expect(JSON.parse(first).github_effect_baseline).toMatchObject({ kind: 'pr', number: 7, head_sha: HEAD_BEFORE });
    expect(JSON.parse(first).github_effect_baseline).not.toHaveProperty('body_sha256');
    expect(writeGithubEffectBaselineToReceipt({
      receiptPath: artifacts.receiptPath, invocationId: ids.invocation,
      target: { repo: 'acme/widgets', kind: 'pr', number: 7, headSha: HEAD_AFTER },
    })).toBe(false);
    expect(readFileSync(artifacts.receiptPath, 'utf8')).toBe(first);
  });

  it('refuses a foreign invocation, a relative path, a missing receipt and a foreign schema without touching the receipt', () => {
    const { ids, artifacts } = baselineFixture('writer-foreign');
    const bytes = readFileSync(artifacts.receiptPath, 'utf8');
    const target = { repo: 'acme/widgets', kind: 'issue' as const, number: 1, bodySha256: ISSUE_BODY_BEFORE };
    expect(writeGithubEffectBaselineToReceipt({ receiptPath: artifacts.receiptPath, invocationId: 'inv-foreign', target })).toBe(false);
    expect(writeGithubEffectBaselineToReceipt({ receiptPath: relative(repoRoot, artifacts.receiptPath), invocationId: ids.invocation, target })).toBe(false);
    expect(writeGithubEffectBaselineToReceipt({ receiptPath: undefined, invocationId: ids.invocation, target })).toBe(false);
    expect(writeGithubEffectBaselineToReceipt({ receiptPath: join(dirname(artifacts.receiptPath), 'no-such.json'), invocationId: ids.invocation, target })).toBe(false);
    expect(readFileSync(artifacts.receiptPath, 'utf8')).toBe(bytes);
    writePrivateJson(artifacts.receiptPath, { ...JSON.parse(bytes), schema: 'other/v1' });
    expect(writeGithubEffectBaselineToReceipt({ receiptPath: artifacts.receiptPath, invocationId: ids.invocation, target })).toBe(false);
    expect(readdirSync(dirname(artifacts.receiptPath)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('sameHandoffIdentity compares immutable launch identity, not the optional baseline or stale bytes', () => {
    const { artifacts } = baselineFixture('identity');
    const receipt = artifacts.receipt as unknown as HandoffReceipt;
    const withBaseline = { ...receipt, github_effect_baseline: issueBaselineFor('identity') } as HandoffReceipt;
    expect(sameHandoffIdentity(receipt, withBaseline)).toBe(true);
    expect(sameHandoffIdentity(receipt, { ...receipt, launcher_pid: 4243 })).toBe(false);
    expect(sameHandoffIdentity(receipt, { ...receipt, owner_dispatch_id: 'dispatch-other' })).toBe(false);
    expect(sameHandoffIdentity(receipt, { ...receipt, invocation_id: 'inv-other' })).toBe(false);
    expect(sameHandoffIdentity(receipt, { ...receipt, launcher_boot_id: undefined } as HandoffReceipt)).toBe(false);
    expect(sameHandoffIdentity(receipt, null)).toBe(false);
    expect(sameHandoffIdentity(undefined, receipt)).toBe(false);
  });
});

describe('Issue #1377 long-running child abandonment proof', () => {
  it('preserves a valid exact-owned receipt on recurring liveness timeout without Stop authority', async () => {
    const root = tempDir('opk-1377-eof-');
    const paths = launchPaths(root, 'receipt-preserve');
    const cdp = 'http://127.0.0.1:9222';
    const profile = join(root, 'profile');
    const invocation = 'invocation-1377-eof';
    const marker = `OPKTURNV1${'34'.repeat(16)}`;
    const conversationUrl = 'https://chatgpt.com/c/33333333-3333-4333-8333-333333333333';
    const receipt = buildBrowserTurnCancellationReceipt({
      invocationId: invocation,
      profileKey: configuredProfileKey(profile, cdp),
      conversationUrl,
      marker,
      sendCount: 1,
    });
    expect(receipt).not.toBeNull();
    const heartbeat = {
      schema: 'observation-heartbeat/v1',
      phase: 'post_send_observation',
      poll_count: 1,
      observation_state: 'busy',
      stable_reads: 0,
      completion_ready: false,
    };
    const fixture = nodeFixture(`
      process.stdout.write(JSON.stringify(${JSON.stringify(heartbeat)}) + '\\n');
      process.stdout.write(JSON.stringify(${JSON.stringify(receipt)}) + '\\n');
      setInterval(() => {}, 1000);
    `);
    const owned = { url: () => conversationUrl, close: vi.fn() };
    const sibling = {
      url: () => 'https://chatgpt.com/c/44444444-4444-4444-8444-444444444444',
      close: vi.fn(),
    };
    const connect = vi.fn(async () => ({}));
    const enumeratePages = vi.fn(async () => [sibling, owned]);
    const readUserMessages = vi.fn(async (page: unknown) => ({
      messages: page === owned
        ? [{ role: 'user' as const, text: `${marker}\n\nprompt` }]
        : [{ role: 'user' as const, text: 'foreign' }],
      incomplete: false,
    }));
    const stop = vi.fn(async () => 'confirmed' as const);
    process.env.OPK_FM_LONG_CHILD_NO_CANDIDATE_GRACE_MS = '200';
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-1377',
      attemptIdentity: 'attempt-1377',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: [
        ...fixture.args,
        '--',
        '--cdp', cdp,
        '--profile', profile,
        '--invocation-id', invocation,
      ],
      cancellationDependencies: {
        connect,
        releaseBrowser: vi.fn(async () => undefined),
        enumeratePages,
        readUserMessages,
        stop,
      },
    });
    expect(code).toBe(1);
    expect(connect).toHaveBeenCalledTimes(0);
    expect(enumeratePages).toHaveBeenCalledTimes(0);
    expect(readUserMessages).toHaveBeenCalledTimes(0);
    expect(stop).toHaveBeenCalledTimes(0);
    expect(owned.close).toHaveBeenCalledTimes(0);
    expect(sibling.close).toHaveBeenCalledTimes(0);
    const envelope = readTerminalEnvelope(paths.envelope);
    expect(envelope).toMatchObject({
      incident: 'child_liveness_timeout',
      delivery: 'POSSIBLY_DELIVERED',
      turn_result_state: 'driver_error',
      turn_result_cause: 'child_liveness_timeout_cancellation_authority_absent',
      send_count: 1,
      recovery_available: false,
    });
    expect(envelope).not.toHaveProperty('conversation_locator');
    expect(envelope?.diagnostics).toMatchObject({
      last_heartbeat: { phase: 'post_send_observation' },
      cancellation: {
        stop_outcome: 'not_attempted_authority_absent',
        identity_proven: false,
        receipt_identity: { invocation_id: invocation, marker },
      },
    });
  });

  it('preserves a bound receipt when the child exits immediately before a turn-result', async () => {
    const cdp = 'http://127.0.0.1:9222';
    const profile = join(tempDir('opk-1377-bound-profile-'), 'profile');
    const invocation = 'invocation-1377-bound';
    const marker = `OPKTURNV1${'56'.repeat(16)}`;
    const conversationUrl = 'https://chatgpt.com/c/55555555-5555-4555-8555-555555555555';
    const receipt = buildBrowserTurnCancellationReceipt({
      invocationId: invocation,
      profileKey: configuredProfileKey(profile, cdp),
      conversationUrl,
      marker,
      sendCount: 1,
    });
    expect(receipt).not.toBeNull();
    const envelope = await launchReceiptScenario({
      id: 'bound-immediate-exit',
      receipt: receipt!,
      cdp,
      profile,
      invocation,
    });
    expect(envelope).toMatchObject({
      incident: 'child_terminal_result_missing',
      delivery: 'POSSIBLY_DELIVERED',
      turn_result_cause: 'child_terminal_result_missing_cancellation_authority_absent',
      send_count: 1,
      recovery_available: false,
      child_exit_code: 0,
    });
    expect(envelope).not.toHaveProperty('conversation_locator');
    expect(envelope?.diagnostics).toMatchObject({
      cancellation: {
        stop_outcome: 'not_attempted_authority_absent',
        receipt_identity: { invocation_id: invocation, marker },
      },
    });
  });

  it('does not treat a receipt with a foreign invocation as delivery evidence', async () => {
    const cdp = 'http://127.0.0.1:9222';
    const profile = join(tempDir('opk-1377-invocation-profile-'), 'profile');
    const receiptInvocation = 'invocation-1377-receipt';
    const childInvocation = 'invocation-1377-foreign';
    const receipt = buildBrowserTurnCancellationReceipt({
      invocationId: receiptInvocation,
      profileKey: configuredProfileKey(profile, cdp),
      conversationUrl: 'https://chatgpt.com/c/66666666-6666-4666-8666-666666666666',
      marker: `OPKTURNV1${'67'.repeat(16)}`,
      sendCount: 1,
    });
    expect(receipt).not.toBeNull();
    const envelope = await launchReceiptScenario({
      id: 'foreign-invocation',
      receipt: receipt!,
      cdp,
      profile,
      invocation: receiptInvocation,
      childInvocation,
    });
    expect(envelope).toMatchObject({
      delivery: 'POSSIBLY_DELIVERED',
      recovery_available: false,
      turn_result_cause: 'child_terminal_result_missing_cancellation_receipt_identity_unproven',
    });
    expect(envelope).not.toHaveProperty('send_count');
    expect(envelope).not.toHaveProperty('conversation_locator');
    expect(envelope?.diagnostics).toMatchObject({
      cancellation: {
        stop_outcome: 'not_attempted_identity_unproven',
        identity_proven: false,
      },
    });
  });

  it('does not treat a receipt with a foreign configured profile as delivery evidence', async () => {
    const cdp = 'http://127.0.0.1:9222';
    const profile = join(tempDir('opk-1377-profile-profile-'), 'profile');
    const foreignProfile = join(tempDir('opk-1377-foreign-profile-'), 'profile');
    const invocation = 'invocation-1377-profile';
    const receipt = buildBrowserTurnCancellationReceipt({
      invocationId: invocation,
      profileKey: configuredProfileKey(profile, cdp),
      conversationUrl: 'https://chatgpt.com/c/77777777-7777-4777-8777-777777777777',
      marker: `OPKTURNV1${'78'.repeat(16)}`,
      sendCount: 1,
    });
    expect(receipt).not.toBeNull();
    const envelope = await launchReceiptScenario({
      id: 'foreign-profile',
      receipt: receipt!,
      cdp,
      profile,
      invocation,
      childProfile: foreignProfile,
    });
    expect(envelope).toMatchObject({
      delivery: 'POSSIBLY_DELIVERED',
      recovery_available: false,
      turn_result_cause: 'child_terminal_result_missing_cancellation_receipt_identity_unproven',
    });
    expect(envelope).not.toHaveProperty('send_count');
    expect(envelope).not.toHaveProperty('conversation_locator');
    expect(envelope?.diagnostics).toMatchObject({
      cancellation: {
        stop_outcome: 'not_attempted_identity_unproven',
        identity_proven: false,
      },
    });
  });
});


describe('Issue #2524: final persisted no-result terminal projection', () => {
  type Phase = 'prepared' | 'dispatching' | 'not_sent' | 'sent_unbound' | 'sent_unharvested' | 'harvested';
  type TargetChange = 'mutated' | 'truncated' | 'unreadable' | 'symlink';

  async function savedTerminal(input: {
    phase?: Phase;
    sendCount?: number;
    reason?: string;
    sendWitness?: 'none' | 'numeric_send_count';
    reply?: string;
    targetChange?: TargetChange;
    heartbeat?: boolean;
    childResult?: TurnResultV1 | ((profileKey: string, invocationId: string) => TurnResultV1);
    cancellationDependencies?: LaunchConfig['cancellationDependencies'];
    conversationLocator?: string;
  }) {
    const root = tempDir('opk-2524-terminal-');
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', join(root, 'state'));
    vi.stubEnv('OPK_BROWSER_TURN_STARTUP_ALLOWANCE_MS', '5000');
    const paths = launchPaths(root, 'observed');
    const profile = join(root, 'profile');
    const cdp = 'http://127.0.0.1:1';
    const invocationId = 'inv-2524-synthetic';
    const profileKey = configuredProfileKey(profile, cdp);
    let primary: { target: string; byte_length: number; sha256: string } | undefined;

    if (input.phase) {
      admitStateLightTurnObservation({
        profileKey, invocationId, marker: 'OPKTURNV1a97e3f70e9c07fa75c0f03840c0528a2',
      });
      const counted = input.sendCount === undefined
        ? {} : { sendCount: input.sendCount, sendWitness: input.sendWitness ?? 'numeric_send_count' as const };
      if (input.phase === 'prepared') {
        if (input.sendCount !== undefined) {
          transitionStateLightTurnObservation({
            profileKey, invocationId, phase: 'prepared', reason: 'fixture_pre_dispatch', ...counted,
          });
        }
      } else if (input.phase === 'not_sent') {
        transitionStateLightTurnObservation({
          profileKey, invocationId, phase: 'not_sent', reason: input.reason ?? 'fixture_pre_dispatch', ...counted,
        });
      } else {
        transitionStateLightTurnObservation({
          profileKey, invocationId, phase: 'dispatching', reason: 'fixture_dispatch',
          ...(input.phase === 'dispatching' ? counted : {}),
        });
        if (input.phase !== 'dispatching') {
          transitionStateLightTurnObservation({
            profileKey, invocationId,
            phase: input.phase === 'sent_unharvested' ? 'sent_unharvested' : 'sent_unbound',
            reason: 'fixture_sent', ...counted,
          });
          if (input.phase === 'harvested') {
            if (input.reply !== undefined) {
              const target = join(root, 'primary.txt');
              const bytes = Buffer.from(input.reply, 'utf8');
              writeFileSync(target, bytes);
              primary = bindPrimaryPublication({ profileKey, invocationId, target, bytes }).primary;
            }
            transitionStateLightTurnObservation({
              profileKey, invocationId, phase: 'harvested', reason: 'fixture_harvested',
            });
          }
        }
      }
    }

    if (primary && input.targetChange) {
      if (input.targetChange === 'mutated') {
        // Same byte count, different digest: digest validation must not be skipped.
        writeFileSync(primary.target, 'synthetic mutate!');
      } else if (input.targetChange === 'truncated') {
        writeFileSync(primary.target, 'synthetic');
      } else if (input.targetChange === 'unreadable') {
        rmSync(primary.target);
      } else {
        const replacement = join(root, 'replacement.txt');
        writeFileSync(replacement, 'different synthetic reply');
        rmSync(primary.target);
        symlinkSync(replacement, primary.target);
      }
    }

    const staleHeartbeat = {
      schema: 'observation-heartbeat/v1',
      phase: 'post_send_observation',
      poll_count: 1,
      observation_state: 'busy',
      stable_reads: 0,
      completion_ready: false,
      last_reply_length: 0,
      last_reply_sha256_head: 'deadbeef00000000',
    };
    const childResult = typeof input.childResult === 'function'
      ? input.childResult(profileKey, invocationId) : input.childResult;
    const output = [
      ...(input.heartbeat ? [JSON.stringify(staleHeartbeat)] : []),
      ...(childResult ? [JSON.stringify(childResult)] : []),
    ].map((line) => line + '\n').join('');
    const fixture = nodeFixture(output
      ? 'process.stdout.write(' + JSON.stringify(output) + ', () => process.exit(0));'
      : 'process.exit(1);');
    const exitCode = await runFixtureLaunch(root, {
      runIdentity: 'run-2524', attemptIdentity: 'attempt-2524',
      handoffReceiptPath: paths.receipt, terminalEnvelopePath: paths.envelope,
      terminalEnvelopeRoot: root, browserOutputPath: paths.output, cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: [...fixture.args, '--', '--profile', profile, '--cdp', cdp, '--invocation-id', invocationId],
      ...(input.conversationLocator ? { conversationLocator: input.conversationLocator } : {}),
      ...(input.cancellationDependencies ? { cancellationDependencies: input.cancellationDependencies } : {}),
    });
    const envelope = readTerminalEnvelope(paths.envelope);
    expect(envelope).not.toBeNull();
    expect(readdirSync(dirname(paths.envelope))
      .filter((name) => name.endsWith(TERMINAL_ENVELOPE_NAME_SUFFIX))).toHaveLength(1);
    return { envelope: envelope!, exitCode, primary };
  }

  it.each([
    ['synthetic reply!!', 17],
    ['😀', 2],
  ])('uses verified final bytes, not an earlier heartbeat: %s', async (reply, jsLength) => {
    const { envelope, exitCode, primary } = await savedTerminal({
      phase: 'harvested', sendCount: 1, reply, heartbeat: true,
    });
    expect(exitCode).toBe(1);
    expect(primary?.byte_length).toBe(Buffer.byteLength(reply, 'utf8'));
    expect(primary?.sha256).toBe(createHash('sha256').update(reply, 'utf8').digest('hex'));
    expect(envelope).toMatchObject({
      schema: TERMINAL_SCHEMA, lifecycle_outcome: 'incident',
      incident: 'child_terminal_result_missing', delivery: 'landed',
      send_count: 1, observed_invocation_id: 'inv-2524-synthetic',
      recovery_available: false,
      diagnostics: {
        persisted_observation: { phase: 'harvested', send_count: 1 },
        last_heartbeat: {
          phase: 'post_send_observation', poll_count: 1, observation_state: 'busy',
          last_reply_length: jsLength,
          last_reply_sha256_head: createHash('sha256').update(reply, 'utf8').digest('hex').slice(0, 16),
        },
      },
    });
    expect(JSON.stringify(envelope)).not.toContain(reply);
  });

  it.each(['mutated', 'truncated', 'unreadable', 'symlink'] as const)(
    'omits both stale advisories when the committed target is %s', async (targetChange) => {
      const { envelope } = await savedTerminal({
        phase: 'harvested', sendCount: 1, reply: 'synthetic reply!!',
        targetChange, heartbeat: true,
      });
      expect(envelope).toMatchObject({
        lifecycle_outcome: 'incident', incident: 'child_terminal_result_missing',
        delivery: 'landed', diagnostics: {
          persisted_observation: { phase: 'harvested' },
          last_heartbeat: { poll_count: 1, observation_state: 'busy' },
        },
      });
      expect(envelope.diagnostics?.last_heartbeat).not.toHaveProperty('last_reply_length');
      expect(envelope.diagnostics?.last_heartbeat).not.toHaveProperty('last_reply_sha256_head');
      expect(JSON.stringify(envelope)).not.toContain('synthetic reply!!');
    },
  );

  it('does not create a heartbeat or liveness fields when no heartbeat was accepted', async () => {
    const { envelope } = await savedTerminal({
      phase: 'harvested', sendCount: 1, reply: 'synthetic reply!!', heartbeat: false,
    });
    expect(envelope).toMatchObject({
      lifecycle_outcome: 'incident', delivery: 'landed',
      diagnostics: { persisted_observation: { phase: 'harvested' } },
    });
    expect(envelope.diagnostics).not.toHaveProperty('last_heartbeat');
    expect(JSON.stringify(envelope)).not.toContain('synthetic reply!!');
  });

  it.each([
    ['dispatching', undefined], ['dispatching', 0], ['dispatching', 1],
    ['sent_unbound', undefined], ['sent_unbound', 0], ['sent_unbound', 1],
    ['sent_unharvested', undefined], ['sent_unharvested', 0], ['sent_unharvested', 1],
    ['harvested', undefined], ['harvested', 0], ['harvested', 1],
  ] as const)('keeps ambiguous %s (count %s) possibly delivered', async (phase, sendCount) => {
    const { envelope } = await savedTerminal({ phase, sendCount });
    expect(envelope).toMatchObject({
      lifecycle_outcome: 'incident', incident: 'child_terminal_result_missing',
      delivery: 'POSSIBLY_DELIVERED',
      diagnostics: { persisted_observation: { phase } },
    });
    if (sendCount === undefined) expect(envelope).not.toHaveProperty('send_count');
    else expect(envelope?.send_count).toBe(sendCount);
  });

  it.each([undefined, 0] as const)(
    'keeps legacy not_sent/send_delivery_unproven (count %s) possibly delivered', async (sendCount) => {
      const { envelope } = await savedTerminal({
        phase: 'not_sent', reason: 'send_delivery_unproven', sendCount,
      });
      expect(envelope?.delivery).toBe('POSSIBLY_DELIVERED');
      expect(envelope?.lifecycle_outcome).toBe('incident');
    },
  );

  it.each([
    ['prepared', undefined, undefined],
    ['prepared', 0, undefined],
    ['not_sent', 0, 'terminal_pre_send'],
  ] as const)('recognizes proven pre-dispatch %s (count %s) as not-sent', async (phase, sendCount, reason) => {
    const { envelope } = await savedTerminal({ phase, sendCount, reason });
    expect(envelope).toMatchObject({ lifecycle_outcome: 'incident', delivery: 'not-sent' });
  });

  it('does not treat an arbitrary legacy not_sent reason as evidence of no dispatch', async () => {
    const { envelope } = await savedTerminal({
      phase: 'not_sent', reason: 'fixture_pre_dispatch', sendCount: 0,
    });
    expect(envelope).toMatchObject({
      lifecycle_outcome: 'incident', delivery: 'POSSIBLY_DELIVERED',
    });
  });

  it('allows harvested committed primary with an absent send count to establish delivery', async () => {
    const { envelope } = await savedTerminal({ phase: 'harvested', reply: 'synthetic reply!!' });
    expect(envelope).toMatchObject({
      lifecycle_outcome: 'incident', delivery: 'landed',
      diagnostics: { persisted_observation: { phase: 'harvested' } },
    });
    expect(envelope).not.toHaveProperty('send_count');
  });

  it('retains the conservative fallback with no readable matching observation', async () => {
    const { envelope } = await savedTerminal({});
    expect(envelope).toMatchObject({
      lifecycle_outcome: 'incident', delivery: 'POSSIBLY_DELIVERED',
      recovery_available: false,
    });
    expect(envelope.diagnostics).not.toHaveProperty('persisted_observation');
  });

  it('keeps actual child results authoritative over an unrelated harvested no-result projection', async () => {
    const result = makeTurnResult({ invocation_id: 'inv-2524-synthetic' });
    const success = await savedTerminal({
      phase: 'harvested', sendCount: 1, reply: 'synthetic reply!!', childResult: result,
    });
    expect(success.exitCode).toBe(0);
    expect(success.envelope).toMatchObject({
      lifecycle_outcome: 'success', delivery: deriveDelivery({ ...result, resolved_send_count: 1 }, false),
      turn_result_state: 'ok',
    });
    expect(success.envelope).not.toHaveProperty('incident');
    const incidentResult = makeTurnResult({
      state: 'output_conflict', scope: 'invocation', cause: 'synthetic_conflict',
      witness: undefined,
      observation_uncertainty_diagnostics: {
        cause: 'synthetic_conflict', send_count: 0, owned_prompt_seen: false,
      },
    });
    const incident = await savedTerminal({
      phase: 'harvested', sendCount: 1, reply: 'synthetic reply!!', childResult: incidentResult,
    });
    expect(incident.exitCode).toBe(1);
    expect(incident.envelope).toMatchObject({
      lifecycle_outcome: 'incident', delivery: 'not-sent',
      incident: 'child_turn_state:output_conflict', turn_result_state: 'output_conflict',
    });
  });


  function matchingSuccess(
    profileKey: string, invocationId: string, overrides: Partial<TurnResultV1> = {},
  ): TurnResultV1 {
    return makeTurnResult({
      invocation_id: invocationId,
      configured_profile_key: profileKey,
      witness: undefined,
      observation_uncertainty_diagnostics: {
        cause: 'ok', send_count: 1, owned_prompt_seen: false,
      },
      ...overrides,
    });
  }

  it.each([true, false])('promotes an identity-matched success to final harvested delivery (heartbeat %s)', async (heartbeat) => {
    const reply = 'synthetic reply!!'; // 17 ASCII bytes and JS string units
    const { envelope, exitCode } = await savedTerminal({
      phase: 'harvested', sendCount: 1, reply, heartbeat, childResult: matchingSuccess,
    });
    expect(exitCode).toBe(0);
    expect(envelope).toMatchObject({
      lifecycle_outcome: 'success', delivery: 'landed',
      turn_result_state: 'ok', turn_result_cause: 'ok',
      send_count: 1, observed_invocation_id: 'inv-2524-synthetic',
      conversation_locator: 'conv-uuid', recovery_available: true,
      diagnostics: { last_reply_length: 17 },
    });
    expect(envelope).not.toHaveProperty('incident');
    expect(envelope.diagnostics).not.toHaveProperty('persisted_observation');
    expect(envelope.diagnostics).not.toHaveProperty('last_heartbeat');
    if (heartbeat) {
      expect(envelope.diagnostics).toMatchObject({
        phase: 'post_send_observation', poll_count: 1, observation_state: 'busy',
        last_reply_sha256_head: createHash('sha256').update(reply, 'utf8').digest('hex').slice(0, 16),
      });
    } else {
      expect(envelope.diagnostics).toEqual({ last_reply_length: 17 });
    }
    expect(JSON.stringify(envelope)).not.toContain(reply);
  });

  it('uses JS string units for a verified harvested emoji success', async () => {
    const { envelope, primary } = await savedTerminal({
      phase: 'harvested', sendCount: 1, reply: '😀', heartbeat: false,
      childResult: matchingSuccess,
    });
    expect(primary?.byte_length).toBe(4);
    expect(envelope).toMatchObject({
      lifecycle_outcome: 'success', delivery: 'landed', diagnostics: { last_reply_length: 2 },
    });
    expect(envelope.diagnostics).not.toHaveProperty('last_heartbeat');
  });

  it.each(['invocation', 'profile'] as const)(
    'refuses to borrow a harvested primary across a parsed %s mismatch', async (mismatch) => {
      const { envelope } = await savedTerminal({
        phase: 'harvested', sendCount: 1, reply: 'synthetic reply!!', heartbeat: true,
        childResult: (profileKey, invocationId) => matchingSuccess(profileKey, invocationId, {
          ...(mismatch === 'invocation' ? { invocation_id: 'foreign-invocation' } : {}),
          ...(mismatch === 'profile' ? { configured_profile_key: 'foreign-profile' } : {}),
        }),
      });
      expect(envelope).toMatchObject({
        lifecycle_outcome: 'success', turn_result_state: 'ok',
        delivery: 'POSSIBLY_DELIVERED', send_count: 1,
        observed_invocation_id: mismatch === 'invocation' ? 'foreign-invocation' : 'inv-2524-synthetic',
        conversation_locator: 'conv-uuid', recovery_available: true,
        diagnostics: { last_reply_length: 0, last_reply_sha256_head: 'deadbeef00000000' },
      });
      expect(envelope.diagnostics).not.toHaveProperty('persisted_observation');
    },
  );

  it.each(['mutated', 'truncated', 'unreadable', 'symlink'] as const)(
    'keeps landed success but discards stale final reply advisories for %s target', async (targetChange) => {
      const { envelope } = await savedTerminal({
        phase: 'harvested', sendCount: 1, reply: 'synthetic reply!!',
        heartbeat: true, targetChange, childResult: matchingSuccess,
      });
      expect(envelope).toMatchObject({
        lifecycle_outcome: 'success', delivery: 'landed', send_count: 1,
        diagnostics: { phase: 'post_send_observation', poll_count: 1, observation_state: 'busy' },
      });
      expect(envelope.diagnostics).not.toHaveProperty('last_reply_length');
      expect(envelope.diagnostics).not.toHaveProperty('last_reply_sha256_head');
      expect(JSON.stringify(envelope)).not.toContain('synthetic reply!!');
    },
  );

  it.each(['prepared', 'not_sent'] as const)(
    'does not demote a result-owned possible send against %s zero observation', async (phase) => {
      const { envelope } = await savedTerminal({
        phase, sendCount: 0,
        childResult: (profileKey, invocationId) => matchingSuccess(profileKey, invocationId),
      });
      expect(envelope).toMatchObject({
        lifecycle_outcome: 'success', delivery: 'POSSIBLY_DELIVERED',
        send_count: 1, observed_invocation_id: 'inv-2524-synthetic',
      });
    },
  );

  it('classifies only matching durable and terminal affirmative attempted no-dispatch as not-sent', async () => {
    const cause = 'affirmative_pre_actionability_no_dispatch';
    const attempted = (profileKey: string, invocationId: string): TurnResultV1 =>
      matchingSuccess(profileKey, invocationId, {
        state: 'send_failed', scope: 'invocation', cause,
        send_attempted: true, conversation_id: undefined, witness: undefined,
        observation_uncertainty_diagnostics: {
          cause, send_count: 0, owned_prompt_seen: false,
        },
      });
    const affirmative = await savedTerminal({
      phase: 'not_sent', reason: cause, sendCount: 0,
      sendWitness: 'none', childResult: attempted,
    });
    expect(affirmative.envelope).toMatchObject({
      lifecycle_outcome: 'incident', delivery: 'not-sent', send_count: 0,
      turn_result_state: 'send_failed', turn_result_cause: cause,
    });
    for (const variant of [
      { phase: 'not_sent' as const, reason: 'send_delivery_unproven', sendCount: 0, sendWitness: 'none' as const },
      { phase: 'not_sent' as const, reason: cause, sendCount: 0, sendWitness: 'numeric_send_count' as const },
      { phase: 'dispatching' as const, reason: cause, sendCount: 0, sendWitness: 'none' as const },
    ]) {
      const observed = await savedTerminal({ ...variant, childResult: attempted });
      expect(observed.envelope.delivery).toBe('POSSIBLY_DELIVERED');
    }
    const noObservation = await savedTerminal({ childResult: attempted });
    expect(noObservation.envelope.delivery).toBe('POSSIBLY_DELIVERED');
  });

  it('preserves an attempted zero-count result against a prepared zero observation', async () => {
    const { envelope } = await savedTerminal({
      phase: 'prepared', sendCount: 0,
      childResult: (profileKey, invocationId) => matchingSuccess(profileKey, invocationId, {
        send_attempted: true,
        observation_uncertainty_diagnostics: { cause: 'ok', send_count: 0, owned_prompt_seen: false },
      }),
    });
    expect(envelope).toMatchObject({
      lifecycle_outcome: 'success', delivery: 'POSSIBLY_DELIVERED', send_count: 0,
    });
  });

  it.each([0, 1] as const)('keeps parsed count %s even if harvested record contradicts it', async (parsedCount) => {
    const { envelope } = await savedTerminal({
      phase: 'harvested', sendCount: parsedCount === 0 ? 1 : 0, reply: 'synthetic reply!!',
      childResult: (profileKey, invocationId) => matchingSuccess(profileKey, invocationId, {
        send_attempted: true,
        observation_uncertainty_diagnostics: { cause: 'ok', send_count: parsedCount, owned_prompt_seen: false },
      }),
    });
    expect(envelope).toMatchObject({
      lifecycle_outcome: 'success', delivery: 'landed', send_count: parsedCount,
      diagnostics: { last_reply_length: 17 },
    });
  });

  it('preserves independent reply_to landing against weaker prepared evidence', async () => {
    const { envelope } = await savedTerminal({
      phase: 'prepared', sendCount: 0,
      childResult: (profileKey, invocationId) => matchingSuccess(profileKey, invocationId, {
        witness: { user_message_id: 'u1', assistant_message_id: 'a1', relation: 'reply_to', source: 'service' },
        observation_uncertainty_diagnostics: { cause: 'ok', send_count: 1, owned_prompt_seen: true },
      }),
    });
    expect(envelope).toMatchObject({
      lifecycle_outcome: 'success', delivery: 'landed', send_count: 1,
      conversation_locator: 'conv-uuid', recovery_available: true,
    });
  });

  it.each([
    ['dispatching', undefined, undefined], ['dispatching', 0, undefined],
    ['sent_unbound', 0, undefined], ['sent_unharvested', undefined, undefined],
    ['not_sent', 0, 'send_delivery_unproven'], ['harvested', 0, undefined],
  ] as const)('keeps correlated ambiguous %s/count %s possible on parsed zero', async (phase, sendCount, reason) => {
    const { envelope } = await savedTerminal({
      phase, sendCount, reason,
      childResult: (profileKey, invocationId) => matchingSuccess(profileKey, invocationId, {
        observation_uncertainty_diagnostics: { cause: 'ok', send_count: 0, owned_prompt_seen: false },
      }),
    });
    expect(envelope).toMatchObject({
      lifecycle_outcome: 'success', delivery: 'POSSIBLY_DELIVERED', send_count: 0,
    });
  });

  it('keeps result delivery/count/locator with no matching readable observation', async () => {
    const { envelope } = await savedTerminal({
      heartbeat: true, childResult: matchingSuccess,
    });
    expect(envelope).toMatchObject({
      lifecycle_outcome: 'success', delivery: 'POSSIBLY_DELIVERED', send_count: 1,
      conversation_locator: 'conv-uuid', recovery_available: true,
      diagnostics: { last_reply_length: 0 },
    });
    expect(envelope.diagnostics).not.toHaveProperty('persisted_observation');
  });

  it('keeps the result/config locator without invoking optional CDP recovery on success', async () => {
    const connect = vi.fn(async (_cdp: string) => { throw new Error('success must not connect to CDP'); });
    const { envelope } = await savedTerminal({
      phase: 'harvested', sendCount: 1, reply: 'synthetic reply!!',
      childResult: matchingSuccess,
      cancellationDependencies: { connect },
      conversationLocator: 'https://chatgpt.com/c/synthetic-config',
    });
    expect(envelope).toMatchObject({
      lifecycle_outcome: 'success', delivery: 'landed',
      conversation_locator: 'https://chatgpt.com/c/synthetic-config', recovery_available: true,
      diagnostics: { last_reply_length: 17 },
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it('remains compatible with both existing pack-review consumer predicates', async () => {
    const { terminalHasPossibleDelivery, authoritativePreSend } =
      await import('./pack-review-no-review-reconcile.ts');
    const landed = await savedTerminal({
      phase: 'harvested', sendCount: 1, reply: 'synthetic reply!!',
    });
    const possible = await savedTerminal({ phase: 'sent_unharvested', sendCount: 0 });
    for (const terminal of [landed.envelope, possible.envelope]) {
      const snapshot = terminal as unknown as Record<string, unknown>;
      expect(terminalHasPossibleDelivery(snapshot)).toBe(true);
      const slot = { lifecycle: 'terminal', terminalResult: snapshot } as
        Parameters<typeof authoritativePreSend>[0];
      expect(authoritativePreSend(slot)).toBe(false);
    }
  });
});
describe('Issue #2718 PR-author --repo/--pr adapter admission', () => {
  const openHead = {
    state: 'open', sha: 'e'.repeat(40), headRepo: 'acme/widgets', headRef: 'feature', baseRepo: 'acme/widgets',
  };

  function adapterCase(extra: string[], options: { cwd?: boolean } = {}) {
    const root = tempDir('opk-2718-adapter-');
    const paths = launchPaths(root, 'bound');
    for (const [key, value] of Object.entries(cliFixtureEnv(root))) vi.stubEnv(key, value);
    vi.stubEnv('CHATGPT_BROWSER_TURN_STATE_DIR', join(root, 'state'));
    const args = [
      '--run-identity', 'run-2718', '--attempt-identity', 'attempt-2718', '--invocation-id', 'inv-2718-' + randomSuffix(),
      '--owner-task-id', 'owner-2718', '--owner-dispatch-id', 'dispatch-2718',
      '--handoff-receipt', paths.receipt, '--terminal-envelope', paths.envelope, '--output', paths.output,
      '--profile', join(root, 'profile'), '--cdp', 'http://127.0.0.1:9222', '--input', join(root, 'prompt.txt'),
      ...(options.cwd === false ? [] : ['--cwd', root]), ...extra,
    ];
    const launched: (readonly string[])[] = [];
    // Capture the forwarded argv only; never start a launcher.
    const spawnLauncher = vi.fn(async (launcherArgs: readonly string[]) => {
      launched.push(launcherArgs);
      throw new Error('fixture_no_spawn');
    });
    return { root, args, launched, spawnLauncher };
  }

  let suffix = 0;
  function randomSuffix(): string { suffix += 1; return String(suffix); }

  async function run(args: string[], deps: Parameters<typeof runBrowserAdapter>[1]) {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await runBrowserAdapter(args, deps);
      return { code, stderr: stderr.mock.calls.map((call) => String(call[0])).join('') };
    } finally {
      stderr.mockRestore();
    }
  }

  const boundDeps = (spawnLauncher: any, overrides: Record<string, unknown> = {}) => ({
    spawnLauncher,
    selectedRepository: () => 'acme/widgets',
    readPrAuthorHead: async () => openHead,
    readWorktreeBranch: async () => 'feature',
    processReader: { cmdline: () => undefined, startTimeMs: () => undefined },
    ...overrides,
  });

  afterEach(() => { vi.unstubAllEnvs(); });
  it.each([
    ['--owner-task-id', 'owner_task_id_required'],
    ['--owner-dispatch-id', 'owner_dispatch_id_required'],
  ] as const)('requires managed owner input %s before launcher spawn', async (missingFlag, reason) => {
    const fixture = adapterCase([]);
    const args = [...fixture.args];
    const index = args.indexOf(missingFlag);
    args.splice(index, 2);
    const result = await run(args, boundDeps(fixture.spawnLauncher));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(reason);
    expect(result.stderr).toContain('nextStep:');
    expect(fixture.spawnLauncher).not.toHaveBeenCalled();
  });


  it('leaves the unbound route unchanged: no PR admission and no pair forwarded', async () => {
    const fixture = adapterCase([]);
    const readPrAuthorHead = vi.fn(async () => openHead);
    const result = await run(fixture.args, { spawnLauncher: fixture.spawnLauncher, readPrAuthorHead });
    expect(result.stderr).toContain('launcher_start_failed');
    expect(readPrAuthorHead).not.toHaveBeenCalled();
    expect(fixture.launched[0]).not.toContain('--repo');
    expect(fixture.launched[0]).not.toContain('--pr');
  });

  it.each([
    [['--repo', 'acme/widgets']],
    [['--pr', '7']],
  ])('refuses a partial pair %j with an actionable nextStep and no launch', async (extra) => {
    const fixture = adapterCase(extra);
    const result = await run(fixture.args, boundDeps(fixture.spawnLauncher));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('pr_author_binding_pair_partial; nextStep:');
    expect(fixture.spawnLauncher).not.toHaveBeenCalled();
  });

  it('forwards the exact bound pair on the turn argv for an OPEN PR whose head ref is the --cwd branch', async () => {
    const fixture = adapterCase(['--repo', 'Acme/Widgets', '--pr', '7']);
    const result = await run(fixture.args, boundDeps(fixture.spawnLauncher));
    expect(result.stderr).toContain('launcher_start_failed');
    const argv = fixture.launched[0]!;
    const turn = argv.indexOf('turn');
    expect(turn).toBeGreaterThan(argv.indexOf('--child-command'));
    expect(argv.slice(turn)).toEqual(expect.arrayContaining(['--repo', 'acme/widgets', '--pr', '7']));
    expect(argv[argv.indexOf('--cwd') + 1]).toBe(fixture.root);
  });

  it.each([
    ['explicit --cwd', { cwd: false }, {}, 'pr_author_cwd_required'],
    ['card repository', {}, { selectedRepository: () => 'other/repo' }, 'pr_author_repository_not_selected_card'],
    ['unreadable PR', {}, { readPrAuthorHead: async () => undefined }, 'pr_author_pr_unreadable'],
    ['closed PR', {}, { readPrAuthorHead: async () => ({ ...openHead, state: 'closed' }) }, 'pr_author_pr_not_open'],
    ['fork head', {}, { readPrAuthorHead: async () => ({ ...openHead, headRepo: 'fork/widgets' }) }, 'pr_author_head_repository_mismatch'],
    ['other branch', {}, { readWorktreeBranch: async () => 'main' }, 'pr_author_head_ref_mismatch'],
  ] as const)('refuses a bound author without %s before launch', async (_label, caseOptions, overrides, reason) => {
    const fixture = adapterCase(['--repo', 'acme/widgets', '--pr', '7'], caseOptions);
    const result = await run(fixture.args, boundDeps(fixture.spawnLauncher, overrides));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(reason);
    expect(fixture.spawnLauncher).not.toHaveBeenCalled();
  });

  it('refuses a live same-PR launcher at the zero-tab prelaunch scan, naming it', async () => {
    const fixture = adapterCase(['--repo', 'acme/widgets', '--pr', '7']);
    const terminalRoot = fixture.root;
    const live = 'inv-2718-live';
    const receipt = join(terminalRoot, 'live-receipt.json');
    const startedAt = Date.now();
    writeFileSync(receipt, JSON.stringify({
      schema: HANDOFF_SCHEMA, run_identity: 'run-live', attempt_identity: 'attempt-live',
      launcher_started_at: new Date(startedAt).toISOString(), handoff_committed_at: new Date(startedAt).toISOString(),
      completion_mode: COMPLETION_MODE, invocation_id: live, launcher_pid: 4242,
    }));
    mkdirSync(dirname(invocationReceiptLocatorPath(live)), { recursive: true, mode: 0o700 });
    writeFileSync(invocationReceiptLocatorPath(live), JSON.stringify({
      schema: 'flow-manager-long-running-child-locator/v1', invocation_id: live,
      run_identity: 'run-live', attempt_identity: 'attempt-live',
      handoff_receipt_path: receipt, terminal_envelope_path: join(terminalRoot, 'live-terminal.json'),
    }));
    const entry = join(repoRoot, 'scripts/chatgpt-browser-turn/state-light-entry.ts');
    const processReader = {
      cmdline: (pid: number) => pid === 4242 ? ['node', '--experimental-strip-types', launcherPath, 'launch',
        '--invocation-id', live, '--child-command', 'node', '--', '--experimental-strip-types', entry, 'turn',
        '--invocation-id', live, '--repo', 'acme/widgets', '--pr', '7'] : undefined,
      startTimeMs: (pid: number) => pid === 4242 ? startedAt - 100 : undefined,
    };
    const result = await run(fixture.args, boundDeps(fixture.spawnLauncher, { processReader }));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('pr_author_occupied: conversation_busy by invocation ' + live);
    expect(result.stderr).toContain('retry only after that turn ends');
    expect(fixture.spawnLauncher).not.toHaveBeenCalled();
  });

  it('keeps the generic line-72 runbook command byte-for-byte and adds one labelled PR-author variant', () => {
    const runbook = readFileSync(join(repoRoot, 'docs/browser-gpt-turn-runbook.md'), 'utf8').split('\n');
    expect(runbook[71]).toBe('npm run --silent flow-manager-browser-gpt-long-run --   --run-identity <run>   --attempt-identity <attempt>   --owner-task-id <approved-task>   --owner-dispatch-id <approved-dispatch>   --handoff-receipt <path>   --invocation-id <id>   --terminal-envelope <path-ending-in-terminal.json>   --output <path>   --profile <profile>   --cdp <url>   --input <prompt-file>   --cwd <worktree>   [--bound-issue <owner/repo>#<number>]   [--project-url <url> --new-chat | --chat-url <url>]');
    const bound = runbook.filter((line) => line.includes('flow-manager-browser-gpt-long-run --') && line.includes('--repo <owner/repo> --pr <number>'));
    expect(bound).toHaveLength(1);
    expect(bound[0]).toContain('--cwd <worktree>');
    expect(runbook.some((line) => line.startsWith('PR-author-only variant'))).toBe(true);
  });
});
