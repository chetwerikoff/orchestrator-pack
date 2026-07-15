import { resolve } from 'node:path';
import { isDirectExecution } from '#opk-toolchain/baseline-io';
import { runProcess } from '#opk-kernel/subprocess';
import { aggregateLane, type GateResult } from './types.ts';

const ALLOWED_ROOT_PATTERNS = [
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'LICENSE',
  'LICENSE.md',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  'agent-orchestrator.yaml.example',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.*.json',
  '*.config.js',
  '*.config.cjs',
  '*.config.mjs',
  '*.config.ts',
  '*.config.mts',
  '*.config.cts',
] as const;

const ALLOWED_PATH_PATTERNS = [
  '.github/*',
  '.cursor/skills/*',
  '.cursor/rules/*',
  '.claude/skills/*',
  'docs/*',
  'prompts/*',
  'plugins/*',
  'scripts/*',
  'schemas/*',
  'examples/*',
  'templates/*',
  'tests/*',
] as const;

const EXCEPTION_PATTERNS = [
  '.env.example',
  '*/.env.example',
  'agent-orchestrator.yaml.example',
] as const;

const FORBIDDEN_PATTERNS = [
  'agent-orchestrator.yaml',
  'agent-orchestrator.*.yaml',
  '.env',
  '.env.*',
  '*/.env',
  '*/.env.*',
  '*.pem',
  '*.key',
  '*.pfx',
  '*.p12',
  '*.crt',
  '*.cer',
  'id_rsa',
  'id_rsa.*',
  '*/id_rsa',
  '*/id_rsa.*',
  'id_ed25519',
  'id_ed25519.*',
  '*/id_ed25519',
  '*/id_ed25519.*',
  'secrets/*',
  'private/*',
  '*/secrets/*',
  '*/private/*',
  '.ao/*',
  '*/.ao/*',
  '.agent-orchestrator/*',
  '*/.agent-orchestrator/*',
  'vendor/*',
  '*/vendor/*',
  'packages/core/*',
  '*/packages/core/*',
  'node_modules/*',
  '*/node_modules/*',
  '.pnpm-store/*',
  '*/.pnpm-store/*',
  '.npm/*',
  '*/.npm/*',
  'dist/*',
  '*/dist/*',
  'build/*',
  '*/build/*',
  'coverage/*',
  '*/coverage/*',
  '.out/*',
  '*/.out/*',
  '.cache/*',
  '*/.cache/*',
  '.turbo/*',
  '*/.turbo/*',
  '.next/*',
  '*/.next/*',
  '*.log',
  '*.tmp',
  '*.temp',
  '*.bak',
  '*.swp',
  '*.sqlite',
  '*.sqlite3',
  '*.db',
  '*.jsonl.local',
  'scratch/*',
  'tmp/*',
  'temp/*',
  'worktrees/*',
  'target-repos/*',
  '*/scratch/*',
  '*/tmp/*',
  '*/temp/*',
  '*/worktrees/*',
  '*/target-repos/*',
] as const;

export interface ReusablePackOptions {
  readonly repoRoot: string;
  readonly allowNoGit?: boolean;
}

export interface ReusablePackEvaluation {
  readonly trackedFiles: readonly string[];
  readonly violations: readonly string[];
  readonly gate: GateResult;
}

function compilePattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

const allowedRootMatchers = ALLOWED_ROOT_PATTERNS.map(compilePattern);
const allowedPathMatchers = ALLOWED_PATH_PATTERNS.map(compilePattern);
const exceptionMatchers = EXCEPTION_PATTERNS.map(compilePattern);
const forbiddenMatchers = FORBIDDEN_PATTERNS.map(compilePattern);

export function normalizeRepoPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function matchesAny(path: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(path));
}

