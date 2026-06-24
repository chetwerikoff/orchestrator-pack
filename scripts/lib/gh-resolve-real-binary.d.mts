export const WRAPPER_PATH: string;
export const MAX_NON_NATIVE_GH_CANDIDATES: number;
export function isNativeGhExecutable(path: string): boolean;
export function resolveRealGhBinary(wrapperRealPath?: string): string;
