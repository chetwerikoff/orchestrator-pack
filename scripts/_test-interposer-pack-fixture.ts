import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect } from 'vitest';
import { repoRoot } from './_test-pwsh-helpers.js';

export const CANONICAL_INTERPOSER_SCRIPT_NAMES = [
  '_resolve-pwsh.sh',
  '_invoke-system-git.sh',
  'ao',
  'git',
  'git-real-binary',
  'ao-autonomous-guard.ps1',
  'git-autonomous-guard.ps1',
  'autonomous-orchestrator-surface-bootstrap.sh',
  'autonomous-bash-env.sh',
] as const;

export type InterposerPackFixture = {
  packRoot: string;
  scriptsDir: string;
  bootstrapPath: string;
  bashEnvPath: string;
  aoShimPath: string;
  gitShimPath: string;
};

export type IsolatedInterposerPack = InterposerPackFixture & { cleanup: () => void };

export function stripInterposerBashEnvBlockers(env: NodeJS.ProcessEnv) {
  const {
    POSIXLY_CORRECT: _pc,
    SHELLOPTS: _so,
    BASH_ENV: _be,
    __AO_AUTONOMOUS_SURFACE_BOOTSTRAP: _sb,
    __AO_AUTONOMOUS_BASH_INTERPOSED: _bi,
    AO_AUTONOMOUS_ORCHESTRATOR_SURFACE: _as,
    ...rest
  } = env;
  return rest;
}

export function createIsolatedInterposerPack(): IsolatedInterposerPack {
  const packRoot = mkdtempSync(path.join(tmpdir(), 'opk-interposer-pack-'));
  const scriptsDir = path.join(packRoot, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  cpSync(path.join(repoRoot, 'scripts/lib'), path.join(scriptsDir, 'lib'), { recursive: true });
  for (const name of CANONICAL_INTERPOSER_SCRIPT_NAMES) {
    cpSync(path.join(repoRoot, 'scripts', name), path.join(scriptsDir, name));
    chmodSync(path.join(scriptsDir, name), 0o755);
  }
  mkdirSync(path.join(packRoot, '.ao'), { recursive: true });
  const fixture: InterposerPackFixture = {
    packRoot,
    scriptsDir,
    bootstrapPath: path.join(scriptsDir, 'autonomous-orchestrator-surface-bootstrap.sh'),
    bashEnvPath: path.join(scriptsDir, 'autonomous-bash-env.sh'),
    aoShimPath: path.join(scriptsDir, 'ao'),
    gitShimPath: path.join(scriptsDir, 'git'),
  };
  return {
    ...fixture,
    cleanup: () => rmSync(packRoot, { recursive: true, force: true }),
  };
}

export function writeIsolatedAutonomousRealBinariesConfig(
  pack: InterposerPackFixture,
  aoStub: string,
  gitStub = pack.gitShimPath,
  gitSystemBinary = '/usr/bin/git',
) {
  writeFileSync(
    path.join(pack.packRoot, '.ao/autonomous-real-binaries.json'),
    `${JSON.stringify({ ao: aoStub, git: gitStub, gitSystemBinary }, null, 2)}\n`,
  );
}

export function withIsolatedInterposerPack(
  aoStub: string,
  fn: (pack: InterposerPackFixture) => void,
) {
  const isolated = createIsolatedInterposerPack();
  try {
    writeIsolatedAutonomousRealBinariesConfig(isolated, aoStub);
    fn(isolated);
  } finally {
    isolated.cleanup();
  }
}

export function spawnIsolatedOrchestratorBash(
  pack: InterposerPackFixture,
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
  cwd = pack.packRoot,
) {
  return spawnSync('/bin/bash', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...stripInterposerBashEnvBlockers(process.env),
      AO_TMUX_NAME: 'opk-orchestrator',
      BASH_ENV: pack.bootstrapPath,
      ...extraEnv,
    },
  });
}

export type InterposerPreprocessRewriteResult = {
  rewritten: string;
  syntaxStatus: number;
  syntaxStderr: string;
};

export type InterposerBinaryRewriteResult = {
  rewritten: string;
};

function writeInterposerFunctionsOnlyScript(pack: InterposerPackFixture) {
  const functionsPath = path.join(pack.scriptsDir, '.autonomous-bash-env.functions.sh');
  const content = readFileSync(pack.bashEnvPath, 'utf8').replace(
    /\n__ao_autonomous_interpose_execution_string\s*$/,
    '\n',
  );
  writeFileSync(functionsPath, content);
  return functionsPath;
}

