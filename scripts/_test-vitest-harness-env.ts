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
    AO_ORCHESTRATOR_ESCALATION_STATE: '',
    AO_OPERATOR_ESCALATION_INBOX: '',
    AO_ESCALATION_HEALTH_SPOOL: '',
    AO_WAKE_SUPERVISOR_STATE_DIR: '',
    ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR: '',
    AO_SIDE_PROCESS_STATE_DIR: '',
    AO_BASE_DIR: '',
    AO_MECHANICAL_TRANSPORT_TEMP: '',
  };
}
