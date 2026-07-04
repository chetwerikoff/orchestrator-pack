/**
 * Bounded best-effort JSONL audit retention for Phase-0 telemetry (Issue #588).
 */
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const POLICY_PATH = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'audit-jsonl-retention-policy.json');

const STREAM_ENV_PREFIX = {
  'gh-wrapper': 'GH_WRAPPER_AUDIT',
  'github-fleet-cache': 'GH_FLEET_CACHE_AUDIT',
};

function isValidStreamPolicyDefaults(defaults) {
  return Boolean(
    defaults
    && typeof defaults === 'object'
    && Number.isFinite(Number(defaults.maxActiveBytes))
    && Number(defaults.maxActiveBytes) > 0
    && Number.isFinite(Number(defaults.maxTotalBytes))
    && Number(defaults.maxTotalBytes) > 0
    && Number.isFinite(Number(defaults.maxAgeDays))
    && Number(defaults.maxAgeDays) > 0,
  );
}

function loadPolicyDefaults(streamId, env = process.env) {
  try {
    const path = env.AUDIT_JSONL_RETENTION_POLICY_PATH?.trim() || POLICY_PATH;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const streamDefaults = parsed?.[streamId];
    if (!isValidStreamPolicyDefaults(streamDefaults)) {
      return embeddedPolicyDefaults(streamId);
    }
    return streamDefaults;
  } catch {
    return embeddedPolicyDefaults(streamId);
  }
}

