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
import { gitFixtureEnv, resolveTrustedSystemGit, withTempGitRepo } from './_test-git-fixture.js';
import {
  assertAssignmentRhsUsesPackTarget,
  createIsolatedInterposerPack,
  runInterposerBinaryRewrite,
  runInterposerPreprocessRewrite,
  spawnIsolatedOrchestratorBash,
  stripInterposerBashEnvBlockers,
  withIsolatedInterposerPack,
  type InterposerPackFixture,
} from './_test-interposer-pack-fixture.js';

const bootstrapPath = path.join(repoRoot, 'scripts/autonomous-orchestrator-surface-bootstrap.sh');
const bashEnvPath = path.join(repoRoot, 'scripts/autonomous-bash-env.sh');
const scriptsDir = path.join(repoRoot, 'scripts');
const aoShimPath = path.join(scriptsDir, 'ao');

const bashEnvRunnerDir = mkdtempSync(path.join(tmpdir(), 'ao-interposer-bash-env-runners-'));
const liveCommandRunner = path.join(bashEnvRunnerDir, 'run-live-command.sh');
const evalHiddenRunner = path.join(bashEnvRunnerDir, 'run-eval-hidden.sh');
writeFileSync(
  liveCommandRunner,
  `#!/usr/bin/env bash
set -euo pipefail
eval "$1"
`,
);
writeFileSync(
  evalHiddenRunner,
  `#!/usr/bin/env bash
set -O extglob
set -euo pipefail
builtin eval "$1"
`,
);
chmodSync(liveCommandRunner, 0o755);
chmodSync(evalHiddenRunner, 0o755);

function spawnLiveArmedBash(
  pack: InterposerPackFixture,
  command: string,
  extraEnv: Record<string, string | undefined> = {},
  cwd = pack.packRoot,
) {
  return spawnIsolatedOrchestratorBash(pack, [liveCommandRunner, command], extraEnv, cwd);
}

function spawnEvalHidden(
  pack: InterposerPackFixture,
  command: string,
  extraEnv: Record<string, string | undefined> = {},
  cwd = pack.packRoot,
) {
  return spawnIsolatedOrchestratorBash(pack, [evalHiddenRunner, command], extraEnv, cwd);
}


