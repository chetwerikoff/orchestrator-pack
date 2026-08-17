#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDirectExecution } from '#opk-toolchain/baseline-io';
import { runProcess } from '#opk-kernel/subprocess';
import { gateRegistrations, runGateRunner } from './gate-runner/runner.ts';
import { scanRetiredRuntimeSurfaces } from './runtime-retirement/retired-surface-guard.ts';

export interface VerifyLine {
  readonly name: string;
  readonly status: 'PASS' | 'WARN' | 'FAIL';
  readonly detail: string;
}

export interface VerifyReport {
  readonly lines: readonly VerifyLine[];
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
  readonly exitCode: 0 | 1;
}

const REQUIRED_FILES = [
  'AGENTS.md',
  'README.md',
  'package.json',
  'package-lock.json',
  '.claude/skills/change-orchestrator-runtime/SKILL.md',
  '.cursor/skills/change-orchestrator-runtime/SKILL.md',
  'scripts/runtime/contracts.ts',
  'scripts/runtime/registry.ts',
  'scripts/runtime/runtime-cli.ts',
  'scripts/lib/operator-publication.ts',
  'scripts/lib/worker-degraded-ci-handoff.ts',
  'scripts/pack-review-runner.ts',
  'scripts/pack-worker-report.ps1',
  'scripts/runtime-retirement/retired-surface-guard.ts',
  'scripts/runtime-retirement/retired-surface-selftest.ts',
  'scripts/json-producers/retired-runtime-surfaces.json',
  'scripts/check-reusable.ps1',
] as const;

const REQUIRED_DIRECTORIES = [
  'plugins/task-declaration',
  'plugins/scope-guard',
  'plugins/token-chain-ledger',
  'plugins/codex-pr-reviewer',
  'prompts',
  '.github/workflows',
] as const;

const PLUGINS = [
  ['task-declaration', '@orchestrator-pack/task-declaration', 'pack-declare'],
  ['scope-guard', '@orchestrator-pack/scope-guard', 'scope-check'],
  ['token-chain-ledger', '@orchestrator-pack/token-chain-ledger', 'pack-ledger'],
  ['codex-pr-reviewer', '@orchestrator-pack/codex-pr-reviewer', 'pack-codex-review'],
] as const;

const retiredRuntimeStem = ['agent', 'orchestrator'].join('-');
const retiredStateStem = `.${retiredRuntimeStem}`;

const ALLOWED_ROOT_PATTERNS = [
  'README.md', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'LICENSE', 'LICENSE.md', '.gitignore', '.gitattributes', '.editorconfig',
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.*.json', '*.config.js', '*.config.cjs', '*.config.mjs', '*.config.ts', '*.config.mts', '*.config.cts',
] as const;
const ALLOWED_PATH_PATTERNS = ['.github/*', '.cursor/skills/*', '.cursor/rules/*', '.claude/skills/*', 'docs/*', 'prompts/*', 'plugins/*', 'scripts/*', 'schemas/*', 'examples/*', 'templates/*', 'tests/*'] as const;
const EXCEPTION_PATTERNS = ['.env.example', '*/.env.example'] as const;
const FORBIDDEN_PATTERNS = [
  `${retiredRuntimeStem}.yaml`, `${retiredRuntimeStem}.*.yaml`, '.env', '.env.*', '*/.env', '*/.env.*', '*.pem', '*.key', '*.pfx', '*.p12', '*.crt', '*.cer',
  'id_rsa', 'id_rsa.*', '*/id_rsa', '*/id_rsa.*', 'id_ed25519', 'id_ed25519.*', '*/id_ed25519', '*/id_ed25519.*', 'secrets/*', 'private/*', '*/secrets/*', '*/private/*',
  '.orchestrator-pack/*', '*/.orchestrator-pack/*', `${retiredStateStem}/*`, `*/${retiredStateStem}/*`, 'vendor/*', '*/vendor/*', 'packages/core/*', '*/packages/core/*',
  'node_modules/*', '*/node_modules/*', '.pnpm-store/*', '*/.pnpm-store/*', '.npm/*', '*/.npm/*', 'dist/*', '*/dist/*', 'build/*', '*/build/*', 'coverage/*', '*/coverage/*',
  '.out/*', '*/.out/*', '.cache/*', '*/.cache/*', '.turbo/*', '*/.turbo/*', '.next/*', '*/.next/*', '*.log', '*.tmp', '*.temp', '*.bak', '*.swp', '*.sqlite', '*.sqlite3', '*.db', '*.jsonl.local',
  'scratch/*', 'tmp/*', 'temp/*', 'worktrees/*', 'target-repos/*', '*/scratch/*', '*/tmp/*', '*/temp/*', '*/worktrees/*', '*/target-repos/*',
] as const;

