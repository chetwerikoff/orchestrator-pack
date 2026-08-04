import { resolve } from 'node:path';

export type WorktreeIdentityMode = 'branch-bound' | 'detached-confirmed';
export type WorktreeBindingKind = 'issue' | 'pr';
export type OrcaBranchShape = 'branch' | 'detached' | 'invalid';

export interface ExpectedWorktreeIdentity {
  readonly repositoryRoot: string;
  readonly repositoryId?: string;
  readonly path: string;
  readonly headSha: string;
  readonly mode: WorktreeIdentityMode;
  readonly branchName?: string;
  readonly bindingKind: WorktreeBindingKind;
  readonly bindingNumber: number;
}

export interface GitWorktreeRow {
  readonly path: string;
  readonly headSha: string;
  readonly branchRef?: string;
  readonly branchName?: string;
  readonly detached: boolean;
  readonly prunable: boolean;
  readonly raw: readonly string[];
}

export interface OrcaAgentRow {
  readonly state?: string;
  readonly interrupted?: boolean;
}

export interface OrcaWorktreeRow {
  readonly id?: string;
  readonly path: string;
  readonly headSha?: string;
  readonly branchRef?: string;
  readonly branchName?: string;
  readonly branchShape: OrcaBranchShape;
  readonly repoId?: string;
  readonly linkedIssue?: number | null;
  readonly linkedPR?: number | null;
  readonly isMainWorktree: boolean;
  readonly isArchived: boolean;
  readonly agents?: readonly OrcaAgentRow[];
  readonly malformedFields: readonly string[];
}

export type EvidenceSourceStatus = 'ok' | 'unavailable' | 'malformed';

export interface CensusEvidence {
  readonly git: {
    readonly status: EvidenceSourceStatus;
    readonly rows: readonly GitWorktreeRow[];
    readonly error?: string;
  };
  readonly orca: {
    readonly status: EvidenceSourceStatus;
    readonly rows: readonly OrcaWorktreeRow[];
    readonly error?: string;
  };
}

export type WorktreeClassification =
  | 'exact_dual'
  | 'exact_git_only'
  | 'orca_only'
  | 'conflict'
  | 'absent';

export interface WorktreeClassificationReport {
  readonly schema: 'orchestrator-pack/worktree-lifecycle-classification/v1';
  readonly classification: WorktreeClassification;
  readonly expected: ExpectedWorktreeIdentity;
  readonly evidence: CensusEvidence;
  readonly exactGitRows: readonly GitWorktreeRow[];
  readonly exactOrcaRows: readonly OrcaWorktreeRow[];
  readonly conflictingGitRows: readonly GitWorktreeRow[];
  readonly conflictingOrcaRows: readonly OrcaWorktreeRow[];
  readonly disagreeingFields: readonly string[];
}

export type LifecycleContext = 'post-create' | 'post-merge-cleanup' | 'explicit-recovery';

export type ContinuationAction =
  | 'continue_existing'
  | 'run_standard_teardown'
  | 'try_guarded_git_only_recovery'
  | 'preserve_and_create_replacement'
  | 'create_replacement_once'
  | 'cleanup_deferred'
  | 'already_absent';

export interface ContinuationDecision {
  readonly schema: 'orchestrator-pack/worktree-lifecycle-decision/v1';
  readonly context: LifecycleContext;
  readonly classification: WorktreeClassification;
  readonly action: ContinuationAction;
  readonly globalPipelineContinues: true;
  readonly targetMutationAuthorized: false;
  readonly terminalSpawnAuthorized: boolean;
  readonly reason: string;
}

const FULL_SHA = /^[0-9a-f]{40}$/;

export function normalizeWorktreePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError('worktree path must be non-empty');
  const absolute = resolve(trimmed).replace(/\/+$/, '');
  return absolute || '/';
}

export function normalizeBranchName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith('refs/heads/') ? trimmed.slice('refs/heads/'.length) : trimmed;
}

export function normalizeHeadSha(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!FULL_SHA.test(normalized)) throw new TypeError(`expected a full 40-hex commit SHA, got ${value}`);
  return normalized;
}

function normalizeRepositoryId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function normalizeExpectedIdentity(input: ExpectedWorktreeIdentity): ExpectedWorktreeIdentity {
  if (!Number.isInteger(input.bindingNumber) || input.bindingNumber <= 0) {
    throw new TypeError('bindingNumber must be a positive integer');
  }
  if (input.bindingKind !== 'issue' && input.bindingKind !== 'pr') {
    throw new TypeError('bindingKind must be issue or pr');
  }
  const branchName = normalizeBranchName(input.branchName);
  if (input.mode === 'branch-bound' && !branchName) {
    throw new TypeError('branch-bound identity requires branchName');
  }
  if (input.mode === 'detached-confirmed' && branchName) {
    throw new TypeError('detached-confirmed identity must not carry branchName');
  }
  const repositoryId = normalizeRepositoryId(input.repositoryId);
  return {
    repositoryRoot: normalizeWorktreePath(input.repositoryRoot),
    ...(repositoryId ? { repositoryId } : {}),
    path: normalizeWorktreePath(input.path),
    headSha: normalizeHeadSha(input.headSha),
    mode: input.mode,
    ...(branchName ? { branchName } : {}),
    bindingKind: input.bindingKind,
    bindingNumber: input.bindingNumber,
  };
}

