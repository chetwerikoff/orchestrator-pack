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

function buildPayload({ sessions, runs, label, targetBytes }) {
  const paddingBytes = Math.max(0, targetBytes - 20_000);
  const padding = 'x'.repeat(paddingBytes);
  return JSON.stringify({
    label,
    sessions,
    runs,
    generatedAt: '2026-06-26T00:00:00.000Z',
    redacted: true,
    secretScanned: true,
    _padding: { kind: 'synthetic-padding', bytes: paddingBytes, repeat: padding.slice(0, 64) },
    _paddingBody: padding,
  });
}

mkdirSync(outDir, { recursive: true });

const statusSessions = Array.from({ length: 180 }, (_, index) => buildSession(index));
const reviewRuns = Array.from({ length: 220 }, (_, index) => buildReviewRun(index));

const statusJson = buildPayload({
  sessions: statusSessions,
  runs: [],
  label: 'status-reports',
  targetBytes: 1_100_000,
});
const reviewJson = buildPayload({
  sessions: [],
  runs: reviewRuns,
  label: 'review-list',
  targetBytes: 734_000,
});

writeFileSync(path.join(outDir, 'grown-status-sessions.json'), statusJson);
writeFileSync(path.join(outDir, 'grown-review-list.json'), reviewJson);

console.log(
  JSON.stringify({
    statusBytes: Buffer.byteLength(statusJson, 'utf8'),
    reviewBytes: Buffer.byteLength(reviewJson, 'utf8'),
    outDir,
  }),
);
