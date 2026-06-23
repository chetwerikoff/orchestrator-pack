import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './_test-pwsh-helpers.js';
import { withTempGitRepo } from './_test-git-fixture.js';

const bootstrapPath = path.join(repoRoot, 'scripts/autonomous-orchestrator-surface-bootstrap.sh');
const bashEnvPath = path.join(repoRoot, 'scripts/autonomous-bash-env.sh');
const scriptsDir = path.join(repoRoot, 'scripts');
const aoShimPath = path.join(scriptsDir, 'ao');

function stripBashEnvBlockers(env: NodeJS.ProcessEnv) {
  const {
    POSIXLY_CORRECT: _pc,
    SHELLOPTS: _so,
    __AO_AUTONOMOUS_SURFACE_BOOTSTRAP: _sb,
    __AO_AUTONOMOUS_BASH_INTERPOSED: _bi,
    ...rest
  } = env;
  return rest;
}


function armedBashCommand(command: string) {
  // GHA node→bash spawns may skip BASH_ENV; source bootstrap in-shell on CI while
  // keeping BASH_ENV set so local runs still exercise the env-channel contract.
  if (process.env.CI === 'true') {
    return `. ${JSON.stringify(bootstrapPath)}; ${command}`;
  }
  return command;
}

function spawnOrchestratorBash(args: string[], env: Record<string, string | undefined>, cwd = repoRoot) {
  return spawnSync('/bin/bash', ['+o', 'posix', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...stripBashEnvBlockers(process.env),
      AO_TMUX_NAME: 'opk-orchestrator',
      BASH_ENV: bootstrapPath,
      ...env,
    },
  });
}

function spawnLiveArmedBash(
  cwd: string,
  command: string,
  extraEnv: Record<string, string | undefined> = {},
) {
  return spawnOrchestratorBash(['-c', armedBashCommand(command)], extraEnv, cwd);
}

function spawnEvalHidden(
  cwd: string,
  command: string,
  extraEnv: Record<string, string | undefined> = {},
) {
  return spawnOrchestratorBash(['-O', 'extglob', '-c', 'builtin eval "$1"', 'x', armedBashCommand(command)], extraEnv, cwd);
}

function writeAoReadStub(dir: string) {
  const aoStub = path.join(dir, 'ao-stub.sh');
  writeFileSync(
    aoStub,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "spawn" ]]; then
  printf '%s\\n' "$@" > "\${AO_SPAWN_PROBE_FILE:?}"
  exit 0
fi
if [[ "\${1:-}" == "review" && "\${2:-}" == "list" && "\${3:-}" == "--json" ]]; then
  printf '[]\\n'
  exit 0
fi
if [[ "\${1:-}" == "status" && "\${2:-}" == "--json" ]]; then
  printf '{"ok":true}\\n'
  exit 0
fi
if [[ "\${1:-}" == "events" && "\${2:-}" == "list" && "\${3:-}" == "--json" ]]; then
  printf '[]\\n'
  exit 0
fi
if [[ "\${1:-}" == "send" ]]; then
  printf 'raw-send-stub\\n' >&2
  exit 0
fi
printf 'unhandled:%s\\n' "$*" >&2
exit 1
`,
  );
  chmodSync(aoStub, 0o755);
  return aoStub;
}

function writeFailClosedBootstrap(packScripts: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'autonomous-bootstrap-missing-'));
  const bootstrap = path.join(dir, 'bootstrap.sh');
  writeFileSync(
    bootstrap,
    `#!/usr/bin/env bash
[[ "\${__AO_AUTONOMOUS_SURFACE_BOOTSTRAP:-}" == "1" ]] && return 0
__AO_AUTONOMOUS_SURFACE_BOOTSTRAP=1
if [[ -n "\${AO_TMUX_NAME:-}" && "\${AO_TMUX_NAME}" == *orchestrator* ]]; then
  export AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1
fi
PACK_SCRIPTS="${packScripts.replace(/"/g, '\\"')}"
case ":\${PATH:-}:" in
  *:"\${PACK_SCRIPTS}":*) ;;
  *) export PATH="\${PACK_SCRIPTS}:\${PATH:-}" ;;
