export const FOUNDATION_CONFIG_SCHEMA_VERSION = 1 as const;

export interface FoundationNotificationConfig {
  aoPath: string;
  timeoutMs: number;
  maxJournalAttempts: number;
  argvCeilingChars: number;
}

export interface FoundationSchedulerConfig {
  pollIntervalMs: number;
  leaseMs: number;
}

export interface FoundationMigrationConfig {
  destructiveCleanupEnabled: boolean;
}

export interface FoundationActuatorConfig {
  enabled: boolean;
  postValidationWindowMs: number;
  maxUnadoptedRuntimeMerges: number;
  runtimeMaxAgeHours: number;
  maxUnadoptedNonRuntimeMerges: number;
  nonRuntimeMaxAgeDays: number;
}

export interface FoundationConfig {
  schemaVersion: 1;
  notification: FoundationNotificationConfig;
  scheduler: FoundationSchedulerConfig;
  migration: FoundationMigrationConfig;
  actuator: FoundationActuatorConfig;
}

export type FoundationConfigResult =
  | { ok: true; config: FoundationConfig }
  | { ok: false; reason: 'invalid_config' | 'unknown_config_key'; path: string };

const ROOT_KEYS = new Set(['schemaVersion', 'notification', 'scheduler', 'migration', 'actuator']);
const NOTIFICATION_KEYS = new Set(['aoPath', 'timeoutMs', 'maxJournalAttempts', 'argvCeilingChars']);
const SCHEDULER_KEYS = new Set(['pollIntervalMs', 'leaseMs']);
const MIGRATION_KEYS = new Set(['destructiveCleanupEnabled']);
const ACTUATOR_KEYS = new Set([
  'enabled',
  'postValidationWindowMs',
  'maxUnadoptedRuntimeMerges',
  'runtimeMaxAgeHours',
  'maxUnadoptedNonRuntimeMerges',
  'nonRuntimeMaxAgeDays',
]);

export const DEFAULT_FOUNDATION_CONFIG: FoundationConfig = Object.freeze({
  schemaVersion: FOUNDATION_CONFIG_SCHEMA_VERSION,
  notification: Object.freeze({
    aoPath: 'ao',
    timeoutMs: 30_000,
    maxJournalAttempts: 3,
    argvCeilingChars: 32_767,
  }),
  scheduler: Object.freeze({
    pollIntervalMs: 5_000,
    leaseMs: 30_000,
  }),
  migration: Object.freeze({
    destructiveCleanupEnabled: false,
  }),
  actuator: Object.freeze({
    enabled: false,
    postValidationWindowMs: 5_000,
    maxUnadoptedRuntimeMerges: 1,
    runtimeMaxAgeHours: 24,
    maxUnadoptedNonRuntimeMerges: 20,
    nonRuntimeMaxAgeDays: 7,
  }),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: Set<string>,
  prefix: string,
): FoundationConfigResult | null {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  return unknown
    ? { ok: false, reason: 'unknown_config_key', path: prefix ? `${prefix}.${unknown}` : unknown }
    : null;
}

function positiveInteger(
  value: unknown,
  fallback: number,
  path: string,
): number | FoundationConfigResult {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return { ok: false, reason: 'invalid_config', path };
  }
  return value;
}

function nonNegativeInteger(
  value: unknown,
  fallback: number,
  path: string,
): number | FoundationConfigResult {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return { ok: false, reason: 'invalid_config', path };
  }
  return value;
}

function booleanValue(
  value: unknown,
  fallback: boolean,
  path: string,
): boolean | FoundationConfigResult {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') return { ok: false, reason: 'invalid_config', path };
  return value;
}

function stringValue(
  value: unknown,
  fallback: string,
  path: string,
): string | FoundationConfigResult {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, reason: 'invalid_config', path };
  }
  return value.trim();
}

function failure(value: unknown): value is FoundationConfigResult {
  return isRecord(value) && value.ok === false;
}

