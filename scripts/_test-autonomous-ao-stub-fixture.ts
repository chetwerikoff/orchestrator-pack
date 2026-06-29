import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { expect } from 'vitest';
import {
  createIsolatedInterposerPack,
  stripInterposerBashEnvBlockers,
  writeIsolatedAutonomousRealBinariesConfig,
  type InterposerPackFixture,
  type IsolatedInterposerPack,
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

/** Reserved synthetic spawn target — safe for pack-layer refuse / obvious test isolation. */
export const SPAWN_GATE_FIXTURE_SESSION_ID = 'opk-probe' as const;

export const AO_SPAWN_NONLIVE_RECEIPT_ENV = 'AO_SPAWN_NONLIVE_RECEIPT_FILE';

const HERMETIC_SYSTEM_PATH = '/usr/bin:/bin';

const bashEnvRunnerDir = mkdtempSync(path.join(tmpdir(), 'ao-spawn-gate-bash-runners-'));
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

export const SPAWN_GATE_LIVE_COMMAND_RUNNER = liveCommandRunner;

function recordNonLiveReceipt() {
  return `if [[ -n "\${${AO_SPAWN_NONLIVE_RECEIPT_ENV}:-}" ]]; then
  printf 'invoked:%s\\n' "$*" >> "\${${AO_SPAWN_NONLIVE_RECEIPT_ENV}}"
fi
`;
}

/** Hermetic spawn-gate env without worktree fixture mode (safe for git-deny probes). */
export function autonomousSpawnProbeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return autonomousBashEnv({
    ...overrides,
  });
}

/** Spawn probe env with worktree fixture mode enabled (spawn/claim-pr probes only). */
export function autonomousSpawnFixtureProbeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return autonomousSpawnProbeEnv({
    AO_SPAWN_WORKTREE_FIXTURE_MODE: '1',
    ...overrides,
  });
}

/** claim-pr spawn probes need a resolvable PR head OID without gh on CI. */
export function autonomousClaimPrProbeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return autonomousSpawnFixtureProbeEnv({
    AO_SPAWN_FIXTURE_PR_HEAD_OID: repoHeadOid,
    ...overrides,
  });
}

export const AUTONOMOUS_AO_PROBE_STUB_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
${recordNonLiveReceipt()}
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

/** Full read stub for interposer matrix — records spawn argv to probeFile when set. */
export const AUTONOMOUS_AO_READ_STUB_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
${recordNonLiveReceipt()}
if [[ "\${1:-}" == "spawn" ]]; then
  if [[ -n "\${AO_SPAWN_PROBE_FILE:-}" ]]; then
    printf '%s\\n' "$@" > "\${AO_SPAWN_PROBE_FILE}"
  fi
  exit 0
fi
if [[ "\${1:-}" == "review" && "\${2:-}" == "list" && "\${3:-}" == "--json" ]]; then
  printf '[]\\n'
  exit 0
fi
if [[ "\${1:-}" == "status" ]]; then
  printf '{"data":[]}\\n'
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
`;

/**
 * Surface-off allow stub (L195-class): spawn succeeds without probe receipt.
 * Non-live execution is proven via AO_SPAWN_NONLIVE_RECEIPT_FILE append only.
 */
export const AUTONOMOUS_AO_SURFACE_OFF_HARMLESS_STUB_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
${recordNonLiveReceipt()}
if [[ "\${1:-}" == "spawn" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "review" && "\${2:-}" == "list" && "\${3:-}" == "--json" ]]; then
  printf '[]\\n'
  exit 0
fi
if [[ "\${1:-}" == "status" ]]; then
  printf '{"data":[]}\\n'
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
`;

export type SpawnGateStubKind = 'probe-receipt' | 'read-receipt' | 'surface-off-harmless';

export type SpawnGateSurfaceOutcome =
  | 'orchestrator-surface-allow'
  | 'orchestrator-surface-deny'
  | 'surface-off-allow'
  | 'worker-surface-allow-stub-receipt';

export type AoSpawnProbeStubContext = {
  aoStub: string;
  probeFile: string;
  nonLiveReceiptFile: string;
  pack: InterposerPackFixture;
};

