export function eliminateDuplicates(
  checkContexts: Array<Record<string, unknown>>,
): Array<Record<string, unknown>>;
export function bucketForState(state: string): string;
export function aggregateChecks(
  checkContexts: Array<Record<string, unknown>>,
): Array<Record<string, unknown>>;
export function extractActionsRunId(url: string): string | null;
