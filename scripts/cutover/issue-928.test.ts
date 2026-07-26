import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';
import { buildPlanningManifest } from '../pr2a/closed-world-scanner.ts';

const repoRoot = path.resolve(process.cwd());
const D928 = [
  'scripts/orchestrator-wake-supervisor.ps1',
  'scripts/lib/Orchestrator-SideProcessSupervisor.ps1',
  'scripts/lib/Review-StartClaim.ps1',
  'scripts/review-start-claim-reaper.ps1',
];
const CLAIM_AUTHORITY = [
  'scripts/lib/review-start-claim-store.ts',
  'scripts/lib/review-start-claim-cli.ts',
  'scripts/pack-review-runner.ts',
];

function command(executable: string, args: string[], cwd = repoRoot): string {
  const result = runProcessSync({ command: executable, args, cwd, inheritParentEnv: true });
  if (!result.ok) throw new Error(`command_failed:${executable}:${result.stderr || result.error || result.exitCode}`);
  return result.stdout.trim();
}

function git(args: string[]): string {
  return command('git', ['-C', repoRoot, ...args]);
}

describe('[diagnostic][AC1] admission and closure', () => {
  it('recomputes #948 reverse closure against the merge base and has no external target-library reference', () => {
    const base = git(['merge-base', 'origin/main', 'HEAD']);
    const manifest = buildPlanningManifest(base);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.unknown).toEqual([]);
    expect(manifest.dynamicUnsupported).toEqual([]);
    const targets = new Set(['scripts/lib/Orchestrator-SideProcessSupervisor.ps1', 'scripts/lib/Review-StartClaim.ps1']);
    const external = manifest.references.filter((row) => targets.has(row.target) && !D928.includes(row.source));
    expect(external).toEqual([]);
  });
});

describe('[diagnostic][AC6] scope', () => {
  it('contains exactly the four PowerShell deletions and preserves #948 claim authority/tracked registry', () => {
    const base = git(['merge-base', 'origin/main', 'HEAD']);
    const rows = git(['diff', '--name-status', `${base}..HEAD`]).split(/\r?\n/).filter(Boolean).map((line) => {
      const [status, ...parts] = line.split('\t');
      return { status, path: parts.at(-1)! };
    });
    const powershell = rows.filter((row) => /\.(ps1|psm1|psd1)$/i.test(row.path)).sort((a, b) => a.path.localeCompare(b.path));
    expect(powershell).toEqual(D928.map((pathName) => ({ status: 'D', path: pathName })).sort((a, b) => a.path.localeCompare(b.path)));
    for (const protectedPath of CLAIM_AUTHORITY) expect(rows.some((row) => row.path === protectedPath)).toBe(false);
    expect(rows.some((row) => row.path === 'scripts/orchestrator-side-process-registry.json')).toBe(false);
    expect(rows.some((row) => row.path === 'scripts/check-side-process-launch-contract.ps1')).toBe(false);
    const newTests = rows.filter((row) => row.status === 'A' && /^scripts\/.*\.test\.ts$/.test(row.path)).map((row) => row.path);
    expect(newTests).toEqual(['scripts/cutover/issue-928.test.ts']);
  });
});
