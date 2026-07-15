import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCaptureManifest } from '#opk-kernel/artifact-contracts';
import { checkGoldenHygiene } from './golden-hygiene.js';

const repoRoot = join(import.meta.dirname, '..', '..');

describe('external-output golden hygiene', () => {
  it('labels every catalog-retired capture and preserves every live golden byte', () => {
    expect(checkGoldenHygiene(repoRoot)).toEqual([]);
  });

  it('round-trips the metadata-only capture manifest through kernel validation', () => {
    const bytes = readFileSync(join(repoRoot, 'tests/external-output-references/capture-manifest.json'));
    const document = parseCaptureManifest(bytes);
    expect(Buffer.from(document.serializeUnchanged()).equals(bytes)).toBe(true);
  });
});
