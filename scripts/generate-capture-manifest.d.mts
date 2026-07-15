export interface CaptureManifestEntry {
  id: string;
  producer: string;
  sourceCommand?: string | null;
  kind?: string;
  path?: string;
  contentHash?: string;
  exitStatus?: number;
  status?: 'historical';
  retiredSurface?: string;
}

export interface CaptureManifest {
  version: number;
  corpusRoot: string;
  entries: Record<string, CaptureManifestEntry>;
}

export function generateCaptureManifest(
  repoRoot: string,
  options?: { corpusRoot?: string },
): CaptureManifest;

export function loadCommittedCaptureManifest(
  repoRoot: string,
  manifestPath: string,
): CaptureManifest;
