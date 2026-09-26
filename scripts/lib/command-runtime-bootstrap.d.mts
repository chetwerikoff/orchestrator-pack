export const COMMAND_RUNTIME_BOOTSTRAP_VERSION: string;
export const RECOVERY_BOUNDARY_DIAGNOSTIC: string;
export const TEMPORARY_REST_UNBLOCK_OWNER_NOTE: string;

export function buildCommandRuntimePath(packScriptsDir: string, inheritedPath?: string): string;
export function classifyEffectivePath(effectivePath: string, packScriptsDir: string): string;
export function evaluateCommandRuntimePreflight(input?: Record<string, unknown>): {
  ok: boolean;
  reason: string;
  diagnostic?: string;
  pathClass?: string;
  missingTool?: string;
  tools?: Record<string, string>;
};
export function resolveManagerBrowserOperatorConfig(input?: Record<string, unknown>):
  | { ok: true; config: { projectUrl: string; chromeUserDataDir: string; source: string; operatorConfigPath?: string } }
  | { ok: false; probe: string; reason: string; evidence: string; remedy: string };
export function evaluateManagerBrowserEnvironmentPreflight(input?: Record<string, unknown>):
  | {
      ok: true;
      runtime: Record<string, unknown>;
      config: { projectUrl: string; chromeUserDataDir: string; source: string; operatorConfigPath?: string };
      sharedModulePath: string;
    }
  | {
      ok: false;
      probe: string;
      reason: string;
      evidence: string;
      remedy: string;
      runtime?: Record<string, unknown>;
    };
export function parseStructuredCommandOutput(input?: Record<string, unknown>): {
  ok: boolean;
  reason?: string;
  value?: unknown;
  stderr?: string;
};
export function evaluateUncoveredGhArgv(argv: string[]): Record<string, unknown>;
export function scanForbiddenWorkaroundInstructions(
  text: string,
  filePath: string,
): Array<{ file: string; id: string; line: string }>;
export function scanRecoveryDuplication(
  text: string,
  filePath: string,
): Array<{ file: string; pattern: string; line: string }>;
export function runLiveCommandRuntimePreflight(packRoot?: string): void;
