import { afterEach } from 'vitest';
import { cleanupSupervisorTests } from './supervisor-recovery.test-helpers.js';

export const supervisorTestTimeoutMs = 60_000;

afterEach(() => {
  cleanupSupervisorTests();
}, supervisorTestTimeoutMs);