export type HermeticSpawnGateContext = Omit<AoSpawnProbeStubContext, 'pack'> & {
  pack: IsolatedInterposerPack;
  stubKind: SpawnGateStubKind;
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

function stubScriptForKind(kind: SpawnGateStubKind): string {
  switch (kind) {
    case 'probe-receipt':
      return AUTONOMOUS_AO_PROBE_STUB_SCRIPT;
    case 'read-receipt':
      return AUTONOMOUS_AO_READ_STUB_SCRIPT;
    case 'surface-off-harmless':
      return AUTONOMOUS_AO_SURFACE_OFF_HARMLESS_STUB_SCRIPT;
    default: {
      const exhaustive: never = kind;
      throw new Error(`unknown spawn-gate stub kind: ${exhaustive}`);
    }
  }
}

function pathSegmentContainsForeignAo(segment: string, pack: InterposerPackFixture): boolean {
  if (!segment) {
    return false;
  }
  if (segment === pack.scriptsDir) {
    return false;
  }
  const candidate = path.join(segment, 'ao');
  if (!existsSync(candidate)) {
    return false;
  }
  try {
    const mode = statSync(candidate).mode;
    if ((mode & 0o111) === 0) {
      return false;
    }
  } catch {
    return false;
  }
  const resolvedCandidate = path.resolve(candidate);
  const resolvedShim = path.resolve(pack.aoShimPath);
  return resolvedCandidate !== resolvedShim;
}

function hermeticUtilityPathSegments(pack: InterposerPackFixture): string[] {
  const segments = new Set<string>(['/usr/bin', '/bin']);
  for (const segment of (process.env.PATH ?? '').split(':')) {
    const trimmed = segment.trim();
    if (!trimmed) {
      continue;
    }
    // Pack scriptsDir is always first on hermetic PATH, so trailing segments may
    // host foreign ao while still supplying pwsh/git/python3 for guarded shims.
    for (const utility of ['pwsh', 'git', 'python3'] as const) {
      if (existsSync(path.join(trimmed, utility))) {
        segments.add(trimmed);
      }
    }
  }
  const resolvedPwsh = spawnSync('/bin/bash', ['-c', 'command -v pwsh'], {
    encoding: 'utf8',
    env: { PATH: [...segments].join(':') },
  }).stdout
    .trim();
  if (resolvedPwsh) {
    segments.add(path.dirname(resolvedPwsh));
  }
  void pack;
  return [...segments];
}

function sanitizePathSuffix(pathSuffix: string | undefined, pack: InterposerPackFixture): string[] {
  if (!pathSuffix) {
    return [];
  }
  return pathSuffix
    .split(':')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && !pathSegmentContainsForeignAo(segment, pack));
}

/** Hermetic PATH: pack scripts first, optional sanitized suffix, then minimal system paths only. */
export function hermeticSpawnGatePath(
  pack: InterposerPackFixture,
  options: { pathPrepend?: string[]; pathSuffix?: string } = {},
): string {
  const prepend = (options.pathPrepend ?? []).filter(Boolean);
  const suffix = sanitizePathSuffix(options.pathSuffix, pack);
  return [...prepend, pack.scriptsDir, ...suffix, ...hermeticUtilityPathSegments(pack)].join(':');
}

