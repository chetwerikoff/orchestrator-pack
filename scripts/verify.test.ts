import { describe, expect, it } from 'vitest';
import { evaluateReusableTrackedPaths } from './verify.ts';

describe('Issue #1415 Node verification authority', () => {
  it('preserves reusable allowlist and forbidden-path behavior without PowerShell', () => {
    expect(evaluateReusableTrackedPaths(['AGENTS.md', 'scripts/verify.ts', 'docs/readme.md'])).toEqual([]);
    expect(evaluateReusableTrackedPaths(['packages/core/private.ts', '.env', 'random.bin'])).toEqual([
      'packages/core/private.ts :: forbidden local/runtime/secret/upstream artifact pattern',
      '.env :: forbidden local/runtime/secret/upstream artifact pattern',
      'random.bin :: not in reusable pack allowlist',
    ]);
  });

  it('preserves the legacy exception semantics without widening the allowlist', () => {
    expect(evaluateReusableTrackedPaths(['.env.example', 'plugins/demo/.env.example'])).toEqual([
      '.env.example :: not in reusable pack allowlist',
    ]);
  });
});
