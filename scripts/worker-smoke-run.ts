#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeOrcaTerminal,
  createOrcaTerminal,
  probeOrcaWorktree,
  readOrcaTerminal,
  resolveOrcaExecutable,
  sendOrcaTerminal,
  waitOrcaTerminal,
} from './lib/orca-cli.ts';
import {
  buildSmokeAgentPrompt,
  checkSmokeTestPlan,
  detectTrackedImplementationMutation,
  evaluateWorkerSmokeGate,
  formatSmokeReportComment,
  normalizeSmokeReport,
  parseSmokeAgentReport,
  resolveSmokeRequirement,
  scrubSmokeOutput,
  type SmokeReport,
} from './lib/worker-smoke-core.ts';

interface CliOptions {
  command: string;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  issueBodyFile: string;
  repoRoot: string;
  cwd: string;
  dryRun: boolean;
  json: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    command: '',
    issueNumber: 0,
    prNumber: 0,
    headSha: '',
    issueBodyFile: '',
    repoRoot: process.cwd(),
    cwd: process.cwd(),
    dryRun: false,
    json: false,
  };

  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) {
    options.command = args.shift() ?? '';
  }

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    switch (token) {
      case '--issue':
        options.issueNumber = Number.parseInt(args[++index] ?? '', 10);
        break;
      case '--pr':
        options.prNumber = Number.parseInt(args[++index] ?? '', 10);
        break;
      case '--head-sha':
        options.headSha = args[++index] ?? '';
        break;
      case '--issue-body-file':
        options.issueBodyFile = args[++index] ?? '';
        break;
      case '--repo-root':
        options.repoRoot = args[++index] ?? options.repoRoot;
        break;
      case '--cwd':
        options.cwd = args[++index] ?? options.cwd;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        throw new Error(`unknown argument: ${token}`);
    }
  }

  return options;
}

function emit(result: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (typeof result === 'string') {
    process.stdout.write(`${result}\n`);
  }
}

function fail(message: string, code = 1): never {
  process.stderr.write(`worker-smoke-run: ${message}\n`);
  process.exit(code);
}

function readIssueBody(path: string): string {
  if (!path) {
    fail('--issue-body-file is required');
  }
  return readFileSync(path, 'utf8');
}

function gitPorcelain(cwd: string): string[] {
  return execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })
    .split(/\r?\n/u)
    .filter(Boolean);
}

