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

export function finishReviewerArgvParse<T extends { json: boolean }>(
  arg: string,
  usage: string,
  opts: T,
): void {
  dispatchDefaultCliArg(arg, usage, () => { opts.json = true; });
}

export function runReviewerParsedCli<T>(
  argv: string[],
  toolName: string,
  parseArgs: (argv: string[]) => T,
  run: (opts: T) => number,
): number {
  let opts: T;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${toolName}: ${message}\n`);
    return 2;
  }
  return run(opts);
}

export function applyJournalTailCliArg<T extends { json: boolean; publicActor: string; workdir?: string }>(
  arg: string,
  argv: string[],
  index: number,
  opts: T,
  usage: string,
): number {
  if (arg === '--public-actor') {
    opts.publicActor = String(argv[index + 1] ?? opts.publicActor);
    return index + 1;
  }
  if (arg === '--workdir') {
    opts.workdir = String(argv[index + 1] ?? '');
    return index + 1;
  }
  finishReviewerArgvParse(arg, usage, opts);
  return index;
}

export function finalizeReviewerArgvIndex<T extends { json: boolean; publicActor: string; workdir?: string }>(
  arg: string,
  argv: string[],
  index: number,
  opts: T,
  usage: string,
): number {
  const next = applyJournalTailCliArg(arg, argv, index, opts, usage);
  return next > index ? next : index;
}

export function bootstrapReviewerCli(
  importMetaUrl: string,
  argvScript: string | undefined,
  runCli: (argv: string[]) => number,
): void {
  const main = (): void => {
    process.exit(runCli(process.argv));
  };
  if (isDirectCliExecution(importMetaUrl, argvScript)) {
    runReviewerTsCli(main);
  }
}
