import type { GateResult } from './contracts.ts';
import type { SourceSnapshot } from './source-snapshot.ts';

export interface GateEvaluationContext {
  readonly repoRoot: string;
  readonly snapshot: SourceSnapshot;
}

export interface GateRegistration {
  readonly gateId: string;
  evaluate(context: GateEvaluationContext): GateResult;
}

export function validateGateRegistrations(registrations: readonly GateRegistration[]): void {
  const ids = new Set<string>();
  for (const registration of registrations) {
    if (!registration.gateId.trim()) throw new Error('gate registration id must not be empty');
    if (registration.gateId === 'gate-census') {
      throw new Error('gate-census is reserved for the runner-owned census evaluator');
    }
    if (ids.has(registration.gateId)) throw new Error(`duplicate gate registration: ${registration.gateId}`);
    ids.add(registration.gateId);
  }
}

export function selectGateRegistrations(
  registrations: readonly GateRegistration[],
  requestedGateIds: readonly string[] | undefined,
): readonly GateRegistration[] {
  validateGateRegistrations(registrations);
  if (requestedGateIds === undefined || requestedGateIds.length === 0) return registrations;

  const requested = new Set(requestedGateIds);
  const known = new Set([...registrations.map((registration) => registration.gateId), 'gate-census']);
  const unknown = [...requested].filter((gateId) => !known.has(gateId)).sort();
  if (unknown.length > 0) throw new Error(`unknown gate id(s): ${unknown.join(', ')}`);
  return registrations.filter((registration) => requested.has(registration.gateId));
}
