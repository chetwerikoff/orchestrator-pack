export declare function classifierManifestHash(manifestPath?: string): string;
export declare function loadClassifierManifest(manifestPath?: string): {
  manifest: Record<string, unknown>;
  hash: string | null;
};
