// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcessSync } from './kernel/subprocess.ts';
import { buildEpochCommitCore, FileEpochAuthority } from './lib/cutover/activation-epoch-authority.ts';
import type { EpochCommitCore } from './lib/cutover/types.ts';

const packRoot = path.resolve(import.meta.dirname, '..');
const driver = path.join(packRoot, '.claude/skills/discuss-with-gpt/driver.mjs');
const roots: string[] = [];

interface Fixture {
  root: string;
  projectId: string;
  repository: string;
  stateRoot: string;
  supervisorDir: string;
  authorityPath: string;
  statusPath: string;
  stoppingPath: string;
  maintenancePath: string;
  registryPath: string;
  primaryRoot: string;
  missingDraft: string;
  env: NodeJS.ProcessEnv;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-discuss-2436-'));
  roots.push(root);
  const projectId = 'synthetic-2436';
  const repository = 'example-co/synthetic';
  const primaryRoot = path.join(root, 'synthetic-repository');
  const configHome = path.join(root, 'config');
  const stateRoot = path.join(root, 'synthetic-wake-state');
  const supervisorDir = path.join(stateRoot, 'supervisor');
  const registryPath = path.join(primaryRoot, 'target-registry.json');
  mkdirSync(primaryRoot, { recursive: true });
  mkdirSync(supervisorDir, { recursive: true });
  for (const args of [
    ['init', '--quiet', primaryRoot],
    ['-C', primaryRoot, 'remote', 'add', 'origin', 'https://github.com/example-co/synthetic.git'],
  ]) {
    const result = runProcessSync({
      command: 'git',
      args,
      inheritParentEnv: true,
    });
    if (!result.ok) throw new Error(`synthetic_git_setup_failed:${result.stderr || result.error || result.exitCode}`);
  }
  writeJson(path.join(configHome, 'orchestrator-pack', 'projects', `${projectId}.json`), {
    projectId,
    repository,
    primaryRoot,
    defaultBranch: 'main',
    orcaWorkspacePattern: 'synthetic/.*',
    orchestratorTitlePattern: 'synthetic',
    browserGpt: { projectUrl: 'https://example.test/g/synthetic' },
  });
  writeJson(registryPath, {
    schemaVersion: 2,
    requiredChildIds: ['pr2-scheduler'],
    children: [{
      id: 'pr2-scheduler', runtime: 'node', script: 'pr2-foundation/scheduler.ts',
      sideEffecting: true, cadenceSeconds: 5, stallGraceMultiplier: 14,
    }],
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: path.join(root, 'xdg-state'),
    OPK_WAKE_SUPERVISOR_STATE_DIR: stateRoot,
    OPK_PROJECT_ID: projectId,
    DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR: path.join(root, 'never-used-chrome-profile'),
  };
  delete env.DISCUSS_WITH_GPT_PROJECT_URL;
  return {
    root, projectId, repository, stateRoot, supervisorDir, registryPath, primaryRoot, env,
    authorityPath: path.join(stateRoot, 'epoch-authority.json'),
    statusPath: path.join(supervisorDir, 'typescript-supervisor-status.json'),
    stoppingPath: path.join(supervisorDir, 'stopping'),
    maintenancePath: path.join(supervisorDir, 'maintenance.epoch'),
    missingDraft: path.join(root, 'deliberately-absent-draft.md'),
  };
}

function epochCore(f: Fixture, epochId = 'epoch-2436', nonce = 'nonce-2436'): EpochCommitCore {
  return buildEpochCommitCore({
    epochId, nonce, hostId: 'synthetic-host', repoRoot: f.primaryRoot,
    installedCommitSha: 'a'.repeat(40),
    snapshotDigests: { reconcile: '1'.repeat(64), reevaluation: '2'.repeat(64), reportStateSeed: '3'.repeat(64) },
    importDigests: { reconcile: '4'.repeat(64), reevaluation: '5'.repeat(64), reportStateSeed: '6'.repeat(64) },
    registryHash: createHash('sha256').update(readFileSync(f.registryPath)).digest('hex'),
    preCommitLogDigest: '7'.repeat(64),
  });
}

function commitEpoch(f: Fixture, core = epochCore(f)): EpochCommitCore {
  const authority = new FileEpochAuthority(f.authorityPath);
  expect(authority.commit(null, core)).toEqual(core);
  expect(authority.verify(core.epochId, core.nonce)).toEqual(core);
  return core;
}

function writeBarriers(f: Fixture, epochId: string, reason = 'issue-928-cutover'): void {
  writeFileSync(f.stoppingPath, 'synthetic legacy-stop barrier\n', 'utf8');
  writeJson(f.maintenancePath, { reason, epochId, startedMs: Date.now() });
}

function committedFixture(): { f: Fixture; core: EpochCommitCore } {
  const f = fixture();
  const core = commitEpoch(f);
  writeBarriers(f, core.epochId);
  return { f, core };
}

function runAdmission(f: Fixture): { status: number | null; stdout: string; stderr: string } {
  // A nonexistent draft is a production-path tripwire: driver admission runs
  // before readFileSync(draft), and that read throws before CDP or any send.
  expect(existsSync(f.missingDraft)).toBe(false);
  const barriers = [f.stoppingPath, f.maintenancePath];
  const before = barriers.map((file) => existsSync(file) ? readFileSync(file) : null);
  const result = runProcessSync({
    command: process.execPath,
    args: [
      '--experimental-strip-types', driver,
      '--project', f.projectId, '--draft', f.missingDraft,
      '--cdp', 'http://127.0.0.1:0',
    ],
    cwd: packRoot,
    env: f.env,
    inheritParentEnv: false,
    timeoutMs: 20_000,
  });
  for (let i = 0; i < barriers.length; i += 1) {
    const file = barriers[i]!;
    const bytes = before[i];
    if (bytes === null) expect(existsSync(file)).toBe(false);
    else {
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file).equals(bytes)).toBe(true);
    }
  }
  expect(result.error).toBeUndefined();
  expect(result.outcome).toBe('exit');
  return { status: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

function expectOpen(result: ReturnType<typeof runAdmission>): void {
  expect(result.status, result.stdout + result.stderr).toBe(11);
  expect(result.stdout).toContain('DRIVER_ERROR ENOENT');
  expect(result.stdout).toContain('STATE=driver_error');
  expect(result.stdout).not.toContain('CONFIG_ERROR');
}

function expectClosed(f: Fixture, result: ReturnType<typeof runAdmission>): void {
  expect(result.status, result.stdout + result.stderr).toBe(12);
  expect(result.stdout).toContain('CONFIG_ERROR legacy_writer_barrier_active');
  expect(result.stdout).toContain('STATE=config_missing');
  expect(existsSync(path.join(f.root, '.local/state/discuss-with-gpt', f.projectId))).toBe(false);
}

describe('discuss-writer admission behind retained issue-928 barriers', () => {
  it('opens a committed epoch without any supervisor status', () => {
    const { f } = committedFixture();
    expect(existsSync(f.statusPath)).toBe(false);
    expectOpen(runAdmission(f));
  });

  it('opens a committed epoch whose recorded hashes carry the production sha256: prefix', () => {
    const f = fixture();
    const core = commitEpoch(f, { ...epochCore(f), registryHash: `sha256:${'a'.repeat(64)}` });
    writeBarriers(f, core.epochId);
    writeJson(f.statusPath, { schemaVersion: 2, epochId: core.epochId, supervisorPid: 999999999 });
    expectOpen(runAdmission(f));
  });

  it('retains the no-barrier admission', () => {
    const f = fixture();
    expectOpen(runAdmission(f));
  });

  it('refuses an uncommitted cutover', () => {
    const f = fixture();
    writeBarriers(f, epochCore(f).epochId);
    expect(new FileEpochAuthority(f.authorityPath).read().currentEpochId).toBeNull();
    expectClosed(f, runAdmission(f));
  });

  it('refuses an abandoned epoch when another epoch is authoritative', () => {
    const f = fixture();
    const old = commitEpoch(f, epochCore(f, 'epoch-previous', 'nonce-previous'));
    writeBarriers(f, 'epoch-abandoned');
    expect(new FileEpochAuthority(f.authorityPath).read().currentEpochId).toBe(old.epochId);
    expectClosed(f, runAdmission(f));
  });

  it('refuses malformed epoch authority', () => {
    const { f } = committedFixture();
    writeFileSync(f.authorityPath, '{invalid json');
    expectClosed(f, runAdmission(f));
  });

  it('refuses ordinary stop-maintenance', () => {
    const { f, core } = committedFixture();
    writeBarriers(f, core.epochId, 'ordinary-maintenance');
    expectClosed(f, runAdmission(f));
  });

  it('refuses malformed maintenance evidence', () => {
    const { f } = committedFixture();
    writeFileSync(f.maintenancePath, '{invalid json');
    expectClosed(f, runAdmission(f));
  });

  it('refuses a stopping-only barrier', () => {
    const { f } = committedFixture();
    rmSync(f.maintenancePath);
    expectClosed(f, runAdmission(f));
  });

  it('refuses a maintenance-only barrier', () => {
    const { f } = committedFixture();
    rmSync(f.stoppingPath);
    expectClosed(f, runAdmission(f));
  });
});
