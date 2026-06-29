export function applyListedJq(value: unknown, jq: string | null): unknown;
export function ghApiJson(
  realGh: string,
  endpoint: string,
  options?: { hostname?: string | null; cwd?: string },
): unknown;
export function mapPullState(pull: Record<string, unknown>): string;
export function mapPullToGhJson(pull: Record<string, unknown>, fields: string[]): Record<string, unknown>;
export function mapIssueState(issue: Record<string, unknown>): string;
export function mapIssueStateReason(issue: Record<string, unknown>): string | null;
export function mapIssueToGhJson(issue: Record<string, unknown>, fields: string[]): Record<string, unknown>;
export function resolveRepoContext(options: {
  cwd?: string;
  repoFlag?: string | null;
  realGh: string;
  hostname?: string | null;
}): { slug: string; host: string };
export const REST_ERROR_MARKER: string;
