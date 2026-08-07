#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
import {
  resolveHeadSha,
  resolveRepositorySlug,
  runGptPackReview,
  assertGptHarnessFixtureAllowed,
  type GptReviewRequest,
} from './lib/pack-gpt-reviewer.ts';
import type { ResolvedScopeContext } from '../plugins/codex-pr-reviewer/lib/scope_context.ts';
import { runProcess } from './kernel/subprocess.ts';

function trim(value: unknown): string {
  return String(value ?? '').trim();
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function resolveFrozenScope(env: NodeJS.ProcessEnv): ResolvedScopeContext | undefined {
  const raw = trim(env.PACK_REVIEW_FROZEN_SCOPE_JSON);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<ResolvedScopeContext>;
    const issueNumber = parsed.issueNumber;
    const issueConstraints = parsed.issueConstraints;
    const validIssueConstraints = issueConstraints !== null
      && typeof issueConstraints === 'object'
      && !Array.isArray(issueConstraints)
      && isStringArray((issueConstraints as { denylist?: unknown }).denylist)
      && (
        (issueConstraints as { allowed_roots?: unknown }).allowed_roots === undefined
        || isStringArray((issueConstraints as { allowed_roots?: unknown }).allowed_roots)
      );
    const hasConcreteScope = issueConstraints !== null
      || (Array.isArray(parsed.declaredPaths) && parsed.declaredPaths.length > 0)
      || (Array.isArray(parsed.declaredGlobs) && parsed.declaredGlobs.length > 0);
    if (!parsed || typeof parsed !== 'object'
      || !(
        issueNumber === null
        || (typeof issueNumber === 'number'
          && Number.isSafeInteger(issueNumber)
          && issueNumber > 0)
      )
      || typeof parsed.hasScope !== 'boolean'
      || !isStringArray(parsed.declaredPaths)
      || !isStringArray(parsed.declaredGlobs)
      || typeof parsed.unverifiedIssueConstraints !== 'boolean'
      || (parsed.issueConstraints !== null && !validIssueConstraints)
      || parsed.hasScope !== hasConcreteScope) {
      throw new Error('invalid frozen scope shape');
    }
    return parsed as ResolvedScopeContext;
  } catch (error) {
    throw new Error(`invalid PACK_REVIEW_FROZEN_SCOPE_JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function usage(): string {
  return [
    'Usage: run-pack-review-gpt.ts --repo-root <path> --base <ref> [--pr-number N] [--issue N] [--head-sha SHA]',
    '',
    'Browser GPT pack reviewer (Issue #1031). Emits terminal verdict JSON on stdout.',
  ].join('\n');
}

function parseArgs(argv: string[]): {
  repoRoot: string;
  baseRef: string;
  prNumber?: number;
  issueNumber?: number;
  headSha?: string;
} {
  let repoRoot = process.cwd();
  let baseRef = 'origin/main';
  let prNumber: number | undefined;
  let issueNumber: number | undefined;
  let headSha: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    switch (flag) {
      case '--repo-root':
        repoRoot = argv[++index] ?? repoRoot;
        break;
      case '--base':
        baseRef = argv[++index] ?? baseRef;
        break;
      case '--pr-number':
        prNumber = Number(argv[++index]);
        break;
      case '--issue':
        issueNumber = Number(argv[++index]);
        break;
      case '--head-sha':
        headSha = trim(argv[++index]).toLowerCase();
        break;
      case '--source':
      case '--model':
        index += 1;
        break;
      case '--help':
      case '-h':
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument '${flag}'\n${usage()}`);
    }
  }

  void baseRef;
  return { repoRoot, baseRef, prNumber, issueNumber, headSha };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const prNumber = Number.isInteger(options.prNumber) && options.prNumber! > 0
    ? options.prNumber!
    : 0;
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error('run-pack-review-gpt requires --pr-number');
  }

  const repoSlug = trim(process.env.PACK_GPT_FIXTURE_REPO_SLUG);
  const fixtureHead = trim(process.env.PACK_GPT_FIXTURE_HEAD_SHA);
  if (repoSlug || fixtureHead) {
    assertGptHarnessFixtureAllowed();
  }
  const resolvedRepoSlug = repoSlug || await resolveRepositorySlug(options.repoRoot);
  const boundHead = trim(process.env.PACK_REVIEW_TARGET_HEAD_SHA);
  let headSha = options.headSha || boundHead;
  if (!headSha) {
    const gitHead = await runProcess({
      command: 'git',
      args: ['rev-parse', 'HEAD'],
      cwd: options.repoRoot,
      inheritParentEnv: true,
      allowEmptyStdout: false,
    });
    if (gitHead.ok) {
      headSha = trim(gitHead.stdout).toLowerCase();
    }
  }
  if (!headSha) {
    headSha = fixtureHead || await resolveHeadSha(options.repoRoot, prNumber, resolvedRepoSlug);
  }

  const request: GptReviewRequest = {
    repoRoot: options.repoRoot,
    repoSlug: resolvedRepoSlug,
    prNumber,
    headSha,
    issueNumber: options.issueNumber,
    baseRef: options.baseRef,
    frozenScope: resolveFrozenScope(process.env),
  };
  const result = await runGptPackReview(request);

  if (result.stderr) {
    process.stderr.write(`${result.stderr}\n`);
  }
  if (result.stdout) {
    process.stdout.write(`${result.stdout}\n`);
  }
  process.exit(result.exitCode);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
