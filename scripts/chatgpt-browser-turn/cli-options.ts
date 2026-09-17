export function optionValue(
  argv: readonly string[],
  key: string,
): string | undefined {
  const flag = `--${key}`;
  let found: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== flag) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--') || found !== undefined) return undefined;
    found = value;
  }
  return found;
}
