import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseIssueBody, parseIssueScopeFences } from '../lib/issue_parser.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'issue-bodies');

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

describe('parseIssueBody', () => {
  it('extracts mandatory denylist from issue body fixtures', () => {
    const constraints = parseIssueBody(loadFixture('minimal-denylist.md'));
    expect(constraints.denylist).toEqual(['vendor/**', 'packages/core/**', '.orchestrator-pack/**']);
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

  it('reports ordered scope fence occurrences with original locations and field-local indices', () => {
    const body = [
      '## Files in scope',
      '```denylist',
      'vendor/**',
      '# skipped',
      '```',
      '```allowed-roots',
      'scripts/**',
      '```',
      '```denylist',
      'packages/core/**',
      '```',
      '```allowed-roots',
      'plugins/**',
      '```',
    ].join('\n');
    const parsed = parseIssueScopeFences(body);
    expect(parsed.constraints).toEqual({
      denylist: ['vendor/**', 'packages/core/**'],
      allowed_roots: ['scripts/**', 'plugins/**'],
    });
    expect(parsed.occurrences.map(({ kind, entryOffset, entries }) => ({ kind, entryOffset, entries }))).toEqual([
      { kind: 'denylist', entryOffset: 0, entries: ['vendor/**'] },
      { kind: 'allowed-roots', entryOffset: 0, entries: ['scripts/**'] },
      { kind: 'denylist', entryOffset: 1, entries: ['packages/core/**'] },
      { kind: 'allowed-roots', entryOffset: 1, entries: ['plugins/**'] },
    ]);
    for (const fence of parsed.occurrences) {
      expect(body.slice(fence.start, fence.end)).toContain('```' + fence.kind);
      expect(fence.end).toBeGreaterThan(fence.start);
    }
    expect(parseIssueBody(body)).toEqual(parsed.constraints);
    expect(parseIssueScopeFences('no fences').occurrences).toEqual([]);
    expect(() => parseIssueBody('no fences')).toThrow(/mandatory/);
  });
});
