import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcess } from '../kernel/subprocess.ts';

describe.skipIf(process.env.OPK_VITEST_PRE_TOPOLOGY_MEASUREMENT === '1')('[AC8] required external mutation CI', () => {
  it.skipIf(process.env.OPK_CONTRACT_MUTATIONS_ALREADY_RUN === '1')(
    'executes the real npm mutation command as an external red/green process',
    async () => {
      const result = await runProcess({
        command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
        args: ['run', 'test:contract-mutations'],
        cwd: path.resolve('.'),
        inheritParentEnv: true,
        env: { OPK_CONTRACT_MUTATION_CI_NESTED: '1' },
        allowEmptyStdout: false,
        timeoutMs: 10 * 60 * 1_000,
      });
      expect(result.ok, result.stderr || result.stdout || result.error).toBe(true);
      expect(result.stdout).toContain('"mutationRunner":{"result":"externally-grounded"}');
    },
    11 * 60 * 1_000,
  );
});
