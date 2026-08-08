import type { RuntimeAdapter, RuntimeWorkerIdentity } from '../runtime/contracts.ts';

export const OPERATOR_PUBLICATION_MAX_TEXT_BYTES = 65_536;
export const OPERATOR_PUBLICATION_MIN_TIMEOUT_MS = 1;
export const OPERATOR_PUBLICATION_MAX_TIMEOUT_MS = 30_000;

export type OperatorPublicationOutcome =
  | 'confirmed'
  | 'pre_dispatch_failure'
  | 'ambiguous';

export interface OperatorPublicationInputV1 {
  readonly route: 'operator-primary';
  readonly target: RuntimeWorkerIdentity;
  readonly text: string;
  readonly timeoutMs: number;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim().length > 0;
}

export function validRuntimeWorkerIdentity(value: unknown): value is RuntimeWorkerIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<RuntimeWorkerIdentity>;
  return nonEmpty(candidate.runtime) && nonEmpty(candidate.id) && nonEmpty(candidate.generation);
}

function validInput(input: OperatorPublicationInputV1): boolean {
  if (!input || input.route !== 'operator-primary' || !validRuntimeWorkerIdentity(input.target)) {
    return false;
  }
  if (!nonEmpty(input.text)) return false;
  const bytes = Buffer.byteLength(input.text, 'utf8');
  if (bytes < 1 || bytes > OPERATOR_PUBLICATION_MAX_TEXT_BYTES) return false;
  return Number.isInteger(input.timeoutMs)
    && input.timeoutMs >= OPERATOR_PUBLICATION_MIN_TIMEOUT_MS
    && input.timeoutMs <= OPERATOR_PUBLICATION_MAX_TIMEOUT_MS;
}

export function publishOperatorMessageOnce(
  adapter: RuntimeAdapter,
  input: OperatorPublicationInputV1,
): OperatorPublicationOutcome {
  if (!validInput(input)) return 'pre_dispatch_failure';

  const result = adapter.dispatchInput(
    { worker: input.target, text: input.text },
    { timeoutMs: input.timeoutMs },
  );
  if (result.status === 'dispatched') return 'confirmed';
  if (result.status === 'send_failed') return 'pre_dispatch_failure';
  return 'ambiguous';
}
