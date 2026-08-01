export function isDirectCliExecution(importMetaUrl: string, argvScript: string | undefined): boolean {
  return importMetaUrl === `file://${argvScript}`;
}

export function runReviewerTsCli(main: () => void): void {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

export function exitMissingRequired(flag: string): never {
  console.error(`missing required ${flag}`);
  process.exit(2);
}

export function parseRequiredPositiveInt(
  value: string | undefined,
  flag: string,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    exitMissingRequired(flag);
  }
  return parsed;
}

export function parseRequiredNonEmptyString(
  value: string | undefined,
  flag: string,
): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    exitMissingRequired(flag);
  }
  return trimmed;
}

export function handleCliHelpOrJson(
  arg: string,
  usage: string,
  onJson: () => void,
): boolean {
  if (arg === '--json') {
    onJson();
    return true;
  }
  if (arg === '--help' || arg === '-h') {
    console.log(usage);
    process.exit(0);
  }
  return false;
}

export function throwUnknownCliArg(arg: string, usage: string): never {
  throw new Error(`Unknown argument: ${arg}\n${usage}`);
}

export function dispatchDefaultCliArg(
  arg: string,
  usage: string,
  onJson: () => void,
): void {
  if (!handleCliHelpOrJson(arg, usage, onJson)) {
    throwUnknownCliArg(arg, usage);
  }
}
