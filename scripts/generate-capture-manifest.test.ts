import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compareCaptureManifests,
  generateCaptureManifest,
} from './generate-capture-manifest.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const committedManifestPath = path.join(
  repoRoot,
  'tests/external-output-references/capture-manifest.json',
);

describe('capture manifest regression', () => {
  it('matches the committed repository capture manifest', () => {
    const committed = JSON.parse(readFileSync(committedManifestPath, 'utf8'));
    const regenerated = generateCaptureManifest(repoRoot);

    expect(compareCaptureManifests(committed, regenerated)).toEqual([]);
  });
});
