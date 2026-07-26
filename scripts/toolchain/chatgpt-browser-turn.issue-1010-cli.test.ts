import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runProcessSync } from '../kernel/subprocess.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = join(repoRoot, 'scripts', 'chatgpt-browser-turn.ts');

describe('issue 1010 CLI rejection handling', () => {
  it('keeps unsupported turn options inside the structured runCli error path', () => {
    const result = runProcessSync({
      command: process.execPath,
      args: ['--experimental-strip-types', entry, 'turn', '--unsupported-option', 'value'],
      cwd: repoRoot,
      inheritParentEnv: true,
    });

    expect(result.exitCode).toBe(22);
    expect(result.stderr).toBe('');
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      schema: 'control-result/v1',
      operation: 'status/list',
      state: 'driver_error',
      configured_profile_key: 'profile-unresolved',
      cause: 'command_failed',
    });
  });
});
