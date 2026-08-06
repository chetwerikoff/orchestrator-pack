import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function vitestHarnessBypassEnv(extraEnv: Record<string, string | undefined> = {}) {
  return {
    ...extraEnv,
    OPK_VITEST_HARNESS: '',
    OPK_VITEST_SKIP_CHILD_ENV_MERGE: '1',
    OPK_VITEST_HARNESS_ROOT: '',
    OPK_VITEST_HARNESS_INVENTORY: '',
    OPK_ORCHESTRATOR_ESCALATION_STATE: '',
    OPK_OPERATOR_ESCALATION_INBOX: '',
    OPK_ESCALATION_HEALTH_SPOOL: '',
    OPK_WAKE_SUPERVISOR_STATE_DIR: '',
    ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR: '',
    OPK_SIDE_PROCESS_STATE_DIR: '',
    OPK_BASE_DIR: '',
    OPK_MECHANICAL_TRANSPORT_TEMP: '',
  };
}
