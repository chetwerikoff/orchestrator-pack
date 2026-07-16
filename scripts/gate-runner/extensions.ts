import type { GateRegistration } from './registry.ts';

// Stable extension seam for later migration waves. Bulk gate ports add registrations
// here without changing the runner, result algebra, evidence contract, or CLI reducer.
export const extensionGateRegistrations: readonly GateRegistration[] = [];
