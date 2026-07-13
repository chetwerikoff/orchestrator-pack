import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  comparePowerShellBootBaseline,
  discoverPowerShellBootTests,
  makePowerShellBootBaseline,
  type PowerShellBootBaseline,
} from '#opk-toolchain/powershell-child-policy';

export function checkPowerShellTestGrowth(repoRoot: string): string[] {
  const baselinePath = resolve(repoRoot, 'scripts/toolchain/powershell-child-tests.json');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as PowerShellBootBaseline;
  const comparison = comparePowerShellBootBaseline(discoverPowerShellBootTests(repoRoot), baseline);
  return [
    ...comparison.added.map((entry) => `${entry.path}: unapproved PowerShell child test (${entry.mechanisms.join(', ')})`),
    ...comparison.stale.map((entry) => `${entry.path}: stale PowerShell child-test baseline entry`),
  ];
}

export function writePowerShellTestBaseline(repoRoot: string): void {
  const path = resolve(repoRoot, 'scripts/toolchain/powershell-child-tests.json');
  const baseline = makePowerShellBootBaseline(discoverPowerShellBootTests(repoRoot));
  const entries = baseline.entries.map((entry, index) =>
    `    ${JSON.stringify(entry)}${index === baseline.entries.length - 1 ? '' : ','}`,
  );
  writeFileSync(path, ['{', '  "version": 1,', '  "entries": [', ...entries, '  ]', '}', ''].join('\n'));
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMain()) {
  const repoRoot = process.cwd();
  if (process.argv.includes('--write-baseline')) {
    writePowerShellTestBaseline(repoRoot);
    process.stdout.write('Wrote PowerShell child-test baseline.\n');
  } else {
    const failures = checkPowerShellTestGrowth(repoRoot);
    if (failures.length > 0) {
      for (const failure of failures) process.stderr.write(`${failure}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write('PowerShell child-test baseline is unchanged.\n');
    }
  }
}
