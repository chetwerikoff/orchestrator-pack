import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolveTargetContext } from './target-context.ts';
import { ensureProjectStateBinding } from './project-state-binding.mjs';
import { join, resolve } from 'node:path';

const STAGE_COMPLETENESS_RECEIPT_SCHEMA = 'stage-completeness-receipt/v1';

export interface CanonicalReviewDirectoryV1 {
  stateRoot: string;
  issueNumber: string;
  directory: string;
  intakePath: string;
}

export interface CanonicalTaskIdentity {
  taskIdentity: string;
}

export type ReviewDirectoryMode = 'authority' | 'history';

function numericIssueFromTaskIdentity(taskIdentity: string): string | null {
  const candidate = taskIdentity.trim().split(':').at(-1)?.trim() ?? '';
  const issueMatch = /^(\d+)(?:-|$)/.exec(candidate);
  if (!issueMatch?.[1]) return null;
  const normalized = issueMatch[1].replace(/^0+(?=\d)/, '');
  return normalized === '0' ? null : normalized;
}

export function canonicalReviewStateRoot(override?: string): string {
  if (override) return resolve(override);
  const explicit = String(process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT ?? '').trim();
  if (explicit) return resolve(explicit);
  const projectId = String(process.env.OPK_PROJECT_ID ?? 'orchestrator-pack').trim() || 'orchestrator-pack';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(projectId)) throw new Error('create_issue_project_id_invalid');
  return resolve(join(process.env.HOME ?? homedir(), '.local', 'state', 'create-issue-draft', projectId));
}

export function resolveCanonicalReviewDirectory(
  intake: CanonicalTaskIdentity,
  stateRootOverride?: string,
): CanonicalReviewDirectoryV1 {
  const issueNumber = numericIssueFromTaskIdentity(intake.taskIdentity);
  if (!issueNumber) throw new Error('tier-intake/v1 taskIdentity must bind a numeric Issue identity');
  const stateRoot = canonicalReviewStateRoot(stateRootOverride);
  const selectedProjectId = String(process.env.OPK_PROJECT_ID ?? '').trim();
  if (selectedProjectId) {
    const target = resolveTargetContext({ projectId: selectedProjectId, env: process.env });
    ensureProjectStateBinding(stateRoot, {
      projectId: target.projectId,
      repository: target.repository,
    });
  }
  const directory = resolve(stateRoot, '.review', issueNumber);
  return { stateRoot, issueNumber, directory, intakePath: join(directory, 'tier-intake.json') };
}

export function resolveReviewDirectories(
  intake: CanonicalTaskIdentity,
  mode: ReviewDirectoryMode,
  legacyDirectories: readonly string[] = [],
): string[] {
  const canonical = resolveCanonicalReviewDirectory(intake);
  if (mode === 'authority') return [canonical.directory];
  return [...new Set([canonical.directory, ...legacyDirectories.map((directory) => resolve(directory))])];
}

function containsStageReceipt(path: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.some((value) => Boolean(value)
      && typeof value === 'object'
      && (value as { schema?: unknown }).schema === STAGE_COMPLETENESS_RECEIPT_SCHEMA);
  } catch {
    return false;
  }
}

function legacyReceiptFilesIn(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => resolve(directory, name))
    .filter((path) => containsStageReceipt(path));
}

export function findLegacyReceiptPaths(
  intake: CanonicalTaskIdentity,
  stateRootOverride?: string,
): string[] {
  const canonical = resolveCanonicalReviewDirectory(intake, stateRootOverride);
  const legacyDirectories = new Set<string>();
  if (existsSync(canonical.stateRoot)) {
    for (const entry of readdirSync(canonical.stateRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.review') continue;
      if (numericIssueFromTaskIdentity(entry.name) !== canonical.issueNumber) continue;
      for (const identity of new Set([entry.name, canonical.issueNumber])) {
        legacyDirectories.add(resolve(canonical.stateRoot, entry.name, 'docs', 'issues_drafts', '.review', identity));
      }
    }
  }
  const repositoryLegacyRoot = resolve(process.cwd(), 'docs', 'issues_drafts', '.review');
  if (existsSync(repositoryLegacyRoot)) {
    for (const entry of readdirSync(repositoryLegacyRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && numericIssueFromTaskIdentity(entry.name) === canonical.issueNumber) {
        legacyDirectories.add(resolve(repositoryLegacyRoot, entry.name));
      }
    }
  }
  return [...legacyDirectories]
    .filter((directory) => directory !== canonical.directory)
    .flatMap((directory) => legacyReceiptFilesIn(directory))
    .sort();
}
