import { spawn, spawnSync } from 'node:child_process';
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
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMPLETION_MODE,
  HANDOFF_SCHEMA,
  TERMINAL_SCHEMA,
  deriveDelivery,
  pathsAlias,
  readHandoffReceipt,
  readTerminalEnvelope,
  runLaunch,
  runWait,
} from './flow-manager-long-running-child.ts';
import {
  ADAPTER_PACKAGE_COMMAND,
  LAUNCHER_PACKAGE_COMMAND,
  runBrowserAdapter,
  spawnDetachedLauncher,
} from './flow-manager-browser-gpt-long-run.ts';
import type { TurnResultV1 } from './chatgpt-browser-turn/contracts.ts';

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
  const child = spawn(process.execPath, ['--experimental-strip-types', launcherPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const code = await new Promise<number>((resolveCode) => child.on('close', (c) => resolveCode(c ?? 1)));
  return { code, stdout, stderr };
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

  it('waiter is non-terminal before envelope exists', async () => {
    const root = tempDir();
    const paths = launchPaths(root, 'wait');
    const waitStdout = await new Promise<string>((resolveStdout) => {
      const child = spawn(process.execPath, [
        '--experimental-strip-types', launcherPath, 'wait',
        '--run-identity', 'run-w',
        '--attempt-identity', 'attempt-w',
        '--terminal-envelope', paths.envelope,
        '--handoff-receipt', paths.receipt,
        '--deadline-ms', '200',
      ], { cwd: repoRoot });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.on('close', () => resolveStdout(stdout));
    });
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
    expect(deriveDelivery(makeTurnResult({ state: 'output_conflict', observation_uncertainty_diagnostics: { cause: 'output_conflict:exists', send_count: 0, owned_prompt_seen: false } }), false)).toBe('not-sent');
    expect(deriveDelivery(makeTurnResult({ observation_uncertainty_diagnostics: { cause: 'sent', send_count: 1, owned_prompt_seen: false }, witness: undefined }), false)).toBe('POSSIBLY_DELIVERED');
    expect(deriveDelivery(makeTurnResult(), false)).toBe('landed');
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
