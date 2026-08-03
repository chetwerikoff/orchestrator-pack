import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { atomicJson, profileDiagnosticsDir, profileDiagnosticsFilePath } from './storage-common.ts';

export const DRIVER_DIAGNOSTIC_SCHEMA = 'driver-diagnostic/v1' as const;
export const DRIVER_DIAGNOSTIC_VERSION = 1 as const;

export const DRIVER_DIAGNOSTIC_DETAIL_UNAVAILABLE = 'driver_exception_detail_unavailable' as const;

export interface DriverDiagnosticV1 {
  schema: typeof DRIVER_DIAGNOSTIC_SCHEMA;
  version: typeof DRIVER_DIAGNOSTIC_VERSION;
  configured_profile_key: string;
  invocation_id?: string;
  operation?: string;
  cause: string;
  exception_name: string;
  exception_message: string;
  exception_stack: string;
  created_at: string;
}

function validDiagnosticIdentity(identity: string): boolean {
  return identity.length > 0
    && identity.length <= 128
    && basename(identity) === identity
    && /^[A-Za-z0-9._-]+$/.test(identity);
}

function diagnosticWritePath(profileKey: string, identity: string): string {
  if (!validDiagnosticIdentity(identity)) throw new Error('driver_diagnostic_identity_invalid');
  return join(profileDiagnosticsDir(profileKey), `${identity}.json`);
}

export function isDriverDiagnosticDebugEnabled(): boolean {
  return process.env.CHATGPT_BROWSER_TURN_DEBUG === '1';
}

export function exceptionDetail(error: unknown): { name: string; message: string; stack: string } {
  try {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack ?? '',
      };
    }
    return {
      name: 'Error',
      message: String(error),
      stack: '',
    };
  } catch {
    return {
      name: 'Error',
      message: DRIVER_DIAGNOSTIC_DETAIL_UNAVAILABLE,
      stack: '',
    };
  }
}

export function writeDriverDiagnostic(profileKey: string, identity: string, record: DriverDiagnosticV1): void {
  atomicJson(diagnosticWritePath(profileKey, identity), record);
}

export function readDriverDiagnostic(profileKey: string, identity: string): DriverDiagnosticV1 | undefined {
  if (!validDiagnosticIdentity(identity)) return undefined;
  const path = profileDiagnosticsFilePath(profileKey, identity);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as DriverDiagnosticV1;
}

export function mirrorDriverDiagnosticToStderr(record: DriverDiagnosticV1): void {
  if (!isDriverDiagnosticDebugEnabled()) return;
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

export function recordSwallowedDriverException(
  profileKey: string | undefined,
  identity: string | undefined,
  cause: string,
  error: unknown,
  extra: { invocation_id?: string; operation?: string; allowUnresolvedProfile?: boolean } = {},
): string | undefined {
  const detail = exceptionDetail(error);
  const resolvedProfile = profileKey
    && (profileKey !== 'profile-unresolved' || extra.allowUnresolvedProfile)
    ? profileKey
    : undefined;
  const record: DriverDiagnosticV1 = {
    schema: DRIVER_DIAGNOSTIC_SCHEMA,
    version: DRIVER_DIAGNOSTIC_VERSION,
    configured_profile_key: resolvedProfile ?? 'profile-unresolved',
    cause,
    exception_name: detail.name,
    exception_message: detail.message,
    exception_stack: detail.stack,
    created_at: new Date().toISOString(),
    ...(extra.invocation_id ? { invocation_id: extra.invocation_id } : {}),
    ...(extra.operation ? { operation: extra.operation } : {}),
  };

  let writtenId: string | undefined;
  if (resolvedProfile && identity) {
    try {
      writeDriverDiagnostic(resolvedProfile, identity, {
        ...record,
        configured_profile_key: resolvedProfile,
        ...(extra.invocation_id ? { invocation_id: extra.invocation_id } : {}),
      });
      writtenId = identity;
    } catch {
      // Recording is best-effort and must not change the emitted terminal result.
    }
  }

  try {
    mirrorDriverDiagnosticToStderr(record);
  } catch {
    // Debug mirroring is best-effort and must not change the emitted terminal result.
  }

  return writtenId;
}
