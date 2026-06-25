export interface ParsedGhArgv {
  raw: string[];
  hostname: string | null;
  repo: string | null;
  jq: string | null;
  jsonFields: string[] | null;
  subcommand: string[];
  flags: Record<string, string | boolean>;
  positionals: string[];
}

export function parseGhArgv(argv: string[]): ParsedGhArgv;
export function jsonFieldsEqual(fields: string[] | null, expected: string[]): boolean;
