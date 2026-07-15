export interface MergeStableCiBase {
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly source: 'merge-base' | 'first-parent';
}

export function resolveMergeStableCiBase(
  repoRoot: string,
  explicitCandidates?: readonly string[],
): MergeStableCiBase | null;
