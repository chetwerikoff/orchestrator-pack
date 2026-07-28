#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
import { classifyRequiredCiLevel } from '../docs/review-ready-stuck-guard.mjs';
import { runProcessSync } from './kernel/subprocess.ts';
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
  hasPreexistingTrackedDirtiness,
  trackedPorcelainPaths,
  evaluateWorkerSmokeGate,
  findCurrentHeadSmokePass,
  formatSmokeReportComment,
  normalizeSmokeReport,
  ownedSmokeTerminalClosedFromReports,
  parseSmokeAgentReport,
  smokeReportHasPackProducer,
  SMOKE_REPORT_PRODUCER,
  verifySmokeHeadBinding,
  resolveSmokeRequirement,
  scrubSmokeOutput,
  type SmokeReport,
} from './lib/worker-smoke-core.ts';
import { verifySmokeRunReceipt, writeWorkerSmokeReceipt } from './lib/worker-smoke-receipt.ts';

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

function requireProcessOutput(label: string, result: ReturnType<typeof runProcessSync>): string {
  if (!result.ok) {
    fail(`${label}: ${result.stderr || result.error || 'non-zero exit'}`);
  }
  return result.stdout;
}

function gitPorcelain(cwd: string): string[] {
  const output = requireProcessOutput('git status --porcelain', runProcessSync({
    command: 'git',
    args: ['status', '--porcelain'],
    cwd,
  }));
  return output.split(/\r?\n/u).filter(Boolean);
}


function hashTrackedPaths(cwd: string, paths: readonly string[]): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const path of paths) {
    const result = runProcessSync({
      command: 'git',
      args: ['hash-object', path],
      cwd,
    });
    if (result.ok) {
      hashes[path] = result.stdout.trim();
    }
  }
  return hashes;
}

function fetchPrComments(prNumber: number, repoRoot: string): { body?: string }[] {
  const output = requireProcessOutput('pr-issue-comments', runProcessSync({
    command: 'gh',
    args: ['api', `repos/{owner}/{repo}/issues/${prNumber}/comments`, '--paginate'],
    cwd: repoRoot,
  }));
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [];
}

function publishPrComment(prNumber: number, body: string, repoRoot: string): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'worker-smoke-comment-'));
  const bodyFile = join(tempDir, 'body.md');
  try {
    writeFileSync(bodyFile, body, 'utf8');
    requireProcessOutput('gh pr comment', runProcessSync({
      command: 'gh',
      args: ['pr', 'comment', String(prNumber), '--body-file', bodyFile],
      cwd: repoRoot,
    }));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}


function resolveGitHead(cwd: string): string {
  return requireProcessOutput('git rev-parse HEAD', runProcessSync({
    command: 'git',
    args: ['rev-parse', 'HEAD'],
    cwd,
  })).trim().toLowerCase();
}

function resolveCiGreen(prNumber: number, headSha: string, repoRoot: string): boolean {
  const prMetaRaw = requireProcessOutput('pr-view-head-base', runProcessSync({
    command: 'gh',
    args: ['pr', 'view', String(prNumber), '--json', 'headRefOid,baseRefName'],
    cwd: repoRoot,
  }));
  const prMeta = JSON.parse(prMetaRaw) as { headRefOid?: string; baseRefName?: string };
  const normalizedHead = headSha.trim().toLowerCase();
  if ((prMeta.headRefOid ?? '').trim().toLowerCase() !== normalizedHead) {
    return false;
  }
  const checksRaw = requireProcessOutput('required-ci-checks', runProcessSync({
    command: 'gh',
    args: ['pr', 'checks', String(prNumber), '--json', 'name,state,bucket,link,startedAt,completedAt,workflow,description'],
    cwd: repoRoot,
  }));
  const checks = JSON.parse(checksRaw) as { name?: string; state?: string; bucket?: string }[];
  let requiredCheckNames: string[] = [];
  let requiredCheckLookupFailed = false;
  const baseRef = String(prMeta.baseRefName ?? 'main').trim() || 'main';
  const protection = runProcessSync({
    command: 'gh',
    args: ['api', `repos/{owner}/{repo}/branches/${baseRef}/protection/required_status_checks`],
    cwd: repoRoot,
  });
  if (protection.ok) {
    try {
      const parsed = JSON.parse(protection.stdout) as { contexts?: string[] };
      requiredCheckNames = Array.isArray(parsed.contexts) ? parsed.contexts : [];
    } catch {
      requiredCheckLookupFailed = true;
    }
  }
  return classifyRequiredCiLevel(checks, { requiredCheckNames, requiredCheckLookupFailed }) === 'green';
}

