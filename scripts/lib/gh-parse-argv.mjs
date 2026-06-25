/**
 * Normalize gh argv into a structured form for inventory matching.
 */

/** gh boolean flags that must not consume the next token as a value. */
const BOOLEAN_ONLY_FLAGS = new Set([
  '--fail-fast',
  '--name-only',
  '--required',
  '--watch',
  '--web',
  '-w',
]);

/**
 * @param {string[]} argv
 * @returns {{
 *   raw: string[],
 *   hostname: string | null,
 *   repo: string | null,
 *   jq: string | null,
 *   jsonFields: string[] | null,
 *   subcommand: string[],
 *   flags: Record<string, string | boolean>,
 *   positionals: string[],
 * }}
 */
export function parseGhArgv(argv) {
  const result = {
    raw: [...argv],
    hostname: null,
    repo: null,
    jq: null,
    jsonFields: null,
    subcommand: [],
    flags: {},
    positionals: [],
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--hostname') {
      result.hostname = argv[++i] ?? null;
      i += 1;
      continue;
    }
    if (arg === '--repo' || arg === '-R') {
      result.repo = argv[++i] ?? null;
      i += 1;
      continue;
    }
    if (arg === '--json') {
      const fields = (argv[++i] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .sort();
      result.jsonFields = fields;
      i += 1;
      continue;
    }
    if (arg === '--jq' || arg === '-q') {
      result.jq = argv[++i] ?? '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        const key = arg.slice(0, eq);
        const value = arg.slice(eq + 1);
        result.flags[key] = value;
        i += 1;
        continue;
      }
      const key = arg;
      const next = argv[i + 1];
      if (next && !next.startsWith('-') && !BOOLEAN_ONLY_FLAGS.has(key)) {
        result.flags[key] = next;
        i += 2;
        continue;
      }
      result.flags[key] = true;
      i += 1;
      continue;
    }
    if (arg.startsWith('-') && arg.length === 2) {
      result.flags[arg] = true;
      i += 1;
      continue;
    }

    if (result.subcommand.length === 0) {
      result.subcommand.push(arg);
      i += 1;
      continue;
    }
    if (result.subcommand.length === 1 && ['pr', 'issue', 'repo', 'api'].includes(result.subcommand[0])) {
      result.subcommand.push(arg);
      i += 1;
      continue;
    }

    result.positionals.push(arg);
    i += 1;
  }

  return result;
}

/**
 * @param {string[] | null} fields
 * @param {string[]} expected
 */
export function jsonFieldsEqual(fields, expected) {
  if (!fields) {
    return false;
  }
  if (fields.length !== expected.length) {
    return false;
  }
  const sorted = [...fields].sort();
  return expected.every((f, idx) => sorted[idx] === f);
}
