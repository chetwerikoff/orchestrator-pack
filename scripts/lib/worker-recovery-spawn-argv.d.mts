export declare const RECOVERY_SPAWN_DISPLAY_NAME_PREFIX: string;
export declare const RECOVERY_SPAWN_DISPLAY_NAME_MAX_LENGTH: number;

export type DeriveRecoverySpawnDisplayNameResult =
  | { ok: true; name: string }
  | { ok: false; reason: string };

export type ResolveRecoverySpawnProjectIdResult =
  | { ok: true; projectId: string }
  | { ok: false; reason: string };

export type BuildRecoverySpawnArgvResult =
  | { ok: true; argv: string[]; displayName: string; projectId: string }
  | { ok: false; reason: string };

export type ClassifyRecoverySpawnExitResult =
  | { ok: true; reason: string; defer: false }
  | { ok: false; reason: string; defer: boolean };

export declare function deriveRecoverySpawnDisplayName(
  input: Record<string, unknown>,
): DeriveRecoverySpawnDisplayNameResult;

export declare function resolveRecoverySpawnProjectId(
  input: Record<string, unknown>,
): ResolveRecoverySpawnProjectIdResult;

export declare function buildRecoverySpawnArgv(
  input: Record<string, unknown>,
): BuildRecoverySpawnArgvResult;

export declare function classifyRecoverySpawnExit(
  input: Record<string, unknown>,
): ClassifyRecoverySpawnExitResult;
