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
  it('removes every foundation-owned docs path and retains one provenance-bound TS port', () => {
    for (const source of FOUNDATION_DOC_ROWS) {
      expect(existsSync(path.resolve(source)), source).toBe(false);
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
});
