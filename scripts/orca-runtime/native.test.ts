import { describe, expect, it } from 'vitest';
import {
  ORCA_ORCHESTRATION_FULL_SUBCOMMANDS,
  orcaJsonArgv,
  runOrcaJson,
} from './native.ts';

// Orca 1.4.247 prints concise JSON by default for every `orchestration` subcommand that has --full.
const supported = [
  'coordinator-start', 'coordinator-stop', 'dispatch-show', 'gate-create', 'gate-list',
  'gate-resolve', 'request-show', 'run-create', 'run-current', 'run-list', 'run-show', 'run-use',
  'task-create', 'task-list', 'task-update', 'worker-abandon', 'worker-keep-open', 'worker-list',
  'worker-read', 'worker-release', 'worker-show', 'worker-start', 'worker-stop',
];

describe('Issue #2784 Orca orchestration --full argv', () => {
  it('lists exactly the supported subcommands', () => {
    expect([...ORCA_ORCHESTRATION_FULL_SUBCOMMANDS].sort()).toEqual([...supported].sort());
  });

  it.each(supported)('orcaJsonArgv appends --full before --json for %s', (subcommand) => {
    expect(orcaJsonArgv(['orchestration', subcommand, '--id', 'x'])).toEqual([
      'orchestration', subcommand, '--id', 'x', '--full', '--json',
    ]);
  });

  it('does not duplicate --full and leaves unsupported commands untouched', () => {
    expect(orcaJsonArgv(['orchestration', 'run-show', '--full'])).toEqual([
      'orchestration', 'run-show', '--full', '--json',
    ]);
    expect(orcaJsonArgv(['orchestration', 'check', '--peek'])).toEqual(['orchestration', 'check', '--peek', '--json']);
    expect(orcaJsonArgv(['orchestration', 'send', '--run', 'r'])).toEqual(['orchestration', 'send', '--run', 'r', '--json']);
    expect(orcaJsonArgv(['terminal', 'list'])).toEqual(['terminal', 'list', '--json']);
    expect(orcaJsonArgv(['worktree', 'show'])).toEqual(['worktree', 'show', '--json']);
  });

  it('runOrcaJson requests --full and parses a full-record worker-show', () => {
    const argvSeen: string[][] = [];
    const response = runOrcaJson<{ dispatch: { id: string; status: string } }>(
      ['orchestration', 'worker-show', '--dispatch', 'ctx_1'],
      {
        executable: 'orca',
        runner: ((_cmd: string, argv: string[]) => {
          argvSeen.push([...argv]);
          return {
            status: 0, signal: null, stderr: '',
            stdout: JSON.stringify({ ok: true, result: { dispatch: { id: 'ctx_1', status: 'dispatched' } } }),
          };
        }) as never,
      },
    );
    expect(argvSeen).toEqual([['orchestration', 'worker-show', '--dispatch', 'ctx_1', '--full', '--json']]);
    expect(response).toMatchObject({ ok: true, result: { dispatch: { id: 'ctx_1', status: 'dispatched' } } });
  });
});
