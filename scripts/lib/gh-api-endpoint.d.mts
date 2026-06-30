export const GH_API_OPTION_WITH_VALUE: ReadonlySet<string>;

export function ghApiEndpointAfterApi(tokens: string[], cursor: number): string | null;
export function ghApiEndpointFromApiTokens(tokens: string[] | null): string | null;
export function ghApiEndpointFromArgv(argv: string[]): string | null;
