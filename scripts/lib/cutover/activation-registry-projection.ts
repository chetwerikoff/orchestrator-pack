import { closeSync, copyFileSync, fsyncSync, openSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SchedulerRegistry } from './types.ts';
import { sha256Bytes } from './stable-stringify.ts';

export function validateSchedulerRegistry(bytes: Buffer): SchedulerRegistry {
  const value = JSON.parse(bytes.toString('utf8')) as SchedulerRegistry;
  if (value.schemaVersion !== 1) throw new Error('registry_schema_invalid');
  if (!Array.isArray(value.children) || value.children.length !== 1) throw new Error('registry_scheduler_cardinality');
  const child = value.children[0]!;
  if (child.id !== 'pack-review-scheduler' || child.script !== 'pr2-foundation/scheduler.ts') throw new Error('registry_scheduler_identity');
  if (value.requiredChildIds.length !== 1 || value.requiredChildIds[0] !== child.id) throw new Error('registry_required_ids_invalid');
  return value;
}

export function projectRegistry(stagedPath: string, targetPath: string): string {
  const staged = readFileSync(stagedPath);
  validateSchedulerRegistry(staged);
  if (statSync(stagedPath).dev !== statSync(dirname(targetPath)).dev) throw new Error('registry_cross_device_projection');
  const temp = `${targetPath}.cutover-${process.pid}`;
  copyFileSync(stagedPath, temp);
  const fd = openSync(temp, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, targetPath);
  const dirFd = openSync(dirname(targetPath), 'r');
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  const readback = readFileSync(targetPath);
  if (!readback.equals(staged)) throw new Error('registry_readback_mismatch');
  return sha256Bytes(readback);
}

export function verifyRegistryHash(path: string, expected: string): void {
  const bytes = readFileSync(path);
  validateSchedulerRegistry(bytes);
  if (sha256Bytes(bytes) !== expected) throw new Error('registry_hash_mismatch');
}
