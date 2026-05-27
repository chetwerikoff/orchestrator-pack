#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseIssueBody } from '@orchestrator-pack/shared/lib/issue_parser.js';
import { validateDeclarationSnapshot } from '@orchestrator-pack/shared/lib/declaration_schema.js';
import type { DeclarationSnapshot } from '@orchestrator-pack/shared/lib/declaration_schema.js';
import { applyAmendment } from '../lib/amendment.js';
import { assertCleanWorktree, computeBaseline } from '../lib/baseline.js';
import { resolveIterationId } from '../lib/iteration.js';
import { findLatestMirrorIterationId, writeMirror } from '../lib/mirror.js';
import {
  findLatestIterationId,
  readSnapshot,
  writeSnapshot,
} from '../lib/snapshot.js';
import {
  normalizeIssueConstraints,
  validateDeclaredScope,
} from '../lib/validate.js';

interface CliOptions {
  issueNumber: number;
  declaredPaths: string[];
  declaredGlobs: string[];
  amend: boolean;
  reason?: string;
  actor: string;
  repoRoot: string;
  iterationId?: string;
}

function usage(): string {
  return [
    'Usage: ao-declare --issue <n> --declared-paths <path[,path...]>',
    '                 [--declared-globs <glob[,glob...]>]',
    '                 [--amend --reason <text> [--actor <name>]]',
    '                 [--iteration-id <id>]',
    '                 [--repo-root <path>]',
  ].join('\n');
}

function parseCsv(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseArgs(argv: string[]): CliOptions {
  let issueNumber: number | undefined;
  let declaredPaths: string[] = [];
  let declaredGlobs: string[] = [];
  let amend = false;
  let reason: string | undefined;
  let actor = process.env.AO_SESSION_ID?.trim() || 'local';
  let repoRoot = process.cwd();
  let iterationId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--issue': {
        const raw = argv[++index];
        issueNumber = Number(raw);
        if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
          throw new Error('--issue must be a positive integer');
        }
        break;
      }
      case '--declared-paths':
        declaredPaths = parseCsv(argv[++index]);
        break;
      case '--declared-globs':
        declaredGlobs = parseCsv(argv[++index]);
        break;
      case '--amend':
        amend = true;
        break;
      case '--reason':
        reason = argv[++index];
        break;
      case '--actor':
        actor = argv[++index] ?? actor;
        break;
      case '--repo-root':
        repoRoot = argv[++index] ?? repoRoot;
        break;
      case '--iteration-id':
        iterationId = argv[++index];
        break;
      case '--help':
      case '-h':
        throw new Error(usage());
      default:
        throw new Error(`unknown argument: ${arg}\n${usage()}`);
    }
  }

  if (issueNumber === undefined) {
    throw new Error(`--issue is required\n${usage()}`);
  }

  if (declaredPaths.length === 0 && declaredGlobs.length === 0) {
    throw new Error(
      'at least one --declared-paths or --declared-globs entry is required',
    );
  }

  if (amend && !reason?.trim()) {
    throw new Error('--reason is required when using --amend');
  }

  return {
    issueNumber,
    declaredPaths,
    declaredGlobs,
    amend,
    reason,
    actor,
    repoRoot,
    iterationId,
  };
}

function resolveDeclareIterationId(options: CliOptions): ReturnType<typeof resolveIterationId> {
  const fallbackIterationId = options.amend
    ? (findLatestIterationId(options.repoRoot, options.issueNumber) ??
      findLatestMirrorIterationId(options.repoRoot, options.issueNumber))
    : null;

  return resolveIterationId(process.env, {
    explicitIterationId: options.iterationId,
    fallbackIterationId,
  });
}

function fetchIssueBody(issueNumber: number, repoRoot: string): string {
  const output = execFileSync(
    'gh',
    ['issue', 'view', String(issueNumber), '--json', 'body'],
    { encoding: 'utf8', cwd: repoRoot },
  );
  const parsed = JSON.parse(output) as { body?: string };
  if (typeof parsed.body !== 'string') {
    throw new Error(`gh issue view ${issueNumber} did not return a body`);
  }
  return parsed.body;
}