function finishGitRecord(lines: string[]): GitWorktreeRow {
  const fields = new Map<string, string[]>();
  let detached = false;
  let prunable = false;
  for (const line of lines) {
    if (line === 'detached') {
      detached = true;
      continue;
    }
    if (line.startsWith('prunable')) {
      prunable = true;
      continue;
    }
    const separator = line.indexOf(' ');
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1);
    const existing = fields.get(key) ?? [];
    existing.push(value);
    fields.set(key, existing);
  }
  for (const required of ['worktree', 'HEAD']) {
    if ((fields.get(required)?.length ?? 0) !== 1) {
      throw new TypeError(`git worktree record requires exactly one ${required} field`);
    }
  }
  if ((fields.get('branch')?.length ?? 0) > 1) {
    throw new TypeError('git worktree record has duplicate branch fields');
  }
  const path = normalizeWorktreePath(fields.get('worktree')![0]!);
  const headSha = normalizeHeadSha(fields.get('HEAD')![0]!);
  const branchRef = fields.get('branch')?.[0]?.trim() || undefined;
  const branchName = normalizeBranchName(branchRef);
  if (detached && branchRef) throw new TypeError('git worktree record is both detached and branch-bound');
  return { path, headSha, branchRef, branchName, detached, prunable, raw: [...lines] };
}

export function parseGitWorktreePorcelain(text: string): GitWorktreeRow[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const records: GitWorktreeRow[] = [];
  let current: string[] = [];
  for (const line of normalized.split('\n')) {
    if (line.trim() === '') {
      if (current.length > 0) {
        records.push(finishGitRecord(current));
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) records.push(finishGitRecord(current));
  const paths = new Set<string>();
  for (const row of records) {
    if (paths.has(row.path)) throw new TypeError(`git worktree inventory has duplicate path ${row.path}`);
    paths.add(row.path);
  }
  return records;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalIntegerField(
  row: Record<string, unknown>,
  field: 'linkedIssue' | 'linkedPR',
  malformedFields: string[],
): number | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(row, field)) return undefined;
  const value = row[field];
  if (value === null) return null;
  if (Number.isInteger(value) && Number(value) > 0) return Number(value);
  malformedFields.push(field);
  return undefined;
}

function parseOrcaCompositeId(
  row: Record<string, unknown>,
  path: string,
  malformedFields: string[],
): { id?: string; repoId?: string } {
  const id = optionalString(row.id);
  if (!id) {
    malformedFields.push('id');
    return {};
  }
  const separator = id.indexOf('::');
  if (separator <= 0 || separator === id.length - 2) {
    malformedFields.push('id');
    return { id };
  }
  const repoId = id.slice(0, separator).trim();
  const idPath = id.slice(separator + 2).trim();
  if (!repoId || !idPath) {
    malformedFields.push('id');
    return { id };
  }
  try {
    if (normalizeWorktreePath(idPath) !== path) malformedFields.push('id.path');
  } catch {
    malformedFields.push('id.path');
  }
  if (Object.prototype.hasOwnProperty.call(row, 'repoId')) {
    const legacyRepoId = optionalString(row.repoId);
    if (!legacyRepoId || legacyRepoId !== repoId) malformedFields.push('repoId');
  }
  return { id, repoId };
}

function parseOrcaBranch(
  row: Record<string, unknown>,
  malformedFields: string[],
): { branchRef?: string; branchName?: string; branchShape: OrcaBranchShape } {
  if (!Object.prototype.hasOwnProperty.call(row, 'branch') || typeof row.branch !== 'string') {
    malformedFields.push('branch');
    return { branchShape: 'invalid' };
  }
  if (row.branch === '') return { branchRef: '', branchShape: 'detached' };
  const branchRef = row.branch.trim();
  if (!branchRef) {
    malformedFields.push('branch');
    return { branchShape: 'invalid' };
  }
  const branchName = normalizeBranchName(branchRef);
  if (!branchName) {
    malformedFields.push('branch');
    return { branchShape: 'invalid' };
  }
  return { branchRef, branchName, branchShape: 'branch' };
}

function parseOrcaAgents(value: unknown, malformedFields: string[]): OrcaAgentRow[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    malformedFields.push('agents');
    return undefined;
  }
  const agents: OrcaAgentRow[] = [];
  for (const rawAgent of value) {
    const agent = objectRecord(rawAgent);
    if (!agent
      || typeof agent.state !== 'string'
      || !agent.state.trim()
      || typeof agent.interrupted !== 'boolean') {
      malformedFields.push('agents');
      continue;
    }
    agents.push({ state: agent.state.trim(), interrupted: agent.interrupted });
  }
  return agents;
}

