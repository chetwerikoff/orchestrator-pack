import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { autonomousBashEnv, resolveTrustedSystemGit } from './_test-git-fixture.js';
import { repoRoot } from './_test-pwsh-helpers.js';

export const repoHeadOid = execFileSync(resolveTrustedSystemGit(), ['-C', repoRoot, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();

/** Shallow-checkout-safe spawn probe env for guard integration tests. */
export function autonomousSpawnProbeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return autonomousBashEnv({
    AO_SPAWN_WORKTREE_FIXTURE_MODE: '1',
    ...overrides,
  });
}

/** claim-pr spawn probes need a resolvable PR head OID without gh on CI. */
export function autonomousClaimPrProbeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return autonomousSpawnProbeEnv({
    AO_SPAWN_FIXTURE_PR_HEAD_OID: repoHeadOid,
    ...overrides,
  });
}

export const AUTONOMOUS_AO_PROBE_STUB_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "spawn" ]]; then
  printf '%s\\n' "$@" > "\${AO_SPAWN_PROBE_FILE:?}"
  exit 0
fi
if [[ "\${1:-}" == "status" ]]; then
  printf '{"data":[]}\\n'
  exit 0
fi
exit 0
`;

/** Isolated ao stub via .ao/autonomous-real-binaries.json — records argv to probeFile. */
export function withAoSpawnProbeStub(run: (ctx: { aoStub: string; probeFile: string }) => void) {
  const stubDir = mkdtempSync(path.join(tmpdir(), 'autonomous-ao-stub-'));
  const aoStub = path.join(stubDir, 'ao-stub.sh');
  const probeFile = path.join(stubDir, 'spawn-probe.txt');
  const aoDir = path.join(repoRoot, '.ao');
  const configPath = path.join(aoDir, 'autonomous-real-binaries.json');
  const priorConfig = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null;
  try {
    writeFileSync(aoStub, AUTONOMOUS_AO_PROBE_STUB_SCRIPT);
    chmodSync(aoStub, 0o755);
    mkdirSync(aoDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(
        { ao: aoStub, git: path.join(repoRoot, 'scripts/git-real-binary'), gitSystemBinary: '/usr/bin/git' },
        null,
        2,
      ),
    );
    run({ aoStub, probeFile });
  } finally {
    if (priorConfig === null) {
      if (existsSync(configPath)) rmSync(configPath);
    } else {
      writeFileSync(configPath, priorConfig);
    }
    rmSync(stubDir, { recursive: true, force: true });
  }
}
