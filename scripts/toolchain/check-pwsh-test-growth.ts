import { resolve } from 'node:path';
import {
  comparePowerShellBootBaseline,
  discoverPowerShellBootTestGrowth,
  discoverPowerShellBootTests,
  makePowerShellBootBaseline,
  type PowerShellBootBaseline,
} from '#opk-toolchain/powershell-child-policy';
import { isDirectExecution, readJsonFile, writeVersionOneBaseline } from '#opk-toolchain/baseline-io';

export async function checkPowerShellTestGrowth(repoRoot: string): Promise<string[]> {
  const baseline = readJsonFile<PowerShellBootBaseline>(repoRoot, 'scripts/toolchain/powershell-child-tests.json');
  const comparison = comparePowerShellBootBaseline(discoverPowerShellBootTests(repoRoot), baseline);
  const growth = await discoverPowerShellBootTestGrowth(repoRoot);
  const growthPaths = new Set(growth.map((entry) => entry.path));
  return [
    ...growth.map((entry) => `${entry.path}: unapproved PowerShell child test (${entry.mechanisms.join(', ')})`),
    ...comparison.added
      .filter((entry) => !growthPaths.has(entry.path))
      .map((entry) => `${entry.path}: PowerShell child test is missing a baseline entry (${entry.mechanisms.join(', ')})`),
    ...comparison.stale.map((entry) => `${entry.path}: stale PowerShell child-test baseline entry`),
  ];
}

export function writePowerShellTestBaseline(repoRoot: string): void {
  const path = resolve(repoRoot, 'scripts/toolchain/powershell-child-tests.json');
  const baseline = makePowerShellBootBaseline(discoverPowerShellBootTests(repoRoot));
  writeVersionOneBaseline(path, baseline.entries);
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  const repoRoot = process.cwd();
  if (process.argv.includes('--write-baseline')) {
    writePowerShellTestBaseline(repoRoot);
    process.stdout.write('Wrote PowerShell child-test baseline.\n');
  } else {
    const failures = await checkPowerShellTestGrowth(repoRoot);
    if (failures.length > 0) {
      for (const failure of failures) process.stderr.write(`${failure}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write('PowerShell child-test baseline is unchanged.\n');
    }
  }
}