export function evaluateTrackedPaths(trackedFiles: readonly string[]): ReusablePackEvaluation {
  const violations: string[] = [];

  for (const originalPath of trackedFiles) {
    const path = normalizeRepoPath(originalPath);
    const isException = matchesAny(path, exceptionMatchers);
    if (!isException && matchesAny(path, forbiddenMatchers)) {
      violations.push(`${path} :: forbidden local/runtime/secret/upstream artifact pattern`);
      continue;
    }

    const isAllowed = matchesAny(path, allowedRootMatchers) || matchesAny(path, allowedPathMatchers);
    if (!isAllowed) violations.push(`${path} :: not in reusable pack allowlist`);
  }

  const gate: GateResult = violations.length === 0
    ? {
        gateId: 'reusable-pack',
        status: 'PASS',
        summary: 'All tracked files match reusable-pack policy.',
        evidence: ['static-source'],
      }
    : {
        gateId: 'reusable-pack',
        status: 'FAIL',
        summary: 'Non-reusable files are tracked or would be pushed.',
        evidence: ['static-source'],
        details: violations,
      };

  return { trackedFiles, violations, gate };
}

async function runGit(repoRoot: string, args: readonly string[]) {
  return runProcess({
    command: 'git',
    args,
    cwd: repoRoot,
    inheritParentEnv: true,
    allowEmptyStdout: true,
  });
}

export async function runReusablePackGate(options: ReusablePackOptions): Promise<ReusablePackEvaluation> {
  const repoRoot = resolve(options.repoRoot);
  const insideWorkTree = await runGit(repoRoot, ['rev-parse', '--is-inside-work-tree']);
  if (insideWorkTree.outcome === 'spawn-failure') {
    return {
      trackedFiles: [],
      violations: [],
      gate: {
        gateId: 'reusable-pack',
        status: 'SKIP',
        summary: 'git not found; cannot inspect tracked files.',
        evidence: ['static-source'],
        allowSkip: options.allowNoGit === true,
      },
    };
  }

  if (!insideWorkTree.ok || insideWorkTree.stdout.trim() !== 'true') {
    return {
      trackedFiles: [],
      violations: [],
      gate: {
        gateId: 'reusable-pack',
        status: 'SKIP',
        summary: 'Not a git worktree; skipping tracked-file policy check.',
        evidence: ['static-source'],
        allowSkip: true,
      },
    };
  }

  const tracked = await runGit(repoRoot, ['ls-files']);
  if (!tracked.ok) {
    return {
      trackedFiles: [],
      violations: [],
      gate: {
        gateId: 'reusable-pack',
        status: 'SKIP',
        summary: 'git ls-files failed; cannot prove tracked-file policy.',
        evidence: ['static-source'],
        details: tracked.stderr.trim() ? [tracked.stderr.trim()] : undefined,
      },
    };
  }

  const trackedFiles = tracked.stdout
    .split(/\r?\n/u)
    .map((line) => normalizeRepoPath(line.trim()))
    .filter((line) => line.length > 0);

  return evaluateTrackedPaths(trackedFiles);
}

export function formatReusablePackReport(evaluation: ReusablePackEvaluation): string {
  const lane = aggregateLane([evaluation.gate]);
  const lines = [
    '== reusable repository content guard ==',
    `Tracked files inspected: ${evaluation.trackedFiles.length}`,
    `[${lane.status}] ${evaluation.gate.summary}`,
  ];

  for (const violation of evaluation.violations) lines.push(`- ${violation}`);

  if (evaluation.gate.status === 'FAIL') {
    lines.push('');
    lines.push(
      'Move reusable material under docs/, prompts/, plugins/, scripts/, examples/, templates/, schemas/, tests/, or .github/workflows/.',
    );
    lines.push('Keep local configs, runtime state, target repos, vendor checkouts, and secrets untracked.');
  }

  return `${lines.join('\n')}\n`;
}

export async function main(argv: readonly string[]): Promise<number> {
  const allowNoGit = argv.includes('--allow-no-git');
  const repoRootFlag = argv.indexOf('--repo-root');
  const repoRoot =
    repoRootFlag >= 0 && repoRootFlag + 1 < argv.length
      ? argv[repoRootFlag + 1] ?? process.cwd()
      : resolve(import.meta.dirname, '../..');

  const evaluation = await runReusablePackGate({ repoRoot, allowNoGit });
  process.stdout.write(formatReusablePackReport(evaluation));
  return aggregateLane([evaluation.gate]).exitCode;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  const exitCode = await main(process.argv.slice(2));
  process.exitCode = exitCode;
}
