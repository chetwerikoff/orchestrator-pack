import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as captureManifestModule from '../generate-capture-manifest.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const committedManifestPath = path.join(
  repoRoot,
  'tests/external-output-references/capture-manifest.json',
);
type CaptureManifest = ReturnType<typeof captureManifestModule.generateCaptureManifest>;
const { compareCaptureManifests } = captureManifestModule as typeof captureManifestModule & {
  compareCaptureManifests(
    committed: CaptureManifest,
    regenerated: CaptureManifest,
  ): string[];
};

describe('capture manifest regression', () => {
  it('matches the committed repository capture manifest', () => {
    const committed = JSON.parse(readFileSync(committedManifestPath, 'utf8')) as CaptureManifest;
    const regenerated = captureManifestModule.generateCaptureManifest(repoRoot);

    expect(compareCaptureManifests(committed, regenerated)).toEqual([]);
  });
});
