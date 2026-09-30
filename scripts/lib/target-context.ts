#!/usr/bin/env -S node --experimental-strip-types
import '../toolchain/native-entrypoint-preflight.ts';

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessSync } from '../kernel/subprocess.ts';

export type TargetContextErrorCode =
  | 'missing-selection'
  | 'selector-mismatch'
  | 'invalid-project-id'
  | 'card-missing'
  | 'card-invalid'
  | 'project-id-mismatch'
  | 'primary-root-invalid'
  | 'origin-unavailable'
  | 'origin-mismatch';

export class TargetContextError extends Error {
  readonly code: TargetContextErrorCode;
  readonly cardPath?: string;

  constructor(code: TargetContextErrorCode, message: string, cardPath?: string) {
    super(message);
    this.name = 'TargetContextError';
    this.code = code;
    this.cardPath = cardPath;
  }
}

export type TargetVerificationErrorCode =
  | 'verification-local-required'
  | 'target-worktree-required'
  | 'target-worktree-invalid'
  | 'target-worktree-repository-mismatch'
  | 'verification-command-spawn-failed'
  | 'verification-command-failed';

export class TargetVerificationError extends Error {
  readonly code: TargetVerificationErrorCode;
  readonly commandIndex?: number;

  constructor(code: TargetVerificationErrorCode, message: string, commandIndex?: number) {
    super(message);
    this.name = 'TargetVerificationError';
    this.code = code;
    this.commandIndex = commandIndex;
  }
}

export interface TargetVerification {
  readonly local?: readonly string[];
  readonly focused?: string;
}

export interface TargetContext {
  readonly projectId: string;
  readonly repository: string;
  readonly primaryRoot: string;
  readonly defaultBranch: string;
  readonly orcaWorkspacePattern: string;
  readonly orchestratorTitlePattern: string;
  readonly browserGpt: Readonly<{ projectUrl: string }>;
  readonly verification?: TargetVerification;
  readonly packRoot: string;
  readonly cardPath: string;
}

export interface ResolveTargetContextInput {
  readonly projectId?: string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
}

export interface RunTargetVerificationInput {
  readonly context: TargetContext;
  readonly targetWorktreeRoot: string;
  readonly commandRunner?: typeof runProcessSync;
}

export interface TargetVerificationResult {
  readonly projectId: string;
  readonly repository: string;
  readonly targetWorktreeRoot: string;
  readonly commandCount: number;
}

const PACK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const REPOSITORY_RE = /^[^/\s]+\/[^/\s]+$/u;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function configHome(env: Readonly<NodeJS.ProcessEnv>): string {
  const xdg = text(env.XDG_CONFIG_HOME);
  return xdg || join(text(env.HOME) || homedir(), '.config');
}

export function projectCardPath(projectId: string, env: Readonly<NodeJS.ProcessEnv> = process.env): string {
  return join(configHome(env), 'orchestrator-pack', 'projects', `${projectId}.json`);
}

function selectedProjectId(input: ResolveTargetContextInput): string {
  const cli = text(input.projectId);
  const envId = text((input.env ?? process.env).OPK_PROJECT_ID);
  if (cli && envId && cli !== envId) {
    throw new TargetContextError(
      'selector-mismatch',
      `target project selector mismatch: --project=${cli} OPK_PROJECT_ID=${envId}`,
    );
  }
  const selected = cli || envId;
  if (!selected) {
    throw new TargetContextError(
      'missing-selection',
      `target project is not selected; pass --project <id> or set OPK_PROJECT_ID (cards: ${join(configHome(input.env ?? process.env), 'orchestrator-pack', 'projects')})`,
    );
  }
  if (!PROJECT_ID_RE.test(selected)) {
    throw new TargetContextError('invalid-project-id', `invalid project id: ${selected}`);
  }
  return selected;
}

function canonicalGitHubRepository(remote: string): string | null {
  const value = remote.trim();
  const scp = /^git@github\.com:([^/\s]+\/[^/\s]+?)(?:\.git)?$/iu.exec(value);
  if (scp) return scp[1]!.replace(/\.git$/iu, '').toLowerCase();
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    const path = url.pathname.replace(/^\/+|\/+$/gu, '').replace(/\.git$/iu, '');
    return REPOSITORY_RE.test(path) ? path.toLowerCase() : null;
  } catch {
    return null;
  }
}

function readOrigin(primaryRoot: string): string {
  const result = runProcessSync({
    command: 'git',
    args: ['remote', 'get-url', 'origin'],
    cwd: primaryRoot,
    inheritParentEnv: true,
  });
  if (!result.ok) {
    const detail = String(result.stderr || result.error || '').trim();
    throw new TargetContextError(
      'origin-unavailable',
      `cannot read git origin for target primaryRoot ${primaryRoot}${detail ? `: ${detail}` : ''}`,
    );
  }
  return result.stdout.trim();
}

