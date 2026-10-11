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
  'const injected = (argv, options = {}) => runStateLightTurn(argv, { ...options, runTurn: async () => ({ result }) });',
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