function writeInterposerRewriteRunner(pack: InterposerPackFixture) {
  const functionsPath = writeInterposerFunctionsOnlyScript(pack);
  const runnerPath = path.join(pack.packRoot, '.interposer-rewrite-runner.sh');
  writeFileSync(
    runnerPath,
    `#!/usr/bin/env bash
set -euo pipefail
export AO_AUTONOMOUS_ORCHESTRATOR_SURFACE=1
export AO_TMUX_NAME=opk-orchestrator
source "${functionsPath}"
pack_git="$(__ao_autonomous_pack_git)"
pack_ao="$(__ao_autonomous_pack_ao)"
input="$(<"$1")"
mode="$2"
if [[ "$mode" == "binary" ]]; then
  out="$(__ao_autonomous_rewrite_all_binaries_in_command "$input" "$pack_git" "$pack_ao")"
  printf '%s' "$out"
  exit 0
fi
if [[ "$mode" == "preprocess" ]]; then
  content="$(__ao_autonomous_rewrite_real_var_assignments_in_content "$input" "$pack_git" "$pack_ao")"
  rewritten="$(__ao_autonomous_rewrite_all_binaries_in_command "$content" "$pack_git" "$pack_ao")"
  tmp="$(mktemp "\${TMPDIR:-/tmp}/ao-rewrite-test.XXXXXX")"
  printf '%s' "$rewritten" > "$tmp"
  if bash -n "$tmp" 2>"$tmp.syntax.err"; then
    printf 'SYNTAX_OK\\n'
  else
    printf 'SYNTAX_FAIL\\n'
    cat "$tmp.syntax.err" >&2
    exit 1
  fi
  printf '%s' "$rewritten"
  exit 0
fi
printf 'unknown mode: %s\\n' "$mode" >&2
exit 2
`,
  );
  chmodSync(runnerPath, 0o755);
  return runnerPath;
}

export function runInterposerBinaryRewrite(
  pack: InterposerPackFixture,
  input: string,
): InterposerBinaryRewriteResult {
  const inputPath = path.join(pack.packRoot, '.rewrite-input.txt');
  writeFileSync(inputPath, input);
  const runnerPath = writeInterposerRewriteRunner(pack);
  const result = spawnSync(runnerPath, [inputPath, 'binary'], {
    cwd: pack.packRoot,
    encoding: 'utf8',
    env: stripInterposerBashEnvBlockers(process.env),
  });
  if (result.status !== 0) {
    throw new Error(
      `binary rewrite runner failed: status=${result.status} stderr=${result.stderr} stdout=${result.stdout}`,
    );
  }
  return { rewritten: result.stdout ?? '' };
}

export function runInterposerPreprocessRewrite(
  pack: InterposerPackFixture,
  scriptContent: string,
): InterposerPreprocessRewriteResult {
  const inputPath = path.join(pack.packRoot, '.rewrite-input.txt');
  writeFileSync(inputPath, scriptContent);
  const runnerPath = writeInterposerRewriteRunner(pack);
  const result = spawnSync(runnerPath, [inputPath, 'preprocess'], {
    cwd: pack.packRoot,
    encoding: 'utf8',
    env: stripInterposerBashEnvBlockers(process.env),
  });
  const stdout = result.stdout ?? '';
  const marker = 'SYNTAX_OK\n';
  const markerIndex = stdout.indexOf(marker);
  if (result.status !== 0 || markerIndex === -1) {
    return {
      rewritten: stdout,
      syntaxStatus: result.status ?? 1,
      syntaxStderr: `${result.stderr ?? ''}${stdout}`,
    };
  }
  return {
    rewritten: stdout.slice(markerIndex + marker.length),
    syntaxStatus: 0,
    syntaxStderr: result.stderr ?? '',
  };
}

export function assertAssignmentRhsUsesPackTarget(
  rewritten: string,
  varName: 'REAL_AO' | 'REAL_GIT',
  packTarget: string,
) {
  const line = rewritten
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.includes(`${varName}=`));
  if (!line) {
    throw new Error(`missing ${varName}= line in rewritten content`);
  }
  expect(line).toContain(packTarget);
  const rhs = line.replace(/^export\s+/, '').slice(varName.length + 1);
  if (rhs.startsWith('"') || rhs.startsWith("'")) {
    expect(rhs.endsWith(rhs[0] ?? '')).toBe(true);
  }
}