function parseVerification(value: unknown, cardPath: string): TargetVerification | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TargetContextError('card-invalid', `verification must be an object in ${cardPath}`, cardPath);
  }
  const record = value as Record<string, unknown>;
  let local: readonly string[] | undefined;
  if (record.local !== undefined) {
    if (!Array.isArray(record.local) || record.local.some((item) => !text(item))) {
      throw new TargetContextError('card-invalid', `verification.local must be an array of non-empty commands in ${cardPath}`, cardPath);
    }
    local = Object.freeze(record.local.map((item) => text(item)));
  }
  const focused = record.focused === undefined ? undefined : text(record.focused);
  if (record.focused !== undefined && !focused) {
    throw new TargetContextError('card-invalid', `verification.focused must be a non-empty string in ${cardPath}`, cardPath);
  }
  return Object.freeze({
    ...(local ? { local } : {}),
    ...(focused ? { focused } : {}),
  });
}

export function resolveTargetContext(input: ResolveTargetContextInput = {}): TargetContext {
  const env = input.env ?? process.env;
  const projectId = selectedProjectId({ ...input, env });
  const cardPath = projectCardPath(projectId, env);
  if (!existsSync(cardPath)) {
    throw new TargetContextError('card-missing', `target project card not found: ${cardPath}`, cardPath);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(cardPath, 'utf8'));
  } catch (error) {
    throw new TargetContextError(
      'card-invalid',
      `cannot parse target project card ${cardPath}: ${error instanceof Error ? error.message : String(error)}`,
      cardPath,
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TargetContextError('card-invalid', `target project card must be a JSON object: ${cardPath}`, cardPath);
  }
  const card = raw as Record<string, unknown>;
  const cardProjectId = text(card.projectId);
  if (cardProjectId !== projectId) {
    throw new TargetContextError(
      'project-id-mismatch',
      `target project card projectId ${cardProjectId || '<empty>'} does not match file/selector ${projectId}: ${cardPath}`,
      cardPath,
    );
  }

  const repository = text(card.repository).toLowerCase();
  const primaryRoot = text(card.primaryRoot);
  const defaultBranch = text(card.defaultBranch);
  const orcaWorkspacePattern = text(card.orcaWorkspacePattern);
  const orchestratorTitlePattern = text(card.orchestratorTitlePattern);
  const browser = card.browserGpt;
  const projectUrl = browser && typeof browser === 'object' && !Array.isArray(browser)
    ? text((browser as Record<string, unknown>).projectUrl)
    : '';

  if (!REPOSITORY_RE.test(repository) || !primaryRoot || !defaultBranch
    || !orcaWorkspacePattern || !orchestratorTitlePattern || !projectUrl) {
    throw new TargetContextError(
      'card-invalid',
      `target project card requires projectId, repository, primaryRoot, defaultBranch, orcaWorkspacePattern, orchestratorTitlePattern, and browserGpt.projectUrl: ${cardPath}`,
      cardPath,
    );
  }
  if (!isAbsolute(primaryRoot)) {
    throw new TargetContextError('primary-root-invalid', `target primaryRoot must be absolute: ${primaryRoot}`, cardPath);
  }
  try {
    if (!statSync(primaryRoot).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new TargetContextError('primary-root-invalid', `target primaryRoot is not a readable directory: ${primaryRoot}`, cardPath);
  }
  try {
    new RegExp(orcaWorkspacePattern, 'u');
    new RegExp(orchestratorTitlePattern, 'iu');
    const parsedProjectUrl = new URL(projectUrl);
    if (parsedProjectUrl.protocol !== 'https:' && parsedProjectUrl.protocol !== 'http:') throw new Error('protocol');
  } catch {
    throw new TargetContextError('card-invalid', `target card contains an invalid regex or Browser-GPT project URL: ${cardPath}`, cardPath);
  }

  const origin = readOrigin(primaryRoot);
  const observedRepository = canonicalGitHubRepository(origin);
  if (!observedRepository || observedRepository !== repository) {
    throw new TargetContextError(
      'origin-mismatch',
      `target card repository ${repository} does not match primaryRoot origin ${origin || '<empty>'}: ${cardPath}`,
      cardPath,
    );
  }

  const verification = parseVerification(card.verification, cardPath);
  return Object.freeze({
    projectId,
    repository,
    primaryRoot: resolve(primaryRoot),
    defaultBranch,
    orcaWorkspacePattern,
    orchestratorTitlePattern,
    browserGpt: Object.freeze({ projectUrl }),
    ...(verification ? { verification } : {}),
    packRoot: PACK_ROOT,
    cardPath,
  });
}

function targetVerificationCommands(context: TargetContext): readonly string[] {
  const commands = context.verification?.local;
  if (!commands || commands.length === 0 || commands.some((command) => !text(command))) {
    throw new TargetVerificationError(
      'verification-local-required',
      `target project ${context.projectId} requires a non-empty verification.local command list in ${context.cardPath}`,
    );
  }
  return commands;
}

function validatedTargetWorktreeRoot(context: TargetContext, value: string): string {
  const requested = text(value);
  if (!requested) {
    throw new TargetVerificationError(
      'target-worktree-required',
      'target verification requires an explicit current target worktree root',
    );
  }

  let root: string;
  try {
    root = realpathSync(resolve(requested));
    if (!statSync(root).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new TargetVerificationError(
      'target-worktree-invalid',
      `target verification worktree is not a readable directory: ${requested}`,
    );
  }

  const topLevel = runProcessSync({
    command: 'git',
    args: ['rev-parse', '--show-toplevel'],
    cwd: root,
    inheritParentEnv: true,
  });
  if (!topLevel.ok || !text(topLevel.stdout)) {
    throw new TargetVerificationError(
      'target-worktree-invalid',
      `target verification root is not a readable Git worktree: ${root}`,
    );
  }

  let canonicalTopLevel: string;
  try {
    canonicalTopLevel = realpathSync(resolve(text(topLevel.stdout)));
  } catch {
    throw new TargetVerificationError(
      'target-worktree-invalid',
      `target verification Git top level is unreadable: ${text(topLevel.stdout) || '<empty>'}`,
    );
  }
  if (canonicalTopLevel !== root) {
    throw new TargetVerificationError(
      'target-worktree-invalid',
      `target verification root must be the Git worktree top level: ${root}`,
    );
  }

  const origin = runProcessSync({
    command: 'git',
    args: ['remote', 'get-url', 'origin'],
    cwd: root,
    inheritParentEnv: true,
  });
  const observedRepository = origin.ok ? canonicalGitHubRepository(origin.stdout) : null;
  if (!observedRepository || observedRepository !== context.repository.toLowerCase()) {
    throw new TargetVerificationError(
      'target-worktree-repository-mismatch',
      `target verification worktree origin does not match selected card repository ${context.repository}: ${root}`,
    );
  }
  return root;
}

export function runTargetVerification(input: RunTargetVerificationInput): TargetVerificationResult {
  const commands = targetVerificationCommands(input.context);
  const targetWorktreeRoot = validatedTargetWorktreeRoot(input.context, input.targetWorktreeRoot);
  const commandRunner = input.commandRunner ?? runProcessSync;

  for (const [index, command] of commands.entries()) {
    let result: ReturnType<typeof runProcessSync>;
    try {
      result = commandRunner({
        command: 'sh',
        args: ['-lc', command],
        cwd: targetWorktreeRoot,
        inheritParentEnv: true,
      });
    } catch (error) {
      throw new TargetVerificationError(
        'verification-command-spawn-failed',
        `target verification command ${index + 1} could not spawn: ${error instanceof Error ? error.message : String(error)}`,
        index,
      );
    }
    if (result.outcome === 'spawn-failure') {
      throw new TargetVerificationError(
        'verification-command-spawn-failed',
        `target verification command ${index + 1} could not spawn`,
        index,
      );
    }
    if (!result.ok) {
      const terminal = result.exitCode !== null
        ? `exit ${result.exitCode}`
        : result.signal
          ? `signal ${result.signal}`
          : result.outcome;
      throw new TargetVerificationError(
        'verification-command-failed',
        `target verification command ${index + 1} failed with ${terminal}`,
        index,
      );
    }
  }

  return Object.freeze({
    projectId: input.context.projectId,
    repository: input.context.repository,
    targetWorktreeRoot,
    commandCount: commands.length,
  });
}

function option(argv: readonly string[], name: string): string {
  const indexes = argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`duplicate argument: ${name}`);
  if (indexes.length === 0) return '';
  const value = String(argv[indexes[0]! + 1] ?? '').trim();
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

export function runTargetContextCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): number {
  const action = argv[0];
  if (action !== 'check' && action !== 'verify') {
    process.stderr.write('Usage: target-context.ts <check|verify> [--project <id>] [--target-worktree <root>]\n');
    return 2;
  }
  try {
    const args = argv.slice(1);
    const allowed = action === 'verify'
      ? new Set(['--project', '--target-worktree'])
      : new Set(['--project']);
    const unknown = args.filter((value, index) => index % 2 === 0 && !allowed.has(value));
    if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}`);
    const context = resolveTargetContext({ projectId: option(args, '--project'), env });
    if (action === 'verify') {
      const result = runTargetVerification({
        context,
        targetWorktreeRoot: option(args, '--target-worktree'),
      });
      process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
      return 0;
    }
    process.stdout.write(`${JSON.stringify({
      projectId: context.projectId,
      repository: context.repository,
      primaryRoot: context.primaryRoot,
      defaultBranch: context.defaultBranch,
      projectUrl: context.browserGpt.projectUrl,
      cardPath: context.cardPath,
    })}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof TargetContextError || error instanceof TargetVerificationError
      ? error.code
      : 'card-invalid';
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code,
      message: error instanceof Error ? error.message : String(error),
    })}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runTargetContextCli();
}
