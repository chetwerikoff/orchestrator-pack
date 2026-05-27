import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const declareScript = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'bin',
  'declare.ts',
);

describe('declare CLI entrypoint', () => {
  it('handles direct invocation without crashing on argv path comparison', () => {
    try {
      execFileSync(process.execPath, ['--import', 'tsx', declareScript, '--help'], {
        encoding: 'utf8',
      });
      throw new Error('expected ao-declare --help to exit with code 1');
    } catch (error) {
      const execError = error as NodeJS.ErrnoException & {
        stderr?: string | Buffer;
        status?: number;
      };
      const stderr = String(execError.stderr ?? '');
      expect(stderr).toContain('Usage: ao-declare');
      expect(stderr).not.toContain('ERR_INVALID_URL');
      expect(execError.status).toBe(1);
    }
  });
});
