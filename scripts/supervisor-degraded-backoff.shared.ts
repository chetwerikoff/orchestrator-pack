import { afterEach } from 'vitest';
import { cleanupSupervisorTests } from './supervisor-recovery.test-helpers.js';

export const degradedBackoffTimeoutMs = 120_000;

afterEach(() => {
  cleanupSupervisorTests();
}, degradedBackoffTimeoutMs);

export {
  countLogMatches,
  isAlive,
  makeStateDir,
  readChildPid,
  readChildRecovery,
  readMarker,
  readSupervisorLog,
  runSupervisor,
  startSupervisorBackground,
  waitForMarker,
  waitForSupervisorLogMatch,
} from './supervisor-recovery.test-helpers.js';
