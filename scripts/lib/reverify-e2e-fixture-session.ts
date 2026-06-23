import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export interface AoFixtureSessionRecord {
  id: string;
  branch?: string | null;
  pr?: string | null;
}

export type AoSessionListingSource = 'json' | 'text' | 'none';

export interface AoSessionListing {
  records: AoFixtureSessionRecord[];
  source: AoSessionListingSource;
}

export const FIXTURE_HOLDER_PROMPT = 'checkpoint-2 contract-evidence reverify e2e fixture holder';

const FIXTURE_HOLDER_CLAIM_ID_RE = /^opk-\S+$/;

function defaultSleepMs(ms: number): void {
  if (ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Parse `ao session ls` text for active session rows (TTY-indented or piped). */
export function parseAoSessionLsText(stdout: string): AoFixtureSessionRecord[] {
  const records: AoFixtureSessionRecord[] = [];
  const seen = new Set<string>();

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('(')) {
      continue;
    }

    const rowMatch = trimmed.match(/^(opk-\S+)\s+\([^)]*\)\s+(\S+)/);
    if (rowMatch) {
      const id = rowMatch[1];
      if (!seen.has(id)) {
        seen.add(id);
        records.push({ id, branch: rowMatch[2] });
      }
      continue;
    }

    const headerMatch = trimmed.match(/^(opk-\S+):$/);
    if (headerMatch && !seen.has(headerMatch[1])) {
      seen.add(headerMatch[1]);
      records.push({ id: headerMatch[1], branch: null });
    }
  }

  return records;
}

export function normalizeAoSessionRecordsFromJson(stdout: string): AoFixtureSessionRecord[] {
  const payload = JSON.parse(stdout);
  return (payload?.data ?? [])
    .filter((session: { id?: string }) => typeof session?.id === 'string' && session.id.startsWith('opk-'))
    .map((session: { id: string; branch?: string; pr?: string | null }) => ({
      id: session.id,
      branch: typeof session.branch === 'string' ? session.branch : null,
      pr: typeof session.pr === 'string' ? session.pr : null,
    }));
}

export function listAoSessionRecordsFromOutputs(options: {
  jsonStdout?: string | null;
  textStdout?: string | null;
}): AoSessionListing {
  if (options.jsonStdout?.trim()) {
    try {
      const records = normalizeAoSessionRecordsFromJson(options.jsonStdout);
      return { records, source: 'json' };
    } catch {
      // fall through to text
    }
  }

  if (options.textStdout?.trim()) {
    return {
      records: parseAoSessionLsText(options.textStdout),
      source: 'text',
    };
  }

  return { records: [], source: 'none' };
}

export function isSpawnTrustworthySessionListing(source: AoSessionListingSource): boolean {
  return source === 'json';
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

export function sessionOwnsRealPr(session: AoFixtureSessionRecord): boolean {
  return Boolean(session.pr?.trim());
}

export function isUsableDedicatedFixtureHolder(session: AoFixtureSessionRecord): boolean {
  return isDedicatedFixtureHolderBranch(session.branch) && !sessionOwnsRealPr(session);
}

export function pickDedicatedFixtureHolderSession(
  sessions: AoFixtureSessionRecord[],
): string | null {
  const dedicated = sessions.filter(isUsableDedicatedFixtureHolder);
  if (dedicated.length === 0) {
    return null;
  }

  const sessionBranch = dedicated.find((session) => /^session\/opk-\d+$/i.test(session.branch ?? ''));
  return sessionBranch?.id ?? dedicated[0]?.id ?? null;
}

export function parseFixtureHolderClaimContent(raw: string): {
  kind: 'empty' | 'pending' | 'resolved';
  sessionId?: string;
  pendingSince?: number;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { kind: 'empty' };
  }
  if (FIXTURE_HOLDER_CLAIM_ID_RE.test(trimmed)) {
    return { kind: 'resolved', sessionId: trimmed };
  }
  const pendingSince = Number.parseInt(trimmed, 10);
  if (Number.isFinite(pendingSince)) {
    return { kind: 'pending', pendingSince };
  }
  return { kind: 'empty' };
}

