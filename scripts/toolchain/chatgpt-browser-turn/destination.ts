import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256 } from './contract.ts';

export class OutputConflictError extends Error { readonly code = 'output_conflict'; }

export interface DestinationReservation { finalPath: string; destinationKey: string; reservationDir: string; tempPath: string; release(): void; }

function canonicalParent(path: string): string {
  const parent = dirname(resolve(path));
  try { return realpathSync.native(parent); } catch { throw new OutputConflictError('destination parent must already exist'); }
}

export function destinationIdentity(path: string): { finalPath: string; destinationKey: string } {
  const parent = canonicalParent(path);
  const finalPath = join(parent, basename(path));
  if (existsSync(finalPath)) throw new OutputConflictError('destination already exists');
  const folded = process.platform === 'win32' ? finalPath.toLowerCase() : finalPath;
  return { finalPath, destinationKey: `path:${sha256(folded)}` };
}

export function reserveDestination(path: string, stateRoot: string, invocationId: string): DestinationReservation {
  const { finalPath, destinationKey } = destinationIdentity(path);
  const reservations = join(stateRoot, 'reservations');
  mkdirSync(reservations, { recursive: true, mode: 0o700 });
  const reservationDir = join(reservations, sha256(destinationKey));
  try { mkdirSync(reservationDir, { mode: 0o700 }); } catch { throw new OutputConflictError('destination is concurrently reserved'); }
  try {
    if (existsSync(finalPath)) throw new OutputConflictError('destination appeared during reservation');
    const parentStat = statSync(dirname(finalPath), { bigint: true });
    const tempPath = join(dirname(finalPath), `.${basename(finalPath)}.${invocationId}.${randomUUID()}.tmp`);
    const fd = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    closeSync(fd);
    const tempStat = statSync(tempPath, { bigint: true });
    if (tempStat.dev !== parentStat.dev) throw new OutputConflictError('temporary and destination are not on the same filesystem');
    return { finalPath, destinationKey, reservationDir, tempPath, release() { rmSync(reservationDir, { recursive: true, force: true }); } };
  } catch (error) {
    rmSync(reservationDir, { recursive: true, force: true });
    throw error;
  }
}

export function publishAtomic(reservation: DestinationReservation, text: string): { byte_length: number; sha256: string; witness: string } {
  if (existsSync(reservation.finalPath)) throw new OutputConflictError('destination appeared before publication');
  const bytes = Buffer.from(text, 'utf8');
  writeFileSync(reservation.tempPath, bytes, { flag: 'w', mode: 0o600 });
  const before = lstatSync(reservation.tempPath, { bigint: true });
  const exclusiveWitness = `inode:${before.dev}:${before.ino}`;
  renameSync(reservation.tempPath, reservation.finalPath);
  const after = lstatSync(reservation.finalPath, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino) throw new Error('publication witness mismatch after rename');
  return { byte_length: bytes.byteLength, sha256: sha256(bytes), witness: exclusiveWitness };
}
