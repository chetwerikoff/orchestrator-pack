import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, type BigIntStats } from 'node:fs';
import { resolve } from 'node:path';

const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });

export interface InputSnapshot {
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface InputSnapshotHooks {
  readonly afterOpen?: () => void;
  readonly afterRead?: () => void;
}

function invalid(cause: string): never {
  throw new Error(`input_invalid:${cause}`);
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

export function readStableInput(path: string, hooks: InputSnapshotHooks = {}): InputSnapshot {
  const absolute = resolve(path);
  let pathBefore: BigIntStats;
  try {
    pathBefore = lstatSync(absolute, { bigint: true });
  } catch {
    return invalid('unreadable');
  }
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) return invalid('not_regular_nonsymlink');

  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  let fd = -1;
  try {
    fd = openSync(absolute, constants.O_RDONLY | noFollow);
    const openedBefore = fstatSync(fd, { bigint: true });
    if (!openedBefore.isFile()) return invalid('not_regular_nonsymlink');
    if (openedBefore.dev !== pathBefore.dev || openedBefore.ino !== pathBefore.ino) {
      return invalid('changed_during_snapshot');
    }
    hooks.afterOpen?.();

    const buffer = readFileSync(fd);
    hooks.afterRead?.();
    const openedAfter = fstatSync(fd, { bigint: true });
    let pathAfter: BigIntStats;
    try {
      pathAfter = lstatSync(absolute, { bigint: true });
    } catch {
      return invalid('changed_during_snapshot');
    }

    if (!sameStableFile(openedBefore, openedAfter)
      || pathAfter.isSymbolicLink()
      || !pathAfter.isFile()
      || pathAfter.dev !== openedAfter.dev
      || pathAfter.ino !== openedAfter.ino
      || pathAfter.size !== openedAfter.size
      || pathAfter.mtimeNs !== openedAfter.mtimeNs
      || pathAfter.ctimeNs !== openedAfter.ctimeNs
      || BigInt(buffer.byteLength) !== openedAfter.size) {
      return invalid('changed_during_snapshot');
    }

    if (buffer.byteLength === 0) return invalid('empty');
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return invalid('bom');
    if (buffer.includes(0)) return invalid('nul');

    let text: string;
    try {
      text = UTF8_FATAL.decode(buffer);
    } catch {
      return invalid('utf8');
    }
    if (/\r(?!\n)/.test(text)) return invalid('bare_cr');

    return {
      text,
      bytes: Uint8Array.from(buffer),
      byteLength: buffer.byteLength,
      dev: openedAfter.dev,
      ino: openedAfter.ino,
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('input_invalid:')) throw error;
    return invalid('unreadable');
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}
