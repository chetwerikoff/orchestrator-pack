#!/usr/bin/env -S node --experimental-strip-types
import '../toolchain/native-entrypoint-preflight.ts';

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

export function authorizeTargetGhInvocation(input: {
  context: Pick<TargetContext, 'repository'>;
  argv: readonly string[];
  env?: Readonly<NodeJS.ProcessEnv>;
}): { repository: string; host: 'github.com' } {
  const env = input.env ?? process.env;
  const selected = normalizeRepository(input.context.repository);
  requireGithubCom(env.GH_HOST, 'GH_HOST');

  if (input.argv[0] === 'api' && input.argv.some((value, index) => index > 0 && value === 'graphql')) {
    throw new TargetGhAuthorizationError(
      'target-gh-graphql-unsupported',
      'arbitrary gh api graphql is unsupported in target mode',
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

  return { repository: input.context.repository, host: 'github.com' };
}

export function requireTargetGhAuthorization(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): { repository: string; host: 'github.com' } {
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
    process.stdout.write(`${authorized.repository}\n`);
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
