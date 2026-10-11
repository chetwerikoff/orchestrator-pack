#!/usr/bin/env -S node --experimental-strip-types
import '../toolchain/native-entrypoint-preflight.ts';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTargetContext, type TargetContext } from './target-context.ts';

const REPOSITORY_RE = /^[^/\s]+\/[^/\s]+$/u;
const FULL_URL_RE = /^https?:\/\//iu;
const NON_ROUTING_VALUE_OPTIONS = new Set([
  '--body', '--body-file', '--title', '--jq', '--template', '--search', '--head', '--base',
  '--state', '--json', '--field', '-f', '--raw-field', '-F', '--header', '-H', '--method', '-X', '--input',
]);

export type TargetGhAuthorizationErrorCode =
  | 'missing-selection'
  | 'target-gh-host-mismatch'
  | 'target-gh-repository-invalid'
  | 'target-gh-repository-mismatch'
  | 'target-gh-graphql-unsupported';

export class TargetGhAuthorizationError extends Error {
  readonly code: TargetGhAuthorizationErrorCode;

  constructor(code: TargetGhAuthorizationErrorCode, message: string) {
    super(message);
    this.name = 'TargetGhAuthorizationError';
    this.code = code;
  }
}

function normalizeRepository(value: unknown): string {
  const raw = String(value ?? '').trim().replace(/^\/+|\/+$/gu, '');
  if (!REPOSITORY_RE.test(raw)) {
    throw new TargetGhAuthorizationError(
      'target-gh-repository-invalid',
      `target gh repository is invalid: ${raw || '<empty>'}`,
    );
  }
  const [owner, name] = raw.split('/');
  return `${owner}/${String(name).replace(/\.git$/iu, '')}`.toLowerCase();
}

function requireGithubCom(host: unknown, source: string): void {
  const normalized = String(host ?? '').trim().toLowerCase();
  if (normalized && normalized !== 'github.com') {
    throw new TargetGhAuthorizationError(
      'target-gh-host-mismatch',
      `target gh host mismatch from ${source}: expected github.com, got ${normalized}`,
    );
  }
}

function repositoryFromGithubUrl(token: string): string | null {
  if (!FULL_URL_RE.test(token)) return null;
  let parsed: URL;
  try {
    parsed = new URL(token);
  } catch {
    throw new TargetGhAuthorizationError('target-gh-host-mismatch', `target gh URL is invalid: ${token}`);
  }
  requireGithubCom(parsed.hostname, 'URL');
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  if (parts[0] === 'repos' && parts.length >= 3) return `${parts[1]}/${parts[2]}`;
  return `${parts[0]}/${parts[1]}`;
}

