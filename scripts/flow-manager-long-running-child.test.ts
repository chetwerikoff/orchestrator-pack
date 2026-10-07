import { createHash } from 'node:crypto';
import { runProcess } from './kernel/subprocess.ts';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
  pathsAlias,
  readHandoffReceipt,
  readTerminalEnvelope,
  runLaunch,
  runWait,
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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const launcherPath = join(repoRoot, 'scripts/flow-manager-long-running-child.ts');
const adapterPath = join(repoRoot, 'scripts/flow-manager-browser-gpt-long-run.ts');
const skillPath = join(repoRoot, '.cursor/skills/create-issue-draft/SKILL.md');
const rulePath = join(repoRoot, '.cursor/rules/flow-manager-browser-turn-monitoring.mdc');
const runbookPath = join(repoRoot, 'docs/flow-manager-long-running-child-runbook.md');
const browserReadmePath = join(repoRoot, 'scripts/chatgpt-browser-turn/README.md');
const livenessContractUrl = pathToFileURL(join(repoRoot, 'scripts/chatgpt-browser-turn/liveness-contract.ts')).href;
const packageJsonPath = join(repoRoot, 'package.json');

const cleanupDirs: string[] = [];

beforeEach(() => {
  process.env.OPK_BROWSER_TURN_STARTUP_ALLOWANCE_MS = '500';
  process.env.OPK_BROWSER_TURN_MAX_HEALTHY_HEARTBEAT_GAP_MS = '50';
  process.env.OPK_BROWSER_TURN_LIVE_CHILD_IDLE_WINDOW_MS = '150';
});

function tempDir(prefix = 'opk-fm-long-child-', base: string = TERMINAL_ENVELOPE_ROOT): string {
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, prefix));
  cleanupDirs.push(dir);
  return dir;
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
    env: { ...process.env, ...env },
    inheritParentEnv: true,
    allowEmptyStdout: true,
    timeoutMs: 120_000,
  });
  return { code: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
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
  const code = await runLaunch({
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

describe('flow-manager long-running child (#1164)', () => {
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
    const fixture = nodeFixture(`
      process.stdout.write(JSON.stringify(${JSON.stringify(result)}) + '\\n');
      process.exit(0);
    `);
    process.env.OPK_FM_LONG_CHILD_DISABLE_DETACH = '1';
    vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term_launcher');
    const code = await spawnDetachedLauncher([
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
    expect(code).toBe(0);
    expect(readHandoffReceipt(paths.receipt)?.schema).toBe(HANDOFF_SCHEMA);
    expect(readTerminalEnvelope(paths.envelope)?.lifecycle_outcome).toBe('success');
    expect(readTerminalEnvelope(paths.envelope)?.cwd).toBe(repoRoot);
    expect(readTerminalEnvelope(paths.envelope)?.terminal_handle).toBe('term_launcher');
  });

  it('refuses before handoff when artifact paths alias', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'alias');
    const fixture = nodeFixture('process.exit(0)');
    const code = await runLaunch({
      runIdentity: 'run',
      attemptIdentity: 'attempt',
      handoffReceiptPath: paths.envelope,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(2);
    expect(existsSync(paths.envelope)).toBe(false);
  });

  it('refuses an envelope name fleet-wake cannot discover before any effect (#2378)', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'unwakeable');
    const envelope = join(root, 'unwakeable', 'issue-2376-envelope.json');
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
    expect(refusal).toContain('terminal_envelope_name_not_wakeable');
    expect(refusal).toContain(TERMINAL_ENVELOPE_NAME_SUFFIX);
    expect(refusal).toContain('/tmp/opencode/issue-2376-envelope-terminal.json');
    expect(existsSync(paths.receipt)).toBe(false);
    expect(existsSync(envelope)).toBe(false);
  });

  it('adapter refuses an unwakeable envelope name without spawning the launcher (#2378)', async () => {
    const root = tempDir();
    const spawnLauncher = vi.fn(async () => 1);
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
    const root = tempDir('outside-root-', tmpdir());
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

  it('refuses when receipt create fails after preflight', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'receipt-fail');
    const fixture = nodeFixture('process.exit(0)');
    process.env.OPK_FM_LONG_CHILD_FORCE_RECEIPT_CREATE_FAIL = '1';
    const code = await runLaunch({
      runIdentity: 'run',
      attemptIdentity: 'attempt',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(2);
    expect(existsSync(paths.receipt)).toBe(false);
  });

  it('creates receipt before child start and succeeds on valid turn-result', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'success');
    const result = makeTurnResult();
    const fixture = nodeFixture(`
      process.stdout.write(JSON.stringify(${JSON.stringify(result)}) + '\\n');
      process.exit(0);
    `);
    const code = await runLaunch({
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

  it('treats exit zero without turn-result as missing after stdout EOF', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'missing');
    const fixture = nodeFixture('process.exit(0)');
    process.env.OPK_FM_LONG_CHILD_NO_CANDIDATE_GRACE_MS = '500';
    const code = await runLaunch({
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
    const code = await runLaunch({
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
    const code = await runLaunch({
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
    const code = await runLaunch({
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
    const code = await runLaunch({
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
    const code = await runLaunch({
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
    const code = await runLaunch({
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
    const code = await runLaunch({
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

    const code = await runLaunch({
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

    const code = await runLaunch({
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

    const code = await runLaunch({
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
    const code = await runLaunch({
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
    const code = await runLaunch({
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
    const code = await runLaunch({
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
    const code = await runLaunch({
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
    const code = await runLaunch({
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
    const code = await runLaunch({
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
    const code = await runLaunch({
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
    const code = await runLaunch({
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
    const code = await runLaunch({
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
    const code = await runLaunch({
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
    const code = await runLaunch({
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
      runLaunch(launchConfig),
      runLaunch(launchConfig),
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
    const code = await runLaunch({
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
    const code = await runLaunch({
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
    const code = await runLaunch({
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
    const fixture = nodeFixture(`
      process.stdout.write(JSON.stringify(${JSON.stringify(result)}) + '\\n');
      process.exit(0);
    `);
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
      inheritParentEnv: true,
      allowEmptyStdout: false,
      timeoutMs: 10_000,
    });
    expect(detachResult.ok).toBe(true);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const envelope = readTerminalEnvelope(paths.envelope);
      if (envelope?.lifecycle_outcome === 'success') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(readTerminalEnvelope(paths.envelope)?.lifecycle_outcome).toBe('success');
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
    const code = await runLaunch({
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
      recovery_available: true,
      conversation_locator: conversationUrl,
    });
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
      recovery_available: true,
      conversation_locator: conversationUrl,
      child_exit_code: 0,
    });
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
