import type {
  OrcaJsonResponse,
  OrcaLocalOutcomeCategory,
} from '../orca-runtime/native.ts';

const COMPAT_DIAGNOSTIC_PREFIX = 'opk-runtime-compat-diagnostic-v1.';

export interface RuntimeCompatibilityDiagnostic {
  readonly outcomeCategory: OrcaLocalOutcomeCategory;
  readonly errorCode?: string;
  readonly message?: string;
}

export function encodeRuntimeCompatibilityDiagnostic(
  response: OrcaJsonResponse,
): string | null {
  if (response.ok || !response.outcomeCategory) return null;
  const payload: RuntimeCompatibilityDiagnostic = {
    outcomeCategory: response.outcomeCategory,
    ...(response.error?.code ? { errorCode: response.error.code } : {}),
    ...(response.error?.message ? { message: response.error.message } : {}),
  };
  return `${COMPAT_DIAGNOSTIC_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

export function decodeRuntimeCompatibilityDiagnostic(
  value: string,
): RuntimeCompatibilityDiagnostic | null {
  if (!value.startsWith(COMPAT_DIAGNOSTIC_PREFIX)) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(value.slice(COMPAT_DIAGNOSTIC_PREFIX.length), 'base64url').toString('utf8'),
    ) as Partial<RuntimeCompatibilityDiagnostic>;
    if (![
      'process_launch_failed',
      'empty_stdout',
      'invalid_json',
      'recognized_control_plane_code',
      'supported_operation_failure',
    ].includes(decoded.outcomeCategory ?? '')) {
      return null;
    }
    return {
      outcomeCategory: decoded.outcomeCategory!,
      ...(typeof decoded.errorCode === 'string' ? { errorCode: decoded.errorCode } : {}),
      ...(typeof decoded.message === 'string' ? { message: decoded.message } : {}),
    };
  } catch {
    return null;
  }
}