function assertSpawnGateExecutable(candidate: string, label: string): void {
  if (!existsSync(candidate)) {
    throw new Error(`spawn-gate preflight: ${label} missing: ${candidate}`);
  }
  try {
    if ((statSync(candidate).mode & 0o111) === 0) {
      throw new Error(`spawn-gate preflight: ${label} not executable: ${candidate}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('spawn-gate preflight:')) {
      throw err;
    }
    throw new Error(`spawn-gate preflight: ${label} not accessible: ${candidate}`);
  }
}

export function assertSpawnGateIsolationPreflight(pack: InterposerPackFixture): void {
  const configPath = path.join(pack.packRoot, '.ao', 'autonomous-real-binaries.json');
  if (!existsSync(configPath)) {
    throw new Error(`spawn-gate preflight: missing pack-local config at ${configPath}`);
  }
  assertSpawnGateExecutable(pack.aoShimPath, 'pack ao shim');
  let configuredAo = '';
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { ao?: string };
    configuredAo = parsed.ao ?? '';
  } catch {
    throw new Error(`spawn-gate preflight: invalid JSON at ${configPath}`);
  }
  if (!configuredAo) {
    throw new Error('spawn-gate preflight: configured ao stub path empty');
  }
  assertSpawnGateExecutable(configuredAo, 'configured ao stub');
  const hermeticPath = hermeticSpawnGatePath(pack);
  const resolved = spawnSync('/bin/bash', ['-c', 'command -v ao'], {
    encoding: 'utf8',
    env: { PATH: hermeticPath },
  });
  const resolvedAo = resolved.stdout.trim();
  if (resolvedAo !== pack.aoShimPath) {
    throw new Error(
      `spawn-gate preflight: hermetic PATH resolves ao to ${resolvedAo || '(missing)'}, expected ${pack.aoShimPath}`,
    );
  }
}

export function buildHermeticSpawnGateEnv(
  pack: InterposerPackFixture,
  overrides: Record<string, string | undefined> = {},
  pathOptions: { pathPrepend?: string[]; pathSuffix?: string } = {},
): NodeJS.ProcessEnv {
  const { PATH: pathOverride, ...rest } = overrides;
  return {
    ...stripInterposerBashEnvBlockers(process.env),
    PATH: hermeticSpawnGatePath(pack, {
      pathPrepend: pathOptions.pathPrepend,
      pathSuffix: typeof pathOverride === 'string' ? pathOverride : undefined,
    }),
    ...rest,
  };
}


function buildHermeticOrchestratorBashEnv(
  pack: InterposerPackFixture,
  extraEnv: Record<string, string | undefined> = {},
  pathOptions: { pathPrepend?: string[]; pathSuffix?: string } = {},
): NodeJS.ProcessEnv {
  const {
    PATH: _inheritedPath,
    AO_SPAWN_WORKTREE_FIXTURE_MODE: _fixtureMode,
    ...probeRest
  } = autonomousSpawnProbeEnv(extraEnv);
  return buildHermeticSpawnGateEnv(
    pack,
    {
      AO_TMUX_NAME: 'opk-orchestrator',
      BASH_ENV: pack.bootstrapPath,
      ...probeRest,
    },
    pathOptions,
  );
}

export function writeSpawnGateAoStub(stubDir: string, kind: SpawnGateStubKind, basename = 'ao-stub.sh'): string {
  const aoStub = path.join(stubDir, basename);
  writeFileSync(aoStub, stubScriptForKind(kind));
  chmodSync(aoStub, 0o755);
  return aoStub;
}

function createHermeticSpawnGateContext(stubKind: SpawnGateStubKind): HermeticSpawnGateContext {
  const stubDir = mkdtempSync(path.join(tmpdir(), 'autonomous-ao-stub-'));
  const aoStub = writeSpawnGateAoStub(stubDir, stubKind);
  const probeFile = path.join(stubDir, 'spawn-probe.txt');
  const nonLiveReceiptFile = path.join(stubDir, 'nonlive-receipt.txt');
  const isolated = createIsolatedInterposerPack();
  copyAoSpawnProbeStubPackDocs(isolated.packRoot);
  assertStubPackDocsImportClosure(STUB_PACK_FIXTURE_SITES.aoSpawnProbeStub, isolated.packRoot);
  writeIsolatedAutonomousRealBinariesConfig(isolated, aoStub);
  assertSpawnGateIsolationPreflight(isolated);
  return { aoStub, probeFile, nonLiveReceiptFile, pack: isolated, stubKind };
}

export function spawnHermeticLiveArmedBash(
  ctx: Pick<HermeticSpawnGateContext, 'pack' | 'nonLiveReceiptFile'>,
  command: string,
  extraEnv: Record<string, string | undefined> = {},
  cwd = ctx.pack.packRoot,
  pathOptions: { pathPrepend?: string[]; pathSuffix?: string } = {},
) {
  assertSpawnGateIsolationPreflight(ctx.pack);
  return spawnSync('/bin/bash', [liveCommandRunner, command], {
    cwd,
    encoding: 'utf8',
    env: buildHermeticOrchestratorBashEnv(
      ctx.pack,
      {
        [AO_SPAWN_NONLIVE_RECEIPT_ENV]: ctx.nonLiveReceiptFile,
        ...extraEnv,
      },
      pathOptions,
    ),
  });
}

export function spawnHermeticEvalHidden(
  ctx: Pick<HermeticSpawnGateContext, 'pack' | 'nonLiveReceiptFile'>,
  command: string,
  extraEnv: Record<string, string | undefined> = {},
  cwd = ctx.pack.packRoot,
  pathOptions: { pathPrepend?: string[]; pathSuffix?: string } = {},
) {
  assertSpawnGateIsolationPreflight(ctx.pack);
  return spawnSync('/bin/bash', [evalHiddenRunner, command], {
    cwd,
    encoding: 'utf8',
    env: buildHermeticOrchestratorBashEnv(
      ctx.pack,
      {
        [AO_SPAWN_NONLIVE_RECEIPT_ENV]: ctx.nonLiveReceiptFile,
        ...extraEnv,
      },
      pathOptions,
    ),
  });
}

export function spawnHermeticIsolatedOrchestratorBash(
  ctx: Pick<HermeticSpawnGateContext, 'pack' | 'nonLiveReceiptFile'>,
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
  cwd = ctx.pack.packRoot,
  pathOptions: { pathPrepend?: string[]; pathSuffix?: string } = {},
) {
  assertSpawnGateIsolationPreflight(ctx.pack);
  return spawnSync('/bin/bash', args, {
    cwd,
    encoding: 'utf8',
    env: buildHermeticOrchestratorBashEnv(
      ctx.pack,
      {
        [AO_SPAWN_NONLIVE_RECEIPT_ENV]: ctx.nonLiveReceiptFile,
        ...extraEnv,
      },
      pathOptions,
    ),
  });
}

export function assertSpawnGateOutcome(
  outcome: SpawnGateSurfaceOutcome,
  result: SpawnSyncReturns<string>,
  ctx: Pick<HermeticSpawnGateContext, 'probeFile' | 'nonLiveReceiptFile'>,
) {
  const receipt = existsSync(ctx.nonLiveReceiptFile) ? readFileSync(ctx.nonLiveReceiptFile, 'utf8') : '';
  const probePresent = existsSync(ctx.probeFile) && readFileSync(ctx.probeFile, 'utf8').trim().length > 0;

  switch (outcome) {
    case 'orchestrator-surface-deny':
      expect(result.status).toBe(93);
      return;
    case 'orchestrator-surface-allow':
      expect(result.status).not.toBe(93);
      // Orchestrator allow must not write probe receipts; non-live receipt proves stub routing.
      expect(probePresent).toBe(false);
      expect(receipt).toMatch(/invoked:.*\bspawn\b/);
      return;
    case 'surface-off-allow':
      expect(result.status).toBe(0);
      expect(probePresent).toBe(false);
      return;
    case 'worker-surface-allow-stub-receipt':
      expect(result.status).toBe(0);
      expect(probePresent).toBe(true);
      expect(receipt).toMatch(/invoked:/);
      return;
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unknown spawn-gate surface outcome: ${exhaustive}`);
    }
  }
}

