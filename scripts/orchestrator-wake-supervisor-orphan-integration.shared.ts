import fs from 'node:fs';
import path from 'node:path';

import { childRegistry } from './lib/orchestrator-side-process-observer.ts';

export const repoRoot = path.resolve(import.meta.dirname, '..');
export const observerBridge = path.join(repoRoot, 'scripts/lib/Orchestrator-WakeSupervisor.ps1');
export const issue613TimeoutMs = 180_000;

export function observedChildIds(): string[] {
  return childRegistry().map((entry) => String(entry.Id ?? '')).filter(Boolean);
}

export async function waitForListenerMarker(stateDir: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(path.join(stateDir, 'markers', 'listener.marker.json'))) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out waiting for listener marker');
}
