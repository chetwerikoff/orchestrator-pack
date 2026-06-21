export function validateLegacyListGuardWorkflowOrdering(workflowContent: string): {
  ok: boolean;
  errors: string[];
};

export function runLegacyListGuardWorkflowOrderingCheck(repoRoot: string): {
  ok: boolean;
  errors: string[];
};
