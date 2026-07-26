import { readFileSync } from 'node:fs';
import { sha256Bytes } from './stable-stringify.ts';
import { writeDurableFile } from './activation-evidence.ts';
import type { SchedulerRegistry } from './types.ts';

export function validateSchedulerRegistry(bytes: Buffer | string): SchedulerRegistry {
  const registry = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes) as SchedulerRegistry;
  if (registry.schemaVersion !== 2 || registry.requiredChildIds?.length !== 1 || registry.requiredChildIds[0] !== 'pr2-scheduler') {
    throw new Error('staged_registry_required_child_invalid');
  }
  if (!Array.isArray(registry.children) || registry.children.length !== 1) throw new Error('staged_registry_child_count_invalid');
  const child = registry.children[0];
  if (child.id !== 'pr2-scheduler' || child.runtime !== 'node' || child.script !== 'pr2-foundation/scheduler.ts' || child.sideEffecting !== true) {
    throw new Error('staged_registry_scheduler_invalid');
  }
  if (!Number.isInteger(child.cadenceSeconds) || child.cadenceSeconds <= 0) throw new Error('staged_registry_cadence_invalid');
  return registry;
}

export function projectRegistry(targetPath: string, projectionPath: string): { registryHash: string; registry: SchedulerRegistry } {
  const source = readFileSync(targetPath);
  const registry = validateSchedulerRegistry(source);
  writeDurableFile(projectionPath, source);
  const readBack = readFileSync(projectionPath);
  if (!readBack.equals(source)) throw new Error('registry_projection_readback_mismatch');
  return { registryHash: sha256Bytes(readBack), registry };
}
