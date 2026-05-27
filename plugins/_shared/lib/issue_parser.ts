export interface IssueConstraints {
  /** Paths/globs that no declaration may include (mandatory in issue body). */
  denylist: string[];
  /** Upper bound on declared paths when present. */
  allowed_roots?: string[];
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
 * Parse authoritative task constraints from a GitHub issue body (#3.A).
 */
export function parseIssueBody(body: string): IssueConstraints {
  const denylist: string[] = [];
  const allowed_roots: string[] = [];
  let sawDenylist = false;

  let match: RegExpExecArray | null;
  const re = new RegExp(FENCE_PATTERN.source, FENCE_PATTERN.flags);
  while ((match = re.exec(body)) !== null) {
    const label = match[1]!.toLowerCase();
    const lines = parseFenceLines(match[2] ?? '');

    if (label === 'denylist') {
      sawDenylist = true;
      denylist.push(...lines);
    } else if (label === 'allowed-roots') {
      allowed_roots.push(...lines);
    }
  }

  if (!sawDenylist) {
    throw new Error('issue body is missing mandatory ```denylist fenced block');
  }

  const result: IssueConstraints = { denylist };
  if (allowed_roots.length > 0) {
    result.allowed_roots = allowed_roots;
  }
  return result;
}
