import { resolveOrcaExecutable } from './orca-runtime/native.ts';

export interface RuntimeCommand {
  readonly command: string;
  readonly args: readonly string[];
}

const executable = resolveOrcaExecutable();

/** The only runtime-specific command surface used by worktree-teardown.ts. */
export const WORKTREE_TEARDOWN_RUNTIME_PROFILE = Object.freeze({
  worktrees: (): RuntimeCommand => ({
    command: executable,
    args: ['worktree', 'list', '--json'],
  }),
  agents: (): RuntimeCommand => ({
    command: executable,
    args: ['worktree', 'ps', '--json'],
  }),
  terminals: (worktreePath: string): RuntimeCommand => ({
    command: executable,
    args: ['terminal', 'list', '--worktree', `path:${worktreePath}`, '--json'],
  }),
  terminals_all: (): RuntimeCommand => ({
    command: executable,
    args: ['terminal', 'list', '--json'],
  }),
  stop_terminals: (worktreePath: string): RuntimeCommand => ({
    command: executable,
    args: ['terminal', 'stop', '--worktree', `path:${worktreePath}`, '--json'],
  }),
  close_tab: (terminalHandle: string): RuntimeCommand => ({
    command: executable,
    args: ['terminal', 'close', '--terminal', terminalHandle, '--tab', '--json'],
  }),
  close_pane: (terminalHandle: string): RuntimeCommand => ({
    command: executable,
    args: ['terminal', 'close', '--terminal', terminalHandle, '--json'],
  }),
  remove_worktree: (worktreePath: string): RuntimeCommand => ({
    command: executable,
    args: ['worktree', 'rm', '--worktree', `path:${worktreePath}`, '--json'],
  }),
});