export function parseOrcaWorktreePayload(payload: unknown): OrcaWorktreeRow[] {
  const root = objectRecord(payload);
  if (!root) throw new TypeError('Orca response must be an object');
  if (root.ok !== true) throw new TypeError('Orca response must carry ok=true');
  const result = objectRecord(root.result);
  if (!result || !Array.isArray(result.worktrees)) {
    throw new TypeError('Orca response omitted result.worktrees[]');
  }
  return result.worktrees.map((rawRow, index) => {
    const row = objectRecord(rawRow);
    if (!row) throw new TypeError(`Orca worktree row ${index} is not an object`);
    const malformedFields: string[] = [];
    const rawPath = optionalString(row.path);
    if (!rawPath) throw new TypeError(`Orca worktree row ${index} omitted path`);
    const path = normalizeWorktreePath(rawPath);
    const identity = parseOrcaCompositeId(row, path, malformedFields);
    const headValue = optionalString(row.head);
    let headSha: string | undefined;
    if (headValue) {
      try {
        headSha = normalizeHeadSha(headValue);
      } catch {
        malformedFields.push('head');
      }
    } else {
      malformedFields.push('head');
    }
    const branch = parseOrcaBranch(row, malformedFields);
    const agents = parseOrcaAgents(row.agents, malformedFields);
    if (typeof row.isMainWorktree !== 'boolean') malformedFields.push('isMainWorktree');
    if (typeof row.isArchived !== 'boolean') malformedFields.push('isArchived');
    return {
      ...identity,
      path,
      headSha,
      ...branch,
      linkedIssue: optionalIntegerField(row, 'linkedIssue', malformedFields),
      linkedPR: optionalIntegerField(row, 'linkedPR', malformedFields),
      isMainWorktree: row.isMainWorktree === true,
      isArchived: row.isArchived === true,
      agents,
      malformedFields: [...new Set(malformedFields)].sort(),
    };
  });
}

function gitIdentityMatches(row: GitWorktreeRow, expected: ExpectedWorktreeIdentity): boolean {
  if (row.path !== expected.path || row.headSha !== expected.headSha) return false;
  if (expected.mode === 'detached-confirmed') return row.detached && !row.branchName;
  return !row.detached && row.branchName === expected.branchName;
}

function orcaBindingMatches(row: OrcaWorktreeRow, expected: ExpectedWorktreeIdentity): boolean {
  if (expected.bindingKind === 'issue') return row.linkedIssue === expected.bindingNumber;
  return row.linkedPR === undefined || row.linkedPR === null || row.linkedPR === expected.bindingNumber;
}

function orcaIdentityMatches(row: OrcaWorktreeRow, expected: ExpectedWorktreeIdentity): boolean {
  if (
    !expected.repositoryId
    || row.path !== expected.path
    || row.headSha !== expected.headSha
    || row.repoId !== expected.repositoryId
    || row.isMainWorktree
    || row.isArchived
    || row.malformedFields.length > 0
    || !orcaBindingMatches(row, expected)
  ) {
    return false;
  }
  if (expected.mode === 'detached-confirmed') return row.branchShape === 'detached';
  return row.branchShape === 'branch' && row.branchName === expected.branchName;
}

function gitIdentityCollision(row: GitWorktreeRow, expected: ExpectedWorktreeIdentity): boolean {
  if (row.path === expected.path) return !gitIdentityMatches(row, expected);
  return expected.mode === 'branch-bound' && row.branchName === expected.branchName;
}

function orcaIdentityCollision(row: OrcaWorktreeRow, expected: ExpectedWorktreeIdentity): boolean {
  if (row.path === expected.path) return !orcaIdentityMatches(row, expected);
  if (!expected.repositoryId || row.repoId !== expected.repositoryId) return false;
  if (expected.mode === 'branch-bound' && row.branchName === expected.branchName) return true;
  return expected.bindingKind === 'pr' && row.linkedPR === expected.bindingNumber;
}