function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
  return new RegExp(`^${escaped}$`, 'iu');
}

function anyGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globRegex(pattern).test(path));
}

export function evaluateReusableTrackedPaths(paths: readonly string[]): readonly string[] {
  const violations: string[] = [];
  for (const raw of paths) {
    const path = raw.replaceAll('\\', '/').replace(/^\.\//u, '');
    const exception = anyGlob(path, EXCEPTION_PATTERNS);
    if (!exception && anyGlob(path, FORBIDDEN_PATTERNS)) {
      violations.push(`${path} :: forbidden local/runtime/secret/upstream artifact pattern`);
      continue;
    }
    if (!anyGlob(path, ALLOWED_ROOT_PATTERNS) && !anyGlob(path, ALLOWED_PATH_PATTERNS)) violations.push(`${path} :: not in reusable pack allowlist`);
  }
  return violations;
}

async function trackedPaths(repoRoot: string, allowNoGit: boolean): Promise<{ paths?: readonly string[]; warning?: string; failure?: string }> {
  const available = await runProcess({ command: 'git', args: ['--version'], cwd: repoRoot, inheritParentEnv: true, allowEmptyStdout: false });
  if (!available.ok) return allowNoGit ? { warning: 'git not found; cannot inspect tracked files.' } : { failure: 'git not found; cannot inspect tracked files.' };
  const inside = await runProcess({ command: 'git', args: ['rev-parse', '--is-inside-work-tree'], cwd: repoRoot, inheritParentEnv: true, allowEmptyStdout: false });
  if (!inside.ok || inside.stdout.trim() !== 'true') return { warning: 'Not a git worktree; skipping tracked-file policy check.' };
  const listed = await runProcess({ command: 'git', args: ['ls-files'], cwd: repoRoot, inheritParentEnv: true, allowEmptyStdout: true });
  if (!listed.ok) return { failure: `git ls-files failed: ${listed.stderr || listed.error || listed.outcome}` };
  return { paths: listed.stdout.split(/\r?\n/u).filter(Boolean) };
}

export async function runReusableGuard(repoRoot: string, allowNoGit = false): Promise<VerifyReport> {
  const lines: VerifyLine[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];
  const tracked = await trackedPaths(repoRoot, allowNoGit);
  if (tracked.failure) failures.push(tracked.failure);
  if (tracked.warning) warnings.push(tracked.warning);
  if (tracked.paths) {
    const violations = evaluateReusableTrackedPaths(tracked.paths);
    if (violations.length > 0) failures.push(...violations);
    else lines.push({ name: 'reusable repository content guard', status: 'PASS', detail: `tracked=${tracked.paths.length}` });
  }
  if (warnings.length > 0) lines.push(...warnings.map((detail) => ({ name: 'reusable repository content guard', status: 'WARN' as const, detail })));
  if (failures.length > 0) lines.push(...failures.map((detail) => ({ name: 'reusable repository content guard', status: 'FAIL' as const, detail })));
  return { lines, failures, warnings, exitCode: failures.length > 0 ? 1 : 0 };
}

function appendPathChecks(repoRoot: string, lines: VerifyLine[], failures: string[]): void {
  for (const path of REQUIRED_FILES) {
    if (existsSync(resolve(repoRoot, path))) lines.push({ name: path, status: 'PASS', detail: 'present' });
    else {
      lines.push({ name: path, status: 'FAIL', detail: 'missing' });
      failures.push(`Missing required path: ${path}`);
    }
  }
  for (const path of REQUIRED_DIRECTORIES) {
    if (existsSync(resolve(repoRoot, path))) lines.push({ name: path, status: 'PASS', detail: 'present' });
    else {
      lines.push({ name: path, status: 'FAIL', detail: 'missing' });
      failures.push(`Missing required path: ${path}`);
    }
  }
  const retiredConfig = `${retiredRuntimeStem}.yaml.example`;
  if (existsSync(resolve(repoRoot, retiredConfig))) {
    lines.push({ name: retiredConfig, status: 'FAIL', detail: 'must be absent' });
    failures.push(`Retired path remains active: ${retiredConfig}`);
  } else lines.push({ name: retiredConfig, status: 'PASS', detail: 'absent' });
}

function appendPluginChecks(repoRoot: string, lines: VerifyLine[], failures: string[]): void {
  for (const [directory, packageName, commandName] of PLUGINS) {
    const path = resolve(repoRoot, 'plugins', directory, 'package.json');
    try {
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown; bin?: unknown };
      const bins = manifest.bin && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin) ? Object.keys(manifest.bin as Record<string, unknown>) : [];
      if (manifest.name === packageName && bins.includes(commandName)) lines.push({ name: `plugin/${directory}`, status: 'PASS', detail: `${packageName} / ${commandName}` });
      else {
        lines.push({ name: `plugin/${directory}`, status: 'FAIL', detail: `name=${String(manifest.name)}; bins=${bins.join(',')}` });
        failures.push(`Plugin identity mismatch: ${directory}`);
      }
    } catch (error) {
      lines.push({ name: `plugin/${directory}`, status: 'FAIL', detail: 'package.json missing or malformed' });
      failures.push(`Plugin manifest invalid: ${directory}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export async function runVerification(repoRoot: string, options: { readonly strictPrereqs?: boolean; readonly testBackedSmoke?: boolean } = {}): Promise<VerifyReport> {
  const lines: VerifyLine[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];
  if (process.versions.node.split('.')[0] !== '22') {
    const message = `Node.js 22.x is required; detected ${process.version}`;
    (options.strictPrereqs ? failures : warnings).push(message);
    lines.push({ name: 'node', status: options.strictPrereqs ? 'FAIL' : 'WARN', detail: message });
  } else lines.push({ name: 'node', status: 'PASS', detail: process.version });
  appendPathChecks(repoRoot, lines, failures);
  appendPluginChecks(repoRoot, lines, failures);

  const selectedGateIds = gateRegistrations.map((registration) => registration.gateId);
  const gateReport = runGateRunner(repoRoot, selectedGateIds);
  for (const result of gateReport.results) {
    lines.push({ name: `gate/${result.gateId}`, status: result.status === 'PASS' ? 'PASS' : result.status === 'WARN' ? 'WARN' : 'FAIL', detail: result.summary });
    if (result.status === 'FAIL') failures.push(`gate ${result.gateId}: ${result.summary}`);
    else if (result.status === 'WARN') warnings.push(`gate ${result.gateId}: ${result.summary}`);
  }

  const retirement = scanRetiredRuntimeSurfaces({ repoRoot });
  if (retirement.violations.length > 0) {
    failures.push(...retirement.violations.map((violation) => `${violation.path}:${violation.line} ${violation.surfaceId}: ${violation.match}`));
    lines.push({ name: 'runtime retirement scan', status: 'FAIL', detail: `violations=${retirement.violations.length}` });
  } else lines.push({ name: 'runtime retirement scan', status: 'PASS', detail: `scanned=${retirement.scannedFileCount}` });

  const reusable = await runReusableGuard(repoRoot);
  lines.push(...reusable.lines);
  failures.push(...reusable.failures);
  warnings.push(...reusable.warnings);

  if (options.testBackedSmoke) {
    failures.push('TestBackedSmoke has no Node-owned implementation; refusing to call PowerShell from the Node verifier');
    lines.push({ name: 'test-backed smoke', status: 'FAIL', detail: 'Node-owned smoke implementation unavailable' });
  }
  return { lines, failures, warnings, exitCode: failures.length > 0 ? 1 : 0 };
}

export function formatVerifyReport(report: VerifyReport): string {
  const lines = ['== orchestrator-pack verify =='];
  for (const item of report.lines) lines.push(`[${item.status}] ${item.name}${item.detail ? `: ${item.detail}` : ''}`);
  lines.push(`Failures: ${report.failures.length}`);
  lines.push(`Warnings: ${report.warnings.length}`);
  if (report.failures.length === 0) lines.push('[PASS] orchestrator-pack verification completed.');
  return `${lines.join('\n')}\n`;
}

function argument(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    const repoRoot = resolve(argument(argv, '--repo-root') ?? resolve(import.meta.dirname, '..'));
    const reusableOnly = argv.includes('--reusable-only');
    const report = reusableOnly
      ? await runReusableGuard(repoRoot, argv.includes('--allow-no-git'))
      : await runVerification(repoRoot, { strictPrereqs: argv.includes('--strict-prereqs'), testBackedSmoke: argv.includes('--test-backed-smoke') });
    process.stdout.write(formatVerifyReport(report));
    return report.exitCode;
  } catch (error) {
    process.stderr.write(`[FAIL] verify: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`[FAIL] verify: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