export function readResolvedFixtureHolderClaim(claimPath: string): string | null {
  if (!existsSync(claimPath)) {
    return null;
  }
  try {
    const parsed = parseFixtureHolderClaimContent(readFileSync(claimPath, 'utf8'));
    return parsed.kind === 'resolved' ? parsed.sessionId ?? null : null;
  } catch {
    return null;
  }
}

export function resolveAoFixtureSessionId(options: {
  envSession?: string | null;
  liveE2eEnabled: boolean;
  preferredSessionId: string;
  knownSessions: AoFixtureSessionRecord[];
  sessionListingSource?: AoSessionListingSource;
  allowSpawn: boolean;
  spawnSession: () => string | null;
  claimSpawn?: (spawnSession: () => string | null, knownSessions: AoFixtureSessionRecord[]) => string | null;
}): string | null {
  const envSession = options.envSession?.trim();
  if (envSession) {
    return envSession;
  }

  if (!options.liveE2eEnabled) {
    return null;
  }

  const knownSessions = options.knownSessions;
  const knownSessionIds = knownSessions.map((session) => session.id);

  if (knownSessionIds.includes(options.preferredSessionId)) {
    const preferred = knownSessions.find((session) => session.id === options.preferredSessionId);
    if (preferred && sessionOwnsRealPr(preferred)) {
      return null;
    }
    return options.preferredSessionId;
  }

  const dedicatedSession = pickDedicatedFixtureHolderSession(knownSessions);
  if (dedicatedSession) {
    return dedicatedSession;
  }

  if (!options.allowSpawn) {
    return null;
  }

  if (!isSpawnTrustworthySessionListing(options.sessionListingSource ?? 'none')) {
    return null;
  }

  const claimSpawn = options.claimSpawn ?? ((spawnSession) => spawnSession());
  return claimSpawn(options.spawnSession, knownSessions);
}

const CLAIM_STALE_MS = 120_000;

export function claimOrSpawnFixtureHolder(options: {
  claimPath: string;
  knownSessions: AoFixtureSessionRecord[];
  spawnSession: () => string | null;
  now?: () => number;
  sleepMs?: (ms: number) => void;
}): string | null {
  const now = options.now ?? Date.now;
  const sleepMs = options.sleepMs ?? defaultSleepMs;
  mkdirSync(path.dirname(options.claimPath), { recursive: true });

  const existingDedicated = pickDedicatedFixtureHolderSession(options.knownSessions);
  if (existingDedicated) {
    return existingDedicated;
  }

  const resolvedClaim = readResolvedFixtureHolderClaim(options.claimPath);
  if (resolvedClaim && options.knownSessions.some((session) => session.id === resolvedClaim)) {
    return resolvedClaim;
  }

  try {
    const fd = openSync(options.claimPath, 'wx');
    writeFileSync(fd, `${now()}\n`, 'utf8');
    closeSync(fd);

    const spawnedId = options.spawnSession();
    if (!spawnedId) {
      unlinkSync(options.claimPath);
      return null;
    }

    writeFileSync(options.claimPath, `${spawnedId}\n`, 'utf8');
    return spawnedId;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'EEXIST') {
      throw error;
    }
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    sleepMs(50);

    const resolved = readResolvedFixtureHolderClaim(options.claimPath);
    if (resolved) {
      return resolved;
    }

    if (existsSync(options.claimPath)) {
      try {
        const parsed = parseFixtureHolderClaimContent(readFileSync(options.claimPath, 'utf8'));
        if (parsed.kind === 'pending' && parsed.pendingSince !== undefined && now() - parsed.pendingSince > CLAIM_STALE_MS) {
          unlinkSync(options.claimPath);
          break;
        }
      } catch {
        // another claimant may have replaced the file
      }
    }
  }

  return pickDedicatedFixtureHolderSession(options.knownSessions);
}
