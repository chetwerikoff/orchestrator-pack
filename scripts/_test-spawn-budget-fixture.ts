import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoRoot } from './_test-pwsh-helpers.js';
import {
  createIsolatedInterposerPack,
  spawnIsolatedOrchestratorBash,
  stripInterposerBashEnvBlockers,
  type InterposerPackFixture,
} from './_test-interposer-pack-fixture.js';
import { withTempGitRepo } from './_test-git-fixture.js';

export const AUTONOMOUS_AO_READ_STUB_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  status)
    printf '{"data":[]}\\n'
    exit 0
    ;;
  session)
    if [[ "\${2:-}" == "ls" && "\${3:-}" == "--json" ]]; then
      printf '{"data":[]}\\n'
      exit 0
    fi
    ;;
  orchestrator)
    if [[ "\${2:-}" == "ls" && "\${3:-}" == "--json" ]]; then
      printf '{"data":[]}\\n'
      exit 0
    fi
    ;;
  review)
    if [[ "\${2:-}" == "list" ]]; then
      printf '[]\\n'
      exit 0
    fi
    ;;
esac
exit 0
`;

export function countPwshGuardAuditLines(auditFile: string): number {
  if (!existsSync(auditFile)) {
    return 0;
  }
  return readFileSync(auditFile, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('pwsh-guard:')).length;
}

export function writeSpawnBudgetRealBinaries(
  pack: InterposerPackFixture,
  aoStub: string,
  gitBinary = '/usr/bin/git',
) {
  writeFileSync(
    path.join(pack.packRoot, '.ao/autonomous-real-binaries.json'),
    `${JSON.stringify({ ao: aoStub, git: gitBinary, gitSystemBinary: gitBinary }, null, 2)}\n`,
  );
}

export function runAutonomousSurfaceCommand(
  pack: InterposerPackFixture,
  argv: string[],
  extraEnv: Record<string, string | undefined> = {},
  cwd = pack.packRoot,
) {
  const auditFile = extraEnv.AO_AUTONOMOUS_GUARD_SPAWN_AUDIT_FILE;
  if (auditFile && existsSync(auditFile)) {
    rmSync(auditFile, { force: true });
  }
  const binary = argv[0] === 'git' ? pack.gitShimPath : pack.aoShimPath;
  const result = spawnSync('bash', [binary, ...argv.slice(1)], {
    cwd,
    encoding: 'utf8',
    env: {
      ...stripInterposerBashEnvBlockers(process.env),
      AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: '1',
      AO_TMUX_NAME: 'opk-orchestrator',
      PATH: `${pack.scriptsDir}:${process.env.PATH ?? ''}`,
      ...extraEnv,
    },
  });
  return {
    ...result,
    pwshGuardSpawns: auditFile ? countPwshGuardAuditLines(auditFile) : 0,
  };
}

export function runNoopShellFixture(
  pack: InterposerPackFixture,
  commandCount: number,
  auditFile: string,
) {
  const commands = Array.from({ length: commandCount }, () => ':').join('; ');
  const before = countPwshGuardAuditLines(auditFile);
  const result = spawnIsolatedOrchestratorBash(
    pack,
    ['-c', commands],
    {
      AO_AUTONOMOUS_GUARD_SPAWN_AUDIT_FILE: auditFile,
    },
    pack.packRoot,
  );
  const after = countPwshGuardAuditLines(auditFile);
  return {
    result,
    helperGrowth: Math.max(0, after - before),
    pwshGuardSpawns: after,
  };
}

export function withSpawnBudgetPack(run: (ctx: {
  pack: InterposerPackFixture;
  aoStub: string;
  cleanup: () => void;
}) => void) {
  const isolated = createIsolatedInterposerPack();
  const aoStub = path.join(isolated.packRoot, 'ao-read-stub.sh');
  writeFileSync(aoStub, AUTONOMOUS_AO_READ_STUB_SCRIPT);
  chmodSync(aoStub, 0o755);
  writeSpawnBudgetRealBinaries(isolated, aoStub);
  try {
    run({ pack: isolated, aoStub, cleanup: isolated.cleanup });
  } finally {
    isolated.cleanup();
  }
}

export function runSupervisorChildTick(
  pack: InterposerPackFixture,
  auditFile: string,
  cwd: string,
) {
  const commands = [
    ['git', 'config', '--get', 'remote.origin.url'],
    ['git', 'log', '--since=60 seconds ago', '--format=%H'],
    ['git', 'branch', '--show-current'],
    ['git', 'status', '--short', '--branch'],
    ['ao', 'status', '--json', '--reports', 'full'],
    ['ao', 'review', 'list', '--json'],
  ];
  let total = 0;
  for (const argv of commands) {
    const result = runAutonomousSurfaceCommand(
      pack,
      argv,
      {
        AO_AUTONOMOUS_GUARD_SPAWN_AUDIT_FILE: auditFile,
        AO_SIDE_PROCESS_CHILD_ID: 'spawn-budget-fixture-child',
      },
      cwd,
    );
    total += result.pwshGuardSpawns;
  }
  return { pwshGuardSpawns: total, commandCount: commands.length };
}

export function runGitRepoSpawnBudgetCase(
  run: (ctx: { pack: InterposerPackFixture; auditFile: string; repoDir: string }) => void,
) {
  withSpawnBudgetPack(({ pack }) => {
    withTempGitRepo((repoDir) => {
      const auditFile = path.join(pack.packRoot, 'spawn-audit.jsonl');
      run({ pack, auditFile, repoDir });
    });
  });
}

export const mandatoryReadCommands = [
  ['git', 'config', '--get', 'remote.origin.url'],
  ['git', 'log', '--since=60 seconds ago', '--format=%H'],
  ['git', 'branch', '--show-current'],
  ['git', 'status', '--short', '--branch'],
  ['ao', 'status', '--json', '--reports', 'full'],
  ['ao', 'review', 'list', '--json'],
] as const;

export function runMandatoryReadCommandMix(
  pack: InterposerPackFixture,
  auditFile: string,
  cwd: string,
  repetitionsPerCommand: number,
) {
  let total = 0;
  for (const argv of mandatoryReadCommands) {
    for (let i = 0; i < repetitionsPerCommand; i += 1) {
      const result = runAutonomousSurfaceCommand(
        pack,
        [...argv],
        { AO_AUTONOMOUS_GUARD_SPAWN_AUDIT_FILE: auditFile },
        cwd,
      );
      total += result.pwshGuardSpawns;
    }
  }
  return {
    pwshGuardSpawns: total,
    commandCount: mandatoryReadCommands.length * repetitionsPerCommand,
  };
}

export function simulateLegacyGuardPerCommand(count: number, legacyPerCommand = 1) {
  return count * legacyPerCommand;
}

export function mkSpawnBudgetAuditFile(prefix = 'spawn-budget-audit-') {
  return path.join(mkdtempSync(path.join(tmpdir(), prefix)), 'audit.jsonl');
}

export { repoRoot };