function repositoryCandidates(argv: readonly string[], env: Readonly<NodeJS.ProcessEnv>): Array<{ source: string; value: string }> {
  const candidates: Array<{ source: string; value: string }> = [];
  const envRepo = String(env.GH_REPO ?? '').trim();
  if (envRepo) candidates.push({ source: 'GH_REPO', value: envRepo });

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? '');
    if (arg === '--repo' || arg === '-R') {
      const value = String(argv[index + 1] ?? '').trim();
      if (!value || value.startsWith('-')) {
        throw new TargetGhAuthorizationError('target-gh-repository-invalid', `${arg} requires owner/name in target mode`);
      }
      candidates.push({ source: arg, value });
      index += 1;
      continue;
    }
    if (arg.startsWith('--repo=')) {
      candidates.push({ source: '--repo', value: arg.slice('--repo='.length) });
      continue;
    }
    if (arg.startsWith('-R') && arg.length > 2) {
      const value = arg.slice(2).replace(/^=/u, '');
      candidates.push({ source: '-R', value });
      continue;
    }
    if (arg === '--hostname') {
      requireGithubCom(argv[index + 1], '--hostname');
      index += 1;
      continue;
    }
    if (arg.startsWith('--hostname=')) {
      requireGithubCom(arg.slice('--hostname='.length), '--hostname');
      continue;
    }
    if (NON_ROUTING_VALUE_OPTIONS.has(arg)) {
      const value = String(argv[index + 1] ?? '');
      if (value && !value.startsWith('-')) index += 1;
      continue;
    }

    const apiMatch = arg.match(/^\/?repos\/([^/?#]+)\/([^/?#]+)(?:[/?#]|$)/iu);
    if (apiMatch?.[1] && apiMatch[2]) {
      candidates.push({ source: 'api-endpoint', value: `${apiMatch[1]}/${apiMatch[2]}` });
      continue;
    }

    if (FULL_URL_RE.test(arg)) {
      const fromUrl = repositoryFromGithubUrl(arg);
      if (fromUrl) candidates.push({ source: 'URL', value: fromUrl });
    }
  }

  if (argv[0] === 'repo' && argv[1] && !String(argv[1]).startsWith('-')) {
    const positional = String(argv[2] ?? '').trim();
    if (positional && REPOSITORY_RE.test(positional)) {
      candidates.push({ source: 'repo-positional', value: positional });
    }
  }
  if (argv[0] === 'issue' && argv[1] === 'transfer') {
    const positionals: string[] = [];
    for (let index = 2; index < argv.length; index += 1) {
      const arg = String(argv[index] ?? '');
      if (arg === '--repo' || arg === '-R' || arg === '--hostname' || NON_ROUTING_VALUE_OPTIONS.has(arg)) {
        index += 1;
      } else if (!arg.startsWith('-')) {
        positionals.push(arg);
      }
    }
    const destination = positionals[1]?.trim();
    if (destination) {
      candidates.push({ source: 'issue-transfer-destination', value: destination });
    }
  }
  return candidates;
}

function registeredEditEvidenceQuery(): string | null {
  try {
    const inventory = JSON.parse(
      readFileSync(new URL('./graphql-quota-github-read-inventory.json', import.meta.url), 'utf8'),
    ) as { rows?: Array<{ id?: string; query?: string }> };
    const matching = inventory.rows?.filter((row) => row.id === 'issue-body-edit-evidence') ?? [];
    return matching.length === 1 && typeof matching[0]?.query === 'string'
      ? matching[0].query : null;
  } catch {
    return null;
  }
}

function registeredEditEvidenceRefusal(
  argv: readonly string[],
  selected: string,
  env: Readonly<NodeJS.ProcessEnv>,
): string | null {
  // The registered query's four unique variables have one precise CLI form.
  // Do not infer an Issue number from arbitrary query text or duplicate flags.
  if (argv.length !== 10 || argv[0] !== 'api' || argv[1] !== 'graphql') return null;
  const values = new Map<string, string>();
  for (let index = 2; index < argv.length; index += 2) {
    const flag = argv[index];
    const raw = String(argv[index + 1] ?? '');
    const equals = raw.indexOf('=');
    if (equals <= 0) return null;
    const key = raw.slice(0, equals);
    const value = raw.slice(equals + 1);
    if (!['query', 'owner', 'name', 'number'].includes(key) || values.has(key)) return null;
    if ((key === 'number' ? '-F' : '-f') !== flag) return null;
    values.set(key, value);
  }
  const query = registeredEditEvidenceQuery();
  if (!query || values.get('query') !== query) return null;
  const rawNumber = values.get('number') ?? '';
  if (!/^\d+$/u.test(rawNumber)) return null;
  const number = Number(rawNumber);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const owner = values.get('owner') ?? '';
  const name = values.get('name') ?? '';
  if (!REPOSITORY_RE.test(owner + '/' + name)) return null;
  try {
    if (normalizeRepository(owner + '/' + name) !== selected) return null;
    if (repositoryCandidates(argv, env).some((candidate) => normalizeRepository(candidate.value) !== selected)) {
      return null;
    }
  } catch {
    return null;
  }
  return 'registered issue-body-edit-evidence GraphQL is unsupported in target mode. '
    + 'Closest inventory-authorized CURRENT-BODY-ONLY read for selected repository '
    + selected + ': gh issue view ' + number + ' --json body. '
    + 'The present REST body does not contain userContentEdits, lastEditedAt, historical '
    + 'editedAt/diff, or the post-terminal before/after proof required for #2428 '
    + 'same-head final-cap settlement; it never authorizes same-head settlement. '
    + 'If edit history is unavailable, a genuine substantive code-bearing strict-descendant '
    + 'change followed by existing scoped reconciliation is a distinct legal route, '
    + 'not equivalent history proof or permission for a process-only/fake commit.';
}

export function authorizeTargetGhInvocation(input: {
  context: Pick<TargetContext, 'repository' | 'defaultBranch'>;
  argv: readonly string[];
  env?: Readonly<NodeJS.ProcessEnv>;
}): { repository: string; defaultBranch: string; host: 'github.com' } {
  const env = input.env ?? process.env;
  const selected = normalizeRepository(input.context.repository);
  const defaultBranch = String(input.context.defaultBranch ?? '').trim();
  if (!defaultBranch) {
    throw new TargetGhAuthorizationError(
      'target-gh-repository-invalid',
      'target gh default branch is empty',
    );
  }
  requireGithubCom(env.GH_HOST, 'GH_HOST');

  if (input.argv[0] === 'api' && input.argv.some((value, index) => index > 0 && value === 'graphql')) {
    throw new TargetGhAuthorizationError(
      'target-gh-graphql-unsupported',
      registeredEditEvidenceRefusal(input.argv, selected, env)
        ?? 'arbitrary gh api graphql is unsupported in target mode; supply the exact registered selected-target request and a real Issue ID for current-body-only guidance',
    );
  }

  for (const candidate of repositoryCandidates(input.argv, env)) {
    const normalized = normalizeRepository(candidate.value);
    if (normalized !== selected) {
      throw new TargetGhAuthorizationError(
        'target-gh-repository-mismatch',
        `target gh repository mismatch from ${candidate.source}: expected ${selected}, got ${normalized}`,
      );
    }
  }

  return { repository: input.context.repository, defaultBranch, host: 'github.com' };
}

export function requireTargetGhAuthorization(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): { repository: string; defaultBranch: string; host: 'github.com' } {
  const projectId = String(env.OPK_PROJECT_ID ?? '').trim();
  if (!projectId) {
    throw new TargetGhAuthorizationError(
      'missing-selection',
      'target gh authorization requires non-empty OPK_PROJECT_ID',
    );
  }
  const context = resolveTargetContext({ projectId, env });
  return authorizeTargetGhInvocation({ context, argv, env });
}

function runCli(): number {
  const argv = process.argv.slice(2);
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv;
  try {
    const authorized = requireTargetGhAuthorization(normalizedArgv, process.env);
    process.stdout.write(`${authorized.repository} ${authorized.defaultBranch}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof TargetGhAuthorizationError ? error.code : 'target-gh-repository-invalid';
    const failure = {
      ok: false,
      code,
      message: error instanceof Error ? error.message : String(error),
    };
    process.stderr.write(`${JSON.stringify(failure)}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli();
}
