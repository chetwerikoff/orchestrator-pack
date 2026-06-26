import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function runReviewReadySeedFixtureRunner(
  runnerScript: string,
  fixtureDir: string,
  fixtureName: string,
): { expected: string; ok: boolean; detail: string } {
  const stdout = execFileSync(
    'pwsh',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runnerScript, '-FixturePath', path.join(fixtureDir, fixtureName)],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
  ).trim();
  return JSON.parse(stdout) as { expected: string; ok: boolean; detail: string };
}
