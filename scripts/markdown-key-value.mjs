/**
 * Shared key-value block parsing for fenced markdown blocks.
 */

/**
 * @param {string} value
 */
export function normalizeLine(value) {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * @param {string} body
 */
export function parseKeyValueBlock(body) {
  /** @type {Record<string, string>} */
  const result = {};
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const match = trimmed.match(/^([a-z][a-z0-9-]*)\s*:\s*(.+)$/i);
    if (match) {
      const key = match[1].toLowerCase().replace(/_/g, '-');
      result[key] = normalizeLine(match[2]);
    }
  }
  return result;
}
