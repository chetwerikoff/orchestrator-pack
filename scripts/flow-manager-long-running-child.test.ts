import { createHash } from 'node:crypto';
import { runProcess } from './kernel/subprocess.ts';
import {
  chmodSync,
  existsSync,
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPLETION_MODE,
  HANDOFF_SCHEMA,
  TERMINAL_ENVELOPE_NAME_SUFFIX,
  TERMINAL_ENVELOPE_ROOT,
  TERMINAL_SCHEMA,
  deriveDelivery,
  isWakeableTerminalEnvelopePath,
  invocationReceiptLocatorPath,
  pathsAlias,
  readInvocationReceiptLocator,
  readHandoffReceipt,
  readTerminalEnvelope,
  runLaunch,
  runWait,
  type LaunchConfig,
  type ParsedTurnResult,
} from './flow-manager-long-running-child.ts';
import {
  ADAPTER_PACKAGE_COMMAND,
  LAUNCHER_PACKAGE_COMMAND,
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
  transitionStateLightTurnObservation,
} from './chatgpt-browser-turn/state-light-turn-observation.ts';

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
      setTimeout(() => process.kill(process.ppid, 'SIGTERM'), 200);
      setTimeout(() => { process.stdout.write(JSON.stringify(${JSON.stringify(result)}) + '\\n'); process.exit(0); }, 260);
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