function verifyPublishedSmokeProvenance(report: SmokeReport): boolean {
  return smokeReportHasPackProducer(report) && verifySmokeRunReceipt(report);
}

function attachPackProducerFields<T extends Partial<SmokeReport>>(
  report: T,
  input: { terminalHandle?: string; orcaExecutable?: string },
): T {
  return {
    ...report,
    producer: SMOKE_REPORT_PRODUCER,
    orcaExecutable: input.orcaExecutable ?? resolveOrcaExecutable(),
    terminalHandle: input.terminalHandle ?? report.terminalHandle,
  };
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
  const pass = options.prNumber > 0
    ? findCurrentHeadSmokePass(comments, options.prNumber, options.headSha, options.issueNumber)
    : null;
  const decision = evaluateWorkerSmokeGate({
    issueBody,
    issueNumber: options.issueNumber,
    prNumber: options.prNumber,
    headSha: options.headSha,
    prComments: comments,
    ciGreen: options.prNumber > 0 ? resolveCiGreen(options.prNumber, options.headSha, options.repoRoot) : false,
    orcaWorktreeOk: worktree.ok,
    ownedTerminalClosed: options.prNumber > 0
      ? ownedSmokeTerminalClosedFromReports(comments, options.prNumber, options.headSha, options.issueNumber)
      : false,
    terminalProvenanceOk: pass ? verifyPublishedSmokeProvenance(pass) : false,
  });
  emit({ ok: decision.allowed, ...decision }, options.json);
  return decision.allowed ? 0 : 1;
}


function publishSmokeReport(
  report: SmokeReport,
  options: CliOptions,
): void {
  const comment = formatSmokeReportComment(report);
  if (!options.dryRun) {
    publishPrComment(options.prNumber, comment, options.repoRoot);
    writeWorkerSmokeReceipt(report);
  }
}

