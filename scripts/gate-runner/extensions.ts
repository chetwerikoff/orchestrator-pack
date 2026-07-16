import { bulkDeclarativeGateRegistrations } from './bulk-declarative-gates.ts';
import { bulkStaticGateRegistrations } from './custom/bulk-static-gates.ts';
import { nodeBackedGateRegistrations } from './custom/node-backed-gates.ts';
import type { GateRegistration } from './registry.ts';

// Stable extension seam for later migration waves. Bulk gate ports add registrations
// here without changing the runner, result algebra, evidence contract, or CLI reducer.
export const extensionGateRegistrations: readonly GateRegistration[] = [
  ...bulkDeclarativeGateRegistrations,
  ...bulkStaticGateRegistrations,
  ...nodeBackedGateRegistrations,
];