function embeddedPolicyDefaults(streamId) {
  if (streamId === 'gh-wrapper') {
    return { maxActiveBytes: 64 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024, maxAgeDays: 7 };
  }
  if (streamId === 'github-fleet-cache') {
    return { maxActiveBytes: 16 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024, maxAgeDays: 7 };
  }
  throw new Error(`unknown audit stream: ${streamId}`);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveAuditJsonlPolicy(streamId, env = process.env) {
  const defaults = loadPolicyDefaults(streamId, env);
  const prefix = STREAM_ENV_PREFIX[streamId];
  const maxActiveBytes = parsePositiveInt(env[`${prefix}_MAX_ACTIVE_BYTES`], defaults.maxActiveBytes);
  const maxTotalBytes = parsePositiveInt(env[`${prefix}_MAX_TOTAL_BYTES`], defaults.maxTotalBytes);
  const maxAgeDays = parsePositiveInt(env[`${prefix}_MAX_AGE_DAYS`], defaults.maxAgeDays);
  return {
    streamId,
    maxActiveBytes,
    maxTotalBytes,
    maxAgeMs: maxAgeDays * 24 * 60 * 60 * 1000,
    defaults,
  };
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function segmentBaseName(activePath) {
  return basename(activePath, '.jsonl');
}

function segmentNameRegex(activePath) {
  const base = escapeRegex(segmentBaseName(activePath));
  return new RegExp(`^${base}\\.\\d{8}T\\d{6}(?:\\d{3})?Z(?:-[a-f0-9]{8})?\\.jsonl$`);
}

function parseCompactRotationTimestamp(compact) {
  if (compact.length === 16) {
    const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${compact.slice(9, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}Z`;
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (compact.length >= 19) {
    const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${compact.slice(9, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}.${compact.slice(15, 18)}Z`;
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function parseSegmentTimestamp(name, activePath) {
  const base = segmentBaseName(activePath);
  const match = name.match(new RegExp(`^${escapeRegex(base)}\\.(\\d{8}T\\d{6}(?:\\d{3})?Z)(?:-[a-f0-9]{8})?\\.jsonl$`));
  if (!match) {
    return 0;
  }
  return parseCompactRotationTimestamp(match[1]);
}

function rotationStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z');
}

function resolveRotationSegmentPath(dir, base) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = randomBytes(4).toString('hex');
    const segmentPath = join(dir, `${base}.${rotationStamp()}-${suffix}.jsonl`);
    if (!existsSync(segmentPath)) {
      return segmentPath;
    }
  }
  return null;
}

function activeFileSize(activePath) {
  if (!existsSync(activePath)) {
    return 0;
  }
  return statSync(activePath).size;
}

const DEFAULT_MAINTENANCE_LOCK_MAX_AGE_MS = 5 * 60 * 1000;

function maintenanceLockMaxAgeMs(env = process.env) {
  const parsed = Number.parseInt(String(env.AUDIT_JSONL_MAINTENANCE_LOCK_MAX_AGE_SECONDS ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : DEFAULT_MAINTENANCE_LOCK_MAX_AGE_MS;
}

function readMaintenanceLockPid(lockPath) {
  try {
    const text = readFileSync(lockPath, 'utf8').trim();
    const pid = Number.parseInt(text.split('\n')[0], 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

function isMaintenanceLockStale(lockPath, maxAgeMs) {
  if (!existsSync(lockPath)) {
    return false;
  }
  try {
    const pid = readMaintenanceLockPid(lockPath);
    if (pid !== null && !isProcessAlive(pid)) {
      return true;
    }
    const { mtimeMs } = statSync(lockPath);
    return Date.now() - mtimeMs > maxAgeMs;
  } catch {
    return false;
  }
}

function clearStaleMaintenanceLockIfNeeded(lockPath, log, env = process.env) {
  if (!isMaintenanceLockStale(lockPath, maintenanceLockMaxAgeMs(env))) {
    return false;
  }
  try {
    unlinkSync(lockPath);
    log?.('stale_lock_reclaimed', { lock: basename(lockPath) });
    return true;
  } catch (err) {
    log?.('stale_lock_reclaim_failed', { reason: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

function tryAcquireMaintenanceLock(lockPath, log, env = process.env) {
  clearStaleMaintenanceLockIfNeeded(lockPath, log, env);
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    const fd = openSync(lockPath, 'wx', 0o600);
    writeSync(fd, `${process.pid}\n`);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function releaseMaintenanceLock(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch {
    // best-effort
  }
}

function listSegments(dir, activePath) {
  const pattern = segmentNameRegex(activePath);
  return readdirSync(dir)
    .filter((name) => pattern.test(name))
    .map((name) => {
      const fullPath = join(dir, name);
      let size = 0;
      let mtimeMs = 0;
      try {
        const stats = statSync(fullPath);
        size = stats.size;
        mtimeMs = stats.mtimeMs;
      } catch {
        // skip unreadable segment metadata
      }
      return {
        name,
        path: fullPath,
        size,
        mtimeMs,
        ts: parseSegmentTimestamp(name, activePath),
      };
    })
    .sort((left, right) => left.ts - right.ts);
}

function pruneSegments(dir, activePath, policy, log) {
  let segments = listSegments(dir, activePath);
  const now = Date.now();

  segments = segments.filter((segment) => {
    const ageMs = segment.mtimeMs > 0 ? now - segment.mtimeMs : now - segment.ts;
    if (policy.maxAgeMs > 0 && ageMs > policy.maxAgeMs) {
      try {
        rmSync(segment.path);
        log?.('prune_age', { segment: segment.name });
        return false;
      } catch (err) {
        log?.('prune_failed', { segment: segment.name, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return true;
  });

  let totalBytes = segments.reduce((sum, segment) => sum + segment.size, 0) + activeFileSize(activePath);
  while (policy.maxTotalBytes > 0 && totalBytes > policy.maxTotalBytes && segments.length > 0) {
    const oldest = segments.shift();
    try {
      rmSync(oldest.path);
      totalBytes -= oldest.size;
      log?.('prune_footprint', { segment: oldest.name, totalBytes });
    } catch (err) {
      log?.('prune_failed', { segment: oldest.name, reason: err instanceof Error ? err.message : String(err) });
      break;
    }
  }
}

function rotateActiveFile(activePath, policy, log) {
  const dir = dirname(activePath);
  const base = segmentBaseName(activePath);
  const segmentPath = resolveRotationSegmentPath(dir, base);
  if (!segmentPath) {
    log?.('rotate_failed', { reason: 'segment_name_collision' });
    return;
  }
  try {
    renameSync(activePath, segmentPath);
    log?.('rotate', { segment: basename(segmentPath) });
    pruneSegments(dir, activePath, policy, log);
  } catch (err) {
    log?.('rotate_failed', { reason: err instanceof Error ? err.message : String(err) });
  }
}

export function maybeMaintainAuditJsonl(activePath, policy, log) {
  const activeSize = activeFileSize(activePath);
  if (policy.maxActiveBytes > 0 && activeSize < policy.maxActiveBytes) {
    return { rotated: false, activeSize };
  }
  if (activeSize === 0) {
    return { rotated: false, activeSize: 0 };
  }

  const lockPath = `${activePath}.maintenance.lock`;
  if (!tryAcquireMaintenanceLock(lockPath, log)) {
    return { rotated: false, activeSize, lockContended: true };
  }

  try {
    const lockedSize = activeFileSize(activePath);
    if (policy.maxActiveBytes > 0 && lockedSize < policy.maxActiveBytes) {
      return { rotated: false, activeSize: lockedSize };
    }
    if (lockedSize === 0) {
      return { rotated: false, activeSize: 0 };
    }
    rotateActiveFile(activePath, policy, log);
    return { rotated: true, activeSize: lockedSize };
  } finally {
    releaseMaintenanceLock(lockPath);
  }
}

export function appendAuditJsonlLine(activePath, line, options = {}) {
  const policy = options.policy ?? resolveAuditJsonlPolicy(options.streamId ?? 'gh-wrapper', options.env);
  const log = options.log;
  mkdirSync(dirname(activePath), { recursive: true });
  maybeMaintainAuditJsonl(activePath, policy, log);
  const payload = line.endsWith('\n') ? line : `${line}\n`;
  appendFileSync(activePath, payload, 'utf8');
}

export function maintenanceLockPath(activePath) {
  return `${activePath}.maintenance.lock`;
}

export {
  activeFileSize,
  clearStaleMaintenanceLockIfNeeded,
  listSegments,
  parseCompactRotationTimestamp,
  pruneSegments,
  resolveRotationSegmentPath,
  rotateActiveFile,
  rotationStamp,
  segmentNameRegex,
  tryAcquireMaintenanceLock,
  releaseMaintenanceLock,
};