function writeAoReadStubAtBinAo(dir: string): string {
  const binDir = path.join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const realAo = path.join(binDir, 'ao');
  writeFileSync(
    realAo,
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
printf 'unhandled:%s\\n' "$*" >&2
exit 1
`,
  );
  chmodSync(realAo, 0o755);
  return realAo;
}

function writeTrustedLocalBinAoForwarder(
  homeDir: string,
  realAo: string,
  assignmentLine: string,
): string {
  const forwarder = path.join(homeDir, '.local', 'bin', 'ao');
  mkdirSync(path.dirname(forwarder), { recursive: true });
  writeFileSync(
    forwarder,
    `#!/usr/bin/env bash
${assignmentLine}
set -euo pipefail
exec "$REAL_AO" "$@"
`,
  );
  chmodSync(forwarder, 0o755);
  return forwarder;
}

function assertNoInterposerQuotingErrors(result: { stderr: string }) {
  expect(result.stderr).not.toMatch(/ao-autonomous-script|unexpected EOF/i);
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

describe('autonomous orchestrator interposer (#406)', () => {
  it('withTempGitRepo initializes repos via trusted system git under autonomous surface env', () => {
    if (!existsSync('/usr/bin/git')) {
      return;
    }
    withTempGitRepo((dir) => {
      expect(readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('test\n');
      const hostileEnv = gitFixtureEnv({
        ...process.env,
        AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '1',
        AO_TMUX_NAME: 'opk-orchestrator',
        PATH: `${scriptsDir}:${process.env.PATH ?? ''}`,
        BASH_ENV: bootstrapPath,
      });
      const status = spawnSync(resolveTrustedSystemGit(), ['rev-parse', '--is-inside-work-tree'], {
        cwd: dir,
        encoding: 'utf8',
        env: hostileEnv,
      });
      expect(status.status).toBe(0);
      expect(status.stdout.trim()).toBe('true');
    });
  });

  it('tracks bootstrap and interposer wiring', () => {
    expect(existsSync(bootstrapPath)).toBe(true);
    expect(existsSync(bashEnvPath)).toBe(true);
    expect(statSync(bootstrapPath).mode & 0o111).toBeGreaterThan(0);
  });

  it('bootstrap maps AO_TMUX_NAME orchestrator sessions to surface and denies spawn', () => {
    const stubDir = mkdtempSync(path.join(tmpdir(), 'autonomous-tmux-map-'));
    const aoStub = writeAoReadStub(stubDir);
    const probeFile = path.join(stubDir, 'spawn-probe.txt');
    try {
      withIsolatedInterposerPack(aoStub, (pack) => {
        const onlyTmux = spawnIsolatedOrchestratorBash(pack, [liveCommandRunner, 'ao spawn opk-probe'], {
          AO_TMUX_NAME: 'opk-orchestrator',
          AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '',
          AO_SPAWN_PROBE_FILE: probeFile,
        });
        expect(onlyTmux.status).toBe(93);
        expect(`${onlyTmux.stderr}${onlyTmux.stdout}`).toMatch(/autonomous worker spawn denied/i);
        expect(existsSync(probeFile)).toBe(false);
      });
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('live arming path: BASH_ENV bootstrap arms orchestrator surface and denies spawn', () => {
    const stubDir = mkdtempSync(path.join(tmpdir(), 'autonomous-live-arm-'));
    const aoStub = writeAoReadStub(stubDir);
    const probeFile = path.join(stubDir, 'spawn-probe.txt');
    try {
      withIsolatedInterposerPack(aoStub, (pack) => {
        const deny = spawnLiveArmedBash(pack, 'ao spawn opk-probe', {
          AO_SPAWN_PROBE_FILE: probeFile,
        });
        expect(deny.status).toBe(93);
        expect(`${deny.stderr}${deny.stdout}`).toMatch(/autonomous worker spawn denied/i);
        expect(existsSync(probeFile)).toBe(false);

        const read = spawnLiveArmedBash(pack, 'ao review list --json');
        expect(read.status).toBe(0);
        expect(() => JSON.parse(read.stdout)).not.toThrow();
        expect(read.stderr).not.toMatch(/ao-autonomous-script|unexpected EOF/i);
      });
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('fail-closed when tracked bootstrap is armed but interposer file is missing', () => {
    const packCopy = mkdtempSync(path.join(tmpdir(), 'autonomous-pack-copy-'));
    try {
      const copiedScripts = path.join(packCopy, 'scripts');
      mkdirSync(copiedScripts, { recursive: true });
      cpSync(path.join(scriptsDir, 'lib'), path.join(copiedScripts, 'lib'), { recursive: true });
      for (const name of [
        '_resolve-pwsh.sh',
        'ao',
        'git',
        'ao-autonomous-guard.ps1',
        'git-autonomous-guard.ps1',
        'autonomous-orchestrator-surface-bootstrap.sh',
      ]) {
        cpSync(path.join(scriptsDir, name), path.join(copiedScripts, name));
        chmodSync(path.join(copiedScripts, name), 0o755);
      }
      const trackedBootstrap = path.join(copiedScripts, 'autonomous-orchestrator-surface-bootstrap.sh');

      const denySpawn = spawnSync('/bin/bash', [path.join(copiedScripts, 'ao'), 'spawn', 'opk-probe'], {
        cwd: packCopy,
        encoding: 'utf8',
        env: {
          ...stripInterposerBashEnvBlockers(process.env),
          AO_TMUX_NAME: 'opk-orchestrator',
          BASH_ENV: trackedBootstrap,
        },
      });
      expect(denySpawn.status).toBe(93);
      expect(denySpawn.stderr).toMatch(/autonomous orchestrator interposer unavailable/i);

      const denySend = spawnSync('/bin/bash', [path.join(copiedScripts, 'ao'), 'send', 'opk-worker', 'hi'], {
        cwd: packCopy,
        encoding: 'utf8',
        env: {
          ...stripInterposerBashEnvBlockers(process.env),
          AO_TMUX_NAME: 'opk-orchestrator',
          BASH_ENV: trackedBootstrap,
        },
      });
      expect(denySend.status).toBe(93);
      expect(denySend.stderr).toMatch(/autonomous orchestrator interposer unavailable/i);

      if (existsSync('/usr/bin/git')) {
        withTempGitRepo((dir) => {
          const readme = path.join(dir, 'README.md');
          const absoluteGit = spawnSync('/bin/bash', [liveCommandRunner, `/usr/bin/git checkout -- ${readme}`], {
            cwd: dir,
            encoding: 'utf8',
            env: {
              ...stripInterposerBashEnvBlockers(process.env),
              AO_TMUX_NAME: 'opk-orchestrator',
              BASH_ENV: trackedBootstrap,
            },
          });
          expect(absoluteGit.status).toBe(93);
          expect(absoluteGit.stderr).toMatch(/autonomous orchestrator interposer unavailable/i);
        });
      }
    } finally {
      rmSync(packCopy, { recursive: true, force: true });
    }
  });



  it('production chain: scripts/ao guard execs trusted ~/.local/bin/ao forwarder without quoting regression', () => {
    const stubDir = mkdtempSync(path.join(tmpdir(), 'autonomous-prod-chain-'));
    const realAo = writeAoReadStubAtBinAo(stubDir);
    const homeDir = mkdtempSync(path.join(tmpdir(), 'autonomous-prod-chain-home-'));
    const forwarder = writeTrustedLocalBinAoForwarder(
      homeDir,
      realAo,
      `REAL_AO="${realAo}"`,
    );
    try {
      withIsolatedInterposerPack(forwarder, (pack) => {
        const viaShim = spawnIsolatedOrchestratorBash(pack, [pack.aoShimPath, 'review', 'list', '--json'], {
          AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '1',
          HOME: homeDir,
        });
        expect(viaShim.status).toBe(0);
        expect(() => JSON.parse(viaShim.stdout)).not.toThrow();
        assertNoInterposerQuotingErrors(viaShim);

        const viaPathReview = spawnEvalHidden(pack, 'ao review list --json', {
          AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '1',
          HOME: homeDir,
        });
        expect(viaPathReview.status).toBe(0);
        expect(() => JSON.parse(viaPathReview.stdout)).not.toThrow();
        assertNoInterposerQuotingErrors(viaPathReview);

        const viaPathStatus = spawnEvalHidden(pack, 'ao status --json', {
          AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '1',
          HOME: homeDir,
        });
        expect(viaPathStatus.status).toBe(0);
        expect(() => JSON.parse(viaPathStatus.stdout)).not.toThrow();
        assertNoInterposerQuotingErrors(viaPathStatus);
      });
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('REAL_AO assignment quoting styles stay shell-valid under BASH_ENV interposer', () => {
    const stubDir = mkdtempSync(path.join(tmpdir(), 'autonomous-real-ao-quotes-'));
    const realAo = writeAoReadStubAtBinAo(stubDir);
    const homeDir = mkdtempSync(path.join(tmpdir(), 'autonomous-real-ao-quotes-home-'));
    const assignmentCases = [
      `REAL_AO="${realAo}"`,
      `REAL_AO='${realAo}'`,
      `REAL_AO=${realAo}`,
      `export REAL_AO="${realAo}"`,
    ] as const;
    try {
      for (const assignmentLine of assignmentCases) {
        const forwarder = writeTrustedLocalBinAoForwarder(homeDir, realAo, assignmentLine);
        withIsolatedInterposerPack(forwarder, (pack) => {
          const syntax = spawnSync('/bin/bash', ['-n', forwarder], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: stripInterposerBashEnvBlockers(process.env),
          });
          expect(syntax.status).toBe(0);

          const result = spawnIsolatedOrchestratorBash(pack, [forwarder, 'review', 'list', '--json'], {
            HOME: homeDir,
          });
          expect(result.status).toBe(0);
          expect(() => JSON.parse(result.stdout)).not.toThrow();
          assertNoInterposerQuotingErrors(result);
        });
      }
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('skips preprocessing for trusted ~/.local/bin ao forwarders with REAL_AO assignment (direct bash argv)', () => {
    const stubDir = mkdtempSync(path.join(tmpdir(), 'autonomous-ao-forwarder-'));
    const realAo = writeAoReadStubAtBinAo(stubDir);
    const homeDir = mkdtempSync(path.join(tmpdir(), 'autonomous-forwarder-home-'));
    const forwarder = writeTrustedLocalBinAoForwarder(
      homeDir,
      realAo,
      `REAL_AO="${realAo}"`,
    );
    try {
      withIsolatedInterposerPack(forwarder, (pack) => {
        const result = spawnIsolatedOrchestratorBash(pack, [forwarder, 'review', 'list', '--json'], { HOME: homeDir });
        expect(result.status).toBe(0);
        expect(() => JSON.parse(result.stdout)).not.toThrow();
        assertNoInterposerQuotingErrors(result);
      });
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('does not exempt untrusted REAL_GIT forwarder bait from preprocessing', () => {
    if (!existsSync('/usr/bin/git')) {
      return;
    }
    withTempGitRepo((dir) => {
      const readme = path.join(dir, 'README.md');
      const evilDir = mkdtempSync(path.join(tmpdir(), 'autonomous-real-git-bait-'));
      const evilScript = path.join(evilDir, 'mutate.sh');
      writeFileSync(
        evilScript,
        `#!/usr/bin/env bash
set -euo pipefail
REAL_GIT=/usr/bin/git
exec "$REAL_GIT" checkout -- ${readme}
`,
      );
      chmodSync(evilScript, 0o755);
      const aoStub = writeAoReadStub(mkdtempSync(path.join(tmpdir(), 'autonomous-real-git-bait-stub-')));
      try {
        withIsolatedInterposerPack(aoStub, (pack) => {
          const result = spawnIsolatedOrchestratorBash(pack, [evilScript], {}, dir);
          expect(result.status).toBe(93);
          expect(`${result.stderr}${result.stdout}`).toMatch(/autonomous tree-mutating git denied/i);
          assertNoInterposerQuotingErrors(result);
        });
      } finally {
        rmSync(evilDir, { recursive: true, force: true });
      }
    });
  });
  it('read-verbs stay clean on orchestrator surface through forwarder shims', () => {
    const stubDir = mkdtempSync(path.join(tmpdir(), 'autonomous-read-verbs-'));
    const aoStub = writeAoReadStub(stubDir);
    try {
      withIsolatedInterposerPack(aoStub, (pack) => {
        const cases = [
          ['review', 'list', '--json'],
          ['status', '--json'],
          ['events', 'list', '--json'],
        ] as const;
        for (const argv of cases) {
          const direct = spawnIsolatedOrchestratorBash(pack, [pack.aoShimPath, ...argv], {
            AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '1',
          });
          expect(direct.status).toBe(0);
          expect(() => JSON.parse(direct.stdout)).not.toThrow();
          expect(direct.stderr).not.toMatch(/ao-autonomous-script|unexpected EOF/i);

          const hidden = spawnEvalHidden(pack, `ao ${argv.join(' ')}`);
          expect(hidden.status).toBe(0);
          expect(() => JSON.parse(hidden.stdout)).not.toThrow();
          expect(hidden.stderr).not.toMatch(/ao-autonomous-script|unexpected EOF/i);
        }
      });
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
      withIsolatedInterposerPack(aoStub, (pack) => {
        withTempGitRepo((dir) => {
          const denySpawn = spawnEvalHidden(
            pack,
            'ao spawn opk-probe',
            {
              AO_SPAWN_PROBE_FILE: probeFile,
              PATH: `${wrapDir}:${hostPath}`,
            },
            dir,
          );
          expect(denySpawn.status).toBe(93);
          expect(`${denySpawn.stderr}${denySpawn.stdout}`).toMatch(/autonomous worker spawn denied/i);

          const readGit = spawnEvalHidden(
            pack,
            'git status --short',
            {
              PATH: `${wrapDir}:${hostPath}`,
            },
            dir,
          );
          expect(readGit.status).toBe(0);
        });
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
    const stubDir = mkdtempSync(path.join(tmpdir(), 'autonomous-buried-path-'));
    const aoStub = writeAoReadStub(stubDir);
    try {
      withIsolatedInterposerPack(aoStub, (pack) => {
        withTempGitRepo((dir) => {
          const readme = path.join(dir, 'README.md');
          const hostPath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
          const buriedPath = `/usr/bin:${pack.scriptsDir}:${hostPath}`;
          const hiddenGit = spawnEvalHidden(
            pack,
            `git checkout -- ${readme}`,
            {
              PATH: buriedPath,
            },
            dir,
          );
          expect(hiddenGit.status).toBe(93);
          expect(`${hiddenGit.stderr}${hiddenGit.stdout}`).toMatch(/autonomous tree-mutating git denied/i);
        });
      });
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('does not treat attacker-named forwarder grep bait as a trusted shim', () => {
    if (!existsSync('/usr/bin/git')) {
      return;
    }
    withTempGitRepo((dir) => {
      const readme = path.join(dir, 'README.md');
      const evilDir = mkdtempSync(path.join(tmpdir(), 'autonomous-evil-forwarder-'));
      const evilAo = path.join(evilDir, 'ao');
      writeFileSync(
        evilAo,
        `#!/usr/bin/env bash
# ao-autonomous-guard REAL_AO=
set -euo pipefail
/usr/bin/git checkout -- ${readme}
`,
      );
      chmodSync(evilAo, 0o755);
      const aoStub = writeAoReadStub(mkdtempSync(path.join(tmpdir(), 'autonomous-evil-fwd-stub-')));
      try {
        withIsolatedInterposerPack(aoStub, (pack) => {
          const result = spawnIsolatedOrchestratorBash(pack, [evilAo], {}, dir);
          expect(result.status).toBe(93);
          expect(`${result.stderr}${result.stdout}`).toMatch(/autonomous tree-mutating git denied/i);
        });
      } finally {
        rmSync(evilDir, { recursive: true, force: true });
      }
    });
  });

  it('ignores turn-visible PATH pwsh on autonomous surface', () => {
    const fakePwshDir = mkdtempSync(path.join(tmpdir(), 'autonomous-fake-pwsh-dir-'));
    const probeFile = path.join(fakePwshDir, 'pwsh-probe.txt');
    const fakePwsh = path.join(fakePwshDir, 'pwsh');
    writeFileSync(
      fakePwsh,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" > "${probeFile}"
exit 0
`,
    );
    chmodSync(fakePwsh, 0o755);
    const stubDir = mkdtempSync(path.join(tmpdir(), 'autonomous-fake-pwsh-stub-'));
    const aoStub = writeAoReadStub(stubDir);
    try {
      withIsolatedInterposerPack(aoStub, (pack) => {
        const spawnProbe = path.join(fakePwshDir, 'spawn-probe.txt');
        const result = spawnEvalHidden(pack, 'ao spawn opk-probe', {
          AO_SPAWN_PROBE_FILE: spawnProbe,
          PATH: `${fakePwshDir}:${process.env.PATH ?? ''}`,
        });
        expect(result.status).toBe(93);
        expect(`${result.stderr}${result.stdout}`).toMatch(/autonomous worker spawn denied/i);
        expect(existsSync(probeFile)).toBe(false);
      });
    } finally {
      rmSync(fakePwshDir, { recursive: true, force: true });
      rmSync(stubDir, { recursive: true, force: true });
    }
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
      withIsolatedInterposerPack(aoStub, (pack) => {
        const spawnProbe = path.join(stubDir, 'spawn-probe.txt');
        const result = spawnEvalHidden(pack, 'ao spawn opk-probe', {
          AO_SPAWN_PROBE_FILE: spawnProbe,
          AO_PWSH_BINARY: fakePwsh,
        });
        expect(result.status).toBe(93);
        expect(`${result.stderr}${result.stdout}`).toMatch(/autonomous worker spawn denied/i);
        expect(existsSync(probeFile)).toBe(false);
      });
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('ignores turn-visible AO_REAL_BINARY on autonomous surface', () => {
    const stubDir = mkdtempSync(path.join(tmpdir(), 'autonomous-ao-real-bypass-'));
    const aoStub = writeAoReadStub(stubDir);
    const maliciousStub = path.join(stubDir, 'malicious-ao.sh');
    writeFileSync(
      maliciousStub,
      `#!/usr/bin/env bash
set -euo pipefail
printf 'bypassed\n'
exit 0
`,
    );
    chmodSync(maliciousStub, 0o755);
    try {
      withIsolatedInterposerPack(aoStub, (pack) => {
        const result = spawnEvalHidden(pack, 'ao status --json', {
          AO_REAL_BINARY: maliciousStub,
        });
        expect(result.status).toBe(0);
        expect(() => JSON.parse(result.stdout)).not.toThrow();
        expect(result.stdout).not.toMatch(/bypassed/);
      });
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('orchestrator deny matrix covers flat and eval-hidden shapes', () => {
    const stubDir = mkdtempSync(path.join(tmpdir(), 'autonomous-deny-matrix-'));
    const aoStub = writeAoReadStub(stubDir);
    const probeFile = path.join(stubDir, 'spawn-probe.txt');
    try {
      withIsolatedInterposerPack(aoStub, (pack) => {
        withTempGitRepo((dir) => {
          const readme = path.join(dir, 'README.md');
          if (!existsSync('/usr/bin/git')) {
            return;
          }

          const flatGit = spawnLiveArmedBash(pack, `/usr/bin/git checkout -- ${readme}`, {}, dir);
          expect(flatGit.status).toBe(93);
          expect(`${flatGit.stderr}${flatGit.stdout}`).toMatch(/autonomous tree-mutating git denied/i);

          const hiddenGit = spawnEvalHidden(pack, `/usr/bin/git checkout -- ${readme}`, {}, dir);
          expect(hiddenGit.status).toBe(93);
          expect(`${hiddenGit.stderr}${hiddenGit.stdout}`).toMatch(/autonomous tree-mutating git denied/i);

          const flatSpawn = spawnLiveArmedBash(pack, 'ao spawn opk-probe', {
            AO_SPAWN_PROBE_FILE: probeFile,
          });
          expect(flatSpawn.status).toBe(93);
          expect(`${flatSpawn.stderr}${flatSpawn.stdout}`).toMatch(/autonomous worker spawn denied/i);

          const hiddenSpawn = spawnEvalHidden(pack, 'ao spawn opk-probe', {
            AO_SPAWN_PROBE_FILE: probeFile,
          });
          expect(hiddenSpawn.status).toBe(93);
          expect(`${hiddenSpawn.stderr}${hiddenSpawn.stdout}`).toMatch(/autonomous worker spawn denied/i);

          const flatSend = spawnLiveArmedBash(pack, 'ao send opk-worker hi');
          expect(flatSend.status).toBe(93);
          expect(`${flatSend.stderr}${flatSend.stdout}`).toMatch(
            /autonomous_raw_worker_send_denied|autonomous worker nudges paused/i,
          );

          const hiddenSend = spawnEvalHidden(pack, 'ao send opk-worker hi');
          expect(hiddenSend.status).toBe(93);
          expect(`${hiddenSend.stderr}${hiddenSend.stdout}`).toMatch(
            /autonomous_raw_worker_send_denied|autonomous worker nudges paused/i,
          );
        });
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
      withIsolatedInterposerPack(aoStub, (pack) => {
        const workerSpawn = spawnEvalHidden(pack, 'ao spawn opk-probe', {
          AO_TMUX_NAME: 'opk-worker',
          AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '',
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
              ...stripInterposerBashEnvBlockers(process.env),
              AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '1',
              BASH_ENV: pack.bootstrapPath,
            },
          },
        );
        expect(gated.status).not.toBe(93);
        expect(`${gated.stderr}${gated.stdout}`).not.toMatch(/autonomous_raw_worker_send_denied/i);
      });
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('double-arm bootstrap + interposer is idempotent on PATH and behavior', () => {
    const stubDir = mkdtempSync(path.join(tmpdir(), 'autonomous-double-arm-'));
    const aoStub = writeAoReadStub(stubDir);
    try {
      withIsolatedInterposerPack(aoStub, (pack) => {
        const command = `source ${pack.bootstrapPath}; source ${pack.bashEnvPath}; ao review list --json`;
        const once = spawnLiveArmedBash(pack, command);
        const twice = spawnLiveArmedBash(pack, command);
        expect(once.status).toBe(0);
        expect(twice.status).toBe(0);
        expect(once.stdout).toBe(twice.stdout);
        const pathProbe = spawnLiveArmedBash(pack, 'printf \'%s\\n\' "$PATH"');
        expect(pathProbe.status).toBe(0);
        const pathSegments = pathProbe.stdout.trim().split(':').filter(Boolean);
        const scriptCount = pathSegments.filter((segment) => segment === pack.scriptsDir).length;
        expect(scriptCount).toBeLessThanOrEqual(1);
      });
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });
  it('quote reconstruction: preprocess rewrites untrusted REAL_AO/REAL_GIT assignments with valid shell', () => {
    const absAo = '/tmp/interposer-quote-abs/bin/ao';
    const absGit = '/usr/bin/git';
    const pack = createIsolatedInterposerPack();
    try {
      const aoCases = [
        `REAL_AO="${absAo}"`,
        `REAL_AO='/tmp/interposer-quote-abs/bin/ao'`,
        `REAL_AO=${absAo}`,
        `export REAL_AO="${absAo}"`,
      ];
      for (const assignmentLine of aoCases) {
        const script = `#!/usr/bin/env bash
set -euo pipefail
${assignmentLine}
exec "$REAL_AO" "$@"
`;
        const result = runInterposerPreprocessRewrite(pack, script);
        expect(result.syntaxStatus).toBe(0);
        assertAssignmentRhsUsesPackTarget(result.rewritten, 'REAL_AO', pack.aoShimPath);
        expect(result.rewritten).not.toMatch(/unexpected EOF/i);
      }

      const gitCases = [
        `REAL_GIT="${absGit}"`,
        `REAL_GIT='${absGit}'`,
        `REAL_GIT=${absGit}`,
        `export REAL_GIT="${absGit}"`,
      ];
      for (const assignmentLine of gitCases) {
        const script = `#!/usr/bin/env bash
set -euo pipefail
${assignmentLine}
exec "$REAL_GIT" "$@"
`;
        const result = runInterposerPreprocessRewrite(pack, script);
        expect(result.syntaxStatus).toBe(0);
        assertAssignmentRhsUsesPackTarget(result.rewritten, 'REAL_GIT', pack.gitShimPath);
      }
    } finally {
      pack.cleanup();
    }
  });

  it('quote reconstruction: binary rewrite preserves closing quote for prefixed quoted absolutes', () => {
    const pack = createIsolatedInterposerPack();
    try {
      const absGit = '/usr/bin/git';
      const input = `echo foo"${absGit}"bar`;
      const { rewritten } = runInterposerBinaryRewrite(pack, input);
      expect(rewritten).toContain(pack.gitShimPath);
      expect(rewritten).toContain('bar');
      expect(rewritten).toMatch(/foo"\/.*\/git"bar/);
      const syntaxPath = path.join(pack.packRoot, '.syntax-check.sh');
      writeFileSync(syntaxPath, rewritten);
      const syntax = spawnSync('/bin/bash', ['-n', syntaxPath], { encoding: 'utf8' });
      expect(syntax.status).toBe(0);

      const assignmentInput = 'REAL_AO="/tmp/interposer-quote-abs/bin/ao"';
      const assignmentOut = runInterposerBinaryRewrite(pack, assignmentInput);
      expect(assignmentOut.rewritten).toBe(assignmentInput);
    } finally {
      pack.cleanup();
    }
  });

  it('quote reconstruction: REAL_AO assignment preprocess replaces RHS and passes bash -n', () => {
    const absAo = '/tmp/interposer-quote-abs/bin/ao';
    const pack = createIsolatedInterposerPack();
    try {
      const script = `#!/usr/bin/env bash
set -euo pipefail
REAL_AO="${absAo}"
exec "$REAL_AO" "$@"
`;
      const result = runInterposerPreprocessRewrite(pack, script);
      expect(result.syntaxStatus).toBe(0);
      expect(result.rewritten).not.toBe(script);
      assertAssignmentRhsUsesPackTarget(result.rewritten, 'REAL_AO', pack.aoShimPath);
    } finally {
      pack.cleanup();
    }
  });

  it('DEBUG trap: untrusted REAL_AO assignment script is rewritten once (side effect not doubled)', () => {
    const stubDir = mkdtempSync(path.join(tmpdir(), 'autonomous-debug-trap-assign-'));
    const aoStub = writeAoReadStub(stubDir);
    const absAo = '/tmp/interposer-quote-abs/bin/ao';
    const probeFile = path.join(stubDir, 'assign-exec-count.txt');
    const scriptPath = path.join(stubDir, 'assign-probe.sh');
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash
set -euo pipefail
REAL_AO="${absAo}"
echo 1 >> "${probeFile}"
declare -p REAL_AO
`,
    );
    chmodSync(scriptPath, 0o755);
    try {
      withIsolatedInterposerPack(aoStub, (pack) => {
        writeFileSync(probeFile, '');
        const result = spawnIsolatedOrchestratorBash(pack, [scriptPath]);
        expect(result.status).toBe(0);
        expect(readFileSync(probeFile, 'utf8').trim()).toBe('1');
        expect(result.stdout).toContain(pack.aoShimPath);
        expect(result.stdout).not.toContain(absAo);
      });
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('DEBUG trap: trusted forwarder REAL_AO assignment skips rewrite', () => {
    const stubDir = mkdtempSync(path.join(tmpdir(), 'autonomous-debug-trap-trusted-'));
    const realAo = writeAoReadStubAtBinAo(stubDir);
    const homeDir = mkdtempSync(path.join(tmpdir(), 'autonomous-debug-trap-trusted-home-'));
    const probeFile = path.join(stubDir, 'real-ao-probe.txt');
    const forwarder = path.join(homeDir, '.local', 'bin', 'ao');
    mkdirSync(path.dirname(forwarder), { recursive: true });
    writeFileSync(
      forwarder,
      `#!/usr/bin/env bash
REAL_AO="${realAo}"
printf '%s' "$REAL_AO" > "${probeFile}"
set -euo pipefail
exec "$REAL_AO" "$@"
`,
    );
    chmodSync(forwarder, 0o755);
    try {
      withIsolatedInterposerPack(forwarder, (pack) => {
        const result = spawnIsolatedOrchestratorBash(pack, [forwarder, 'review', 'list', '--json'], {
          HOME: homeDir,
        });
        expect(result.status).toBe(0);
        expect(readFileSync(probeFile, 'utf8')).toBe(realAo);
        expect(readFileSync(probeFile, 'utf8')).not.toBe(pack.aoShimPath);
      });
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });



});

