import fs from 'node:fs';
import path from 'node:path';
import { expect, vi } from 'vitest';
import { repoRoot, runSupervisor } from './supervisor-recovery.test-helpers.js';

export const supervisorLib = path.join(repoRoot, 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1');
export const issue613TimeoutMs = 180_000;

vi.setConfig({ testTimeout: issue613TimeoutMs, hookTimeout: 30_000 });

export function startDetachedSupervisor(
  stateDir: string,
  sessionId: string,
): { supervisorPid: number; start: ReturnType<typeof runSupervisor> } {
  const start = runSupervisor([
    '-Action',
    'Start',
    '-TestMode',
    '-SkipInitialWait',
    '-OrchestratorSessionId',
    sessionId,
    '-StateDir',
    stateDir,
    '-PollSeconds',
    '1',
  ]);
  expect(start.status).toBe(0);
  const supervisorPid = Number(
    fs.readFileSync(path.join(stateDir, 'supervisor.pid'), 'utf8').trim(),
  );
  expect(supervisorPid).toBeGreaterThan(0);
  return { supervisorPid, start };
}

export async function waitForListenerMarker(stateDir: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(path.join(stateDir, 'markers', 'listener.marker.json'))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out waiting for listener marker');
}
