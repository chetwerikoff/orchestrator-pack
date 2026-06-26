import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(
  repoRoot,
  'tests/external-output-references/generated/review-ready-seed-liveness',
);

function buildSession(index) {
  return {
    id: `session-redacted-${index}`,
    project: 'orchestrator-pack',
    projectId: 'orchestrator-pack',
    status: index % 3 === 0 ? 'terminated' : 'working',
    prNumber: 400 + (index % 50),
    headSha: `abc${String(index).padStart(40, '0')}`,
    reports: [
      {
        state: index % 5 === 0 ? 'ready_for_review' : 'working',
        headSha: `abc${String(index).padStart(40, '0')}`,
        acceptedAtMs: 1_700_000_000_000 + index,
      },
    ],
  };
}

function buildReviewRun(index) {
  return {
    id: `run-redacted-${index}`,
    projectId: 'orchestrator-pack',
    prNumber: 400 + (index % 50),
    targetSha: `def${String(index).padStart(40, '0')}`,
    status: index % 4 === 0 ? 'reviewing' : 'clean',
    findingCount: index % 7,
  };
}

function buildPayload({ sessions, runs, label }) {
  const payload = {
    label,
    sessions,
    runs,
    generatedAt: '2026-06-26T00:00:00.000Z',
    redacted: true,
    secretScanned: true,
  };
  let json = JSON.stringify(payload);
  const targetBytes = label === 'review-list' ? 734_000 : 1_100_000;
  const pad = {
  kind: 'synthetic-padding',
  repeat: 'x',
  };
  while (Buffer.byteLength(json, 'utf8') < targetBytes) {
    pad.repeat += 'x'.repeat(1024);
    payload._padding = { ...pad, bytes: Buffer.byteLength(JSON.stringify(pad), 'utf8') };
    json = JSON.stringify(payload);
  }
  return json;
}

mkdirSync(outDir, { recursive: true });

const statusSessions = Array.from({ length: 180 }, (_, index) => buildSession(index));
const reviewRuns = Array.from({ length: 220 }, (_, index) => buildReviewRun(index));

writeFileSync(
  path.join(outDir, 'grown-status-sessions.json'),
  buildPayload({ sessions: statusSessions, runs: [], label: 'status-reports' }),
);
writeFileSync(
  path.join(outDir, 'grown-review-list.json'),
  buildPayload({ sessions: [], runs: reviewRuns, label: 'review-list' }),
);

console.log(
  JSON.stringify({
    statusBytes: Buffer.byteLength(
      buildPayload({ sessions: statusSessions, runs: [], label: 'status-reports' }),
      'utf8',
    ),
    reviewBytes: Buffer.byteLength(
      buildPayload({ sessions: [], runs: reviewRuns, label: 'review-list' }),
      'utf8',
    ),
    outDir,
  }),
);
