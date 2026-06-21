export function validateLegacyListGuardWorkflowOrdering(workflowContent: string): {
  ok: boolean;
  errors: string[];
};

export function extractLegacyListGuardJobSteps(
  job: string,
): Array<{ name: string; body: string }>;

export function runLegacyListGuardWorkflowOrderingCheck(repoRoot: string): {
  ok: boolean;
  errors: string[];
};
