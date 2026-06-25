import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export type FleetHarness = {
  root: string;
  auditFile: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
};

export function createGithubFleetCacheHarness(prefix = 'gh-fleet-cache-'): FleetHarness {
  const repoRoot = join(import.meta.dirname, '..');
  const fakeGh = join(repoRoot, 'scripts/fixtures/github-fleet-cache/fake-gh.sh');
  const root = mkdtempSync(join(tmpdir(), prefix));
  const auditFile = join(root, 'audit.log');
  writeFileSync(auditFile, '');
  chmodSync(fakeGh, 0o755);
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'gh'), readFileSync(fakeGh));
  chmodSync(join(binDir, 'gh'), 0o755);
  const env = {
    ...process.env,
    AO_SIDE_PROCESS_STATE_DIR: join(root, 'supervisor-state'),
    GH_FLEET_OPEN_PR_LIST_TTL_SECONDS: '30',
    GH_FLEET_TEST_AUDIT_FILE: auditFile,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  };
  return {
    root,
    auditFile,
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
