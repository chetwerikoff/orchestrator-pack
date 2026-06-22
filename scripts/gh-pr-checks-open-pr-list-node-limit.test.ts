import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const source = readFileSync(path.join(repoRoot, 'scripts/lib/Gh-PrChecks.ps1'), 'utf8');

// Extract the Invoke-GhOpenPrList function body so the guard is scoped to the
// open-PR list helper, not other gh invocations in the file.
function functionBody(name: string): string {
  const start = source.indexOf(`function ${name}`);
  expect(start, `${name} not found`).toBeGreaterThanOrEqual(0);
  // Find the matching closing brace by tracking depth from the first '{'.
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

describe('Invoke-GhOpenPrList query cost (node-limit regression)', () => {
  const body = functionBody('Invoke-GhOpenPrList');
  const prListLine = body
    .split('\n')
    .find((l) => l.includes('gh pr list'));

  it('issues a gh pr list query', () => {
    expect(prListLine, 'gh pr list invocation not found').toBeTruthy();
  });

  it('requests baseRefName for handoff admission snapshots', () => {
    expect(prListLine).toMatch(/baseRefName/);
  });

  it('does not request the heavy commits connection in the list query', () => {
    // `--json ...,commits` at --limit 200 blows past GitHub's 500k GraphQL node
    // limit and fails every reconcile tick (issue: open-PR list node limit).
    expect(prListLine).not.toMatch(/commits/);
  });

  it('still resolves head commit committed date per-PR via a single-commit lookup', () => {
    expect(body).toMatch(/headCommittedAt/);
    expect(body).toMatch(/gh api[^\n]*commits\//);
  });
});

describe('Invoke-GhOpenPrListForNumbers query cost', () => {
  const body = functionBody('Invoke-GhOpenPrListForNumbers');

  it('scopes GitHub lookups to explicit PR numbers', () => {
    expect(body).toMatch(/gh pr view \$n/);
    expect(body).not.toMatch(/gh pr list/);
  });

  it('resolves head commit committed date per scoped PR', () => {
    expect(body).toMatch(/headCommittedAt/);
    expect(body).toMatch(/gh api[^\n]*commits\//);
  });
});
