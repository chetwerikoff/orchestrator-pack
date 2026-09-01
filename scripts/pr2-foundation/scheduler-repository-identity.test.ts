import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ProcessResult } from '../kernel/subprocess.ts';
import {
  liveCandidateRepository,
  repositorySlugFromRemote,
  resolveRepositoryFromRepoRoot,
  schedulerProcessFailureDiagnostic,
} from './scheduler.ts';

function failedProcess(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    outcome: 'exit',
    ok: false,
    exitCode: 7,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    cancelled: false,
    ...overrides,
  };
}

describe('scheduler repository identity', () => {
  it('never fills or rewrites a live row repository identity', () => {
    expect(liveCandidateRepository({ repoSlug: '' }, 'chetwerikoff/orchestrator-pack')).toBe('');
    expect(liveCandidateRepository({ repoSlug: 'other/repository' }, 'chetwerikoff/orchestrator-pack')).toBe('');
    expect(liveCandidateRepository({ repoSlug: 'chetwerikoff/orchestrator-pack' }, 'chetwerikoff/orchestrator-pack'))
      .toBe('chetwerikoff/orchestrator-pack');
  });

  it('normalizes observed GitHub remotes', () => {
    expect(repositorySlugFromRemote('git@github.com:chetwerikoff/orchestrator-pack.git'))
      .toBe('chetwerikoff/orchestrator-pack');
    expect(repositorySlugFromRemote('https://github.com/chetwerikoff/orchestrator-pack'))
      .toBe('chetwerikoff/orchestrator-pack');
    expect(() => repositorySlugFromRemote('file:///tmp/orchestrator-pack'))
      .toThrow('scheduler_repository_identity_unresolved');
  });

  it('resolves the checked-out repository from the pack-owned config', async () => {
    await expect(resolveRepositoryFromRepoRoot(process.cwd()))
      .resolves.toBe('chetwerikoff/orchestrator-pack');
  });

  it('does not use the fragile external remote lookup in production startup', () => {
    const source = readFileSync(new URL('./scheduler.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("'remote', 'get-url', 'origin'");
  });

  it('retains safe ProcessResult diagnostics for timeout, signal, empty stdout, and nonzero exit', () => {
    const cases: Array<[string, Partial<ProcessResult>, string[]]> = [
      ['timeout', { outcome: 'timeout', exitCode: null, timedOut: true }, ['outcome=timeout', 'timedOut=true']],
      ['signal', { outcome: 'signal', exitCode: null, signal: 'SIGTERM' }, ['outcome=signal', 'signal=SIGTERM']],
      ['empty stdout', { stdout: '', stderr: '', error: undefined }, ['stderr=<empty>', 'error=<none>']],
      ['nonzero exit', { outcome: 'exit', exitCode: 7, stderr: 'origin unavailable' }, ['outcome=exit', 'exitCode=7', 'stderr=origin unavailable']],
    ];
    for (const [name, overrides, expected] of cases) {
      const diagnostic = schedulerProcessFailureDiagnostic(failedProcess(overrides));
      for (const field of expected) expect(diagnostic, name).toContain(field);
      expect(diagnostic).toContain('cancelled=false');
    }
  });
});
