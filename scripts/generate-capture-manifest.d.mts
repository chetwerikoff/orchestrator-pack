export function loadCommittedCaptureManifest(
  repoRoot: string,
  manifestPath: string,
): {
  version?: number;
  corpusRoot: string;
  entries?: Record<
    string,
    {
      id: string;
      producer: string;
      sourceCommand?: string;
      kind?: string;
      path?: string;
      contentHash?: string;
      exitStatus?: number;
    }
  >;
};
