export const LEGACY_LIST_REL_PATH: string;

export function canonicalLegacyDraftPath(input: string): string | null;

export function parseLegacyListContent(content: string): {
  paths: string[];
  malformed: string[];
  duplicateEquivalent: string[];
  rawPaths: unknown[];
};

export function loadLegacyPathSet(content: string): {
  ok: boolean;
  paths: Set<string> | null;
  errors: string[];
  malformed: string[];
  duplicateEquivalent: string[];
};

export function diffLegacyPathSets(
  baseSet: Set<string>,
  headSet: Set<string>,
): { added: string[]; removed: string[] };

export function resolveLegacyListPath(
  repoRoot: string,
  legacyListPath?: string,
): string | null;
