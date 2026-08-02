import { readFileSync } from 'node:fs';
import { defaultGhTransport } from './create-issue-stage-record-gh.ts';
import {
  publishSettledStageRecord,
  retryPendingEvents,
  startReviewCycle,
} from './create-issue-stage-record-core.ts';
import { runFinalAcceptance } from './create-issue-final-acceptance.ts';
import {
  inspectAcceptanceArtifacts,
  produceAcceptanceArtifacts,
} from './create-issue-stage-record-artifacts.ts';
import type { PublicActor } from './create-issue-stage-record-types.ts';
import type { ReviewLaneOverride } from './review-lane-selector.ts';
import {
  dispatchDefaultCliArg,
  isDirectCliExecution,
  parseRequiredNonEmptyString,
  parseRequiredPositiveInt,
  runReviewerTsCli,
} from './reviewer-ts-cli.ts';

interface JournalTailCliOptions {
  json: boolean;
  publicActor: PublicActor;
  workdir?: string;
}

interface StageFinalizeCliOptions extends JournalTailCliOptions {
  command: 'start-cycle' | 'publish-stage' | 'retry-pending' | 'produce-artifacts' | 'check-artifacts';
  repo: string;
  issueNumber: number;
  sourceRevision?: string;
  stageAttemptId?: string;
  permittedLaneOverride?: ReviewLaneOverride;
  tier?: string;
  predecessorCycleId?: string;
  receiptPath?: string;
  waiverPath?: string;
  reviewDir?: string;
  outputDir?: string;
  tierIntakePath?: string;
  stageEvidencePaths: string[];
  authorDispositionsPath?: string;
  claudeProducerEvidencePaths: string[];
  phase?: 'pre-lens' | 'final-acceptance';
}

interface FinalAcceptanceCliOptions extends JournalTailCliOptions {
  repo: string;
  issueNumber: number;
  cycleId: string;
  issueBodyPath: string;
  issueRevision: string;
  reviewDir: string;
  stageReceipts: string[];
  capturePaths: string[];
  ledgerPath?: string;
  relayEvidencePaths: string[];
  claudeProducerEvidencePaths: string[];
  externalPassReceiptPath?: string;
}

function finishJournalArgvParse<T extends { json: boolean }>(
  arg: string,
  usage: string,
  opts: T,
): void {
  dispatchDefaultCliArg(arg, usage, () => { opts.json = true; });
}

function applyJournalTailCliArg<T extends JournalTailCliOptions>(
  arg: string,
  argv: string[],
  index: number,
  opts: T,
  usage: string,
): number {
  if (arg === '--public-actor') {
    opts.publicActor = String(argv[index + 1] ?? opts.publicActor) as PublicActor;
    return index + 1;
  }
  if (arg === '--workdir') {
    opts.workdir = String(argv[index + 1] ?? '');
    return index + 1;
  }
  finishJournalArgvParse(arg, usage, opts);
  return index;
}

function finalizeJournalArgvIndex<T extends JournalTailCliOptions>(
  arg: string,
  argv: string[],
  index: number,
  opts: T,
  usage: string,
): number {
  const next = applyJournalTailCliArg(arg, argv, index, opts, usage);
  return next > index ? next : index;
}

