export function applyListedJq(value: unknown, jq: string | null): unknown;
export function mapPullState(pull: Record<string, unknown>): string;
export function resolveRepoContext(options: {
  cwd?: string;
  repoFlag?: string | null;
  realGh: string;
  hostname?: string | null;
}): { slug: string; host: string };
export const REST_ERROR_MARKER: string;
