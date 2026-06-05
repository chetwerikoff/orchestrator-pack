export declare function evaluateMechanicalTickInterval(input: {
  nowMs: number;
  lastTickMs?: number;
  intervalMs?: number;
  defaultIntervalMs: number;
}): { ok: true; intervalMs: number } | { ok: false; reason: 'interval_not_elapsed'; intervalMs: number };

export declare function readStdinJson(): Record<string, unknown>;
export declare function printJson(value: unknown): void;
export declare function runStdinJsonCli(
  scriptBasename: string,
  handlers: Record<string, () => unknown>,
): void;
