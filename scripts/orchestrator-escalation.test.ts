// @vitest-ci-lane light
import { describe, expect, it } from 'vitest';
import { runProcess } from './kernel/subprocess.ts';

describe('terminal orchestrator escalation authority', () => {
  it('proves scheduler escalation reaches only the TypeScript operator-publication seam', async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ['--experimental-strip-types', 'scripts/pr2-foundation/fleet-escalation-proof.ts'],
      cwd: process.cwd(),
      inheritParentEnv: true,
      allowEmptyStdout: false,
      timeoutMs: 30_000,
    });
    expect(result.ok, result.stderr || result.error).toBe(true);
    const proof = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(proof).toMatchObject({
      schema: 'fleet-escalation-proof/v1',
      producer: 'orchestrator-pack',
      expected: 'operator-escalation-only',
      productionBoundary: 'scheduler-to-current-operator-publication-seam',
      aoOrPowerShellCalls: 0,
      retryAuthority: 'none',
    });
  });
});
