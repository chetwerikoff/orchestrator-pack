#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '#opk-kernel/subprocess';
import { resolveMergeStableCiBase } from '../../lib/resolve-merge-stable-ci-base.mjs';
import { inspectSupervisorHeavyLaneRpcBinding } from '../../lib/validate-supervisor-heavy-lane-rpc-artifacts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(process.argv[2] ?? join(__dirname, '..', '..', '..'));
const HISTORICAL_PR_HEAD = '3a3a299cdcc0e00270b4fa2c785b98ac7fdb4992';
const HISTORICAL_MAIN = '225187b7d3507a0872fc1bf435089a7e3aa0c1d7';

async function run(command, args, options = {}) {
  const result = await runProcess({
    command,
    args,
    cwd: options.cwd,
    env: options.env ?? process.env,
    inheritParentEnv: true,
    allowEmptyStdout: true,
  });
  return {
    status: result.exitCode ?? (result.ok ? 0 : 1),
    stdout: result.stdout,
    stderr: result.stderr || result.error || '',
  };
}

async function git(cwd, args) {
  const result = await run('git', args, { cwd });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

async function initRepo(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.email', 'fixture@example.invalid']);
  await git(root, ['config', 'user.name', 'merge-blind-fixture']);
  return root;
}

async function commitAll(root, message) {
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function contextEnv(kind, baseSha = '') {
  const env = { ...process.env };
  for (const key of ['BASE_SHA', 'GITHUB_BASE_SHA', 'PR_BASE_SHA', 'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH']) {
    delete env[key];
  }
  if (kind === 'pr') {
    env.PR_BASE_SHA = baseSha;
    env.GITHUB_EVENT_NAME = 'pull_request';
  } else {
    env.GITHUB_EVENT_NAME = 'push';
  }
  return env;
}

async function withProcessEnv(env, callback) {
  const keys = ['BASE_SHA', 'GITHUB_BASE_SHA', 'PR_BASE_SHA', 'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH'];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    if (key in env) process.env[key] = env[key];
    else delete process.env[key];
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function expectSameStatus(label, pr, push, expected) {
  assert.equal(pr.status, expected, `${label} PR status; stderr=${pr.stderr}; stdout=${pr.stdout}`);
  assert.equal(push.status, expected, `${label} push status; stderr=${push.stderr}; stdout=${push.stdout}`);
  assert.equal(pr.status, push.status, `${label} PR/push verdict mismatch`);
}

async function prepareGateRepo() {
  const root = await initRepo('opk-823-gates-');
  copyFileSync(join(repoRoot, 'package.json'), join(root, 'package.json'));
  mkdirSync(join(root, 'scripts/kernel'), { recursive: true });
  copyFileSync(join(repoRoot, 'scripts/kernel/subprocess.ts'), join(root, 'scripts/kernel/subprocess.ts'));
  write(
    join(root, 'scripts/lib/Orchestrator-WakeSupervisorLease.ps1'),
    "# State-root singleton lease for wake supervisor fleet cardinality (Issue #709)\nfunction Get-OrchestratorWakeSupervisorLeasePath {}\n$lock = 'supervisor.lock'\n",
  );
  write(
    join(root, 'scripts/lib/Orchestrator-FleetHygiene.ps1'),
    "# Fleet hygiene assertions H1–H7 (Issue #711)\n$Script:FleetHygieneAssertionIds = @('H1')\nfunction Get-FleetHygieneConfig {}\n",
  );
  copyFileSync(
    join(repoRoot, 'scripts/lib/resolve-merge-stable-ci-base.mjs'),
    join(root, 'scripts/lib/resolve-merge-stable-ci-base.mjs'),
  );
  write(join(root, 'protected.txt'), 'stable\n');
  write(
    join(root, 'docs/orchestrator-message-registry.mjs'),
    `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
const [command, root, base] = process.argv.slice(2);
if (command === 'audit') process.exit(0);
if (command === 'generate-map') { console.log('stub-map'); process.exit(0); }
if (command === 'check-protected-runtime') {
  const changed = execFileSync('git', ['diff', '--name-only', base + '...HEAD'], { cwd: root, encoding: 'utf8' })
    .split(/\\r?\\n/).filter(Boolean);
  process.exit(changed.includes('protected.txt') ? 1 : 0);
}
process.exit(2);
`,
  );
  write(join(root, 'docs/orchestrator-message-map.md'), 'stub-map\n');
  const base = await commitAll(root, 'semantic prerequisites');
  write(join(root, 'unrelated.txt'), 'same binding tree, new commit identity\n');
  const head = await commitAll(root, 'unrelated change');
  await git(root, ['update-ref', 'refs/remotes/origin/main', head]);
  return { root, base, head };
}

async function verifySharedBaseParity(gateRepo) {
  const pr = await withProcessEnv(contextEnv('pr', gateRepo.base), () => resolveMergeStableCiBase(gateRepo.root));
  const push = await withProcessEnv(contextEnv('push'), () => resolveMergeStableCiBase(gateRepo.root));
  assert.equal(pr?.baseSha, gateRepo.base, 'PR context must resolve the semantic base');
  assert.equal(push?.baseSha, gateRepo.base, 'push context must reject origin/main=HEAD and use HEAD^1');
  assert.deepEqual(
    (await git(gateRepo.root, ['diff', '--name-only', `${pr.baseSha}...HEAD`])).split('\n').filter(Boolean),
    (await git(gateRepo.root, ['diff', '--name-only', `${push.baseSha}...HEAD`])).split('\n').filter(Boolean),
    'PR/push changed-file sets must match',
  );
}

async function verifyPowerShellGateParity(gateRepo) {
  const probe = await run('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']);
  if (probe.status !== 0) {
    console.warn('[SKIP] pwsh unavailable locally; Node parity proofs completed (CI wrapper itself requires pwsh)');
    return;
  }

  const sequencing = join(repoRoot, 'scripts/check-side-process-registry-709-711-sequencing.ps1');
  const messageRegistry = join(repoRoot, 'scripts/check-orchestrator-message-registry.ps1');
  const prEnv = contextEnv('pr', gateRepo.base);
  const pushEnv = contextEnv('push');

  expectSameStatus(
    'sequencing positive',
    await run('pwsh', ['-NoProfile', '-File', sequencing, gateRepo.root], { env: prEnv }),
    await run('pwsh', ['-NoProfile', '-File', sequencing, gateRepo.root], { env: pushEnv }),
    0,
  );
  expectSameStatus(
    'message registry positive',
    await run('pwsh', ['-NoProfile', '-File', messageRegistry, gateRepo.root], { env: prEnv }),
    await run('pwsh', ['-NoProfile', '-File', messageRegistry, gateRepo.root], { env: pushEnv }),
    0,
  );

  write(join(gateRepo.root, 'protected.txt'), 'genuine protected drift\n');
  write(
    join(gateRepo.root, 'scripts/lib/Orchestrator-FleetHygiene.ps1'),
    '# genuine drift removed the #711 semantic contract\n',
  );
  await commitAll(gateRepo.root, 'genuine binding drift');
  await git(gateRepo.root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

  expectSameStatus(
    'sequencing negative',
    await run('pwsh', ['-NoProfile', '-File', sequencing, gateRepo.root], { env: prEnv }),
    await run('pwsh', ['-NoProfile', '-File', sequencing, gateRepo.root], { env: pushEnv }),
    1,
  );
  expectSameStatus(
    'message registry negative',
    await run('pwsh', ['-NoProfile', '-File', messageRegistry, gateRepo.root], { env: prEnv }),
    await run('pwsh', ['-NoProfile', '-File', messageRegistry, gateRepo.root], { env: pushEnv }),
    1,
  );
}

async function verifyRpcBindingParity() {
  const root = await initRepo('opk-823-rpc-');
  const scopePath = join(root, 'scripts/lib/validate-supervisor-heavy-lane-rpc-artifacts.mjs');
  write(scopePath, '// stable binding-scope payload\n');
  write(
    join(root, 'scripts/fixtures/supervisor-test-waits-heavy-lane-rpc/manifest.json'),
    JSON.stringify({ bindingMode: 'scoped-tree-content-v1', captureCommitSha: '0'.repeat(40) }, null, 2) + '\n',
  );
  const capture = await commitAll(root, 'capture scoped tree');
  const manifestPath = join(root, 'scripts/fixtures/supervisor-test-waits-heavy-lane-rpc/manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.captureCommitSha = capture;
  write(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  await commitAll(root, 'bind metadata to capture');
  write(join(root, 'unrelated.txt'), 'merge identity changes, scope does not\n');
  await commitAll(root, 'unrelated commit');

  const pr = await withProcessEnv(contextEnv('pr', capture), () => inspectSupervisorHeavyLaneRpcBinding(root));
  const push = await withProcessEnv(contextEnv('push'), () => inspectSupervisorHeavyLaneRpcBinding(root));
  assert.equal(pr.ok, true, pr.reason);
  assert.equal(push.ok, true, push.reason);
  assert.equal(pr.captureCommitSha, push.captureCommitSha);

  write(scopePath, '// genuine binding-scope drift\n');
  await commitAll(root, 'genuine RPC scope drift');
  const prNegative = await withProcessEnv(contextEnv('pr', capture), () => inspectSupervisorHeavyLaneRpcBinding(root));
  const pushNegative = await withProcessEnv(contextEnv('push'), () => inspectSupervisorHeavyLaneRpcBinding(root));
  assert.equal(prNegative.ok, false, 'PR context must reject genuine RPC scope drift');
  assert.equal(pushNegative.ok, false, 'push context must reject genuine RPC scope drift');
  assert.deepEqual(prNegative.stalePaths, pushNegative.stalePaths);
  rmSync(root, { recursive: true, force: true });
}

const gateRepo = await prepareGateRepo();
try {
  await verifySharedBaseParity(gateRepo);
  await verifyPowerShellGateParity(gateRepo);
  await verifyRpcBindingParity();
  console.log(
    `[PASS] issue #823 PR/main parity and negative controls (historical PR ${HISTORICAL_PR_HEAD}, post-merge main ${HISTORICAL_MAIN})`,
  );
} finally {
  rmSync(gateRepo.root, { recursive: true, force: true });
}
