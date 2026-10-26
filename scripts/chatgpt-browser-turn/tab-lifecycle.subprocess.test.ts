import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runProcess, runProcessSync } from '../kernel/subprocess.ts';

const fixture = join(import.meta.dirname, 'tab-lifecycle-subprocess-fixture.ts');

async function killAtBarrier(mode: 'before-link' | 'after-link') {
  const root = mkdtempSync(join(tmpdir(), `opk-1238-${mode}-`));
  const barrier = join(root, `${mode}.barrier`);
  const controller = new AbortController();
  const child = runProcess({
    command: process.execPath,
    args: ['--experimental-strip-types', fixture, mode, root],
    cwd: resolve(import.meta.dirname, '../..'),
    inheritParentEnv: true,
    signal: controller.signal,
    killGraceMs: 100,
  });
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(barrier)) {
      if (Date.now() >= deadline) throw new Error('fixture_barrier_timeout');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    const result = await child;
    expect(result.outcome).toBe('cancelled');
    return root;
  } catch (error) {
    controller.abort();
    await child.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

describe('Issue #1238 helper-termination publication barriers', () => {
  it('leaves no final path and no page-close actuation before final-link creation', async () => {
    const root = await killAtBarrier('before-link');
    try {
      expect(existsSync(join(root, 'reply.txt'))).toBe(false);
      expect(existsSync(join(root, 'before-link.page-close'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves exact final bytes recoverable and the page unclosed after final-link creation', async () => {
    const root = await killAtBarrier('after-link');
    try {
      expect(readFileSync(join(root, 'reply.txt'), 'utf8')).toBe('subprocess after-link reply');
      expect(existsSync(join(root, 'after-link.page-close'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


// #2494: use the entry's actual executable-only exit function with a base
// runStateLightTurn-injected synthetic outcome. This is not a JSON printer.
const entryUrl = pathToFileURL(join(import.meta.dirname, 'state-light-entry.ts')).href;
const turnUrl = pathToFileURL(join(import.meta.dirname, 'state-light-turn.ts')).href;
const executableFixture = [
  'import { runStateLightExecutable, runStateLightEntry } from ' + JSON.stringify(entryUrl) + ';',
  'import { runStateLightTurn } from ' + JSON.stringify(turnUrl) + ';',
  'const [mode, state] = process.argv.slice(1);',
  "const result = { schema: 'turn-result/v1', state, scope: state === 'ok' ? 'none' : 'invocation',",
  "  cause: state === 'ok' ? 'completed_page_only' : 'synthetic_failure',",
  "  invocation_id: 'fixture-2494', configured_profile_key: 'fixture-profile',",
  "  send_count: 1, poll_count: 0, goto_count: 0, new_chat_click_count: 0, navigation_count: 0, incidents: [] };",
  "const page = mode === 'hung-close-turn' || mode === 'reject-close-turn' ? { isClosed: () => false,",
  "  close: mode === 'hung-close-turn' ? () => new Promise(() => {}) : async () => { throw new Error('synthetic_close_rejected'); } } : undefined;",
  "const injected = (argv, options = {}) => runStateLightTurn(argv, { ...options, runTurn: async () => ({ result, ...(page ? { page, cleanupAction: 'preserve' } : {}) }) });",
  "const args = mode.startsWith('direct') ? ['--profile', 'synthetic'] : ['turn', '--profile', 'synthetic'];",
  'const held = setInterval(() => {}, 60_000);',
  "if (mode === 'imported-entry') {",
  '  await runStateLightEntry(args, { runTurn: injected });',
  "  clearInterval(held); console.log('imported-entry-survived');",
  "} else if (mode === 'imported-turn') {",
  '  await injected(args.slice(1));',
  "  clearInterval(held); console.log('imported-turn-survived');",
  "} else if (mode === 'nonturn') {",
  "  try { await runStateLightExecutable([state, '--invalid-2494']); } catch {}",
  "  clearInterval(held); console.log('nonturn-survived');",
  '} else {',
  "  await runStateLightExecutable(mode.startsWith('invalid')",
  "    ? (mode === 'invalid-direct' ? ['--profile'] : ['turn', '--profile']) : args,",
  '    { runTurn: injected });',
  '}',
].join('\n');

function spawnStateLightEntryFixture(mode: string, state: string) {
  const root = mkdtempSync(join(tmpdir(), 'opk-2494-subprocess-'));
  const began = Date.now();
  try {
    const child = runProcessSync({
      command: process.execPath,
      args: ['--experimental-strip-types', '--input-type=module', '--eval', executableFixture, mode, state],
      cwd: resolve(import.meta.dirname, '../..'),
      encoding: 'utf8',
      timeoutMs: 8_000, // Timeout kills a failed fixture; it cannot count as successful exit.
      env: {
        ...process.env,
        CHATGPT_BROWSER_TURN_STATE_DIR: root,
        ORCA_TERMINAL_HANDLE: '',
        NODE_OPTIONS: '',
      },
      inheritParentEnv: false,
    });
    expect(child.outcome, child.stderr).toBe('exit');
    expect(child.signal, child.stderr).toBeNull();
    expect(Date.now() - began).toBeLessThan(60_000);
    return child;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('Issue #2494 executable state-light turn terminal/exit', () => {
  it.each([
    ['turn', 'ok', 0],
    ['turn', 'no_reply', 11],
    ['turn', 'driver_error', 13],
    ['direct', 'ok', 0],
    ['direct', 'no_reply', 11],
    ['direct', 'driver_error', 13],
  ] as const)('flushes exactly one %s %s terminal before actual exit %i with a retained handle',
    (mode, state, code) => {
      const child = spawnStateLightEntryFixture(mode, state);
      expect(child.exitCode, child.stderr).toBe(code);
      expect(child.stdout.endsWith('\n')).toBe(true);
      const records = child.stdout.trimEnd().split('\n');
      expect(records).toHaveLength(1);
      expect(JSON.parse(records[0]!)).toMatchObject({
        schema: 'turn-result/v1', state, send_count: 1, cleanup: 'skipped',
      });
    });

  it.each([
    ['hung-close-turn', 'ok', 0],
    ['hung-close-turn', 'no_reply', 11],
    ['reject-close-turn', 'driver_error', 13],
  ] as const)('never calls %s page-close for %s without created-target CDP evidence', (mode, state, code) => {
    const child = spawnStateLightEntryFixture(mode, state);
    expect(child.exitCode, child.stderr).toBe(code);
    expect(child.stdout.endsWith('\n')).toBe(true);
    const records = child.stdout.trimEnd().split('\n');
    expect(records).toHaveLength(1);
    const result = JSON.parse(records[0]!);
    expect(result).toMatchObject({
      schema: 'turn-result/v1', state, send_count: 1, cleanup: 'skipped',
    });
    // This subprocess fixture deliberately has neither a pinned created
    // target nor a CDP census. A hung synthetic Page.close is not proof of
    // current ownership and must never be attempted.
    expect(result.incidents ?? []).not.toContain('owned_tab_cleanup_failed');
  }, 15_000);

  it.each([
    ['invalid-turn', 'turn'],
    ['invalid-direct', 'direct'],
  ])('preserves argument-invalid 22 on the %s route', (mode) => {
    const child = spawnStateLightEntryFixture(mode, 'ok');
    expect(child.exitCode, child.stderr).toBe(22);
    const lines = child.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      schema: 'turn-result/v1', state: 'driver_error', cause: 'argument_invalid',
    });
  });

  it.each(['imported-entry', 'imported-turn'])('%s returns without forcing process exit', (mode) => {
    const child = spawnStateLightEntryFixture(mode, 'no_reply');
    expect(child.exitCode, child.stderr).toBe(0);
    expect(child.stdout).toContain(mode + '-survived\n');
  });

  it.each(['preflight', 'cancel', 'session', 'unrelated'])(
    'does not force process exit for the %s non-turn route', (route) => {
      const child = spawnStateLightEntryFixture('nonturn', route);
      expect(child.exitCode, child.stderr).toBe(0);
      expect(child.stdout).toContain('nonturn-survived\n');
    },
  );
});

// #2718 AC5/6: a real running state-light turn child receives OS SIGTERM at a
// deterministic observation phase. The exact-target retirement seam counts
// guarded close attempts; its CDP guard itself is covered in tab-lifecycle.test.ts.
const baseUrl = pathToFileURL(join(import.meta.dirname, 'state-light-turn-base.ts')).href;
const observationUrl = pathToFileURL(join(import.meta.dirname, 'state-light-turn-observation.ts')).href;
const storageUrl = pathToFileURL(join(import.meta.dirname, 'storage-common.ts')).href;
const sigtermFixture = [
  'import { appendFileSync, writeFileSync } from "node:fs";',
  'import { join } from "node:path";',
  'import { runStateLightTurn, __setStateLightSignalRetirementForTest } from ' + JSON.stringify(baseUrl) + ';',
  'import { admitStateLightTurnObservation, bindStateLightOwnedTarget, transitionStateLightTurnObservation } from ' + JSON.stringify(observationUrl) + ';',
  'import { configuredProfileKey } from ' + JSON.stringify(storageUrl) + ';',
  'const [phase, retire, root] = process.argv.slice(1);',
  'const profile = join(root, "profile"); const cdp = "http://127.0.0.1:9222"; const invocationId = "inv-2718-sigterm";',
  'const profileKey = configuredProfileKey(profile, cdp);',
  'admitStateLightTurnObservation({ profileKey, invocationId, marker: "OPKTURNV1sigterm" });',
  'bindStateLightOwnedTarget({ profileKey, invocationId, targetId: "target-2718", created: true, cdp, initialRoute: "https://chatgpt.com/" });',
  'if (phase === "not_sent") transitionStateLightTurnObservation({ profileKey, invocationId, phase: "not_sent", reason: "terminal_pre_send", sendCount: 0, sendWitness: "numeric_send_count" });',
  'if (phase === "dispatching" || phase === "sent_unharvested") transitionStateLightTurnObservation({ profileKey, invocationId, phase: "dispatching", reason: "dispatch_boundary_entered" });',
  'if (phase === "sent_unharvested") transitionStateLightTurnObservation({ profileKey, invocationId, phase: "sent_unharvested", reason: "owned_marker_observed", sendCount: 1, sendWitness: "numeric_send_count" });',
  '__setStateLightSignalRetirementForTest(async () => {',
  '  appendFileSync(join(root, "close-attempts"), "close\\n");',
  '  if (retire === "hung") return new Promise(() => {});',
  '  return { status: "confirmed", targetId: "target-2718" };',
  '});',
  'const code = await runStateLightTurn(["--profile", profile, "--cdp", cdp, "--invocation-id", invocationId], {',
  // Keep the event loop alive like a real browser turn; only SIGTERM ends it.
  '  runTurn: async () => { setInterval(() => {}, 1000); writeFileSync(join(root, "barrier"), "running"); return new Promise(() => {}); },',
  '});',
  'process.exit(code);',
].join('\n');

async function sigtermAtPhase(phase: string, retire: 'confirm' | 'hung') {
  const root = mkdtempSync(join(tmpdir(), 'opk-2718-sigterm-'));
  let pid: number | undefined;
  const began = Date.now();
  const child = runProcess({
    command: process.execPath,
    args: ['--experimental-strip-types', '--input-type=module', '--eval', sigtermFixture, phase, retire, root],
    cwd: resolve(import.meta.dirname, '../..'),
    env: { ...process.env, CHATGPT_BROWSER_TURN_STATE_DIR: join(root, 'state'), ORCA_TERMINAL_HANDLE: '', NODE_OPTIONS: '' },
    inheritParentEnv: false,
    timeoutMs: 20_000,
    onSpawn: (spawned) => { pid = spawned; },
  });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(root, 'barrier'))) {
      if (Date.now() >= deadline) throw new Error('fixture_barrier_timeout');
      await new Promise((done) => setTimeout(done, 10));
    }
    process.kill(pid!, 'SIGTERM');
    await new Promise((done) => setTimeout(done, 20));
    try { process.kill(pid!, 'SIGTERM'); } catch { /* already exited */ }
    const result = await child;
    const closes = existsSync(join(root, 'close-attempts'))
      ? readFileSync(join(root, 'close-attempts'), 'utf8').trim().split('\n').length : 0;
    return { result, closes, elapsedMs: Date.now() - began, root };
  } catch (error) {
    if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    await child.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

describe('Issue #2718 real state-light SIGTERM finalizer', () => {
  it('safe not_sent: repeated SIGTERM performs exactly one guarded close and exits bounded', async () => {
    const { result, closes, elapsedMs, root } = await sigtermAtPhase('not_sent', 'confirm');
    try {
      expect(result.outcome, result.stderr).toBe('exit');
      expect(result.exitCode).toBe(13);
      expect(closes).toBe(1);
      const records = result.stdout.trimEnd().split('\n');
      expect(records).toHaveLength(1);
      expect(JSON.parse(records[0]!)).toMatchObject({
        schema: 'turn-result/v1', cause: 'terminated_by_sigterm', send_count: 0, cleanup: 'confirmed',
        owned_target_id: 'target-2718',
      });
      expect(JSON.parse(records[0]!)).not.toHaveProperty('cleanup_status');
      expect(elapsedMs).toBeLessThan(15_000);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it.each(['prepared', 'dispatching', 'sent_unharvested'])(
    'unsafe %s: preserves the Page with cleanup_unconfirmed and no close attempt', async (phase) => {
      const { result, closes, root } = await sigtermAtPhase(phase, 'confirm');
      try {
        expect(result.outcome, result.stderr).toBe('exit');
        expect(closes).toBe(0);
        const records = result.stdout.trimEnd().split('\n');
        expect(records).toHaveLength(1);
        const record = JSON.parse(records[0]!);
        expect(record).toMatchObject({
          cause: 'terminated_by_sigterm', cleanup: 'unconfirmed', cleanup_status: 'cleanup_unconfirmed',
          owned_target_id: 'target-2718',
        });
        if (phase === 'prepared') expect(record).not.toHaveProperty('send_attempted');
        else expect(record.send_attempted).toBe(true);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }, 30_000);

  it('a hung guarded close still exits within the cleanup bound as cleanup_unconfirmed', async () => {
    const { result, closes, elapsedMs, root } = await sigtermAtPhase('not_sent', 'hung');
    try {
      expect(result.outcome, result.stderr).toBe('exit');
      expect(closes).toBe(1);
      expect(JSON.parse(result.stdout.trimEnd())).toMatchObject({
        cleanup: 'unconfirmed', cleanup_status: 'cleanup_unconfirmed',
      });
      expect(elapsedMs).toBeLessThan(15_000);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
});
