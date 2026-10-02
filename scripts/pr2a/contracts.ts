export const FOUNDATION_COMMIT = 'b967dfe156838039e1d6d137e7064dc9d1b10b4d';

export const D928 = Object.freeze([
  'scripts/orchestrator-wake-supervisor.ps1',
  'scripts/lib/Orchestrator-SideProcessSupervisor.ps1',
  'scripts/lib/Review-StartClaim.ps1',
  'scripts/review-start-claim-reaper.ps1',
] as const);

export const TARGET_LIBRARIES = Object.freeze([
  'scripts/lib/Orchestrator-SideProcessSupervisor.ps1',
  'scripts/lib/Review-StartClaim.ps1',
] as const);
