import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSyntheticMigration } from './migration-journal.ts';

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('[AC5] migration ancestor-symlink guard', () => {
  it.skipIf(process.platform === 'win32')(
    'refuses source reads through a fixture-root ancestor symlink into a live store',
    () => {
      const fixtureRoot = tempRoot('opk-pr2-fixture-');
      const liveRoot = tempRoot('opk-pr2-live-');
      writeFileSync(path.join(liveRoot, 'secret.json'), '{"live":true}\n', 'utf8');
      symlinkSync(liveRoot, path.join(fixtureRoot, 'link-to-live'), 'dir');

      expect(runSyntheticMigration({
        journalPath: path.join(fixtureRoot, 'journal.json'),
        sourcePath: path.join(fixtureRoot, 'link-to-live', 'secret.json'),
        targetPath: path.join(fixtureRoot, 'target.json'),
        fixtureRoot,
        liveStoreRoots: [liveRoot],
        journalKey: 'ancestor-source',
      })).toEqual({ ok: false, reason: 'path_ancestry_symlink_refused' });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses target and journal writes through an ancestor symlink before creating bytes',
    () => {
      const fixtureRoot = tempRoot('opk-pr2-fixture-output-');
      const liveRoot = tempRoot('opk-pr2-live-output-');
      mkdirSync(path.join(liveRoot, 'out'), { recursive: true });
      writeFileSync(path.join(fixtureRoot, 'source.json'), '{"fixture":true}\n', 'utf8');
      symlinkSync(path.join(liveRoot, 'out'), path.join(fixtureRoot, 'linked-output'), 'dir');

      expect(runSyntheticMigration({
        journalPath: path.join(fixtureRoot, 'linked-output', 'journal.json'),
        sourcePath: path.join(fixtureRoot, 'source.json'),
        targetPath: path.join(fixtureRoot, 'linked-output', 'target.json'),
        fixtureRoot,
        liveStoreRoots: [liveRoot],
        journalKey: 'ancestor-output',
      })).toEqual({ ok: false, reason: 'path_ancestry_symlink_refused' });
    },
  );
});