esac
INTERPOSER="\${PACK_SCRIPTS}/autonomous-bash-env.sh"
if [[ -r "\${INTERPOSER}" ]]; then
  source "\${INTERPOSER}"
fi
`,
  );
  chmodSync(bootstrap, 0o755);
  return { dir, bootstrap };
}

describe('autonomous orchestrator interposer (#406)', () => {
  it('tracks bootstrap and interposer wiring', () => {
    expect(existsSync(bootstrapPath)).toBe(true);
    expect(existsSync(bashEnvPath)).toBe(true);
    expect(statSync(bootstrapPath).mode & 0o111).toBeGreaterThan(0);
  });

  it('live arming path: bootstrap maps AO_TMUX_NAME to surface and denies spawn', () => {
    const stubDir = mkdtempSync(path.join(tmpdir(), 'autonomous-live-arm-'));
    const aoStub = writeAoReadStub(stubDir);
    const probeFile = path.join(stubDir, 'spawn-probe.txt');
    try {
      const deny = spawnLiveArmedBash(repoRoot, 'ao spawn opk-probe', {
        AO_REAL_BINARY: aoStub,
        AO_SPAWN_PROBE_FILE: probeFile,
      });
      expect(deny.status).toBe(93);
      expect(`${deny.stderr}${deny.stdout}`).toMatch(/autonomous worker spawn denied/i);
      expect(existsSync(probeFile)).toBe(false);

      const read = spawnLiveArmedBash(repoRoot, 'ao review list --json', {
        AO_REAL_BINARY: aoStub,
      });
      expect(read.status).toBe(0);
      expect(() => JSON.parse(read.stdout)).not.toThrow();
      expect(read.stderr).not.toMatch(/ao-autonomous-script|unexpected EOF/i);
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('fail-closed when bootstrap is armed but interposer file is missing', () => {
    const packCopy = mkdtempSync(path.join(tmpdir(), 'autonomous-pack-copy-'));
    try {
      const copiedScripts = path.join(packCopy, 'scripts');
      mkdirSync(copiedScripts, { recursive: true });
      cpSync(path.join(scriptsDir, 'lib'), path.join(copiedScripts, 'lib'), { recursive: true });
      for (const name of ['_resolve-pwsh.sh', 'ao', 'git', 'ao-autonomous-guard.ps1', 'git-autonomous-guard.ps1']) {
        writeFileSync(path.join(copiedScripts, name), readFileSync(path.join(scriptsDir, name)));
        if (name === 'ao' || name === 'git') {
          chmodSync(path.join(copiedScripts, name), 0o755);
        }
      }
      const { dir: bootstrapDir, bootstrap } = writeFailClosedBootstrap(copiedScripts);
      try {
        const denySpawn = spawnOrchestratorBash([path.join(packCopy, 'scripts/ao'), 'spawn', 'opk-probe'], { BASH_ENV: bootstrap });
        expect(denySpawn.status).toBe(93);
        expect(denySpawn.stderr).toMatch(/autonomous worker spawn denied/i);

        const denySend = spawnOrchestratorBash([path.join(packCopy, 'scripts/ao'), 'send', 'opk-worker', 'hi'], { BASH_ENV: bootstrap });
        expect(denySend.status).toBe(93);
        expect(denySend.stderr).toMatch(/autonomous worker nudges paused/i);
      } finally {
        rmSync(bootstrapDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(packCopy, { recursive: true, force: true });
    }
  });

  it('read-verbs stay clean on orchestrator surface through forwarder shims', () => {
    const stubDir = mkdtempSync(path.join(tmpdir(), 'autonomous-read-verbs-'));
    const aoStub = writeAoReadStub(stubDir);
    try {
      const cases = [
        ['review', 'list', '--json'],
        ['status', '--json'],
        ['events', 'list', '--json'],
      ] as const;
      for (const argv of cases) {
        const direct = spawnOrchestratorBash([aoShimPath, ...argv], {
            AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '1',
            AO_REAL_BINARY: aoStub,
          });
        expect(direct.status).toBe(0);
        expect(() => JSON.parse(direct.stdout)).not.toThrow();
        expect(direct.stderr).not.toMatch(/ao-autonomous-script|unexpected EOF/i);

        const hidden = spawnEvalHidden(repoRoot, `ao ${argv.join(' ')}`, { AO_REAL_BINARY: aoStub });
        expect(hidden.status).toBe(0);
        expect(() => JSON.parse(hidden.stdout)).not.toThrow();
        expect(hidden.stderr).not.toMatch(/ao-autonomous-script|unexpected EOF/i);
      }
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('re-prepends pack scripts after synthetic PATH reset and keeps eval-hidden behavior', () => {
    const stubDir = mkdtempSync(path.join(tmpdir(), 'autonomous-path-reset-'));
    const aoStub = writeAoReadStub(stubDir);
    const probeFile = path.join(stubDir, 'spawn-probe.txt');
    const wrapDir = mkdtempSync(path.join(tmpdir(), 'wrapdir-'));
    const hostPath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
    try {
      withTempGitRepo((dir) => {
        const denySpawn = spawnEvalHidden(dir, 'ao spawn opk-probe', {
          AO_REAL_BINARY: aoStub,
          AO_SPAWN_PROBE_FILE: probeFile,
          PATH: `${wrapDir}:${hostPath}`,
        });
        expect(denySpawn.status).toBe(93);
        expect(`${denySpawn.stderr}${denySpawn.stdout}`).toMatch(/autonomous worker spawn denied/i);

        const readGit = spawnEvalHidden(dir, 'git status --short', {
          PATH: `${wrapDir}:${hostPath}`,
        });
        expect(readGit.status).toBe(0);
      });
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
      rmSync(wrapDir, { recursive: true, force: true });
    }
  });

  it('moves pack scripts to PATH front when already present later in PATH', () => {
    if (!existsSync('/usr/bin/git')) {
      return;
    }
    withTempGitRepo((dir) => {
      const readme = path.join(dir, 'README.md');
      const hostPath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
      const buriedPath = `/usr/bin:${scriptsDir}:${hostPath}`;
      const hiddenGit = spawnEvalHidden(dir, `git checkout -- ${readme}`, {
        PATH: buriedPath,
      });
      expect(hiddenGit.status).toBe(93);
      expect(`${hiddenGit.stderr}${hiddenGit.stdout}`).toMatch(/autonomous tree-mutating git denied/i);
    });
  });

  it('ignores turn-visible AO_PWSH_BINARY on autonomous surface', () => {
    const stubDir = mkdtempSync(path.join(tmpdir(), 'autonomous-pwsh-bypass-'));
    const aoStub = writeAoReadStub(stubDir);
    const probeFile = path.join(stubDir, 'pwsh-probe.txt');
    const fakePwsh = path.join(stubDir, 'fake-pwsh');
    writeFileSync(
      fakePwsh,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" > "${probeFile}"
exit 0
`,
    );
    chmodSync(fakePwsh, 0o755);
    try {
      const spawnProbe = path.join(stubDir, 'spawn-probe.txt');
      const result = spawnEvalHidden(repoRoot, 'ao spawn opk-probe', {
        AO_REAL_BINARY: aoStub,
        AO_SPAWN_PROBE_FILE: spawnProbe,
        AO_PWSH_BINARY: fakePwsh,
      });
      expect(result.status).toBe(93);
      expect(`${result.stderr}${result.stdout}`).toMatch(/autonomous worker spawn denied/i);
      expect(existsSync(probeFile)).toBe(false);
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('orchestrator deny matrix covers flat and eval-hidden shapes', () => {
    const stubDir = mkdtempSync(path.join(tmpdir(), 'autonomous-deny-matrix-'));
    const aoStub = writeAoReadStub(stubDir);
    const probeFile = path.join(stubDir, 'spawn-probe.txt');
    try {
      withTempGitRepo((dir) => {
        const readme = path.join(dir, 'README.md');
        if (!existsSync('/usr/bin/git')) {
          return;
        }

        const flatGit = spawnLiveArmedBash(dir, `/usr/bin/git checkout -- ${readme}`);
        expect(flatGit.status).toBe(93);
        expect(`${flatGit.stderr}${flatGit.stdout}`).toMatch(/autonomous tree-mutating git denied/i);

        const hiddenGit = spawnEvalHidden(dir, `/usr/bin/git checkout -- ${readme}`);
        expect(hiddenGit.status).toBe(93);
        expect(`${hiddenGit.stderr}${hiddenGit.stdout}`).toMatch(/autonomous tree-mutating git denied/i);

        const flatSpawn = spawnLiveArmedBash(repoRoot, 'ao spawn opk-probe', {
          AO_REAL_BINARY: aoStub,
          AO_SPAWN_PROBE_FILE: probeFile,
        });
        expect(flatSpawn.status).toBe(93);
        expect(`${flatSpawn.stderr}${flatSpawn.stdout}`).toMatch(/autonomous worker spawn denied/i);

        const hiddenSpawn = spawnEvalHidden(repoRoot, 'ao spawn opk-probe', {
          AO_REAL_BINARY: aoStub,
          AO_SPAWN_PROBE_FILE: probeFile,
        });
        expect(hiddenSpawn.status).toBe(93);
        expect(`${hiddenSpawn.stderr}${hiddenSpawn.stdout}`).toMatch(/autonomous worker spawn denied/i);

        const flatSend = spawnLiveArmedBash(repoRoot, 'ao send opk-worker hi');
        expect(flatSend.status).toBe(93);
        expect(`${flatSend.stderr}${flatSend.stdout}`).toMatch(
          /autonomous_raw_worker_send_denied|autonomous worker nudges paused/i,
        );

        const hiddenSend = spawnEvalHidden(repoRoot, 'ao send opk-worker hi');
        expect(hiddenSend.status).toBe(93);
        expect(`${hiddenSend.stderr}${hiddenSend.stdout}`).toMatch(
          /autonomous_raw_worker_send_denied|autonomous worker nudges paused/i,
        );
      });
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('allow matrix: worker surface allows spawn; gated send is not raw-denied', () => {
    const stubDir = mkdtempSync(path.join(tmpdir(), 'autonomous-allow-matrix-'));
    const aoStub = writeAoReadStub(stubDir);
    const probeFile = path.join(stubDir, 'spawn-probe.txt');
    try {
      const workerSpawn = spawnEvalHidden(repoRoot, 'ao spawn opk-probe', {
        AO_TMUX_NAME: 'opk-worker',
        AO_REAL_BINARY: aoStub,
        AO_SPAWN_PROBE_FILE: probeFile,
      });
      expect(workerSpawn.status).toBe(0);
      expect(readFileSync(probeFile, 'utf8').trim().split('\n')).toEqual(['spawn', 'opk-probe']);
      expect(`${workerSpawn.stderr}${workerSpawn.stdout}`).not.toMatch(/autonomous worker spawn denied/i);

      const gated = spawnSync(
        'pwsh',
        ['-NoProfile', '-File', path.join(scriptsDir, 'invoke-gated-worker-nudge.ps1'), '-Probe'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...stripBashEnvBlockers(process.env),
            AO_TMUX_NAME: 'opk-orchestrator',
            BASH_ENV: bootstrapPath,
          },
        },
      );
      expect(gated.status).not.toBe(93);
      expect(`${gated.stderr}${gated.stdout}`).not.toMatch(/autonomous_raw_worker_send_denied/i);
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('double-arm bootstrap + interposer is idempotent on PATH and behavior', () => {
    const stubDir = mkdtempSync(path.join(tmpdir(), 'autonomous-double-arm-'));
    const aoStub = writeAoReadStub(stubDir);
    try {
      const command = `source ${bootstrapPath}; source ${bashEnvPath}; ao review list --json`;
      const once = spawnLiveArmedBash(repoRoot, command, { AO_REAL_BINARY: aoStub });
      const twice = spawnLiveArmedBash(repoRoot, command, { AO_REAL_BINARY: aoStub });
      expect(once.status).toBe(0);
      expect(twice.status).toBe(0);
      expect(once.stdout).toBe(twice.stdout);
      const pathSegments = (process.env.PATH ?? '').split(':').filter(Boolean);
      const scriptCount = pathSegments.filter((segment) => segment === scriptsDir).length;
      expect(scriptCount).toBeLessThanOrEqual(1);
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });
});

