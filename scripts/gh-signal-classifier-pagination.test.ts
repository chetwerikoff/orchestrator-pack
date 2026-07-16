import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyGhJsonCapture,
  runGhJsonCommand,
} from './lib/gh-signal-classifier.ts';

const tempRoots: string[] = [];

function writePaginatedGhFake(): string {
  const root = mkdtempSync(join(tmpdir(), 'gh-signal-pagination-'));
  tempRoots.push(root);
  const executable = join(root, 'gh');
  writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (!args.includes('--paginate')) {
  process.stderr.write('missing --paginate\\n');
  process.exit(7);
}
if (!args.includes('--slurp')) {
  process.stdout.write('[{"id":1}]\\n[{"id":2}]\\n');
  process.exit(0);
}
if (args.includes('empty')) {
  process.stdout.write('[[],[]]\\n');
} else {
  process.stdout.write('[[{"id":1}],[{"id":2}]]\\n');
}
`, 'utf8');
  chmodSync(executable, 0o755);
  return executable;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('gh signal paginated API normalization', () => {
  it('adds --slurp and flattens paginated array pages', () => {
    const result = runGhJsonCommand({
      command: writePaginatedGhFake(),
      args: ['api', 'repos/acme/repo/issues/849/events', '--paginate'],
      expectedRoot: 'array',
    });

    expect(result).toMatchObject({
      ok: true,
      classification: 'success',
      reason: 'gh_json_success',
      value: [{ id: 1 }, { id: 2 }],
    });
  });

  it('classifies paginated empty pages as a valid empty array', () => {
    const result = runGhJsonCommand({
      command: writePaginatedGhFake(),
      args: ['api', 'empty', '--paginate'],
      expectedRoot: 'array',
    });

    expect(result).toMatchObject({
      ok: true,
      classification: 'empty',
      reason: 'gh_json_empty_success',
      value: [],
    });
  });

  it('does not broadly accept concatenated JSON documents', () => {
    const result = classifyGhJsonCapture(
      { exitCode: 0, stdout: '[{"id":1}]\n[{"id":2}]\n', stderr: '' },
      { expectedRoot: 'array' },
    );

    expect(result).toMatchObject({
      ok: false,
      classification: 'malformed-json',
      reason: 'gh_json_parse_failed',
    });
  });
});
