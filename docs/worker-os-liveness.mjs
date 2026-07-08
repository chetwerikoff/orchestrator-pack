import { runStdinJsonCli, readStdinJson } from './review-mechanical-cli.mjs';

function normalizeString(value) {
  return String(value ?? '').trim();
}

export function normalizeWorkerOsLiveness(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'pane-alive' || normalized === 'pane-gone' || normalized === 'unknown') {
    return normalized;
  }
  return 'unknown';
}

export function workerOsLivenessFromTmuxExitCode(exitCode) {
  if (exitCode === 0) return 'pane-alive';
  if (Number.isFinite(Number(exitCode))) return 'pane-gone';
  return 'unknown';
}

export function buildWorkerOsLivenessMap(rows = []) {
  const map = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const sessionId = normalizeString(row?.sessionId ?? row?.id ?? row?.name);
    if (!sessionId) continue;
    map[sessionId] = normalizeWorkerOsLiveness(row?.osLiveness ?? row?.liveness ?? row?.state);
  }
  return map;
}

runStdinJsonCli('worker-os-liveness.mjs', {
  normalize: () => {
    const payload = readStdinJson();
    return { osLiveness: normalizeWorkerOsLiveness(payload.osLiveness ?? payload.value) };
  },
  'from-tmux-exit': () => {
    const payload = readStdinJson();
    return { osLiveness: workerOsLivenessFromTmuxExitCode(Number(payload.exitCode)) };
  },
  'build-map': () => ({ osLiveness: buildWorkerOsLivenessMap(readStdinJson().rows) }),
});
