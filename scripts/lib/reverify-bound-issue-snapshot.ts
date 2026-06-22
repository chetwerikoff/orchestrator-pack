import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getAoProjectDir } from '../../docs/review-run-recovery.mjs';
import { hashIssueBodySnapshot } from './reviewer-contract-mapping.js';

export const BOUND_ISSUE_SNAPSHOT_SCHEMA_VERSION = 1;
export const BOUND_ISSUE_SNAPSHOT_STORE_REL = 'code-reviews/bound-issue-snapshots';
export const BOUND_ISSUE_SNAPSHOT_CAPTURE_PHASE = 'review-preflight' as const;

export interface BoundIssueSnapshotMetadata {
  schemaVersion: typeof BOUND_ISSUE_SNAPSHOT_SCHEMA_VERSION;
  projectId: string;
  prNumber: number;
  prHeadSha: string;
  issueNumber: number;
  snapshotHash: string;
  capturedAt: string;
  capturePhase: typeof BOUND_ISSUE_SNAPSHOT_CAPTURE_PHASE;
}

export interface BoundIssueSnapshotCaptureResult {
  issueNumber: number;
  snapshotPath: string;
  metadataPath: string;
  snapshotHash: string;
  created: boolean;
}

export interface BoundIssueSnapshotResolveResult {
  status: 'found' | 'missing' | 'corrupted';
  snapshotPath: string | null;
  metadataPath: string | null;
  snapshotHash: string | null;
  metadata: BoundIssueSnapshotMetadata | null;
}

export function computeBoundIssueSnapshotHash(issueBody: string): string {
  return `sha256:${hashIssueBodySnapshot(issueBody)}`;
}

function verifyBoundIssueSnapshotBody(snapshotPath: string, expectedHash: string): boolean {
  const body = readFileSync(snapshotPath, 'utf8');
  return computeBoundIssueSnapshotHash(body) === expectedHash;
}

function normalizeSha(sha: string): string {
  return sha.trim().toLowerCase();
}

export function resolveDefaultAoProjectId(env: NodeJS.ProcessEnv = process.env): string {
  return (env.AO_PROJECT_ID ?? env.AO_PROJECT ?? 'orchestrator-pack').trim() || 'orchestrator-pack';
}

export function resolveBoundIssueSnapshotStoreDir(
  projectId: string,
  options: { aoBaseDir?: string; storeDirOverride?: string | null } = {},
): string {
  const override = options.storeDirOverride ?? process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR ?? null;
  if (override) {
    return override;
  }
  return join(getAoProjectDir(projectId, options.aoBaseDir), BOUND_ISSUE_SNAPSHOT_STORE_REL);
}

export function boundIssueSnapshotArtifactPaths(input: {
  projectId: string;
  prNumber: number;
  prHeadSha: string;
  issueNumber: number;
  aoBaseDir?: string;
  storeDirOverride?: string | null;
}): { artifactDir: string; snapshotPath: string; metadataPath: string } {
  const prHeadSha = normalizeSha(input.prHeadSha);
  const artifactDir = join(
    resolveBoundIssueSnapshotStoreDir(input.projectId, {
      aoBaseDir: input.aoBaseDir,
      storeDirOverride: input.storeDirOverride,
    }),
    `pr-${input.prNumber}`,
    prHeadSha.slice(0, 12),
  );
  const baseName = `issue-${input.issueNumber}`;
  return {
    artifactDir,
    snapshotPath: join(artifactDir, `${baseName}.md`),
    metadataPath: join(artifactDir, `${baseName}.meta.json`),
  };
}

