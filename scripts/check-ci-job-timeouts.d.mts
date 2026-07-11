export function parseWorkflowJobs(text: string): Array<{
  name: string;
  line: number;
  keys: Map<string, number>;
  timeoutMinutes: number | null;
}>;
export function verifyWorkflowTimeoutPolicy(
  path: string,
  text: string,
  policy?: {
    references: Record<string, { minutes: number; margin: number }>;
    jobs: Record<string, { timeout: number; reference: string }>;
  },
): {
  ok: boolean;
  errors: string[];
  jobs: ReturnType<typeof parseWorkflowJobs>;
};
export function verifyConfiguredWorkflowTimeouts(readFile?: (path: string, encoding: 'utf8') => string): Array<{
  path: string;
  ok: boolean;
  errors: string[];
  jobs: ReturnType<typeof parseWorkflowJobs>;
}>;
