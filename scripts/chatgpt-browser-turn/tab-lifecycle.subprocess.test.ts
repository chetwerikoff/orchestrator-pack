import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runProcess, runProcessSync } from '../kernel/subprocess.ts';
import { releaseCdpBrowser } from './browser-session.ts';
import { readStateLightTurnObservation } from './state-light-turn-observation.ts';
import { configuredProfileKey } from './storage-common.ts';

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
// deterministic observation phase. No retirement seam: the finalizer runs the
// real guarded reattach and Page.close against a disposable headless Chrome.
const baseUrl = pathToFileURL(join(import.meta.dirname, 'state-light-turn-base.ts')).href;
const observationUrl = pathToFileURL(join(import.meta.dirname, 'state-light-turn-observation.ts')).href;
const storageUrl = pathToFileURL(join(import.meta.dirname, 'storage-common.ts')).href;
const sigtermFixture = [
  'import { writeFileSync } from "node:fs";',
  'import { join } from "node:path";',
  'import { runStateLightTurn, __setStateLightSignalSubmissionWitnessForTest } from ' + JSON.stringify(baseUrl) + ';',
  'import { admitStateLightTurnObservation, bindStateLightOwnedTarget, transitionStateLightTurnObservation } from ' + JSON.stringify(observationUrl) + ';',
  'import { configuredProfileKey } from ' + JSON.stringify(storageUrl) + ';',
  'const [phase, cdp, targetId, initialRoute, root] = process.argv.slice(1);',
  'const profile = join(root, "profile"); const invocationId = "inv-2718-sigterm";',
  'const profileKey = configuredProfileKey(profile, cdp);',
  'if (phase !== "missing") {',
  '  admitStateLightTurnObservation({ profileKey, invocationId, marker: "OPKTURNV1sigterm" });',
  '  bindStateLightOwnedTarget({ profileKey, invocationId, targetId, created: true, cdp, initialRoute });',
  '}',
  'if (phase === "not_sent") transitionStateLightTurnObservation({ profileKey, invocationId, phase: "not_sent", reason: "terminal_pre_send", sendCount: 0, sendWitness: "numeric_send_count" });',
  'if (phase === "dispatching" || phase === "sent_unharvested") transitionStateLightTurnObservation({ profileKey, invocationId, phase: "dispatching", reason: "dispatch_boundary_entered" });',
  'if (phase === "sent_unharvested") transitionStateLightTurnObservation({ profileKey, invocationId, phase: "sent_unharvested", reason: "owned_marker_observed", sendCount: 1, sendWitness: "numeric_send_count" });',
  'if (phase.startsWith("sending_")) transitionStateLightTurnObservation({ profileKey, invocationId, phase: "sending", reason: "pr_author_send_claim:acme/widgets#7" });',
  'if (phase.startsWith("sending_")) __setStateLightSignalSubmissionWitnessForTest(() => phase === "sending_issued");',
  'const code = await runStateLightTurn(["--profile", profile, "--cdp", cdp, "--invocation-id", invocationId], {',
  // Keep the event loop alive like a real browser turn; only SIGTERM ends it.
  '  runTurn: async () => { setInterval(() => {}, 1000); writeFileSync(join(root, "barrier"), "running"); return new Promise(() => {}); },',
  '});',
  'process.exit(code);',
].join('\n');

const PROJECT_URL = 'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-fixture/project';
// A blank project surface with one empty ProseMirror composer.
const COMPOSER_HTML = '<div id="prompt-textarea" contenteditable="true" role="textbox" class="ProseMirror">'
  + '<p><br class="ProseMirror-trailingBreak"></p></div>';
const BLANK_PROJECT_HTML = '<!doctype html><title>project</title><main>' + COMPOSER_HTML + '</main>';
// The same surface before ChatGPT has rendered its composer.
const LOADING_PROJECT_HTML = '<!doctype html><title>project</title><main></main>';

// An independent page-level CDP client renders the composer late.
async function renderComposerLater(endpoint: string, targetId: string, delayMs: number): Promise<void> {
  await new Promise((done) => setTimeout(done, delayMs));
  const listed = await (await fetch(endpoint + '/json/list')).json() as Array<{ id: string; webSocketDebuggerUrl: string }>;
  const socket = new WebSocket(listed.find((entry) => entry.id === targetId)!.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  await new Promise((done) => {
    socket.onmessage = done;
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: 'document.querySelector("main").innerHTML = ' + JSON.stringify(COMPOSER_HTML),
    } }));
  });
  socket.close();
}