export function parseFoundationConfig(input: unknown = {}): FoundationConfigResult {
  if (!isRecord(input)) return { ok: false, reason: 'invalid_config', path: '$' };
  const rootUnknown = rejectUnknown(input, ROOT_KEYS, '');
  if (rootUnknown) return rootUnknown;
  if (input.schemaVersion !== undefined && input.schemaVersion !== FOUNDATION_CONFIG_SCHEMA_VERSION) {
    return { ok: false, reason: 'invalid_config', path: 'schemaVersion' };
  }

  const notification = input.notification === undefined ? {} : input.notification;
  const scheduler = input.scheduler === undefined ? {} : input.scheduler;
  const migration = input.migration === undefined ? {} : input.migration;
  const actuator = input.actuator === undefined ? {} : input.actuator;
  for (const [path, value] of Object.entries({ notification, scheduler, migration, actuator })) {
    if (!isRecord(value)) return { ok: false, reason: 'invalid_config', path };
  }

  const sectionUnknown = [
    rejectUnknown(notification as Record<string, unknown>, NOTIFICATION_KEYS, 'notification'),
    rejectUnknown(scheduler as Record<string, unknown>, SCHEDULER_KEYS, 'scheduler'),
    rejectUnknown(migration as Record<string, unknown>, MIGRATION_KEYS, 'migration'),
    rejectUnknown(actuator as Record<string, unknown>, ACTUATOR_KEYS, 'actuator'),
  ].find(Boolean);
  if (sectionUnknown) return sectionUnknown;

  const n = notification as Record<string, unknown>;
  const s = scheduler as Record<string, unknown>;
  const m = migration as Record<string, unknown>;
  const a = actuator as Record<string, unknown>;
  const values = {
    aoPath: stringValue(n.aoPath, DEFAULT_FOUNDATION_CONFIG.notification.aoPath, 'notification.aoPath'),
    timeoutMs: positiveInteger(n.timeoutMs, DEFAULT_FOUNDATION_CONFIG.notification.timeoutMs, 'notification.timeoutMs'),
    maxJournalAttempts: positiveInteger(n.maxJournalAttempts, DEFAULT_FOUNDATION_CONFIG.notification.maxJournalAttempts, 'notification.maxJournalAttempts'),
    argvCeilingChars: positiveInteger(n.argvCeilingChars, DEFAULT_FOUNDATION_CONFIG.notification.argvCeilingChars, 'notification.argvCeilingChars'),
    pollIntervalMs: positiveInteger(s.pollIntervalMs, DEFAULT_FOUNDATION_CONFIG.scheduler.pollIntervalMs, 'scheduler.pollIntervalMs'),
    leaseMs: positiveInteger(s.leaseMs, DEFAULT_FOUNDATION_CONFIG.scheduler.leaseMs, 'scheduler.leaseMs'),
    destructiveCleanupEnabled: booleanValue(m.destructiveCleanupEnabled, DEFAULT_FOUNDATION_CONFIG.migration.destructiveCleanupEnabled, 'migration.destructiveCleanupEnabled'),
    enabled: booleanValue(a.enabled, DEFAULT_FOUNDATION_CONFIG.actuator.enabled, 'actuator.enabled'),
    postValidationWindowMs: positiveInteger(a.postValidationWindowMs, DEFAULT_FOUNDATION_CONFIG.actuator.postValidationWindowMs, 'actuator.postValidationWindowMs'),
    maxUnadoptedRuntimeMerges: nonNegativeInteger(a.maxUnadoptedRuntimeMerges, DEFAULT_FOUNDATION_CONFIG.actuator.maxUnadoptedRuntimeMerges, 'actuator.maxUnadoptedRuntimeMerges'),
    runtimeMaxAgeHours: positiveInteger(a.runtimeMaxAgeHours, DEFAULT_FOUNDATION_CONFIG.actuator.runtimeMaxAgeHours, 'actuator.runtimeMaxAgeHours'),
    maxUnadoptedNonRuntimeMerges: nonNegativeInteger(a.maxUnadoptedNonRuntimeMerges, DEFAULT_FOUNDATION_CONFIG.actuator.maxUnadoptedNonRuntimeMerges, 'actuator.maxUnadoptedNonRuntimeMerges'),
    nonRuntimeMaxAgeDays: positiveInteger(a.nonRuntimeMaxAgeDays, DEFAULT_FOUNDATION_CONFIG.actuator.nonRuntimeMaxAgeDays, 'actuator.nonRuntimeMaxAgeDays'),
  };
  const invalid = Object.values(values).find(failure);
  if (invalid) return invalid;

  return {
    ok: true,
    config: {
      schemaVersion: FOUNDATION_CONFIG_SCHEMA_VERSION,
      notification: {
        aoPath: values.aoPath as string,
        timeoutMs: values.timeoutMs as number,
        maxJournalAttempts: values.maxJournalAttempts as number,
        argvCeilingChars: values.argvCeilingChars as number,
      },
      scheduler: {
        pollIntervalMs: values.pollIntervalMs as number,
        leaseMs: values.leaseMs as number,
      },
      migration: {
        destructiveCleanupEnabled: values.destructiveCleanupEnabled as boolean,
      },
      actuator: {
        enabled: values.enabled as boolean,
        postValidationWindowMs: values.postValidationWindowMs as number,
        maxUnadoptedRuntimeMerges: values.maxUnadoptedRuntimeMerges as number,
        runtimeMaxAgeHours: values.runtimeMaxAgeHours as number,
        maxUnadoptedNonRuntimeMerges: values.maxUnadoptedNonRuntimeMerges as number,
        nonRuntimeMaxAgeDays: values.nonRuntimeMaxAgeDays as number,
      },
    },
  };
}

export function notificationConfig(input: unknown = {}): FoundationNotificationConfig {
  const parsed = parseFoundationConfig(input);
  if (!parsed.ok) throw new Error(`${parsed.reason}:${parsed.path}`);
  return parsed.config.notification;
}