function fetchPrComments(prNumber: number, repoRoot: string): { body?: string }[] {
  const output = execFileSync(
    'gh',
    ['api', `repos/{owner}/{repo}/issues/${prNumber}/comments`, '--paginate'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [];
}

function publishPrComment(prNumber: number, body: string, repoRoot: string): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'worker-smoke-comment-'));
  const bodyFile = join(tempDir, 'body.md');
  try {
    writeFileSync(bodyFile, body, 'utf8');
    execFileSync('gh', ['pr', 'comment', String(prNumber), '--body-file', bodyFile], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function resolveCiGreen(prNumber: number, headSha: string, repoRoot: string): boolean {
  const output = execFileSync(
    'gh',
    ['pr', 'checks', String(prNumber), '--json', 'name,state,bucket'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  const checks = JSON.parse(output) as { name?: string; state?: string; bucket?: string }[];
  if (!Array.isArray(checks) || checks.length === 0) {
    return false;
  }
  void headSha;
  return checks.every((check) => {
    const state = String(check.state ?? check.bucket ?? '').toLowerCase();
    return state === 'success' || state === 'pass' || state === 'successful';
  });
}

function runValidatePlan(options: CliOptions): number {
  const markdown = readIssueBody(options.issueBodyFile);
  const result = checkSmokeTestPlan(markdown);
  if (!result.ok) {
    for (const error of result.errors) {
      process.stderr.write(`worker-smoke-run: ${error}\n`);
    }
    return 1;
  }
  emit({ ok: true, plan: result.plan }, options.json);
  return 0;
}

function runGateCheck(options: CliOptions): number {
  const issueBody = readIssueBody(options.issueBodyFile);
  const comments = options.prNumber > 0 ? fetchPrComments(options.prNumber, options.repoRoot) : [];
  const worktree = probeOrcaWorktree(options.cwd);
  const decision = evaluateWorkerSmokeGate({
    issueBody,
    prNumber: options.prNumber,
    headSha: options.headSha,
    prComments: comments,
    ciGreen: options.prNumber > 0 ? resolveCiGreen(options.prNumber, options.headSha, options.repoRoot) : false,
    orcaWorktreeOk: worktree.ok,
    ownedTerminalClosed: true,
  });
  emit({ ok: decision.allowed, ...decision }, options.json);
  return decision.allowed ? 0 : 1;
}

async function runSmokeAttempt(options: CliOptions): Promise<number> {
  const issueBody = readIssueBody(options.issueBodyFile);
  const plan = resolveSmokeRequirement(issueBody);
  if (plan.requirement !== 'required') {
    emit({ ok: true, skipped: true, reason: plan.requirement }, options.json);
    return 0;
  }

  const worktree = probeOrcaWorktree(options.cwd);
  if (!worktree.ok) {
    const blocked: Partial<SmokeReport> = {
      result: 'BLOCKED',
      scenarios: [{ action: 'resolve orca worktree', expected: 'cwd is Orca-managed', observed: worktree.reason ?? 'blocked', outcome: 'blocked' }],
      trackedFilesUnmodified: true,
      terminalCleanup: 'not_started',
      limitations: [],
      environmentNotes: ['orca worktree current failed'],
    };
    const normalized = normalizeSmokeReport(blocked, {
      issueNumber: options.issueNumber,
      prNumber: options.prNumber,
      headSha: options.headSha,
    });
    if (!normalized.ok) {
      fail(normalized.reason);
    }
    const comment = formatSmokeReportComment(normalized.report);
    if (!options.dryRun) {
      publishPrComment(options.prNumber, comment, options.repoRoot);
    }
    emit({ ok: false, report: normalized.report, published: !options.dryRun }, options.json);
    return 1;
  }

  const beforeStatus = gitPorcelain(options.cwd);
  const created = createOrcaTerminal({
    cwd: options.cwd,
    title: `smoke-${options.issueNumber}`,
    command: 'cursor-agent',
  });
  if (!created.ok) {
    fail(created.reason);
  }

  const handle = created.terminal.handle;
  let terminalCleanup = 'pending';
  try {
    const prompt = buildSmokeAgentPrompt({
      issueNumber: options.issueNumber,
      issueBody,
      prNumber: options.prNumber,
      headSha: options.headSha,
      plan,
    });
    const sendResult = sendOrcaTerminal(handle, prompt, { cwd: options.cwd });
    if (!sendResult.ok) {
      fail(sendResult.error?.message ?? 'terminal_send_failed');
    }

    const waitResult = waitOrcaTerminal(handle, {
      for: 'tui-idle',
      timeoutMs: 30 * 60 * 1000,
      cwd: options.cwd,
    });
    if (!waitResult.ok) {
      fail(waitResult.error?.message ?? 'terminal_wait_failed');
    }

    const readResult = readOrcaTerminal(handle, { cwd: options.cwd, limit: 2000 });
    const output = scrubSmokeOutput((readResult.result?.lines ?? []).join('\n'));
    const partial = parseSmokeAgentReport(output);
    const afterStatus = gitPorcelain(options.cwd);
    const mutated = detectTrackedImplementationMutation(beforeStatus, afterStatus);

    if (!partial) {
      fail('smoke agent output missing worker-smoke-report block');
    }

    if (mutated) {
      partial.result = 'FAIL';
      partial.trackedFilesUnmodified = false;
    }

    const normalized = normalizeSmokeReport(partial, {
      issueNumber: options.issueNumber,
      prNumber: options.prNumber,
      headSha: options.headSha,
    });
    if (!normalized.ok && partial.result !== 'FAIL' && partial.result !== 'BLOCKED') {
      fail(normalized.reason);
    }

    const report: SmokeReport = normalized.ok
      ? normalized.report
      : {
          result: partial.result === 'BLOCKED' ? 'BLOCKED' : 'FAIL',
          issueNumber: options.issueNumber,
          prNumber: options.prNumber,
          headSha: options.headSha,
          scenarios: partial.scenarios ?? [],
          limitations: partial.limitations ?? [],
          trackedFilesUnmodified: !mutated,
          terminalCleanup: 'pending',
          environmentNotes: partial.environmentNotes ?? [],
        };

    const comment = formatSmokeReportComment(report);
    if (!options.dryRun) {
      publishPrComment(options.prNumber, comment, options.repoRoot);
    }

    const closeResult = closeOrcaTerminal(handle, { cwd: options.cwd });
    terminalCleanup = closeResult.ok ? 'closed_owned_handle' : `close_failed:${closeResult.error?.code ?? 'unknown'}`;
    report.terminalCleanup = terminalCleanup;

    emit({
      ok: report.result === 'PASS',
      report,
      published: !options.dryRun,
      orcaExecutable: resolveOrcaExecutable(),
      terminalHandle: handle,
    }, options.json);
    return report.result === 'PASS' ? 0 : 1;
  } finally {
    if (terminalCleanup === 'pending') {
      const closeResult = closeOrcaTerminal(handle, { cwd: options.cwd });
      terminalCleanup = closeResult.ok ? 'closed_owned_handle' : `close_failed:${closeResult.error?.code ?? 'unknown'}`;
    }
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  switch (options.command) {
    case 'validate-plan':
      return runValidatePlan(options);
    case 'gate-check':
      return runGateCheck(options);
    case 'run':
      return runSmokeAttempt(options);
    default:
      fail('usage: worker-smoke-run.ts <validate-plan|gate-check|run> [--issue N] [--pr N] [--head-sha SHA] [--issue-body-file path] [--repo-root path] [--cwd path] [--dry-run] [--json]');
  }
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
