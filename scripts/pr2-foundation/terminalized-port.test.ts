import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FOUNDATION_DOC_ROWS } from './contracts.ts';

const runtimeSources = FOUNDATION_DOC_ROWS.filter((file) => !file.endsWith('.d.mts'));

function targetFor(source: string): string {
  const basename = path.basename(source).replace(/\.mjs$/, '.ts');
  return path.join('scripts', 'pr2-foundation', 'terminalized', basename);
}

describe('[AC7] terminalized executable docs TypeScript ports', () => {
  it('terminalizes ownership while preserving legacy live compatibility until cutover', () => {
    for (const source of FOUNDATION_DOC_ROWS) {
      expect(existsSync(path.resolve(source)), source).toBe(true);
      expect(readFileSync(path.resolve(source), 'utf8'), source)
        .toMatch(/^\/\/ Issue #923 foundation-terminalized:/);
    }
    for (const source of runtimeSources) {
      const target = targetFor(source);
      expect(existsSync(path.resolve(target)), target).toBe(true);
      const text = readFileSync(path.resolve(target), 'utf8');
      expect(text, target).toContain(`Ported from ${source} blob `);
      expect(text, target).not.toContain(`from './${path.basename(source)}'`);
    }
    const declarationTarget = path.resolve(
      'scripts/pr2-foundation/terminalized/events-optional-consumer-signal-recovery.d.ts',
    );
    expect(existsSync(declarationTarget)).toBe(true);
    expect(readFileSync(declarationTarget, 'utf8')).toContain(
      'Ported from docs/events-optional-consumer-signal-recovery.d.mts blob ',
    );
  });

  it('keeps cutover bytes untouched and leaves no temporary workflow in the final tree', () => {
    const cutoverSource = readFileSync(path.resolve('scripts/reaction-config-messages.mjs'), 'utf8');
    expect(cutoverSource).toContain("from '../docs/worker-message-dispatch-observe.mjs'");
    expect(cutoverSource).not.toContain('scripts/pr2-foundation/terminalized');
    for (const workflow of [
      '.github/workflows/issue-923-scope-type-diagnostic.yml',
      '.github/workflows/issue-923-final-cleanup-helper.yml',
      '.github/workflows/issue-923-final-diagnostics.yml',
      '.github/workflows/issue-923-regression-diagnostics.yml',
    ]) {
      expect(existsSync(path.resolve(workflow)), workflow).toBe(false);
    }
  });

  it('keeps the worker-report PowerShell edge byte-compatible and the TypeScript authority dormant', () => {
    const wrapper = readFileSync(path.resolve('scripts/lib/WorkerReportStore.ps1'), 'utf8');
    expect(wrapper).toContain("'docs/worker-report-store.mjs'");
    expect(wrapper).toContain(
      'Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:WorkerReportStoreCli',
    );
    expect(wrapper).not.toContain('scripts/lib/Invoke-TypeScriptCli.ts');
    expect(wrapper).not.toContain("'--experimental-strip-types'");
    expect(wrapper).not.toContain('Write-MechanicalTransportPrivateFile');
    expect(existsSync(path.resolve(
      'scripts/pr2-foundation/terminalized/worker-report-store.ts',
    ))).toBe(true);
  });

  it('keeps live sibling readiness byte-compatible and the TypeScript port dormant', () => {
    const source = readFileSync(path.resolve('scripts/lib/worker-status-store.mjs'), 'utf8');
    expect(source).toContain('workerReportStorePresent = reportStorePath');
    expect(source).toContain("existsSync(join(docsDir, 'worker-report-store.mjs'))");
    expect(source).not.toContain("'terminalized',
    'worker-report-store.ts'");
    expect(existsSync(path.resolve(
      'scripts/pr2-foundation/terminalized/worker-report-store.ts',
    ))).toBe(true);
  });
});