function writeFileAtomically(targetPath: string, content: string): void {
  const parent = dirname(targetPath);
  mkdirSync(parent, { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.tmp`;
  writeFileSync(tempPath, content, 'utf8');
  renameSync(tempPath, targetPath);
}

export function captureBoundIssueSnapshot(input: {
  projectId: string;
  prNumber: number;
  prHeadSha: string;
  issueNumber: number;
  issueBody: string;
  aoBaseDir?: string;
  storeDirOverride?: string | null;
  capturedAt?: string;
}): BoundIssueSnapshotCaptureResult {
  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0) {
    throw new Error('prNumber must be a positive integer');
  }
  if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) {
    throw new Error('issueNumber must be a positive integer');
  }
  const prHeadSha = normalizeSha(input.prHeadSha);
  if (!/^[0-9a-f]{7,40}$/.test(prHeadSha)) {
    throw new Error('prHeadSha must be a git commit SHA');
  }

  const paths = boundIssueSnapshotArtifactPaths({
    projectId: input.projectId,
    prNumber: input.prNumber,
    prHeadSha,
    issueNumber: input.issueNumber,
    aoBaseDir: input.aoBaseDir,
    storeDirOverride: input.storeDirOverride,
  });
  const snapshotHash = computeBoundIssueSnapshotHash(input.issueBody);
  const metadata: BoundIssueSnapshotMetadata = {
    schemaVersion: BOUND_ISSUE_SNAPSHOT_SCHEMA_VERSION,
    projectId: input.projectId,
    prNumber: input.prNumber,
    prHeadSha,
    issueNumber: input.issueNumber,
    snapshotHash,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    capturePhase: BOUND_ISSUE_SNAPSHOT_CAPTURE_PHASE,
  };

  let created = false;
  if (existsSync(paths.metadataPath)) {
    const existing = JSON.parse(readFileSync(paths.metadataPath, 'utf8')) as BoundIssueSnapshotMetadata;
    if (existing.snapshotHash !== snapshotHash) {
      throw new Error(
        `bound issue snapshot already captured for PR #${input.prNumber} head ${prHeadSha} issue #${input.issueNumber} with different content`,
      );
    }
    if (!existsSync(paths.snapshotPath) || !verifyBoundIssueSnapshotBody(paths.snapshotPath, snapshotHash)) {
      throw new Error(
        `bound issue snapshot body corrupted for PR #${input.prNumber} head ${prHeadSha} issue #${input.issueNumber}`,
      );
    }
  } else {
    writeFileAtomically(paths.snapshotPath, input.issueBody);
    writeFileAtomically(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    created = true;
  }

  return {
    issueNumber: input.issueNumber,
    snapshotPath: paths.snapshotPath,
    metadataPath: paths.metadataPath,
    snapshotHash,
    created,
  };
}

export function captureBoundIssueSnapshotsFromPreflight(input: {
  projectId: string;
  prNumber: number;
  prHeadSha: string;
  specBodies: Array<{ issueNumber: number; body: string }>;
  aoBaseDir?: string;
  storeDirOverride?: string | null;
}): BoundIssueSnapshotCaptureResult[] {
  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0) {
    return [];
  }
  const prHeadSha = normalizeSha(input.prHeadSha);
  if (!prHeadSha || prHeadSha === 'unknown' || !/^[0-9a-f]{7,40}$/.test(prHeadSha)) {
    return [];
  }

  return input.specBodies.map((spec) => captureBoundIssueSnapshot({
    projectId: input.projectId,
    prNumber: input.prNumber,
    prHeadSha,
    issueNumber: spec.issueNumber,
    issueBody: spec.body,
    aoBaseDir: input.aoBaseDir,
    storeDirOverride: input.storeDirOverride,
  }));
}

export function resolveBoundIssueSnapshot(input: {
  projectId: string;
  prNumber: number;
  prHeadSha: string;
  issueNumber: number;
  aoBaseDir?: string;
  storeDirOverride?: string | null;
}): BoundIssueSnapshotResolveResult {
  const paths = boundIssueSnapshotArtifactPaths({
    projectId: input.projectId,
    prNumber: input.prNumber,
    prHeadSha: input.prHeadSha,
    issueNumber: input.issueNumber,
    aoBaseDir: input.aoBaseDir,
    storeDirOverride: input.storeDirOverride,
  });

  if (!existsSync(paths.snapshotPath) || !existsSync(paths.metadataPath)) {
    return {
      status: 'missing',
      snapshotPath: null,
      metadataPath: null,
      snapshotHash: null,
      metadata: null,
    };
  }

  const metadata = JSON.parse(readFileSync(paths.metadataPath, 'utf8')) as BoundIssueSnapshotMetadata;
  if (!verifyBoundIssueSnapshotBody(paths.snapshotPath, metadata.snapshotHash)) {
    return {
      status: 'corrupted',
      snapshotPath: null,
      metadataPath: paths.metadataPath,
      snapshotHash: metadata.snapshotHash,
      metadata,
    };
  }

  return {
    status: 'found',
    snapshotPath: paths.snapshotPath,
    metadataPath: paths.metadataPath,
    snapshotHash: metadata.snapshotHash,
    metadata,
  };
}
