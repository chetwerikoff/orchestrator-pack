import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { formatGateRunnerReport, main, runGateRunner } from './runner.ts';

const repoRoot = resolve(import.meta.dirname, '../..');

describe('real gate runner dispatch', () => {
  it('runs the representative ports and census as one lane', () => {
    const report = runGateRunner(repoRoot);
    expect(report.aggregate.status, formatGateRunnerReport(report)).toBe('PASS');
    expect(report.aggregate.green).toBe(true);
    expect(report.results.map((result) => result.gateId)).toEqual([
      'agent-rules-live-reference',
      'agent-rules-size-budget',
      'agent-rules-moved-content',
      'ao-capture-redaction',
      'gate-census',
    ]);
  });

  it('supports a stable per-gate CLI selection without changing the default full run', () => {
    const report = runGateRunner(repoRoot, ['agent-rules-size-budget']);
    expect(report.results.map((result) => result.gateId)).toEqual(['agent-rules-size-budget']);
    expect(report.aggregate.status).toBe('PASS');
  });

  it('honors repeated selectors and keeps gate-census runner-owned', async () => {
    const report = runGateRunner(repoRoot, ['gate-census', 'agent-rules-size-budget']);
    expect(report.results.map((result) => result.gateId)).toEqual(['agent-rules-size-budget', 'gate-census']);
    expect(report.aggregate.status).toBe('PASS');

    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      expect(await main([
        '--repo-root', repoRoot,
        '--gate', 'agent-rules-size-budget',
        '--gate', 'gate-census',
        '--json',
      ])).toBe(0);
    } finally {
      stdout.mockRestore();
    }
  });

  it('fails closed on an unknown per-gate selector', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(await main(['--repo-root', repoRoot, '--gate', 'missing-gate'])).toBe(2);
      expect(stderr).toHaveBeenCalledWith('[FAIL] gate-runner dispatch: unknown gate id(s): missing-gate\n');
    } finally {
      stderr.mockRestore();
    }
  });

  it.each([
    ['missing', ['--repo-root', repoRoot, '--gate']],
    ['empty', ['--repo-root', repoRoot, '--gate', '']],
    ['whitespace-only', ['--repo-root', repoRoot, '--gate', '   ']],
    ['missing after a valid selector', [
      '--repo-root', repoRoot,
      '--gate', 'agent-rules-size-budget',
      '--gate',
    ]],
  ])('fails closed when --gate has a %s value', async (_caseName, argv) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(await main(argv)).toBe(2);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith('[FAIL] gate-runner dispatch: --gate requires a non-empty value\n');
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
