export declare const AFFIRMATIVE_LIVE_RUNTIME: 'alive';

export declare const TERMINAL_RUNTIME_VALUES: ReadonlySet<string>;

export declare function hasRuntimeField(session: unknown): boolean;

export declare function normalizeRuntimeValue(value: unknown): string;

export declare function isRuntimeFieldLive(session: Record<string, unknown>): boolean;

export declare function isRuntimeAlive(session: Record<string, unknown>): boolean;

export declare function classifyRuntimeField(
  session: Record<string, unknown>,
): 'absent' | 'affirmative_live' | 'terminal_death' | 'present_non_live';