async function sigtermAtPhase(phase: string, target: {
  cdp: string; targetId?: string; realHome?: true; afterSigterm?: () => Promise<void>;
}) {
  const root = mkdtempSync(join(tmpdir(), 'opk-2718-sigterm-'));
  const stateDir = join(root, 'state');
  let pid: number | undefined;
  const began = Date.now();
  const child = runProcess({
    command: process.execPath,
    args: ['--experimental-strip-types', '--input-type=module', '--eval', sigtermFixture,
      phase, target.cdp, target.targetId ?? 'target-2718', PROJECT_URL, root],
    cwd: resolve(import.meta.dirname, '../..'),
    env: {
      ...process.env, CHATGPT_BROWSER_TURN_STATE_DIR: stateDir, ORCA_TERMINAL_HANDLE: '', NODE_OPTIONS: '',
      // The production loadChromium resolves the operator playwright-core under
      // HOME, which the Vitest harness redirects.
      ...(target.realHome ? { HOME: userInfo().homedir } : {}),
    },
    inheritParentEnv: false,
    timeoutMs: 40_000,
    onSpawn: (spawned) => { pid = spawned; },
  });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(root, 'barrier'))) {
      if (Date.now() >= deadline) throw new Error('fixture_barrier_timeout');
      await new Promise((done) => setTimeout(done, 10));
    }
    process.kill(pid!, 'SIGTERM');
    const sideEffect = target.afterSigterm?.();
    await new Promise((done) => setTimeout(done, 20));
    try { process.kill(pid!, 'SIGTERM'); } catch { /* already exited */ }
    const result = await child;
    await sideEffect;
    const previous = process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
    process.env.CHATGPT_BROWSER_TURN_STATE_DIR = stateDir;
    let persistedPhase: string | undefined;
    try {
      persistedPhase = readStateLightTurnObservation(
        configuredProfileKey(join(root, 'profile'), target.cdp), 'inv-2718-sigterm').phase;
    } catch { persistedPhase = undefined; }
    finally {
      if (previous === undefined) delete process.env.CHATGPT_BROWSER_TURN_STATE_DIR;
      else process.env.CHATGPT_BROWSER_TURN_STATE_DIR = previous;
    }
    return { result, persistedPhase, elapsedMs: Date.now() - began, root };
  } catch (error) {
    if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    await child.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

const liveChromium = (() => {
  const require = createRequire(import.meta.url);
  for (const location of [
    ...(process.env.OPK_TEST_PLAYWRIGHT_CORE_PATH ? [process.env.OPK_TEST_PLAYWRIGHT_CORE_PATH] : []),
    join(homedir(), '.local/share/discuss-with-gpt/node_modules/playwright-core'),
    'playwright-core',
  ]) {
    try { return require(location).chromium; } catch { /* not installed here */ }
  }
  return undefined;
})();
const chromeExecutable = [
  process.env.OPK_TEST_CHROME_BIN, process.env.CHROME_BIN,
  '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((candidate) => Boolean(candidate && existsSync(candidate)));
// Same contract as own-target-attach.test.ts: OPK_REQUIRE_REAL_CDP_TEST=1
// makes a missing playwright-core or Chrome a failure, never a silent skip.
const realCdp = process.env.OPK_REQUIRE_REAL_CDP_TEST === '1' || Boolean(liveChromium && chromeExecutable);

type PageCensus = Array<{ id: string; type: string }>;
async function pageIds(endpoint: string): Promise<string[]> {
  const listed = await (await fetch(endpoint + '/json/list')).json() as PageCensus;
  return listed.filter((entry) => entry.type === 'page').map((entry) => entry.id).sort();
}

// A fresh isolated Chrome with one foreign blank page and one owned page on
// the blank project surface; the owned page's target id is the pinned target.
async function withDisposableChrome(
  work: (chrome: { endpoint: string; ownedId: string; foreignIds: string[] }) => Promise<void>,
  html = BLANK_PROJECT_HTML,
) {
  if (!liveChromium || !chromeExecutable) throw new Error('real CDP SIGTERM test requires installed playwright-core and Chrome');
  const profile = mkdtempSync(join(tmpdir(), 'opk-2718-chrome-'));
  const chromeAbort = new AbortController();
  const chromeRun = runProcess({
    command: chromeExecutable,
    args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
      '--no-default-browser-check', '--remote-allow-origins=*', '--remote-debugging-port=0',
      '--user-data-dir=' + profile, 'about:blank'],
    signal: chromeAbort.signal, timeoutMs: 90_000, allowEmptyStdout: true,
  }).catch(() => undefined);
  let client: any;
  try {
    const activePortFile = join(profile, 'DevToolsActivePort');
    let port = 0;
    for (let i = 0; i < 100 && !port; i++) {
      if (existsSync(activePortFile)) {
        const candidate = Number(readFileSync(activePortFile, 'utf8').split(/\r?\n/u)[0]);
        if (Number.isInteger(candidate) && candidate > 0) port = candidate;
      }
      if (!port) await new Promise((done) => setTimeout(done, 100));
    }
    if (!port) throw new Error('headless Chrome did not expose a CDP port');
    const endpoint = 'http://127.0.0.1:' + port;
    const foreignIds = await pageIds(endpoint);
    client = await liveChromium.connectOverCDP(endpoint, { timeout: 10_000 });
    const context = client.contexts()[0];
    const owned = await context.newPage();
    await owned.route('https://chatgpt.com/**', (route: any) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    await owned.goto(PROJECT_URL);
    const session = await context.newCDPSession(owned);
    const ownedId = (await session.send('Target.getTargetInfo')).targetInfo.targetId as string;
    await session.detach();
    await releaseCdpBrowser(client);
    client = undefined;
    await work({ endpoint, ownedId, foreignIds });
  } finally {
    await releaseCdpBrowser(client);
    chromeAbort.abort();
    await chromeRun;
    rmSync(profile, { recursive: true, force: true });
  }
}

describe('Issue #2718 real state-light SIGTERM finalizer', () => {
  it.skipIf(!realCdp).each(['not_sent', 'prepared', 'sending_unissued'])(
    'pre-dispatch %s: repeated SIGTERM retires only the owned target through the real guarded close', async (phase) => {
      await withDisposableChrome(async ({ endpoint, ownedId, foreignIds }) => {
        expect(await pageIds(endpoint)).toEqual([...foreignIds, ownedId].sort());
        const { result, persistedPhase, elapsedMs, root } = await sigtermAtPhase(phase, { cdp: endpoint, targetId: ownedId, realHome: true });
        try {
          expect(result.outcome, result.stderr).toBe('exit');
          expect(result.exitCode).toBe(13);
          const records = result.stdout.trimEnd().split('\n');
          expect(records).toHaveLength(1);
          const record = JSON.parse(records[0]!);
          expect(record).toMatchObject({
            schema: 'turn-result/v1', cause: 'terminated_by_sigterm', send_count: 0, cleanup: 'confirmed',
            owned_target_id: ownedId, cleanup_attempted: true, cleanup_cause: 'confirmed',
          });
          expect(record).not.toHaveProperty('cleanup_status');
          expect(record).not.toHaveProperty('send_attempted');
          expect(record.next_action).toContain('Cleanup diagnostic: attempted, cause confirmed.');
          expect(persistedPhase).toBe('not_sent');
          // Own target gone; every other page id unchanged.
          expect(await pageIds(endpoint)).toEqual(foreignIds);
          expect(elapsedMs).toBeLessThan(30_000);
        } finally { rmSync(root, { recursive: true, force: true }); }
      });
    }, 90_000);

  it.skipIf(!realCdp)('prepared before the composer renders: a later guarded pass closes the project page', async () => {
    await withDisposableChrome(async ({ endpoint, ownedId, foreignIds }) => {
      const { result, persistedPhase, root } = await sigtermAtPhase('prepared', {
        cdp: endpoint, targetId: ownedId, realHome: true,
        afterSigterm: () => renderComposerLater(endpoint, ownedId, 1_500),
      });
      try {
        expect(result.outcome, result.stderr).toBe('exit');
        const record = JSON.parse(result.stdout.trimEnd());
        expect(record).toMatchObject({
          cause: 'terminated_by_sigterm', send_count: 0, cleanup: 'confirmed',
          cleanup_attempted: true, cleanup_cause: 'confirmed',
        });
        expect(persistedPhase).toBe('not_sent');
        expect(await pageIds(endpoint)).toEqual(foreignIds);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }, LOADING_PROJECT_HTML);
  }, 90_000);

  it.skipIf(!realCdp)('prepared whose composer never renders: preserves the project page within the bound', async () => {
    await withDisposableChrome(async ({ endpoint, ownedId, foreignIds }) => {
      const { result, elapsedMs, root } = await sigtermAtPhase('prepared', {
        cdp: endpoint, targetId: ownedId, realHome: true,
      });
      try {
        expect(result.outcome, result.stderr).toBe('exit');
        expect(JSON.parse(result.stdout.trimEnd())).toMatchObject({
          cause: 'terminated_by_sigterm', cleanup: 'unconfirmed', cleanup_status: 'cleanup_unconfirmed',
          cleanup_attempted: true,
        });
        // The last settle pass is either refused or cut by the cleanup bound.
        expect(['composer_unknown', 'retirement_bound_elapsed'])
          .toContain(JSON.parse(result.stdout.trimEnd()).cleanup_cause);
        expect(await pageIds(endpoint)).toEqual([...foreignIds, ownedId].sort());
        expect(elapsedMs).toBeLessThan(30_000);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }, LOADING_PROJECT_HTML);
  }, 90_000);

  it.skipIf(!realCdp)('issued sending: preserves the live owned target with cleanup_unconfirmed', async () => {
    await withDisposableChrome(async ({ endpoint, ownedId, foreignIds }) => {
      const { result, persistedPhase, root } = await sigtermAtPhase('sending_issued', { cdp: endpoint, targetId: ownedId, realHome: true });
      try {
        expect(result.outcome, result.stderr).toBe('exit');
        const record = JSON.parse(result.stdout.trimEnd());
        expect(record).toMatchObject({
          cause: 'terminated_by_sigterm', cleanup: 'unconfirmed', cleanup_status: 'cleanup_unconfirmed',
          owned_target_id: ownedId, send_attempted: true,
        });
        expect(record).not.toHaveProperty('cleanup_attempted');
        expect(persistedPhase).toBe('sending');
        expect(await pageIds(endpoint)).toEqual([...foreignIds, ownedId].sort());
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }, 90_000);

  // The remaining cases never reach a browser: their CDP endpoint is a local
  // listener that counts and holds every request.
  async function withHeldCdp(work: (cdp: string, requests: () => number) => Promise<void>) {
    let requests = 0;
    const held: ServerResponse[] = [];
    const server = createServer((_request, response) => { requests++; held.push(response); });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      await work('http://127.0.0.1:' + (server.address() as AddressInfo).port, () => requests);
    } finally {
      for (const response of held) response.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }

  it.each(['dispatching', 'sent_unharvested'])(
    'unsafe %s: preserves the Page with cleanup_unconfirmed and no CDP request', async (phase) => {
      await withHeldCdp(async (cdp, requests) => {
        const { result, persistedPhase, root } = await sigtermAtPhase(phase, { cdp });
        try {
          expect(result.outcome, result.stderr).toBe('exit');
          expect(requests()).toBe(0);
          const records = result.stdout.trimEnd().split('\n');
          expect(records).toHaveLength(1);
          const record = JSON.parse(records[0]!);
          expect(record).toMatchObject({
            cause: 'terminated_by_sigterm', cleanup: 'unconfirmed', cleanup_status: 'cleanup_unconfirmed',
            owned_target_id: 'target-2718',
          });
          expect(record.send_attempted).toBe(true);
          expect(record).not.toHaveProperty('cleanup_attempted');
          expect(persistedPhase).toBe(phase);
        } finally { rmSync(root, { recursive: true, force: true }); }
      });
    }, 30_000);

  it('a missing observation record is unknown delivery, never an affirmative pre-Send claim', async () => {
    await withHeldCdp(async (cdp, requests) => {
      const { result, root } = await sigtermAtPhase('missing', { cdp });
      try {
        expect(result.outcome, result.stderr).toBe('exit');
        expect(requests()).toBe(0);
        const record = JSON.parse(result.stdout.trimEnd());
        expect(record).toMatchObject({ cause: 'terminated_by_sigterm', send_attempted: true });
        expect(record.next_action).toContain('never resend blindly');
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }, 30_000);

  it('a hung CDP census still exits within the cleanup bound as cleanup_unconfirmed', async () => {
    await withHeldCdp(async (cdp, requests) => {
      const { result, elapsedMs, root } = await sigtermAtPhase('not_sent', { cdp });
      try {
        expect(result.outcome, result.stderr).toBe('exit');
        expect(requests()).toBeGreaterThan(0);
        expect(JSON.parse(result.stdout.trimEnd())).toMatchObject({
          cleanup: 'unconfirmed', cleanup_status: 'cleanup_unconfirmed', cleanup_attempted: true,
          cleanup_cause: expect.stringMatching(/^[A-Za-z0-9._:-]{1,128}$/u),
        });
        expect(elapsedMs).toBeLessThan(15_000);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }, 30_000);
});
