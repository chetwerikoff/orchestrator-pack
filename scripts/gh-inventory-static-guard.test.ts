import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractAmbientGhExecutableSelections,
} from './lib/gh-inventory-static-guard.mjs';
import {
  TRACKED_GH_UNAVAILABLE_DIAGNOSTIC,
  resolveTrackedGhWrapper,
} from './lib/gh-resolve-real-binary.mjs';
import { evaluateUncoveredGhArgv } from './lib/command-runtime-bootstrap.mjs';

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'opk-gh-transport-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe('tracked gh transport selection guard', () => {
  it('rejects literal ambient gh executable selections', () => {
    const source = [
      "runProcess({ command: 'gh', args: ['pr', 'view', '1'] });",
      "execFileSync(\"gh\", ['issue', 'view', '2']);",
      "ghApiJson('gh', 'repos/o/r/pulls/3');",
    ].join('\n');

    expect(extractAmbientGhExecutableSelections(source)).toEqual([
      "command: 'gh'",
      'execFileSync("gh"',
      "ghApiJson('gh'",
    ]);
  });

  it('permits semantic gh argv once executable selection is already bound', () => {
    const source = [
      "const argv = ['gh', 'pr', 'view', '1'];",
      "runProcess({ command: resolveTrackedGhWrapper(), args: ['pr', 'view', '1'] });",
      "transport(['gh', 'issue', 'view', '2']);",
    ].join('\n');

    expect(extractAmbientGhExecutableSelections(source)).toEqual([]);
  });

  it('resolves one explicit tracked wrapper path without PATH search', () => {
    const root = tempRoot();
    const wrapper = join(root, 'gh');
    writeFileSync(wrapper, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(wrapper, 0o755);

    expect(resolveTrackedGhWrapper(wrapper)).toBe(resolve(wrapper));
  });

  it('fails closed with the canonical tracked-wrapper diagnostic', () => {
    const missing = join(tempRoot(), 'missing-gh');
    expect(() => resolveTrackedGhWrapper(missing)).toThrow(TRACKED_GH_UNAVAILABLE_DIAGNOSTIC);
  });

  it('keeps uncovered reads on the existing inventory-gap path', () => {
    expect(evaluateUncoveredGhArgv(['api', 'repos/o/r/uncovered-shape'])).toMatchObject({
      ok: false,
      reason: 'gh_inventory_gap',
    });
  });
});
