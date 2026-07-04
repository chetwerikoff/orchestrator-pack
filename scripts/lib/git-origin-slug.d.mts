export const RESOLVER_GIT_ARGV: readonly (readonly string[])[];

export function parseRemoteSlug(url: string): string | null;
export function resolveGitCommonDir(repoRoot: string): string | null;
export function readOriginUrlFromGitConfig(repoRoot: string): string | null;
export function originSlugFromGitConfig(repoRoot: string): string | null;
