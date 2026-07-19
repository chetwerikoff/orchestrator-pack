import {
  describe,
  expect,
  fs,
  isAlive,
  issue205TimeoutMs,
  it,
  makeStateDir,
  managedChildRoles,
  path,
  spawnSync,
  readMarker,
  repoRoot,
  runSupervisor,
  waitForMarkerPidChange,
  waitForMarkers,
} from './orchestrator-wake-supervisor.shared.js';

const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']).status === 0;

describe('Issue #906 pruned side-process registry', () => {
  it('lists exactly the three PR 1 starter children', () => {
    const registryPath = path.join(repoRoot, 'scripts/orchestrator-side-process-registry.json');
    const doc = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as {
      requiredChildIds: string[];
      children: { id: string; script: string }[];
    };
    expect(doc.requiredChildIds).toEqual([...managedChildRoles]);
    expect(doc.children.map((child) => child.id)).toEqual([...managedChildRoles]);
    for (const child of doc.children) {
      expect(fs.existsSync(path.join(repoRoot, 'scripts', child.script))).toBe(true);
    }
  });

  it.skipIf(!hasPwsh)(
    'recovers one hung starter without restarting an idle sibling',
    async () => {
      const stateDir = makeStateDir();
      const start = runSupervisor(
        [
          '-Action', 'Start', '-TestMode', '-SkipInitialWait',
          '-OrchestratorSessionId', 'op-stall-test', '-StateDir', stateDir, '-PollSeconds', '1',
        ],
        {
          AO_WAKE_SUPERVISOR_TEST_MODE_review_trigger_reconcile: 'hang',
          AO_WAKE_SUPERVISOR_TEST_STALL_SECONDS_review_trigger_reconcile: '5',
        },
      );
      expect(start.status).toBe(0);
      await waitForMarkers(stateDir, 25_000, ['review-trigger-reconcile', 'review-trigger-reeval']);
      const first = await readMarker(stateDir, 'review-trigger-reconcile');
      const sibling = await readMarker(stateDir, 'review-trigger-reeval');
      await waitForMarkerPidChange(stateDir, 'review-trigger-reconcile', first.pid, 25_000);
      expect(isAlive(sibling.pid)).toBe(true);
      runSupervisor(['-Action', 'Stop', '-StateDir', stateDir]);
    },
    issue205TimeoutMs,
  );
});
