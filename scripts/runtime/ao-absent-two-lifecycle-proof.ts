import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { OrcaTaskRuntimeAdapter } from '../orca-runtime/task-adapter.ts';
import { runOrcaJson, type OrcaJsonResponse } from '../orca-runtime/native.ts';
import {
  executeRuntimeTaskLifecycle,
  type RuntimeTaskLifecycleResult,
} from './task-lifecycle.ts';

function hermeticTwoLifecycleFixture(
  statePath: string,
  capturePath: string,
  expectedPath: string,
): string {
  return `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter } from 'node:path';

const statePath = ${JSON.stringify(statePath)};
const capturePath = ${JSON.stringify(capturePath)};
const expectedPath = ${JSON.stringify(expectedPath)};
const args = process.argv.slice(2).filter((arg) => arg !== '--json');
const operation = \`\${args[0] ?? ''} \${args[1] ?? ''}\`;
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : { sequence: 0, terminals: {}, operations: [], captures: [] };
const forbiddenEnvironment = Object.keys(process.env).filter(
  (key) => key.startsWith('AO_') || key.startsWith('AGENT_ORCHESTRATOR_'),
);
const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
const legacyAdapterLoaded = Object.keys(process.env).some((key) => key.includes('AO_LEGACY'));
const capture = { operation, args, forbiddenEnvironment, pathEntries, expectedPath, legacyAdapterLoaded };
state.captures.push(capture);
writeFileSync(capturePath, \`\${JSON.stringify(state.captures)}\\n\`, 'utf8');
if (forbiddenEnvironment.length > 0 || pathEntries.length !== 1 || pathEntries[0] !== expectedPath || legacyAdapterLoaded) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: { code: 'fixture_environment_not_hermetic', message: JSON.stringify(capture) },
  }));
  process.exit(0);
}
state.operations.push(operation);
const persist = () => writeFileSync(statePath, \`\${JSON.stringify(state)}\\n\`, 'utf8');
const respond = (value) => {
  persist();
  process.stdout.write(\`\${JSON.stringify(value)}\\n\`);
};
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] ?? '') : '';
};

switch (operation) {
  case 'worktree current':
    respond({ ok: true, result: { worktree: { path: expectedPath, head: 'a'.repeat(40) } } });
    break;
  case 'terminal create': {
    state.sequence += 1;
    const handle = \`term-1250-\${state.sequence}\`;
    const incarnationId = \`generation-1250-\${state.sequence}\`;
    const title = option('--title');
    state.terminals[handle] = {
      handle,
      incarnationId,
      title,
      worktreePath: expectedPath,
      status: 'running',
      lines: [\`started:\${option('--command')}\`],
      dispatches: 0,
      closes: 0,
      exists: true,
    };
    respond({ ok: true, result: { terminal: { handle, incarnationId, title } } });
    break;
  }
  case 'terminal list':
    respond({
      ok: true,
      result: {
        terminals: Object.values(state.terminals)
          .filter((terminal) => terminal.exists)
          .map(({ lines, dispatches, closes, exists, ...terminal }) => terminal),
      },
    });
    break;
  case 'terminal send': {
    const handle = option('--terminal');
    const terminal = state.terminals[handle];
    if (!terminal || !terminal.exists) {
      respond({ ok: false, error: { code: 'terminal_not_found', message: handle } });
      break;
    }
    terminal.dispatches += 1;
    terminal.lines.push(option('--text'));
    respond({ ok: true, result: { send: { accepted: true } } });
    break;
  }
  case 'terminal read': {
    const handle = option('--terminal');
    const terminal = state.terminals[handle];
    if (!terminal || !terminal.exists) {
      respond({ ok: false, error: { code: 'terminal_not_found', message: handle } });
      break;
    }
    respond({
      ok: true,
      result: {
        terminal: {
          handle,
          status: terminal.status,
          tail: [...terminal.lines],
          nextCursor: String(terminal.lines.length),
          latestCursor: String(terminal.lines.length),
        },
      },
    });
    break;
  }
  case 'terminal wait': {
    const handle = option('--terminal');
    const terminal = state.terminals[handle];
    if (!terminal || !terminal.exists) {
      respond({ ok: false, error: { code: 'terminal_not_found', message: handle } });
      break;
    }
    respond({ ok: true, result: { wait: { handle, condition: 'tui-idle', satisfied: true, status: 'running' } } });
    break;
  }
  case 'terminal close': {
    const handle = option('--terminal');
    const terminal = state.terminals[handle];
    if (!terminal || !terminal.exists) {
      respond({ ok: false, error: { code: 'terminal_not_found', message: handle } });
      break;
    }
    terminal.closes += 1;
    terminal.exists = false;
    terminal.status = 'exited';
    respond({ ok: true, result: { close: { handle, closed: true } } });
    break;
  }
  default:
    respond({ ok: false, error: { code: 'unexpected_operation', message: operation } });
}
`;
}

