export type NormalizeSuccess = { ok: true; path: string };
export type NormalizeFailure = { ok: false; reason: string };
export type NormalizeResult = NormalizeSuccess | NormalizeFailure;

const DRIVE_LETTER = /^[a-zA-Z]:/;
const ABSOLUTE_UNIX = /^\//;
const ABSOLUTE_WIN = /^\\/;
const PARENT_SEGMENT = /(^|\/)\.\.(\/|$)/;

/**
 * Normalize a repository-relative path per architecture decision #3.E.
 * Rejects traversal, drive letters, absolute paths, and backslashes.
 */
export function normalizePath(input: string): NormalizeResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, reason: 'empty path' };
  }

  if (DRIVE_LETTER.test(trimmed)) {
    return { ok: false, reason: 'drive letter paths are not allowed' };
  }

  if (ABSOLUTE_UNIX.test(trimmed) || ABSOLUTE_WIN.test(trimmed)) {
    return { ok: false, reason: 'absolute paths are not allowed' };
  }

  if (trimmed.includes('\\')) {
    return { ok: false, reason: 'backslashes are not allowed; use forward slashes' };
  }

  let normalized = trimmed.replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }

  if (!normalized) {
    return { ok: false, reason: 'empty path after normalization' };
  }

  if (PARENT_SEGMENT.test(normalized)) {
    return { ok: false, reason: 'parent directory segments (..) are not allowed' };
  }

  if (normalized.includes('//')) {
    return { ok: false, reason: 'duplicate slashes are not allowed' };
  }

  return { ok: true, path: normalized };
}

/**
 * Normalize many paths; returns first failure or all normalized paths.
 */
export function normalizePaths(
  inputs: string[],
): { ok: true; paths: string[] } | NormalizeFailure {
  const paths: string[] = [];
  for (const input of inputs) {
    const result = normalizePath(input);
    if (!result.ok) {
      return result;
    }
    paths.push(result.path);
  }
  return { ok: true, paths };
}
