/**
 * Compatibility facade over the pure topology consumer. On a real checkout (but
 * never inside Vitest itself), unresolved changed/stale weights are supplied by the
 * bounded same-run producer required by Issue #695.
 */
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from './vitest-heavy-topology-core.mjs';
import {
  measurePreTopologyFiles,
  resolvePreTopologyMeasurementTargets,
  shouldMeasurePreTopology,
} from './vitest-pre-topology-measurement.mjs';

export * from './vitest-heavy-topology-core.mjs';

const defaultRepoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function buildHeavyTopology(repoRoot = defaultRepoRoot, options = {}) {
  const root = resolvePath(repoRoot);
  const initial = core.buildHeavyTopology(root, options);
  if (!initial.ok || !shouldMeasurePreTopology(root, options)) return initial;
  const targets = resolvePreTopologyMeasurementTargets(initial, options);
  if (targets.length === 0) return initial;
  const preTopologyMeasurements = measurePreTopologyFiles(root, targets, options);
  return core.buildHeavyTopology(root, { ...options, preTopologyMeasurements });
}
