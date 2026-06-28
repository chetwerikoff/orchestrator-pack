import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..');
const enforcer = join(repoRoot, 'scripts/enforce-vitest-runtime-budget.mjs');
const configPath = join(repoRoot, 'scripts/test-runtime-budget.config.json');

describe('test runtime budget guard (Issue #488)', () => {
  it('passes when all tests and files are within configured budgets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runtime-budget-pass-'));
    const report = join(dir, 'report.json');
    writeFileSync(
      report,
      JSON.stringify({
        testResults: [
          {
            name: 'scripts/example.test.ts',
            assertionResults: [
              { ancestorTitles: ['suite'], title: 'fast case', duration: 120, status: 'passed' },
            ],
          },
        ],
      }),
    );
    const result = spawnSync(process.execPath, [enforcer, report], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    rmSync(dir, { recursive: true, force: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/runtime budget OK/i);
  });

  it('fails with actionable slow test and slow file messages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runtime-budget-fail-'));
    const report = join(dir, 'report.json');
    writeFileSync(
      report,
      JSON.stringify({
        testResults: [
          {
            name: 'scripts/slow-example.test.ts',
            startTime: 0,
            endTime: 520_000,
            assertionResults: [
              { ancestorTitles: ['suite'], title: 'slow case', duration: 250_000, status: 'passed' },
              { ancestorTitles: ['suite'], title: 'another slow case', duration: 250_000, status: 'passed' },
            ],
          },
        ],
      }),
    );
    const result = spawnSync(process.execPath, [enforcer, report], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    rmSync(dir, { recursive: true, force: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/slow test: scripts\/slow-example\.test\.ts > suite > slow case/i);
    expect(result.stderr).toMatch(/slow file: scripts\/slow-example\.test\.ts took 520000ms file wall time/i);
    expect(result.stderr).toMatch(/test-runtime-budget\.config\.json/i);
  });

  it('fails per-file budget on file wall time when assertion durations are short', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runtime-budget-file-wall-'));
    const report = join(dir, 'report.json');
    writeFileSync(
      report,
      JSON.stringify({
        testResults: [
          {
            name: 'scripts/setup-heavy.test.ts',
            startTime: 1_000,
            endTime: 501_000,
            assertionResults: [
              { ancestorTitles: ['suite'], title: 'fast case', duration: 40, status: 'passed' },
            ],
          },
        ],
      }),
    );
    const result = spawnSync(process.execPath, [enforcer, report], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    rmSync(dir, { recursive: true, force: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/slow file: scripts\/setup-heavy\.test\.ts took 500000ms file wall time/i);
    expect(result.stderr).not.toMatch(/slow test:/);
  });

  it('documents adjustable thresholds in config', () => {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.perTestMs).toBeGreaterThan(0);
    expect(config.perFileMs).toBeGreaterThan(0);
    expect(config.notes?.perTestMs).toBeTruthy();
    expect(config.notes?.perFileMs).toBeTruthy();
  });
});
