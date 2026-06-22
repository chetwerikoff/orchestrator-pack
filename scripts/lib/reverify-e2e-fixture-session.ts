export interface AoFixtureSessionRecord {
  id: string;
  branch?: string | null;
}

/** Branch names used for operator-spawned AC#13 fixture holders (not task workers). */
export function isDedicatedFixtureHolderBranch(branch: string | null | undefined): boolean {
  if (!branch?.trim()) {
    return false;
  }
  const normalized = branch.trim();
  return /^session\/opk-\d+$/i.test(normalized)
    || /^feat\/opk-\d+-reverify-e2e-holder(?:-[\w-]+)?$/i.test(normalized);
}

export function pickDedicatedFixtureHolderSession(
  sessions: AoFixtureSessionRecord[],
): string | null {
  const dedicated = sessions.filter((session) => isDedicatedFixtureHolderBranch(session.branch));
  if (dedicated.length === 0) {
    return null;
  }

  const sessionBranch = dedicated.find((session) => /^session\/opk-\d+$/i.test(session.branch ?? ''));
  return sessionBranch?.id ?? dedicated[0]?.id ?? null;
}

export function resolveAoFixtureSessionId(options: {
  envSession?: string | null;
  liveE2eEnabled: boolean;
  preferredSessionId: string;
  knownSessionIds: string[];
  knownSessions: AoFixtureSessionRecord[];
  allowSpawn: boolean;
  spawnSession: () => string | null;
}): string | null {
  const envSession = options.envSession?.trim();
  if (envSession) {
    return envSession;
  }

  if (!options.liveE2eEnabled) {
    return null;
  }

  if (options.knownSessionIds.includes(options.preferredSessionId)) {
    return options.preferredSessionId;
  }

  const dedicatedSession = pickDedicatedFixtureHolderSession(options.knownSessions);
  if (dedicatedSession) {
    return dedicatedSession;
  }

  if (options.knownSessionIds.length > 0) {
    return options.knownSessionIds[0] ?? null;
  }

  if (options.allowSpawn) {
    return options.spawnSession();
  }

  return null;
}
