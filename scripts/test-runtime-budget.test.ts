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

  it.each([
    {
      name: 'fails per-file budget on file wall time when assertion durations are short',
      tempPrefix: 'runtime-budget-file-wall-',
      payload: {
        testResults: [
          {
            name: 'scripts/setup-heavy.test.ts',
            startTime: 1_000,
            endTime: 516_000,
            assertionResults: [
              { ancestorTitles: ['suite'], title: 'fast case', duration: 40, status: 'passed' },
            ],
          },
        ],
      },
      expectedStatus: 1,
      expectedDiagnostic: /slow file: scripts\/setup-heavy\.test\.ts took 515000ms file wall time/i,
    },
    {
      name: 'aggregates repeated assertion durations by normalized file path before enforcing the per-file budget',
      tempPrefix: 'runtime-budget-merged-file-',
      payload: {
        testResults: Array.from({ length: 5 }, (_, index) => ({
          name: index === 0 ? 'scripts\\per-test-isolated.test.ts' : 'scripts/per-test-isolated.test.ts',
          startTime: 0,
          endTime: 110_000,
          assertionResults: [
            {
              ancestorTitles: ['isolated suite'],
              title: `case ${index + 1}`,
              duration: 110_000,
              status: 'passed',
            },
          ],
        })),
      },
      expectedStatus: 1,
      expectedDiagnostic:
        /slow file: scripts\/per-test-isolated\.test\.ts took 550000ms merged assertion duration plus one invocation overhead across 5 test\(s\)/i,
    },
    {
      name: 'preserves one setup and hook overhead while removing repeated process boot time',
      tempPrefix: 'runtime-budget-merged-setup-',
      payload: {
        testResults: Array.from({ length: 5 }, (_, index) => ({
          name: 'scripts/setup-and-tests.test.ts',
          startTime: 0,
          endTime: 500_000,
          assertionResults: [
            {
              ancestorTitles: ['isolated suite'],
              title: `setup-sensitive case ${index + 1}`,
              duration: 20_000,
              status: 'passed',
            },
          ],
        })),
      },
      expectedStatus: 1,
      expectedDiagnostic:
        /slow file: scripts\/setup-and-tests\.test\.ts took 580000ms merged assertion duration plus one invocation overhead across 5 test\(s\)/i,
    },
    {
      name: 'does not count repeated isolated Vitest boot time as file test duration',
      tempPrefix: 'runtime-budget-isolate-boot-',
      payload: {
        testResults: Array.from({ length: 5 }, (_, index) => ({
          name: 'scripts/per-test-isolated.test.ts',
          startTime: 0,
          endTime: 110_000,
          assertionResults: [
            {
              ancestorTitles: ['isolated suite'],
              title: `short case ${index + 1}`,
              duration: 1_000,
              status: 'passed',
            },
          ],
        })),
      },
      expectedStatus: 0,
      expectedDiagnostic: null,
    },
    {
      name: 'fails closed on repeated file-wall entries without assertion records',
      tempPrefix: 'runtime-budget-merged-wall-fallback-',
      payload: {
        testResults: Array.from({ length: 5 }, () => ({
          name: 'scripts/per-test-isolated.test.ts',
          startTime: 0,
          endTime: 110_000,
          assertionResults: [],
        })),
      },
      expectedStatus: 1,
      expectedDiagnostic:
        /slow file: scripts\/per-test-isolated\.test\.ts took 550000ms merged file wall time across 0 test\(s\)/i,
    },
  ])('$name', ({ tempPrefix, payload, expectedStatus, expectedDiagnostic }) => {
    const dir = mkdtempSync(join(tmpdir(), tempPrefix));
    const report = join(dir, 'report.json');
    writeFileSync(report, JSON.stringify(payload));
    const result = spawnSync(process.execPath, [enforcer, report], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    rmSync(dir, { recursive: true, force: true });
    expect(result.status).toBe(expectedStatus);
    if (expectedDiagnostic) {
      expect(result.stderr).toMatch(expectedDiagnostic);
    } else {
      expect(result.stdout).toMatch(/runtime budget OK/i);
      expect(result.stderr).not.toMatch(/slow file:/i);
    }
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