function buildOperationalSmokeReport(
  result: SmokeReport['result'],
  options: CliOptions,
  input: {
    action: string;
    expected: string;
    observed: string;
    terminalCleanup?: string;
    limitations?: string[];
    environmentNotes?: string[];
    trackedFilesUnmodified?: boolean;
  },
): SmokeReport {
  return {
    result,
    issueNumber: options.issueNumber,
    prNumber: options.prNumber,
    headSha: options.headSha,
    scenarios: [{
      action: input.action,
      expected: input.expected,
      observed: input.observed,
      outcome: result === 'BLOCKED' ? 'blocked' : 'fail',
    }],
    limitations: input.limitations ?? [],
    trackedFilesUnmodified: input.trackedFilesUnmodified ?? true,
    terminalCleanup: input.terminalCleanup ?? 'not_started',
    environmentNotes: input.environmentNotes ?? [],
  };
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
    publishSmokeReport(normalized.report, options);
    emit({ ok: false, report: normalized.report, published: !options.dryRun }, options.json);
    return 1;
  }

  const gitHeadSha = resolveGitHead(options.cwd);
  const headBinding = verifySmokeHeadBinding({
    requestedHeadSha: options.headSha,
    orcaHeadSha: worktree.headSha,
    gitHeadSha,
  });
  if (!headBinding.ok) {
    const blocked: Partial<SmokeReport> = {
      result: 'BLOCKED',
      scenarios: [{
        action: 'bind smoke run to current checkout head',
        expected: `orca/git head equals ${options.headSha}`,
        observed: `${headBinding.reason}:${headBinding.observed}`,
        outcome: 'blocked',
      }],
      trackedFilesUnmodified: true,
      terminalCleanup: 'not_started',
      limitations: [],
      environmentNotes: ['head binding failed'],
    };
    const normalized = normalizeSmokeReport(blocked, {
      issueNumber: options.issueNumber,
      prNumber: options.prNumber,
      headSha: options.headSha,
    });
    if (!normalized.ok) {
      fail(normalized.reason);
    }
    publishSmokeReport(normalized.report, options);
    emit({ ok: false, report: normalized.report, published: !options.dryRun }, options.json);
    return 1;
  }

  const beforeStatus = gitPorcelain(options.cwd);
  if (hasPreexistingTrackedDirtiness(beforeStatus)) {
    const blocked: Partial<SmokeReport> = {
      result: 'BLOCKED',
      scenarios: [{
        action: 'verify clean tracked worktree before smoke',
        expected: 'no pre-existing tracked modifications',
        observed: trackedPorcelainPaths(beforeStatus).join(', ') || 'tracked_dirty',
        outcome: 'blocked',
      }],
      trackedFilesUnmodified: true,
      terminalCleanup: 'not_started',
      limitations: [],
      environmentNotes: ['tracked worktree dirty before smoke launch'],
    };
    const normalized = normalizeSmokeReport(blocked, {
      issueNumber: options.issueNumber,
      prNumber: options.prNumber,
      headSha: options.headSha,
    });
    if (!normalized.ok) {
      fail(normalized.reason);
    }
    publishSmokeReport(normalized.report, options);
    emit({ ok: false, report: normalized.report, published: !options.dryRun }, options.json);
    return 1;
  }
  const beforeHashes = hashTrackedPaths(options.cwd, trackedPorcelainPaths(beforeStatus));
  const created = createOrcaTerminal({
    cwd: options.cwd,
    title: `smoke-${options.issueNumber}`,
    command: 'cursor-agent',
  });
  if (!created.ok) {
    const blocked: Partial<SmokeReport> = {
      result: 'BLOCKED',
      scenarios: [{
        action: 'create Orca smoke terminal',
        expected: 'terminal create succeeds',
        observed: created.reason,
        outcome: 'blocked',
      }],
      trackedFilesUnmodified: true,
      terminalCleanup: 'not_started',
      limitations: [],
      environmentNotes: ['orca terminal create failed'],
    };
    const normalized = normalizeSmokeReport(blocked, {
      issueNumber: options.issueNumber,
      prNumber: options.prNumber,
      headSha: options.headSha,
    });
    if (!normalized.ok) {
      fail(normalized.reason);
    }
    publishSmokeReport(attachPackProducerFields(normalized.report, {}), options);
    emit({ ok: false, report: normalized.report, published: !options.dryRun }, options.json);
    return 1;
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
      const closeResult = closeOrcaTerminal(handle, { cwd: options.cwd });
      terminalCleanup = closeResult.ok ? 'closed_owned_handle' : `close_failed:${closeResult.error?.code ?? 'unknown'}`;
      const report = buildOperationalSmokeReport('BLOCKED', options, {
        action: 'send smoke prompt to Orca terminal',
        expected: 'terminal send succeeds',
        observed: sendResult.error?.message ?? 'terminal_send_failed',
        terminalCleanup,
      });
      publishSmokeReport(report, options);
      emit({ ok: false, report, published: !options.dryRun }, options.json);
      return 1;
    }

    const waitResult = waitOrcaTerminal(handle, {
      for: 'tui-idle',
      timeoutMs: 30 * 60 * 1000,
      cwd: options.cwd,
    });
    if (!waitResult.ok) {
      const closeResult = closeOrcaTerminal(handle, { cwd: options.cwd });
      terminalCleanup = closeResult.ok ? 'closed_owned_handle' : `close_failed:${closeResult.error?.code ?? 'unknown'}`;
      const report = buildOperationalSmokeReport('BLOCKED', options, {
        action: 'wait for smoke agent completion',
        expected: 'terminal wait succeeds',
        observed: waitResult.error?.message ?? 'terminal_wait_failed',
        terminalCleanup,
      });
      publishSmokeReport(report, options);
      emit({ ok: false, report, published: !options.dryRun }, options.json);
      return 1;
    }

    const readResult = readOrcaTerminal(handle, { cwd: options.cwd, limit: 2000 });
    if (!readResult.ok) {
      const closeResult = closeOrcaTerminal(handle, { cwd: options.cwd });
      terminalCleanup = closeResult.ok ? 'closed_owned_handle' : `close_failed:${closeResult.error?.code ?? 'unknown'}`;
      const report = buildOperationalSmokeReport('BLOCKED', options, {
        action: 'read Orca terminal output',
        expected: 'terminal read succeeds',
        observed: readResult.error?.message ?? readResult.error?.code ?? 'terminal_read_failed',
        terminalCleanup,
      });
      publishSmokeReport(report, options);
      emit({ ok: false, report, published: !options.dryRun }, options.json);
      return 1;
    }
    const output = scrubSmokeOutput((readResult.result?.lines ?? []).join('\n'));
    const partial = parseSmokeAgentReport(output);
    const afterStatus = gitPorcelain(options.cwd);
    const afterHashes = hashTrackedPaths(options.cwd, trackedPorcelainPaths(afterStatus));
    const mutated = detectTrackedImplementationMutation(beforeStatus, afterStatus, beforeHashes, afterHashes);

    if (!partial) {
      const closeResult = closeOrcaTerminal(handle, { cwd: options.cwd });
      terminalCleanup = closeResult.ok ? 'closed_owned_handle' : `close_failed:${closeResult.error?.code ?? 'unknown'}`;
      const report = buildOperationalSmokeReport('FAIL', options, {
        action: 'parse smoke agent report',
        expected: 'worker-smoke-report block present',
        observed: 'missing worker-smoke-report block',
        terminalCleanup,
      });
      publishSmokeReport(report, options);
      emit({ ok: false, report, published: !options.dryRun }, options.json);
      return 1;
    }

    if (mutated) {
      partial.result = 'FAIL';
      partial.trackedFilesUnmodified = false;
    }

    const normalized = normalizeSmokeReport(attachPackProducerFields({
      ...partial,
      result: partial.result ?? 'FAIL',
      scenarios: partial.scenarios ?? [],
      limitations: partial.limitations ?? [],
      trackedFilesUnmodified: partial.trackedFilesUnmodified ?? !mutated,
      terminalCleanup: partial.terminalCleanup ?? 'pending',
      environmentNotes: partial.environmentNotes ?? [],
    }, { terminalHandle: handle }), {
      issueNumber: options.issueNumber,
      prNumber: options.prNumber,
      headSha: options.headSha,
    });
    if (!normalized.ok && partial.result !== 'FAIL' && partial.result !== 'BLOCKED') {
      const closeResult = closeOrcaTerminal(handle, { cwd: options.cwd });
      terminalCleanup = closeResult.ok ? 'closed_owned_handle' : `close_failed:${closeResult.error?.code ?? 'unknown'}`;
      const report = attachPackProducerFields(buildOperationalSmokeReport('FAIL', options, {
        action: 'normalize smoke agent report',
        expected: 'valid PASS evidence',
        observed: normalized.reason,
        terminalCleanup,
      }), { terminalHandle: handle });
      publishSmokeReport(report, options);
      emit({ ok: false, report, published: !options.dryRun }, options.json);
      return 1;
    }

    const report: SmokeReport = normalized.ok
      ? attachPackProducerFields(normalized.report, { terminalHandle: handle })
      : attachPackProducerFields({
          result: partial.result === 'BLOCKED' ? 'BLOCKED' : 'FAIL',
          issueNumber: options.issueNumber,
          prNumber: options.prNumber,
          headSha: options.headSha,
          scenarios: partial.scenarios ?? [],
          limitations: partial.limitations ?? [],
          trackedFilesUnmodified: !mutated,
          terminalCleanup: 'pending',
          environmentNotes: partial.environmentNotes ?? [],
        } as SmokeReport, { terminalHandle: handle });

    const closeResult = closeOrcaTerminal(handle, { cwd: options.cwd });
    terminalCleanup = closeResult.ok ? 'closed_owned_handle' : `close_failed:${closeResult.error?.code ?? 'unknown'}`;
    report.terminalCleanup = terminalCleanup;
    if (report.result === 'PASS' && terminalCleanup !== 'closed_owned_handle') {
      report.result = 'FAIL';
      report.scenarios.push({
        action: 'close owned Orca terminal handle',
        expected: 'terminal close succeeds',
        observed: terminalCleanup,
        outcome: 'fail',
      });
    }

    publishSmokeReport(report, options);

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
