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
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMPLETION_MODE,
  HANDOFF_SCHEMA,
  TERMINAL_SCHEMA,
  classifyConcurrentBatchDelivery,
  deriveDelivery,
  observePublishedArtifact,
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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const launcherPath = join(repoRoot, 'scripts/flow-manager-long-running-child.ts');
const adapterPath = join(repoRoot, 'scripts/flow-manager-browser-gpt-long-run.ts');
const skillPath = join(repoRoot, '.claude/skills/create-issue-draft/SKILL.md');
const rulePath = join(repoRoot, '.cursor/rules/flow-manager-browser-turn-monitoring.mdc');
const runbookPath = join(repoRoot, 'docs/flow-manager-long-running-child-runbook.md');
const browserReadmePath = join(repoRoot, 'scripts/chatgpt-browser-turn/README.md');
const packageJsonPath = join(repoRoot, 'package.json');

const cleanupDirs: string[] = [];

function tempDir(prefix = 'opk-fm-long-child-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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
    envelope: join(attempt, 'terminal-envelope.json'),
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
  it('static adoption references package commands and policy surfaces', () => {
    const packageJson = readFileSync(packageJsonPath, 'utf8');
    expect(packageJson).toContain('flow-manager-long-running-child');
    expect(packageJson).toContain('flow-manager-browser-gpt-long-run');
    expect(readFileSync(skillPath, 'utf8')).toContain('flow-manager-browser-gpt-long-run');
    expect(readFileSync(skillPath, 'utf8')).toContain('browser-turn-result-v1');
    expect(readFileSync(rulePath, 'utf8')).toContain('flow-manager-long-running-child-runbook.md');
    expect(readFileSync(runbookPath, 'utf8')).toContain(ADAPTER_PACKAGE_COMMAND);
    expect(readFileSync(runbookPath, 'utf8')).toContain(LAUNCHER_PACKAGE_COMMAND);
    expect(readFileSync(browserReadmePath, 'utf8')).toContain('flow-manager-browser-gpt-long-run');
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
  });

  it('refuses before handoff when artifact paths alias', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'alias');
    const fixture = nodeFixture('process.exit(0)');
    const code = await runLaunch({
      runIdentity: 'run',
      attemptIdentity: 'attempt',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.receipt,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(2);
    expect(existsSync(paths.receipt)).toBe(false);
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

  it('classifies hang after result as child_post_result_exit_timeout', async () => {
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
    expect(code).toBe(1);
    expect(readTerminalEnvelope(paths.envelope)?.incident).toBe('child_post_result_exit_timeout');
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

  it('classifies retained stdout past no-candidate grace as child_stdout_eof_timeout', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'eof-timeout');
    const fixture = nodeFixture('setInterval(() => {}, 1000);');
    process.env.OPK_FM_LONG_CHILD_NO_CANDIDATE_GRACE_MS = '200';
    const code = await runLaunch({
      runIdentity: 'run-eof',
      attemptIdentity: 'attempt-eof',
      handoffReceiptPath: paths.receipt,
      terminalEnvelopePath: paths.envelope,
      browserOutputPath: paths.output,
      cwd: repoRoot,
      childCommand: fixture.command,
      childArgs: fixture.args,
    });
    expect(code).toBe(1);
    expect(readTerminalEnvelope(paths.envelope)?.incident).toBe('child_stdout_eof_timeout');
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
      incident: 'child_stdout_eof_timeout',
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
  it('preserves a valid exact-owned receipt without using it as Stop authority', async () => {
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
    const fixture = nodeFixture(`
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
      incident: 'child_stdout_eof_timeout',
      delivery: 'POSSIBLY_DELIVERED',
      turn_result_state: 'driver_error',
      turn_result_cause: 'child_stdout_eof_timeout_cancellation_authority_absent',
      send_count: 1,
      recovery_available: true,
      conversation_locator: conversationUrl,
    });
    expect(envelope?.diagnostics).toMatchObject({
      cancellation: {
        stop_outcome: 'not_attempted_authority_absent',
        identity_proven: false,
      },
    });
  });

  it('preserves a bound receipt when the child exits immediately before a turn-result', async () => {
    const cdp = 'http://127.0.0.1:9222';
    const profile = join(tempDir('opk-1377-bound-profile-'), 'profile');
    const invocation = 'invocation-1377-bound';
    const conversationUrl = 'https://chatgpt.com/c/55555555-5555-4555-8555-555555555555';
    const receipt = buildBrowserTurnCancellationReceipt({
      invocationId: invocation,
      profileKey: configuredProfileKey(profile, cdp),
      conversationUrl,
      marker: `OPKTURNV1${'56'.repeat(16)}`,
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
      incident: 'child_stdout_eof_timeout',
      delivery: 'POSSIBLY_DELIVERED',
      turn_result_cause: 'child_stdout_eof_timeout_cancellation_authority_absent',
      send_count: 1,
      recovery_available: true,
      conversation_locator: conversationUrl,
    });
    expect(envelope?.diagnostics).toMatchObject({
      cancellation: { stop_outcome: 'not_attempted_authority_absent' },
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
      turn_result_cause: 'child_stdout_eof_timeout_cancellation_receipt_identity_unproven',
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
      turn_result_cause: 'child_stdout_eof_timeout_cancellation_receipt_identity_unproven',
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

function publicationTransport(input: {
  issueBody?: string;
  comments?: readonly Record<string, unknown>[];
  principal?: string;
}) {
  const runGh = vi.fn((argv: string[]) => {
    const target = argv[2] ?? '';
    if (target === 'user') {
      return { exitCode: 0, stdout: `${input.principal ?? 'chetwerikoff'}\n`, stderr: '' };
    }
    if (target.includes('/comments?')) {
      return { exitCode: 0, stdout: JSON.stringify(input.comments ?? []), stderr: '' };
    }
    if (/\/issues\/1441$/u.test(target)) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ title: 'fixture', body: input.issueBody ?? '', labels: [] }),
        stderr: '',
      };
    }
    return { exitCode: 1, stdout: '', stderr: `unexpected:${argv.join(' ')}` };
  });
  return { runGh };
}

function trustedComment(id: number, body: string, principal = 'chetwerikoff') {
  return {
    id,
    body,
    created_at: '2026-08-19T01:00:00Z',
    updated_at: '2026-08-19T01:00:00Z',
    user: { login: principal },
    author_association: 'OWNER',
  };
}

describe('Issue #1441 publication completion authority', () => {
  it('settles an author from exact revision plus exact REST body hash', () => {
    const body = '<!-- source-revision: r06 -->\n# Published author body\n';
    const exactBodySha256 = createHash('sha256').update(body, 'utf8').digest('hex');
    const transport = publicationTransport({ issueBody: body });
    expect(observePublishedArtifact({
      kind: 'author',
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1441,
      sourceRevision: 'r06',
      exactBodySha256,
    }, transport as never)).toEqual({
      status: 'published',
      kind: 'author',
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1441,
      sourceRevision: 'r06',
      exactBodySha256,
    });
  });

  it('binds reviewer completion to one unedited current-principal invocation/stage/slot comment', () => {
    const invocationId = '14410000-1111-4222-8333-444444444444';
    const body = [
      'Read revision: #1441 r05',
      `INVOCATION_ID_TO_ECHO: ${invocationId}`,
      'stage: architectural-review',
      'source-slot: 02',
      'VERDICT: NO_FINDINGS',
    ].join('\n');
    const transport = publicationTransport({ comments: [trustedComment(1, body)] });
    expect(observePublishedArtifact({
      kind: 'reviewer',
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1441,
      sourceRevision: 'r05',
      invocationId,
      stage: 'architectural-review',
      sourceSlot: '02',
    }, transport as never)).toMatchObject({
      status: 'published',
      kind: 'reviewer',
      commentId: 1,
      principal: 'chetwerikoff',
      invocationId,
    });
  });

  it('keeps duplicate owned reviewer publications blocked and never selects first match', () => {
    const invocationId = '14410000-1111-4222-8333-555555555555';
    const body = [
      'Read revision: #1441 r05',
      `INVOCATION_ID_TO_ECHO: ${invocationId}`,
      'stage: architectural-review',
      'source-slot: 03',
    ].join('\n');
    const transport = publicationTransport({ comments: [trustedComment(1, body), trustedComment(2, body)] });
    expect(observePublishedArtifact({
      kind: 'reviewer',
      repository: 'chetwerikoff/orchestrator-pack',
      issueNumber: 1441,
      sourceRevision: 'r05',
      invocationId,
      stage: 'architectural-review',
      sourceSlot: '03',
    }, transport as never)).toMatchObject({
      status: 'blocked',
      reason: 'reviewer_publication_duplicate_invocation',
    });
  });

  it('lets a REST-visible reviewer publication override a dead-child incident as completion authority', async () => {
    const root = tempDir('opk-1441-publication-wait-');
    const paths = launchPaths(root, 'published-dead-child');
    mkdirSync(dirname(paths.receipt), { recursive: true });
    writeFileSync(paths.receipt, JSON.stringify({
      schema: HANDOFF_SCHEMA,
      run_identity: 'run-1441',
      attempt_identity: 'attempt-1441',
      launcher_started_at: '2026-08-19T01:00:00.000Z',
      handoff_committed_at: '2026-08-19T01:00:01.000Z',
      completion_mode: COMPLETION_MODE,
    }));
    writeFileSync(paths.envelope, JSON.stringify({
      schema: TERMINAL_SCHEMA,
      run_identity: 'run-1441',
      attempt_identity: 'attempt-1441',
      completion_mode: COMPLETION_MODE,
      handoff_receipt_path: paths.receipt,
      launcher_started_at: '2026-08-19T01:00:00.000Z',
      handoff_committed_at: '2026-08-19T01:00:01.000Z',
      terminal_at: '2026-08-19T01:00:02.000Z',
      lifecycle_outcome: 'incident',
      incident: 'child_stdout_eof_timeout',
      delivery: 'POSSIBLY_DELIVERED',
      recovery_available: false,
    }));
    const invocationId = '14410000-1111-4222-8333-666666666666';
    const comment = [
      'Read revision: #1441 r05',
      `INVOCATION_ID_TO_ECHO: ${invocationId}`,
      'stage: architectural-review',
      'source-slot: 01',
    ].join('\n');
    const transport = publicationTransport({ comments: [trustedComment(9, comment)] });
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      await runWait({
        runIdentity: 'run-1441',
        attemptIdentity: 'attempt-1441',
        terminalEnvelopePath: paths.envelope,
        handoffReceiptPath: paths.receipt,
        deadlineMs: 1_000,
        publicationExpectation: {
          kind: 'reviewer',
          repository: 'chetwerikoff/orchestrator-pack',
          issueNumber: 1441,
          sourceRevision: 'r05',
          invocationId,
          stage: 'architectural-review',
          sourceSlot: '01',
        },
        transport: transport as never,
      });
    } finally {
      write.mockRestore();
    }
    const result = JSON.parse(chunks.join('').trim());
    expect(result).toMatchObject({
      terminal: true,
      non_terminal: false,
      no_success_authority: false,
      no_retry_authority: true,
      completion_authority: 'published_artifact',
      publication_terminal: true,
      envelope: { lifecycle_outcome: 'incident', incident: 'child_stdout_eof_timeout' },
    });
  });

  it('classifies a silent sibling possible-or-actual only when the batch has a published artifact', () => {
    const withPublishedSibling = classifyConcurrentBatchDelivery([
      { invocationId: 'slot-1', publication: 'published' },
      { invocationId: 'slot-2', publication: 'published' },
      { invocationId: 'slot-3', publication: 'missing', childHint: 'child_stdout_eof_timeout' },
    ]);
    expect(withPublishedSibling[2]).toEqual({
      invocationId: 'slot-3',
      classification: 'possible-or-actual',
      resendForbidden: true,
      settlement: 'incident',
      childHint: 'child_stdout_eof_timeout',
    });

    const withoutPublishedSibling = classifyConcurrentBatchDelivery([
      { invocationId: 'slot-1', publication: 'missing' },
      { invocationId: 'slot-2', publication: 'missing' },
      { invocationId: 'slot-3', publication: 'missing', childHint: 'child_stdout_eof_timeout' },
    ]);
    expect(withoutPublishedSibling.every((slot) => slot.classification === 'unproven')).toBe(true);
    expect(withoutPublishedSibling.every((slot) => slot.resendForbidden === false)).toBe(true);
  });
});
