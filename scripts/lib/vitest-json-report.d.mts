export function normalizeFilePath(file: unknown, repoRoot: unknown): string;
export function sumAssertionDurationMs(assertions: unknown[]): number;
export function resolveFileDurationMs(fileResult: unknown): number;
export function collectFromVitestJson(payload: unknown, repoRoot: string): {
  tests: Array<{ kind: 'test'; name: string; file: string; durationMs: number }>;
  files: Array<{ file: string; durationMs: number; testCount: number; timingSource: string }>;
} | null;
export function isCleanVitestJsonReport(payload: unknown): boolean;
export function hasFailedTestsVitestJsonReport(payload: unknown): boolean;
export function isCleanVitestJsonReportFile(reportPath: string): boolean;
export function hasFailedTestsVitestJsonReportFile(reportPath: string): boolean;
export function parseVitestReportFile(reportPath: string, repoRoot: string): ReturnType<typeof collectFromVitestJson>;
export function mergeVitestJsonPayloads(payloads: unknown[]): { testResults: unknown[] };
export function mergeVitestReportFiles(reportPaths: string[], outputPath: string): { testResults: unknown[] };