function disagreementFields(
  expected: ExpectedWorktreeIdentity,
  gitRows: readonly GitWorktreeRow[],
  orcaRows: readonly OrcaWorktreeRow[],
): string[] {
  const fields = new Set<string>();
  if (!expected.repositoryId) fields.add('orca.repositoryId');
  for (const row of gitRows) {
    if (row.path !== expected.path) fields.add('git.path');
    if (row.headSha !== expected.headSha) fields.add('git.head');
    if (expected.mode === 'branch-bound' && row.branchName !== expected.branchName) fields.add('git.branch');
    if (expected.mode === 'detached-confirmed' && !row.detached) fields.add('git.detached');
  }
  for (const row of orcaRows) {
    if (row.path !== expected.path) fields.add('orca.path');
    if (row.headSha !== expected.headSha) fields.add('orca.head');
    if (row.repoId !== expected.repositoryId) fields.add('orca.repoId');
    if (row.isMainWorktree) fields.add('orca.isMainWorktree');
    if (row.isArchived) fields.add('orca.isArchived');
    if (expected.mode === 'branch-bound' && row.branchName !== expected.branchName) fields.add('orca.branch');
    if (expected.mode === 'detached-confirmed' && row.branchShape !== 'detached') fields.add('orca.detached');
    if (!orcaBindingMatches(row, expected)) {
      fields.add(expected.bindingKind === 'issue' ? 'orca.linkedIssue' : 'orca.linkedPR');
    }
    for (const malformed of row.malformedFields) fields.add(`orca.${malformed}`);
  }
  return [...fields].sort();
}

export function classifyWorktree(input: {
  readonly expected: ExpectedWorktreeIdentity;
  readonly evidence: CensusEvidence;
}): WorktreeClassificationReport {
  const expected = normalizeExpectedIdentity(input.expected);
  const gitRows = input.evidence.git.rows;
  const orcaRows = input.evidence.orca.rows;
  const exactGitRows = gitRows.filter((row) => gitIdentityMatches(row, expected));
  const exactOrcaRows = orcaRows.filter((row) => orcaIdentityMatches(row, expected));
  const conflictingGitRows = gitRows.filter((row) => gitIdentityCollision(row, expected));
  const conflictingOrcaRows = orcaRows.filter((row) => orcaIdentityCollision(row, expected));

  let classification: WorktreeClassification;
  const sourceUnavailable = input.evidence.git.status !== 'ok' || input.evidence.orca.status !== 'ok';
  const hasConflict = sourceUnavailable
    || !expected.repositoryId
    || exactGitRows.length > 1
    || exactOrcaRows.length > 1
    || conflictingGitRows.length > 0
    || conflictingOrcaRows.length > 0;
  if (hasConflict) classification = 'conflict';
  else if (exactGitRows.length === 1 && exactOrcaRows.length === 1) classification = 'exact_dual';
  else if (exactGitRows.length === 1) classification = 'exact_git_only';
  else if (exactOrcaRows.length === 1) classification = 'orca_only';
  else classification = 'absent';

  return {
    schema: 'orchestrator-pack/worktree-lifecycle-classification/v1',
    classification,
    expected,
    evidence: input.evidence,
    exactGitRows,
    exactOrcaRows,
    conflictingGitRows,
    conflictingOrcaRows,
    disagreeingFields: disagreementFields(expected, conflictingGitRows, conflictingOrcaRows),
  };
}

export function decideContinuation(
  classification: WorktreeClassification,
  context: LifecycleContext,
): ContinuationDecision {
  let action: ContinuationAction;
  let terminalSpawnAuthorized = false;
  let reason: string;
  if (classification === 'exact_dual') {
    if (context === 'post-create') {
      action = 'continue_existing';
      reason = 'Git and Orca agree; the bounded create-and-spawn actuator owns terminal creation';
    } else if (context === 'post-merge-cleanup') {
      action = 'run_standard_teardown';
      reason = 'exact dual registration can use the existing guarded teardown';
    } else {
      action = 'continue_existing';
      reason = 'the requested identity is already exact in both authorities';
    }
  } else if (classification === 'exact_git_only') {
    action = 'try_guarded_git_only_recovery';
    reason = 'the exact Git worktree must pass recovery gates before any mutation';
  } else if (classification === 'absent') {
    if (context === 'post-create') {
      action = 'create_replacement_once';
      reason = 'the unknown create outcome read back absent in both authorities';
    } else {
      action = 'already_absent';
      reason = 'the exact target is already absent from both authorities';
    }
  } else if (context === 'post-create') {
    action = 'preserve_and_create_replacement';
    reason = 'the disputed target is preserved while one isolated replacement is attempted';
  } else {
    action = 'cleanup_deferred';
    reason = 'cleanup is unsafe for the disputed target and must not fail the completed work pipeline';
  }
  return {
    schema: 'orchestrator-pack/worktree-lifecycle-decision/v1',
    context,
    classification,
    action,
    globalPipelineContinues: true,
    targetMutationAuthorized: false,
    terminalSpawnAuthorized,
    reason,
  };
}