function runParsedCli<T>(
  argv: string[],
  toolName: string,
  parseArgs: (argv: string[]) => T,
  run: (opts: T) => number,
): number {
  let opts: T;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${toolName}: ${message}\n`);
    return 2;
  }
  return run(opts);
}

function stageFinalizeUsage(): string {
  return [
    'Usage:',
    '  create-issue-stage-finalize.ts start-cycle --repo <owner/name> --issue-number <n> --source-revision <rNN> --stage-attempt-id <id> --tier <T1|T2|T3> [--permitted-lane-override <normal|disputed>] [--public-actor <actor>] [--predecessor-cycle-id <id>] [--workdir <path>] [--json]',
    '  create-issue-stage-finalize.ts publish-stage --repo <owner/name> --issue-number <n> --receipt <path> [--waiver <path>] [--workdir <path>] [--json]',
    '  create-issue-stage-finalize.ts retry-pending --repo <owner/name> --issue-number <n> [--workdir <path>] [--json]',
    '  create-issue-stage-finalize.ts produce-artifacts --review-dir <path> --tier-intake <path> --stage-evidence <path>... --author-dispositions <path> [--claude-producer-evidence <path>...] [--output-dir <path>] [--phase <pre-lens|final-acceptance>] [--json]',
    '  create-issue-stage-finalize.ts check-artifacts --review-dir <path> --tier-intake <path> --stage-evidence <path>... --author-dispositions <path> [--claude-producer-evidence <path>...] [--output-dir <path>] [--json]',
  ].join('\n');
}

function parseStageFinalizeArgs(argv: string[]): StageFinalizeCliOptions {
  const command = argv[2];
  if (command !== 'start-cycle' && command !== 'publish-stage' && command !== 'retry-pending' && command !== 'produce-artifacts' && command !== 'check-artifacts') {
    throw new Error(`unknown command\n${stageFinalizeUsage()}`);
  }
  const opts: StageFinalizeCliOptions = {
    command,
    repo: 'chetwerikoff/orchestrator-pack',
    issueNumber: 0,
    publicActor: 'cursor-flow-manager',
    json: false,
    stageEvidencePaths: [],
    claudeProducerEvidencePaths: [],
  };
  const artifactCommand = command === 'produce-artifacts' || command === 'check-artifacts';
  const requireArtifactCommand = (arg: string): void => {
    if (!artifactCommand) throw new Error(`${arg} is only valid with produce-artifacts or check-artifacts`);
  };
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--repo':
        opts.repo = String(argv[++i] ?? opts.repo);
        break;
      case '--issue-number':
        opts.issueNumber = Number(argv[++i]);
        break;
      case '--source-revision':
        opts.sourceRevision = String(argv[++i] ?? '');
        break;
      case '--stage-attempt-id':
        opts.stageAttemptId = String(argv[++i] ?? '');
        break;
      case '--permitted-lane-override': {
        const override = String(argv[++i] ?? '');
        if (override !== 'normal' && override !== 'disputed') throw new Error('--permitted-lane-override must be normal or disputed');
        opts.permittedLaneOverride = override;
        break;
      }
      case '--tier':
        opts.tier = String(argv[++i] ?? '');
        break;
      case '--predecessor-cycle-id':
        opts.predecessorCycleId = String(argv[++i] ?? '');
        break;
      case '--receipt':
        opts.receiptPath = String(argv[++i] ?? '');
        break;
      case '--waiver':
        opts.waiverPath = String(argv[++i] ?? '');
        break;
      case '--review-dir':
        requireArtifactCommand(arg);
        opts.reviewDir = String(argv[++i] ?? '');
        break;
      case '--output-dir':
        requireArtifactCommand(arg);
        opts.outputDir = String(argv[++i] ?? '');
        break;
      case '--tier-intake':
        requireArtifactCommand(arg);
        opts.tierIntakePath = String(argv[++i] ?? '');
        break;
      case '--stage-evidence':
        requireArtifactCommand(arg);
        opts.stageEvidencePaths.push(String(argv[++i] ?? ''));
        break;
      case '--author-dispositions':
        requireArtifactCommand(arg);
        opts.authorDispositionsPath = String(argv[++i] ?? '');
        break;
      case '--claude-producer-evidence':
        requireArtifactCommand(arg);
        opts.claudeProducerEvidencePaths.push(String(argv[++i] ?? ''));
        break;
      case '--phase': {
        requireArtifactCommand(arg);
        const phase = String(argv[++i] ?? '');
        if (phase !== 'pre-lens' && phase !== 'final-acceptance') throw new Error('--phase must be pre-lens or final-acceptance');
        opts.phase = phase;
        break;
      }
      default:
        i = finalizeJournalArgvIndex(arg, argv, i, opts, stageFinalizeUsage());
        break;
    }
  }
  return opts;
}

function finalAcceptanceUsage(): string {
  return [
    'Usage:',
    '  create-issue-final-acceptance.ts --repo <owner/name> --issue-number <n> --cycle-id <id> --issue-body <path> --issue-revision <rNN> --review-dir <path> --stage-receipt <path>... [--capture <path>...] [--ledger <path>] [--relay-evidence <path>...] [--claude-producer-evidence <path>...] [--external-pass-receipt <path>] [--public-actor <actor>] [--workdir <path>] [--json]',
  ].join('\n');
}

function parseFinalAcceptanceArgs(argv: string[]): FinalAcceptanceCliOptions {
  const opts: FinalAcceptanceCliOptions = {
    repo: 'chetwerikoff/orchestrator-pack',
    issueNumber: 0,
    cycleId: '',
    issueBodyPath: '',
    issueRevision: '',
    reviewDir: '',
    stageReceipts: [],
    capturePaths: [],
    relayEvidencePaths: [],
    claudeProducerEvidencePaths: [],
    publicActor: 'cursor-flow-manager',
    json: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--repo':
        opts.repo = String(argv[++i] ?? opts.repo);
        break;
      case '--issue-number':
        opts.issueNumber = Number(argv[++i]);
        break;
      case '--cycle-id':
        opts.cycleId = String(argv[++i] ?? '');
        break;
      case '--issue-body':
        opts.issueBodyPath = String(argv[++i] ?? '');
        break;
      case '--issue-revision':
        opts.issueRevision = String(argv[++i] ?? '');
        break;
      case '--review-dir':
        opts.reviewDir = String(argv[++i] ?? '');
        break;
      case '--stage-receipt':
        opts.stageReceipts.push(String(argv[++i] ?? ''));
        break;
      case '--capture':
        opts.capturePaths.push(String(argv[++i] ?? ''));
        break;
      case '--ledger':
        opts.ledgerPath = String(argv[++i] ?? '');
        break;
      case '--relay-evidence':
        opts.relayEvidencePaths.push(String(argv[++i] ?? ''));
        break;
      case '--claude-producer-evidence':
        opts.claudeProducerEvidencePaths.push(String(argv[++i] ?? ''));
        break;
      case '--external-pass-receipt':
        opts.externalPassReceiptPath = String(argv[++i] ?? '');
        break;
      default:
        i = finalizeJournalArgvIndex(arg, argv, i, opts, finalAcceptanceUsage());
        break;
    }
  }
  return opts;
}

export function runStageFinalizeCli(argv: string[]): number {
  return runParsedCli(argv, 'create-issue-stage-finalize', parseStageFinalizeArgs, (opts) => {
    if (opts.command === 'produce-artifacts' || opts.command === 'check-artifacts') {
      const reviewDir = parseRequiredNonEmptyString(opts.reviewDir, '--review-dir');
      const tierIntakePath = parseRequiredNonEmptyString(opts.tierIntakePath, '--tier-intake');
      const authorDispositionsPath = parseRequiredNonEmptyString(opts.authorDispositionsPath, '--author-dispositions');
      const artifactOptions = {
        reviewDir,
        tierIntakePath,
        stageEvidencePaths: opts.stageEvidencePaths,
        authorDispositionsPath,
        claudeProducerEvidencePaths: opts.claudeProducerEvidencePaths,
        outputDir: opts.outputDir,
        phase: opts.phase,
      };
      const result = opts.command === 'produce-artifacts'
        ? produceAcceptanceArtifacts(artifactOptions)
        : inspectAcceptanceArtifacts(artifactOptions);
      if (opts.json) console.log(JSON.stringify(result));
      else if (!result.ok) {
        const messages = 'errors' in result ? result.errors : result.missing.map((item) => item.reason);
        process.stderr.write(`${messages.join('\n')}\n`);
      }
      return result.ok ? 0 : 1;
    }
    const issueNumber = parseRequiredPositiveInt(String(opts.issueNumber || ''), '--issue-number');
    const transport = defaultGhTransport();

    if (opts.command === 'start-cycle') {
      const sourceRevision = parseRequiredNonEmptyString(opts.sourceRevision, '--source-revision');
      const tier = parseRequiredNonEmptyString(opts.tier, '--tier');
      const result = startReviewCycle(transport, {
        repo: opts.repo,
        issueNumber,
        sourceRevision,
        stageAttemptId: parseRequiredNonEmptyString(opts.stageAttemptId, '--stage-attempt-id'),
        permittedLaneOverride: opts.permittedLaneOverride,
        tier,
        publicActor: opts.publicActor,
        predecessorCycleId: opts.predecessorCycleId,
        workdir: opts.workdir,
      });
      if (opts.json) console.log(JSON.stringify(result));
      else if (!result.ok) process.stderr.write(`${result.diagnostics.map((item) => item.message).join('\n')}\n`);
      return result.ok ? 0 : 1;
    }

    if (opts.command === 'publish-stage') {
      const receiptPath = parseRequiredNonEmptyString(opts.receiptPath, '--receipt');
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      const result = publishSettledStageRecord(transport, {
        repo: opts.repo,
        issueNumber,
        receipt,
        waiverPath: opts.waiverPath,
        readJson: (path) => JSON.parse(readFileSync(path, 'utf8')) as unknown,
        workdir: opts.workdir,
      });
      if (opts.json) console.log(JSON.stringify(result));
      else if (!result.ok) process.stderr.write(`${result.diagnostics.map((item) => item.message).join('\n')}\n`);
      return result.ok ? 0 : 1;
    }

    const results = retryPendingEvents(transport, opts.repo, issueNumber, opts.workdir);
    const ok = results.every((item) => item.ok);
    if (opts.json) console.log(JSON.stringify(results));
    return ok ? 0 : 1;
  });
}

export function runFinalAcceptanceCli(argv: string[]): number {
  return runParsedCli(argv, 'create-issue-final-acceptance', parseFinalAcceptanceArgs, (opts) => {
    const issueNumber = parseRequiredPositiveInt(String(opts.issueNumber || ''), '--issue-number');
    const cycleId = parseRequiredNonEmptyString(opts.cycleId, '--cycle-id');
    const issueBodyPath = parseRequiredNonEmptyString(opts.issueBodyPath, '--issue-body');
    const issueRevision = parseRequiredNonEmptyString(opts.issueRevision, '--issue-revision');
    const reviewDir = parseRequiredNonEmptyString(opts.reviewDir, '--review-dir');
    if (opts.stageReceipts.length === 0) {
      process.stderr.write('create-issue-final-acceptance: at least one --stage-receipt is required\n');
      return 2;
    }

    const issueBody = readFileSync(issueBodyPath, 'utf8');
    const transport = defaultGhTransport();
    const result = runFinalAcceptance(transport, {
      repo: opts.repo,
      issueNumber,
      cycleId,
      issueBody,
      issueRevision,
      reviewDir,
      stageReceiptPaths: opts.stageReceipts,
      capturePaths: opts.capturePaths,
      ledgerPath: opts.ledgerPath,
      relayEvidencePaths: opts.relayEvidencePaths,
      claudeProducerEvidencePaths: opts.claudeProducerEvidencePaths,
      externalPassReceiptPath: opts.externalPassReceiptPath,
      publicActor: opts.publicActor,
      workdir: opts.workdir,
    });

    if (opts.json) console.log(JSON.stringify(result));
    else if (!result.ok) {
      for (const error of result.guardErrors) process.stderr.write(`${error}\n`);
      for (const diagnostic of result.diagnostics) process.stderr.write(`${diagnostic.message}\n`);
    }
    return result.ok ? 0 : 1;
  });
}

export function bootstrapCreateIssueCli(
  importMetaUrl: string,
  argvScript: string | undefined,
  runCli: (argv: string[]) => number,
): void {
  const main = (): void => {
    process.exit(runCli(process.argv));
  };
  if (isDirectCliExecution(importMetaUrl, argvScript)) {
    runReviewerTsCli(main);
  }
}
