import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** True when this module is the process entry script (direct CLI invocation). */
export function isDirectCliExecution(moduleUrl: string): boolean {
  const entryScript = process.argv[1];
  if (!entryScript) {
    return false;
  }

  try {
    return (
      realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entryScript)
    );
  } catch {
    return false;
  }
}
