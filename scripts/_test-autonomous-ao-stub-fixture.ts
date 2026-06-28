import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  createIsolatedInterposerPack,
  writeIsolatedAutonomousRealBinariesConfig,
  type InterposerPackFixture,
} from './_test-interposer-pack-fixture.js';
import { autonomousBashEnv, resolveTrustedSystemGit } from './_test-git-fixture.js';
import { repoRoot } from './_test-pwsh-helpers.js';
import {
  assertStubPackDocsImportClosure,
  STUB_PACK_FIXTURE_SITES,
} from './_test-stub-pack-import-closure.js';

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

export type AoSpawnProbeStubContext = {
  aoStub: string;
  probeFile: string;
  pack: InterposerPackFixture;
};

const liveOperatorConfigPath = path.join(repoRoot, '.ao', 'autonomous-real-binaries.json');

const AO_SPAWN_PROBE_STUB_PACK_DOCS = [
  'autonomous-gate-preflight.mjs',
  'codex-reviewer-timeout-retry.mjs',
  'review-finding-delivery-confirm.mjs',
  'review-head-ready.mjs',
  'review-ready-stuck-guard.mjs',
  'review-reconcile-primitives.mjs',
  'review-trigger-reconcile.mjs',
  'session-runtime-liveness.mjs',
  'spawn-worktree-git-ref.mjs',
  'spawn-worktree-grant.mjs',
  'terminal-flood-detect.mjs',
  'worker-iteration-cycle.mjs',
  'worker-message-dispatch-observe.mjs',
] as const;

function copyAoSpawnProbeStubPackDocs(packRoot: string) {
  for (const doc of AO_SPAWN_PROBE_STUB_PACK_DOCS) {
    cpSync(path.join(repoRoot, 'docs', doc), path.join(packRoot, 'docs', doc));
  }
}

function snapshotLiveOperatorConfig(): string | null {
  return existsSync(liveOperatorConfigPath) ? readFileSync(liveOperatorConfigPath, 'utf8') : null;
}

function assertLiveOperatorConfigUnchanged(before: string | null, label: string) {
  const after = existsSync(liveOperatorConfigPath) ? readFileSync(liveOperatorConfigPath, 'utf8') : null;
  if (after !== before) {
    throw new Error(
      `withAoSpawnProbeStub ${label}: live operator config mutated at ${liveOperatorConfigPath}`,
    );
  }
}

/** Isolated ao stub via pack-local .ao/autonomous-real-binaries.json — records argv to probeFile. */
export function withAoSpawnProbeStub(run: (ctx: AoSpawnProbeStubContext) => void) {
  const liveConfigBefore = snapshotLiveOperatorConfig();
  const stubDir = mkdtempSync(path.join(tmpdir(), 'autonomous-ao-stub-'));
  const aoStub = path.join(stubDir, 'ao-stub.sh');
  const probeFile = path.join(stubDir, 'spawn-probe.txt');
  const isolated = createIsolatedInterposerPack();
  try {
    copyAoSpawnProbeStubPackDocs(isolated.packRoot);
    assertStubPackDocsImportClosure(STUB_PACK_FIXTURE_SITES.aoSpawnProbeStub, isolated.packRoot);
    writeFileSync(aoStub, AUTONOMOUS_AO_PROBE_STUB_SCRIPT);
    chmodSync(aoStub, 0o755);
    writeIsolatedAutonomousRealBinariesConfig(isolated, aoStub);
    assertLiveOperatorConfigUnchanged(liveConfigBefore, 'before callback');
    // Isolation under pack.packRoot/.ao is the durable fix — not finally restoring repoRoot/.ao.
    run({ aoStub, probeFile, pack: isolated });
    assertLiveOperatorConfigUnchanged(liveConfigBefore, 'after callback');
  } finally {
    isolated.cleanup();
    rmSync(stubDir, { recursive: true, force: true });
    assertLiveOperatorConfigUnchanged(liveConfigBefore, 'after cleanup');
  }
}
