import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcess } from '#opk-kernel/subprocess';

const repoRoot = resolve(import.meta.dirname, '../..');

function encode(relativePath: string): string {
  return Buffer.from(readFileSync(resolve(repoRoot, relativePath))).toString('base64');
}

describe('issue 830 bootstrap census export', () => {
  it('exports the pre-change enforcement surface from a real CI checkout', async () => {
    const tracked = await runProcess({
      command: 'git',
      args: ['ls-files'],
      cwd: repoRoot,
      inheritParentEnv: true,
      allowEmptyStdout: false,
    });
    expect(tracked.ok).toBe(true);

    const checkScripts = tracked.stdout
      .split(/\r?\n/u)
      .filter((path) => /^scripts\/check-.*\.ps1$/u.test(path))
      .sort();

    const payload = {
      version: 1,
      head: process.env.GITHUB_SHA ?? null,
      checkScripts,
      verifyBase64: encode('scripts/verify.ps1'),
      checkReusableBase64: encode('scripts/check-reusable.ps1'),
    };

    console.error(`OPK830_BOOTSTRAP_BEGIN\n${Buffer.from(JSON.stringify(payload)).toString('base64')}\nOPK830_BOOTSTRAP_END`);
    expect.fail('intentional one-run bootstrap export; remove after harvesting the CI payload');
  });
});
