export function normalizeGhCommandTemplate(command: string): string;
export function commandTemplateToArgv(command: string): string[] | null;
export function isInventoryCoveredArgv(argv: string[]): boolean;
export function isInventoryCoveredCommand(command: string): boolean;
export function extractGhCommandsFromReconcileLine(line: string): string[];
export function extractGhCommandsFromRuleSurfaceLine(line: string): string[];
export function extractGhCommandsFromRuleSurface(text: string): string[];
export function scanFileForViolations(
  filePath: string,
  mode: 'reconcile' | 'rules',
): Array<{ file: string; command: string; line?: string }>;
