import { describe, expect, it } from 'vitest';
import {
  issue205TimeoutMs,
  makeStateDir,
  managedChildRoles,
  runSupervisor,
  waitForMarkers,
  waitForSupervisorHealthyStatus,
} from './orchestrator-wake-supervisor.shared.js';

describe('Issue #906 three-child wake supervisor', () => {
  it(
    'starts, reports healthy, and stops exactly the retained children',
    async () => {
      const stateDir = makeStateDir();
      const start = runSupervisor([
        '-Action', 'Start', '-TestMode', '-SkipInitialWait',
        '-OrchestratorSessionId', 'op-pr1-test', '-StateDir', stateDir, '-PollSeconds', '1',
      ]);
      expect(start.status).toBe(0);
      await waitForMarkers(stateDir, 25_000, managedChildRoles);
      await waitForSupervisorHealthyStatus(stateDir, 25_000);
      const stop = runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
      expect(stop.status).toBe(0);
    },
    issue205TimeoutMs,
  );
});
