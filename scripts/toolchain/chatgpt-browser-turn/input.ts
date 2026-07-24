import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync } from 'node:fs';

export class InputInvalidError extends Error { readonly code = 'input_invalid'; }

function sameFile(a: ReturnType<typeof fstatSync>, b: ReturnType<typeof fstatSync>): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

export interface InputSnapshot { bytes: Uint8Array; text: string; byteLength: number; }

export function readStableInput(path: string): InputSnapshot {
  let beforePath;
  try { beforePath = lstatSync(path, { bigint: true }); } catch { throw new InputInvalidError('input path is not readable'); }
  if (beforePath.isSymbolicLink() || !beforePath.isFile()) throw new InputInvalidError('input must be a regular non-symlink file');
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let fd = -1;
  try {
    fd = openSync(path, flags);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new InputInvalidError('input changed away from regular file');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (!sameFile(before, after) || before.size !== BigInt(bytes.byteLength)) throw new InputInvalidError('input changed while being read');
    const afterPath = lstatSync(path, { bigint: true });
    if (afterPath.isSymbolicLink() || afterPath.dev !== after.dev || afterPath.ino !== after.ino || afterPath.size !== after.size || afterPath.mtimeNs !== after.mtimeNs)
      throw new InputInvalidError('input path identity changed while being read');
    if (bytes.byteLength === 0) throw new InputInvalidError('input is empty');
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new InputInvalidError('UTF-8 BOM is forbidden');
    if (bytes.includes(0)) throw new InputInvalidError('NUL is forbidden');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new InputInvalidError('input is not valid UTF-8'); }
    if (/\r(?!\n)/.test(text)) throw new InputInvalidError('bare CR is forbidden');
    return { bytes: Uint8Array.from(bytes), text: text.replace(/\r\n/g, '\n'), byteLength: bytes.byteLength };
  } catch (error) {
    if (error instanceof InputInvalidError) throw error;
    throw new InputInvalidError(error instanceof Error ? error.message : String(error));
  } finally { if (fd >= 0) closeSync(fd); }
}
