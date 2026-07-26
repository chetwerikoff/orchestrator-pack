import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseIssueBody } from '../lib/issue_parser.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'issue-bodies');

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

describe('parseIssueBody', () => {
  it('extracts mandatory denylist from issue body fixtures', () => {
    const constraints = parseIssueBody(loadFixture('minimal-denylist.md'));
    expect(constraints.denylist).toEqual(['vendor/**', 'packages/core/**', '.ao/**']);
    expect(constraints.allowed_roots).toBeUndefined();
  });

  it('extracts optional allowed-roots when present', () => {
    const constraints = parseIssueBody(loadFixture('with-allowed-roots.md'));
    expect(constraints.denylist).toEqual(['vendor/**', 'packages/core/**']);
    expect(constraints.allowed_roots).toEqual([
      'plugins/**',
      'scripts/**',
      'docs/**',
    ]);
  });

  it('ignores comment lines inside fenced blocks', () => {
    const body = [
      'Task',
      '```denylist',
      '# runtime',
      'vendor/**',
      '```',
    ].join('\n');
    expect(parseIssueBody(body).denylist).toEqual(['vendor/**']);
  });

  it('rejects bodies without denylist fence', () => {
    expect(() => parseIssueBody('No fenced denylist here.')).toThrow(
      /missing mandatory.*denylist/i,
    );
  });
});
