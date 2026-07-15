import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCaptureManifest } from '#opk-kernel/artifact-contracts';

interface RetiredSurface { readonly id: string; readonly sourceCommandPattern: string }
interface RetiredCatalog {
  readonly version: number;
  readonly surfaces: readonly RetiredSurface[];
  readonly knownDefectiveGoldens: readonly { readonly id: string; readonly owningIssue: string; readonly reason: string }[];
}
interface LiveHashes { readonly version: number; readonly entries: Readonly<Record<string, string>> }

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function checkGoldenHygiene(repoRoot: string): string[] {
  const externalRoot = join(repoRoot, 'tests', 'external-output-references');
  const manifest = parseCaptureManifest(readFileSync(join(externalRoot, 'capture-manifest.json'))).value;
  const catalog = JSON.parse(readFileSync(join(repoRoot, 'scripts/json-producers/retired-surfaces.json'), 'utf8')) as RetiredCatalog;
  const liveHashes = JSON.parse(readFileSync(join(externalRoot, 'live-golden-hashes.json'), 'utf8')) as LiveHashes;
  const failures: string[] = [];
  const surfaces = new Map(catalog.surfaces.map((row) => [row.id, row]));

  for (const [id, entry] of Object.entries(manifest.entries)) {
    const command = entry.sourceCommand ?? '';
    const matching = catalog.surfaces.filter((surface) => new RegExp(surface.sourceCommandPattern, 'i').test(command));
    if (matching.length > 0 && entry.status !== 'historical') failures.push(`${id}: retired source command is not historical`);
    if (entry.status === 'historical') {
      if (!entry.retiredSurface || !surfaces.has(entry.retiredSurface)) failures.push(`${id}: unknown retiredSurface`);
      continue;
    }
    const path = join(externalRoot, entry.path);
    const actual = sha256(readFileSync(path));
    if (entry.contentHash !== actual) failures.push(`${id}: contentHash differs from capture bytes`);
    if (liveHashes.entries[id] !== actual) failures.push(`${id}: live golden bytes differ from the committed baseline`);
  }
  for (const id of Object.keys(liveHashes.entries)) {
    if (!manifest.entries[id]) failures.push(`${id}: live hash has no capture manifest entry`);
    else if (manifest.entries[id].status === 'historical') failures.push(`${id}: historical entry remains in live hash baseline`);
  }
  for (const defect of catalog.knownDefectiveGoldens) {
    if (!defect.owningIssue || !defect.reason) failures.push(`${defect.id}: defective golden lacks owning issue/reason`);
    if (manifest.entries[defect.id]?.status !== 'historical') failures.push(`${defect.id}: defective golden is still a live parity target`);
  }
  return failures;
}
