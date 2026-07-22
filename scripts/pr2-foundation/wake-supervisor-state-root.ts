import { homedir } from 'node:os';
import path from 'node:path';

export interface WakeSupervisorStateRootOptions {
  env?: Readonly<NodeJS.ProcessEnv>;
  platform?: NodeJS.Platform;
  homeDir?: string;
}

function trimmed(value: string | undefined): string {
  return String(value ?? '').trim();
}

function pathApi(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * TypeScript parity port of Get-OrchestratorWakeSupervisorStateRoot.
 * The supervisor override is authoritative, followed by XDG_STATE_HOME,
 * Windows LOCALAPPDATA, and the user-home fallback. Keep this precedence
 * identical to the live reconciler so notification and recovery always share
 * the same durable journal bytes.
 */
export function resolveWakeSupervisorStateRoot(
  options: WakeSupervisorStateRootOptions = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const paths = pathApi(platform);
  const override = trimmed(env.AO_WAKE_SUPERVISOR_STATE_DIR);
  if (override) return override;

  const userHome = trimmed(env.HOME) || trimmed(options.homeDir) || homedir();
  const stateBase = trimmed(env.XDG_STATE_HOME)
    || trimmed(env.LOCALAPPDATA)
    || paths.join(userHome, '.local', 'state');
  return paths.join(stateBase, 'orchestrator-pack-wake-supervisor');
}

export function resolveWorkerMessageDispatchJournalPath(
  options: WakeSupervisorStateRootOptions = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const paths = pathApi(platform);
  const explicit = trimmed(env.AO_WORKER_MESSAGE_DISPATCH_JOURNAL);
  if (explicit) return paths.resolve(explicit);
  return paths.join(
    resolveWakeSupervisorStateRoot(options),
    'worker-message-dispatch-journal.json',
  );
}
