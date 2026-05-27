import { matchesGlob } from './glob_match.js';

/** Hardcoded control-artifact prefixes (#3.C / issue #5). */
export const CONTROL_ARTIFACT_GLOBS = ['docs/declarations/**', '.ao/**'] as const;

export function isControlArtifact(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return CONTROL_ARTIFACT_GLOBS.some((pattern) => matchesGlob(pattern, normalized));
}

export function partitionControlArtifacts(paths: string[]): {
  control: string[];
  scoped: string[];
} {
  const control: string[] = [];
  const scoped: string[] = [];

  for (const path of paths) {
    if (isControlArtifact(path)) {
      control.push(path);
    } else {
      scoped.push(path);
    }
  }

  return { control, scoped };
}
