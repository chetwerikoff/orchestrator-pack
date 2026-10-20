export interface IssueConstraints {
  /** Paths/globs that no declaration may include (mandatory in issue body). */
  denylist: string[];
  /** Upper bound on declared paths when present. */
  allowed_roots?: string[];
}

export type IssueScopeFenceKind = 'denylist' | 'allowed-roots';

/** Locations and field-local indices of each recognized Issue scope fence. */
export interface IssueScopeFenceOccurrence {
  kind: IssueScopeFenceKind;
  start: number;
  end: number;
  entryOffset: number;
  entries: string[];
}

const FENCE_PATTERN =
  /```(denylist|allowed-roots)\s*\r?\n([\s\S]*?)```/gi;

function parseFenceLines(block: string): string[] {
  return block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * One syntax owner for ordered Issue scope entries and fence occurrences.
 * The occurrence indices are field-local across repeated supported fences.
 * Semantic restrictions (such as exactly-one-fence for guarded PRs) belong
 * to each consuming checker, not to this shared parser.
 */
export function parseIssueScopeFences(body: string): {
  constraints: IssueConstraints;
  occurrences: IssueScopeFenceOccurrence[];
} {
  const denylist: string[] = [];
  const allowed_roots: string[] = [];
  const occurrences: IssueScopeFenceOccurrence[] = [];
  const re = new RegExp(FENCE_PATTERN.source, FENCE_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const kind = match[1]!.toLowerCase() as IssueScopeFenceKind;
    const entries = parseFenceLines(match[2] ?? '');
    const field = kind === 'denylist' ? denylist : allowed_roots;
    occurrences.push({
      kind,
      start: match.index,
      end: re.lastIndex,
      entryOffset: field.length,
      entries,
    });
    field.push(...entries);
  }

  const constraints: IssueConstraints = { denylist };
  if (allowed_roots.length > 0) constraints.allowed_roots = allowed_roots;
  return { constraints, occurrences };
}

/** Parse authoritative Issue constraints, retaining the legacy result shape. */
export function parseIssueBody(body: string): IssueConstraints {
  const parsed = parseIssueScopeFences(body);
  if (!parsed.occurrences.some((fence) => fence.kind === 'denylist')) {
    throw new Error('issue body is missing mandatory ```denylist fenced block');
  }
  return parsed.constraints;
}