function buildInitialSnapshot(
  options: CliOptions,
  constraints: ReturnType<typeof normalizeIssueConstraints>,
): DeclarationSnapshot {
  assertCleanWorktree(options.repoRoot);

  const validated = validateDeclaredScope(
    {
      declared_paths: options.declaredPaths,
      declared_globs: options.declaredGlobs,
    },
    constraints,
  );

  if (!validated.ok) {
    throw new Error(validated.errors.join('; '));
  }

  const iteration = resolveDeclareIterationId(options);
  const existing = readSnapshot(
    options.repoRoot,
    options.issueNumber,
    iteration.iteration_id,
  );
  if (existing) {
    throw new Error(
      `declaration already exists for iteration ${iteration.iteration_id}; use --amend to rewrite scope once`,
    );
  }

  const baseline = computeBaseline(options.repoRoot, {
    declared_paths: validated.declared_paths,
    declared_globs: validated.declared_globs,
    issue_denylist: constraints.denylist,
    issue_allowed_roots: constraints.allowed_roots,
  });

  if (baseline.worktree_dirty) {
    throw new Error(
      'worktree is dirty; commit or stash pending changes before declaring scope',
    );
  }

  const snapshot: DeclarationSnapshot = {
    issue_number: options.issueNumber,
    iteration_id: iteration.iteration_id,
    iteration_id_source: iteration.iteration_id_source,
    supersedes: findLatestIterationId(options.repoRoot, options.issueNumber),
    created_at: new Date().toISOString(),
    baseline,
    declared_paths: validated.declared_paths,
    declared_globs: validated.declared_globs,
    amendments: [],
  };

  const schema = validateDeclarationSnapshot(snapshot);
  if (!schema.ok) {
    throw new Error(schema.errors.join('; '));
  }

  return snapshot;
}

function buildAmendedSnapshot(
  options: CliOptions,
  constraints: ReturnType<typeof normalizeIssueConstraints>,
): DeclarationSnapshot {
  assertCleanWorktree(options.repoRoot);

  const iteration = resolveDeclareIterationId(options);
  const existing = readSnapshot(
    options.repoRoot,
    options.issueNumber,
    iteration.iteration_id,
  );

  if (!existing) {
    throw new Error(
      `no declaration snapshot found for issue ${options.issueNumber} and iteration ${iteration.iteration_id}`,
    );
  }

  const amended = applyAmendment(
    existing,
    {
      declared_paths: options.declaredPaths,
      declared_globs: options.declaredGlobs,
      reason: options.reason ?? '',
      actor: options.actor,
    },
    constraints,
  );

  if (!amended.ok) {
    throw new Error(amended.error);
  }

  const schema = validateDeclarationSnapshot(amended.snapshot);
  if (!schema.ok) {
    throw new Error(schema.errors.join('; '));
  }

  return amended.snapshot;
}

export function runDeclare(argv: string[]): DeclarationSnapshot {
  const options = parseArgs(argv);
  const issueBody = fetchIssueBody(options.issueNumber, options.repoRoot);
  const constraints = normalizeIssueConstraints(parseIssueBody(issueBody));

  const snapshot = options.amend
    ? buildAmendedSnapshot(options, constraints)
    : buildInitialSnapshot(options, constraints);

  const snapshotPath = writeSnapshot(options.repoRoot, snapshot);
  const mirrorPath = writeMirror(options.repoRoot, snapshot);

  process.stderr.write(`wrote snapshot: ${snapshotPath}\n`);
  process.stderr.write(`wrote mirror: ${mirrorPath}\n`);
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
}

function isDirectExecution(): boolean {
  const entryScript = process.argv[1];
  if (!entryScript) {
    return false;
  }

  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entryScript)
    );
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  try {
    runDeclare(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ao-declare: ${message}\n`);
    process.exit(1);
  }
}