/** Hermetic spawn-gate pack with fail-closed preflight — for interposer live-armed migration. */
export function withHermeticSpawnGatePack(
  stubKind: SpawnGateStubKind,
  run: (ctx: HermeticSpawnGateContext) => void,
) {
  const liveConfigBefore = snapshotLiveOperatorConfig();
  const ctx = createHermeticSpawnGateContext(stubKind);
  try {
    assertLiveOperatorConfigUnchanged(liveConfigBefore, 'before callback');
    run(ctx);
    assertLiveOperatorConfigUnchanged(liveConfigBefore, 'after callback');
  } finally {
    ctx.pack.cleanup();
    rmSync(path.dirname(ctx.aoStub), { recursive: true, force: true });
    assertLiveOperatorConfigUnchanged(liveConfigBefore, 'after cleanup');
  }
}

/** Isolated ao stub via pack-local .ao/autonomous-real-binaries.json — records argv to probeFile. */
export function withAoSpawnProbeStub(run: (ctx: AoSpawnProbeStubContext) => void) {
  withHermeticSpawnGatePack('probe-receipt', (ctx) => {
    run({
      aoStub: ctx.aoStub,
      probeFile: ctx.probeFile,
      nonLiveReceiptFile: ctx.nonLiveReceiptFile,
      pack: ctx.pack,
    });
  });
}

export function spawnHermeticBoundaryBash(
  pack: InterposerPackFixture,
  args: string[],
  nonLiveReceiptFile: string,
  extraEnv: Record<string, string | undefined> = {},
  cwd = pack.packRoot,
) {
  assertSpawnGateIsolationPreflight(pack);
  return spawnSync('/bin/bash', args, {
    cwd,
    encoding: 'utf8',
    env: buildHermeticSpawnGateEnv(pack, {
      [AO_SPAWN_NONLIVE_RECEIPT_ENV]: nonLiveReceiptFile,
      ...extraEnv,
    }),
  });
}
