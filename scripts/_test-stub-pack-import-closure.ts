import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runnerPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '_test-stub-pack-import-closure-runner.mjs',
);

export const STUB_PACK_FIXTURE_SITES = {
  isolatedInterposer: 'createIsolatedInterposerPack',
  aoSpawnProbeStub: 'withAoSpawnProbeStub',
} as const;

export type StubPackImportClosureFailure = {
  fixtureSite: string;
  module: string;
  missingDep: string;
  message: string;
};

type RunnerFailurePayload = {
  module: string;
  missingDep: string;
  message: string;
};

function parseRunnerFailure(stderr: string): RunnerFailurePayload | null {
  for (const line of stderr.split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Partial<RunnerFailurePayload>;
      if (parsed.module && parsed.missingDep) {
        return {
          module: parsed.module,
          missingDep: parsed.missingDep,
          message: parsed.message ?? trimmed,
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function formatClosureFailure(
  fixtureSite: string,
  payload: RunnerFailurePayload | null,
  result: ReturnType<typeof spawnSync>,
): string {
  if (payload) {
    return `stub-pack docs import-closure failed (${fixtureSite}, ${payload.module}, ${payload.missingDep}): ${payload.message}`;
  }
  if (result.signal === 'SIGTERM') {
    return `stub-pack docs import-closure timed out (${fixtureSite})`;
  }
  const stderr = String(result.stderr ?? '').trim();
  const stdout = String(result.stdout ?? '').trim();
  const detail = stderr || stdout || `exit status ${result.status ?? 'unknown'}`;
  return `stub-pack docs import-closure failed (${fixtureSite}, (unknown), (unresolved)): ${detail}`;
}

export function assertStubPackDocsImportClosure(
  fixtureSite: string,
  packRoot: string,
  options: { timeoutMs?: number } = {},
): void {
  const docsDir = path.join(packRoot, 'docs');
  const timeoutMs = options.timeoutMs ?? 30_000;
  const result = spawnSync(process.execPath, [runnerPath, docsDir], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });

  if (result.status === 0 && result.signal == null) {
    return;
  }

  const payload = parseRunnerFailure(String(result.stderr ?? ''));
  throw new Error(formatClosureFailure(fixtureSite, payload, result));
}