function makeChildEnvironment(root: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('AO_') || key.startsWith('AGENT_ORCHESTRATOR_')) continue;
    environment[key] = value;
  }
  Object.assign(environment, {
    PATH: root,
    OPK_VITEST_HARNESS: '',
    OPK_VITEST_SKIP_CHILD_ENV_MERGE: '1',
  });
  return environment;
}

function makeObservedTransport(
  calls: Array<{ readonly args: readonly string[]; readonly response: OrcaJsonResponse }>,
): typeof runOrcaJson {
  return <T>(args: readonly string[], options = {}) => {
    const response = runOrcaJson<T>(args, {
      ...options,
      inheritParentEnv: false,
    });
    calls.push({ args: [...args], response: response as OrcaJsonResponse });
    return response;
  };
}

function requireSuccess(
  result: ReturnType<typeof executeRuntimeTaskLifecycle>,
  label: string,
): RuntimeTaskLifecycleResult {
  if (!('status' in result) || result.status !== 'ok') {
    throw new Error(`${label} lifecycle failed: ${JSON.stringify(result)}`);
  }
  return result;
}

function runLifecycle(
  adapter: OrcaTaskRuntimeAdapter,
  root: string,
  title: string,
  prompt: string,
): RuntimeTaskLifecycleResult {
  return requireSuccess(executeRuntimeTaskLifecycle({
    adapter,
    title,
    command: 'cursor-agent',
    prompt,
    observationWindowMs: 1_000,
    options: { cwd: root, timeoutMs: 5_000 },
    acquireClaim: () => ({ ok: true }),
  }), title);
}

function main(): void {
  const root = mkdtempSync(join(process.cwd(), '.issue-1250-orca-hermetic-'));
  const fixturePath = join(root, 'orca-hermetic.mjs');
  const statePath = join(root, 'state.json');
  const capturePath = join(root, 'capture.json');
  const nativeCalls: Array<{
    readonly args: readonly string[];
    readonly response: OrcaJsonResponse;
  }> = [];

  try {
    writeFileSync(
      fixturePath,
      hermeticTwoLifecycleFixture(statePath, capturePath, root),
      'utf8',
    );
    chmodSync(fixturePath, 0o755);

    const adapter = new OrcaTaskRuntimeAdapter({
      cwd: root,
      env: makeChildEnvironment(root),
      executable: fixturePath,
      runJson: makeObservedTransport(nativeCalls),
      timeoutMs: 5_000,
    });
    const first = runLifecycle(
      adapter,
      root,
      'issue-1250-lifecycle-a',
      'implement task A',
    );
    const second = runLifecycle(
      adapter,
      root,
      'issue-1250-lifecycle-b',
      'implement task B',
    );

    assert.equal(first.worker.title, 'issue-1250-lifecycle-a');
    assert.equal(second.worker.title, 'issue-1250-lifecycle-b');
    assert.notEqual(first.worker.identity.id, second.worker.identity.id);
    assert.notEqual(first.worker.identity.generation, second.worker.identity.generation);
    assert.ok(first.lines.includes('implement task A'));
    assert.ok(second.lines.includes('implement task B'));
    assert.equal(first.liveness, 'idle');
    assert.equal(second.liveness, 'idle');

    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      terminals: Record<string, {
        title: string;
        dispatches: number;
        closes: number;
        exists: boolean;
      }>;
      operations: string[];
      captures: Array<{
        forbiddenEnvironment: string[];
        pathEntries: string[];
        expectedPath: string;
        legacyAdapterLoaded: boolean;
      }>;
    };
    const terminals = Object.values(state.terminals)
      .sort((left, right) => left.title.localeCompare(right.title));
    assert.deepEqual(
      terminals.map((terminal) => terminal.title),
      ['issue-1250-lifecycle-a', 'issue-1250-lifecycle-b'],
    );
    assert.ok(terminals.every((terminal) => terminal.dispatches === 1));
    assert.ok(terminals.every((terminal) => terminal.closes === 1));
    assert.ok(terminals.every((terminal) => !terminal.exists));
    assert.equal(state.operations.filter((value) => value === 'terminal create').length, 2);
    assert.equal(state.operations.filter((value) => value === 'terminal send').length, 2);
    assert.equal(state.operations.filter((value) => value === 'terminal close').length, 2);
    assert.ok(state.captures.length > 0);
    assert.ok(state.captures.every((capture) => (
      capture.forbiddenEnvironment.length === 0
      && capture.pathEntries.length === 1
      && capture.pathEntries[0] === root
      && capture.expectedPath === root
      && !capture.legacyAdapterLoaded
    )));

    process.stdout.write(`${JSON.stringify({
      status: 'pass',
      first: first.worker.identity,
      second: second.worker.identity,
      operations: state.operations,
    })}\n`);
  } catch (error) {
    const capture = existsSync(capturePath)
      ? readFileSync(capturePath, 'utf8').trim()
      : 'capture_missing';
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}; native=${JSON.stringify(nativeCalls)}; capture=${capture}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main();
