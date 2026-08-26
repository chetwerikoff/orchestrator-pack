export const WRAPPER_PATH: string;
export const TRACKED_GH_UNAVAILABLE_REASON: string;
export const TRACKED_GH_UNAVAILABLE_DIAGNOSTIC: string;
export const MAX_NON_NATIVE_GH_CANDIDATES: number;
export function resolveTrackedGhWrapper(wrapperPath?: string): string;
export function isNativeGhExecutable(path: string): boolean;
export function resolveRealGhBinary(wrapperRealPath?: string): string;