describe('flow-manager long-running child (#1164)', () => {
  it('projects only bounded holder and stale-clear diagnostics through the persisted terminal (#2487)', async () => {
    for (const [label, extras, expected] of [
      ['stable', {
        send_slot_holder_invocation_id: 'holder-2487',
        send_slot_holder_phase: 'prepared',
        stale_composer_cleared: true,
      }, {
        send_slot_holder_invocation_id: 'holder-2487',
        send_slot_holder_phase: 'prepared',
        stale_composer_cleared: true,
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
    expect(refusal).toContain('/tmp/opencode/issue-2376-envelope-terminal.json');
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
    ], { spawnLauncher });
    const refusal = stderr.mock.calls.map((call) => String(call[0])).join('');
    stderr.mockRestore();
    expect(code).toBe(2);
    expect(refusal).toContain('terminal_envelope_name_not_wakeable');
    expect(refusal).toContain('--terminal-envelope /tmp/opencode/envelope-terminal.json');
    expect(spawnLauncher).not.toHaveBeenCalled();
  });

  it('wakeable envelope rule matches fleet-wake discovery names (#2378)', () => {
    expect(isWakeableTerminalEnvelopePath('/tmp/opencode/issue-2376-inv-terminal.json')).toBe(true);
    expect(isWakeableTerminalEnvelopePath('/tmp/opencode/issue-2376-envelope.json')).toBe(false);
    expect(isWakeableTerminalEnvelopePath('/tmp/opencode/terminal-envelope.json')).toBe(false);
  });
  it('rejects wakeable envelope names outside fleet-wake discovery root and suggests the scanned location', async () => {
    const root = tempDir('outside-root-');
    const paths = launchPaths(root, 'outside-root');
    const envelope = join(root, 'outside-root', 'issue-terminal.json');
    const fixture = nodeFixture('process.exit(0)');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runLaunch({
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
    expect(isWakeableTerminalEnvelopePath(envelope)).toBe(false);
    expect(refusal).toContain('terminal_envelope_name_not_wakeable');
    expect(refusal).toContain('/tmp/opencode/issue-terminal.json');
    expect(existsSync(paths.receipt)).toBe(false);
    expect(existsSync(envelope)).toBe(false);
  });

  it.each([
    ['unoverridden', 'none'],
    ['root-only', 'root'],
    ['gate-only', 'gate'],
  ] as const)('real native CLI refuses a suffix-valid off-root terminal without the gate pair: %s', async (id, mode) => {
    const root = tempDir('opk-2440-ungated-');
    const paths = launchPaths(root, id);
    const marker = join(root, 'should-not-start.txt');
    const fixture = markedChildFixture(marker, makeTurnResult());
    const env: Record<string, string> = mode === 'root' ? { [CLI_FIXTURE_ROOT_ENV]: root }
      : mode === 'gate' ? { [CLI_FIXTURE_GATE_ENV]: 'fixture-root-v1' } : {};
    const outcome = await runLauncherCli(cliLaunchArgs(paths, fixture), env);
    expect(isWakeableTerminalEnvelopePath(paths.envelope, root)).toBe(true);
    expect(outcome.code).toBe(2);
    expect(outcome.stderr).toContain('terminal_envelope_name_not_wakeable');
    expectNoLauncherEffects(paths, marker);
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
      expect(readFileSync(paths.output, 'utf8').trimEnd().split('\n')).toHaveLength(1);
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

  it('does not admit a first heartbeat that arrives after the startup deadline', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'late-startup-heartbeat');
    const heartbeat = {
      schema: 'observation-heartbeat/v1',
      phase: 'admitted_pre_send',
      poll_count: 0,
      observation_state: 'admitted',
      stable_reads: 0,
      completion_ready: false,
    };
    const fixture = nodeFixture(`
      setTimeout(() => {
        process.stdout.write(JSON.stringify(${JSON.stringify(heartbeat)}) + '\\n');
      }, 35);
      setInterval(() => {}, 1000);
    `);
    process.env.OPK_BROWSER_TURN_STARTUP_ALLOWANCE_MS = '20';
    process.env.OPK_BROWSER_TURN_MAX_HEALTHY_HEARTBEAT_GAP_MS = '10';
    process.env.OPK_BROWSER_TURN_LIVE_CHILD_IDLE_WINDOW_MS = '30';

    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-late-startup-heartbeat',
      attemptIdentity: 'attempt-late-startup-heartbeat',
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
    expect(envelope?.diagnostics ?? {}).not.toHaveProperty('last_heartbeat');
  });

  it('does not refresh an expired recurring deadline from a late heartbeat', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'late-recurring-heartbeat');
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
      }, 45);
      setInterval(() => {}, 1000);
    `);
    process.env.OPK_BROWSER_TURN_MAX_HEALTHY_HEARTBEAT_GAP_MS = '10';
    process.env.OPK_BROWSER_TURN_LIVE_CHILD_IDLE_WINDOW_MS = '30';

    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-late-recurring-heartbeat',
      attemptIdentity: 'attempt-late-recurring-heartbeat',
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
      last_heartbeat: { poll_count: 1 },
    });
  });

  it('does not accept a terminal result that arrives after the recurring deadline', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'late-recurring-result');
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
      process.stdout.write(JSON.stringify(${JSON.stringify(heartbeat)}) + '\\n');
      setTimeout(() => {
        process.stdout.write(JSON.stringify(${JSON.stringify(result)}) + '\\n');
      }, 45);
      setInterval(() => {}, 1000);
    `);
    process.env.OPK_BROWSER_TURN_MAX_HEALTHY_HEARTBEAT_GAP_MS = '10';
    process.env.OPK_BROWSER_TURN_LIVE_CHILD_IDLE_WINDOW_MS = '30';

    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-late-recurring-result',
      attemptIdentity: 'attempt-late-recurring-result',
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
      incident: 'child_liveness_timeout',
      child_exit_code: null,
    });
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

  it('publishes a timeout envelope when ongoing heartbeats never produce a completion signal', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'hard-timeout');
    const heartbeat = {
      schema: 'observation-heartbeat/v1',
      phase: 'post_send_observation',
      poll_count: 1,
      observation_state: 'busy',
      stable_reads: 0,
      completion_ready: false,
    };
    const fixture = nodeFixture(`
      let pollCount = 0;
      setInterval(() => process.stdout.write(JSON.stringify({ ...${JSON.stringify(heartbeat)}, poll_count: ++pollCount }) + '\\n'), 10);
    `);
    process.env.OPK_BROWSER_TURN_STARTUP_ALLOWANCE_MS = '100';
    process.env.OPK_BROWSER_TURN_MAX_HEALTHY_HEARTBEAT_GAP_MS = '50';
    process.env.OPK_BROWSER_TURN_LIVE_CHILD_IDLE_WINDOW_MS = '100';
    process.env.OPK_FM_LONG_CHILD_HARD_DEADLINE_MS = '160';
    const startedAt = Date.now();
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-hard-timeout',
      attemptIdentity: 'attempt-hard-timeout',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(code).toBe(1);
    expect(readTerminalEnvelope(paths.envelope)).toMatchObject({
      lifecycle_outcome: 'incident',
      incident: 'child_liveness_timeout',
      child_exit_code: null,
      delivery: 'POSSIBLY_DELIVERED',
    });
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
    const paths = launchPaths(root, 'heartbeat-idle-timeout');
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
      setTimeout(() => {}, 1000);
    `);
    process.env.OPK_FM_LONG_CHILD_NO_CANDIDATE_GRACE_MS = '100';
    process.env.OPK_FM_LONG_CHILD_CANDIDATE_GRACE_MS = '100';
    const startedAt = Date.now();
    const code = await runFixtureLaunch(root, {
      runIdentity: 'run-heartbeat-idle',
      attemptIdentity: 'attempt-heartbeat-idle',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    const elapsedMs = Date.now() - startedAt;
    expect(code).toBe(1);
    expect(elapsedMs).toBeGreaterThanOrEqual(120);
    const envelope = readTerminalEnvelope(paths.envelope);
    expect(envelope?.incident).toBe('child_liveness_timeout');
    expect(envelope?.child_exit_code).toBeNull();
    expect(envelope?.diagnostics).toHaveProperty('last_heartbeat');
    expect(envelope).toMatchObject({
      delivery: 'POSSIBLY_DELIVERED',
      send_count: 1,
    });
    expect(JSON.stringify(envelope)).not.toContain('child_stdout_eof_timeout');
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

  it('derives three-state delivery semantics', () => {
    expect(deriveDelivery(makeParsedTurnResult({ state: 'output_conflict', observation_uncertainty_diagnostics: { cause: 'output_conflict:exists', send_count: 0, owned_prompt_seen: false }, resolved_send_count: 0 }), false)).toBe('not-sent');
    expect(deriveDelivery(makeParsedTurnResult({ observation_uncertainty_diagnostics: { cause: 'sent', send_count: 1, owned_prompt_seen: false }, witness: undefined }), false)).toBe('POSSIBLY_DELIVERED');
    expect(deriveDelivery(makeParsedTurnResult(), false)).toBe('landed');
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
      expect(args).not.toContain('--owner-dispatch-id');
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
      '--invocation-id', invocationId, '--owner-task-id', 'owner-42',
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
    expect(ack).not.toHaveProperty('owner_dispatch_id');
    expect(receipt.launching_terminal_handle).toBe('synthetic-terminal-handle');
    expect(receipt).not.toHaveProperty('launching_terminal_incarnation');
    if (synchronous) {
      expect(readTerminalEnvelope(paths.envelope)?.lifecycle_outcome)
        .toBe(childFails ? 'incident' : 'success');
      expect(readTerminalEnvelope(paths.envelope)?.child_exit_code)
        .toBe(childFails ? 7 : 0);
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
        for (let tick = 0; tick < 100 && !existsSync(paths.envelope); tick += 1) {
          await new Promise((done) => setTimeout(done, 30));
        }
        expect(readTerminalEnvelope(paths.envelope)?.lifecycle_outcome).toBe('success');
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
        expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain(
          'occupied_handoff_or_invocation_use_fresh_id',
        );
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
