import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FOUNDATION_DOC_ROWS,
  FOUNDATION_LINT_SUPPRESSION_CONFIG_PATH,
} from './contracts.ts';

const runtimeSources = FOUNDATION_DOC_ROWS.filter((file) => !file.endsWith('.d.mts'));

function targetFor(source: string): string {
  const basename = path.posix.basename(source)
    .replace(/\.d\.mts$/, '.d.ts')
    .replace(/\.mjs$/, '.ts');
  return path.posix.join('scripts', 'pr2-foundation', 'terminalized', basename);
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

  it('limits the justified lint suppressions to the exact sixteen dormant mirror pairs', () => {
    const config = JSON.parse(readFileSync(
      path.resolve(FOUNDATION_LINT_SUPPRESSION_CONFIG_PATH),
      'utf8',
    )) as {
      excludePaths: string[];
      suppressions: Array<{ rule: string; files: string[]; reason: string }>;
      [key: string]: unknown;
    };
    const { suppressions, ...nonSuppressionConfig } = config;
    const nonSuppressionDigest = createHash('sha256')
      .update(JSON.stringify(nonSuppressionConfig))
      .digest('hex');
    const expectedSuppressions = FOUNDATION_DOC_ROWS.map((source) => ({
      rule: 'duplicate-literal',
      reason: 'Issue #923 migration parity until draft 315; remove at cutover',
      files: [source, targetFor(source)],
    }));
    const suppressionKey = (entry: { files: string[] }): string => entry.files.join('\0');

    expect(nonSuppressionDigest).toBe('b7e8863fb2bfdcf4f9c3c7e5f393ebe810880b158362fb50cfd37cb2d084eb12');
    expect(config.excludePaths).not.toContain('scripts/pr2-foundation/terminalized/**');
    expect([...suppressions].sort((left, right) => suppressionKey(left).localeCompare(suppressionKey(right))))
      .toEqual([...expectedSuppressions].sort((left, right) => suppressionKey(left).localeCompare(suppressionKey(right))));
    for (const suppression of suppressions) {
      expect(suppression.files).toHaveLength(2);
      const hasWildcard = suppression.files.some((file) =>
        file.includes('*') || file.includes('?') || file.includes('['));
      expect(hasWildcard, suppression.files.join(' | ')).toBe(false);
    }
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
    expect(source).not.toContain("join(packRoot, 'scripts', 'pr2-foundation', 'terminalized'");
    expect(source).not.toContain('worker-report-store.ts');
    expect(existsSync(path.resolve(
      'scripts/pr2-foundation/terminalized/worker-report-store.ts',
    ))).toBe(true);
  });

  it('rewrites actual imports without rewriting string-based consumer inventories', () => {
    const source = readFileSync(path.resolve('scripts/session-pr-binding-resolver.test.ts'), 'utf8');
    expect(source).toContain(
      "} from './pr2-foundation/terminalized/review-trigger-reconcile.ts';",
    );
    expect(source).toContain("'docs/review-trigger-reconcile.mjs',");
    expect(source).toContain("'docs/review-finding-delivery-confirm.mjs',");
    expect(source).toContain("'docs/review-wake-trigger.mjs',");
  });
});
