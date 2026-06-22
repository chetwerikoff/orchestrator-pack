import { describe, expect, it } from 'vitest';
import { isCommandSafe, resolveAllowlistedCommand } from './lib/reverify-command-resolution.js';
import { loadReverifyAllowlistConfig } from './lib/reverify-allowlist-config.js';

const packRoot = process.cwd();

describe('reverify allowlist config (Issue #376)', () => {
  it('merges production command registrations into the effective allowlist', () => {
    const config = loadReverifyAllowlistConfig();
    expect(config.trustedCommandPrefixes).toContain('npm test -- legacy-list-guard');
    expect(config.trustedCommandPrefixes).toContain('node scripts/run-contract-evidence-legacy-list-guard.mjs');
    expect(config.npmProofIndependentCommands['npm test -- legacy-list-guard']).toBe(
      'node scripts/run-contract-evidence-legacy-list-guard.mjs',
    );
  });

  it('allows production legacy-list-guard npm proof command', () => {
    expect(isCommandSafe('npm test -- legacy-list-guard', packRoot)).toBe(true);
    const resolved = resolveAllowlistedCommand('npm test -- legacy-list-guard', { repoRoot: packRoot });
    expect(resolved?.allowlistId).toBe('npm test -- legacy-list-guard');
    expect(resolved?.args?.[2]).toBe('legacy-list-guard');
  });

  it('keeps checkpoint fixture npm proofs allowlisted', () => {
    expect(isCommandSafe('npm test -- reverify', packRoot)).toBe(true);
    expect(isCommandSafe('npm test -- contract-evidence-reverify', packRoot)).toBe(true);
  });
});
