import { readFileSync } from 'node:fs';
import { defaultGhTransport } from './create-issue-stage-record-gh.ts';
import {
  publishSettledStageRecord,
  retryPendingEvents,
  startReviewCycle,
} from './create-issue-stage-record-core.ts';
import { runFinalAcceptance } from './create-issue-final-acceptance.ts';
import {
  ACCEPTANCE_ARTIFACT_REQUIRED_INPUTS,
  inspectAcceptanceArtifacts,
  produceAcceptanceArtifacts,
} from './create-issue-stage-record-artifacts.ts';
import type { LifecycleReviewStage } from './create-issue-stage-lifecycle.ts';
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
  stage?: LifecycleReviewStage;
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
  operatorIssueNumber?: string;
  operatorSourceRevision?: string;
  operatorVerdictUrl?: string;
  operatorVerdictSha256?: string;
  operatorVerdictByteLength?: string;
  operatorFindingCount?: string;
  operatorReason?: string;
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

type AcceptanceArtifactInputProperty = typeof ACCEPTANCE_ARTIFACT_REQUIRED_INPUTS[number]['property'];

function requiredAcceptanceArtifactInput(
  opts: StageFinalizeCliOptions,
  property: AcceptanceArtifactInputProperty,
): string | string[] {
  const descriptor = ACCEPTANCE_ARTIFACT_REQUIRED_INPUTS.find((item) => item.property === property);
  if (!descriptor) throw new Error(`acceptance artifact input descriptor is missing for ${property}`);
  const value = (opts as unknown as Record<string, unknown>)[descriptor.property];
  if (descriptor.repeatable) {
    if (!Array.isArray(value) || value.length === 0) throw new Error(`${descriptor.flag} is required`);
    return value.map((item) => parseRequiredNonEmptyString(typeof item === 'string' ? item : undefined, descriptor.flag));
  }
  return parseRequiredNonEmptyString(typeof value === 'string' ? value : undefined, descriptor.flag);
}

function operatorAcceptanceAdjudication(opts: StageFinalizeCliOptions) {
  const values = [
    opts.operatorIssueNumber,
    opts.operatorSourceRevision,
    opts.operatorVerdictUrl,
    opts.operatorVerdictSha256,
    opts.operatorVerdictByteLength,
    opts.operatorFindingCount,
    opts.operatorReason,
  ];
  if (values.every((value) => value === undefined)) return undefined;
  if (opts.phase !== 'final-acceptance') {
    throw new Error('operator adjudication requires --phase final-acceptance');
  }
  if (values.some((value) => value === undefined || String(value).trim() === '')) {
    throw new Error('operator adjudication requires Issue, revision, verdict URL/hash/bytes/findings, and reason');
  }
  const issueNumber = Number(opts.operatorIssueNumber);
  const verdictByteLength = Number(opts.operatorVerdictByteLength);
  const verdictFindingCount = Number(opts.operatorFindingCount);
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error('--operator-issue-number must be positive');
  if (!Number.isInteger(verdictByteLength) || verdictByteLength < 0) throw new Error('--operator-verdict-byte-length must be non-negative');
  if (!Number.isInteger(verdictFindingCount) || verdictFindingCount < 0) throw new Error('--operator-finding-count must be non-negative');
  return {
    issueNumber,
    sourceRevision: String(opts.operatorSourceRevision),
    verdictUrl: String(opts.operatorVerdictUrl),
    verdictSha256: String(opts.operatorVerdictSha256),
    verdictByteLength,
    verdictFindingCount,
    reason: String(opts.operatorReason),
  };
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

export function stageFinalizeUsage(): string {
  return [
    'Usage:',
    '  create-issue-stage-finalize.ts start-cycle --repo <owner/name> --issue-number <n> --source-revision <rNN> --stage <competitive|architectural-review|architectural-lens|architectural> --tier <T1|T2|T3> [--stage-attempt-id <retry-id>] [--permitted-lane-override <normal|disputed>] [--public-actor <actor>] [--predecessor-cycle-id <id>] [--workdir <path>] [--json]',
    '  create-issue-stage-finalize.ts publish-stage --repo <owner/name> --issue-number <n> --receipt <path> [--waiver <path>] [--workdir <path>] [--json]',
    '  create-issue-stage-finalize.ts retry-pending --repo <owner/name> --issue-number <n> [--workdir <path>] [--json]',
    `  create-issue-stage-finalize.ts produce-artifacts --review-dir <path> ${ACCEPTANCE_ARTIFACT_REQUIRED_INPUTS.map((input) => `${input.flag} <path>${input.repeatable ? '...' : ''}`).join(' ')} [--claude-producer-evidence <path>...] [--waiver <path>] [--output-dir <path>] [--phase <pre-lens|final-acceptance>] [--operator-issue-number <n> --operator-source-revision <rNN> --operator-verdict-url <url> --operator-verdict-sha256 <hex> --operator-verdict-byte-length <n> --operator-finding-count <n> --operator-reason <text>] [--json]`,
    `  create-issue-stage-finalize.ts check-artifacts --review-dir <path> ${ACCEPTANCE_ARTIFACT_REQUIRED_INPUTS.map((input) => `${input.flag} <path>${input.repeatable ? '...' : ''}`).join(' ')} [--claude-producer-evidence <path>...] [--waiver <path>] [--output-dir <path>] [--json]`,
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
      case '--stage': {
        const stage = String(argv[++i] ?? '');
        if (stage !== 'competitive' && stage !== 'architectural-review' && stage !== 'architectural-lens' && stage !== 'architectural') {
          throw new Error('--stage must be competitive, architectural-review, architectural-lens, or architectural');
        }
        opts.stage = stage;
        break;
      }
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
      case '--operator-issue-number':
        requireArtifactCommand(arg);
        opts.operatorIssueNumber = String(argv[++i] ?? '');
        break;
      case '--operator-source-revision':
        requireArtifactCommand(arg);
        opts.operatorSourceRevision = String(argv[++i] ?? '');
        break;
      case '--operator-verdict-url':
        requireArtifactCommand(arg);
        opts.operatorVerdictUrl = String(argv[++i] ?? '');
        break;
      case '--operator-verdict-sha256':
        requireArtifactCommand(arg);
        opts.operatorVerdictSha256 = String(argv[++i] ?? '');
        break;
      case '--operator-verdict-byte-length':
        requireArtifactCommand(arg);
        opts.operatorVerdictByteLength = String(argv[++i] ?? '');
        break;
      case '--operator-finding-count':
        requireArtifactCommand(arg);
        opts.operatorFindingCount = String(argv[++i] ?? '');
        break;
      case '--operator-reason':
        requireArtifactCommand(arg);
        opts.operatorReason = String(argv[++i] ?? '');
        break;
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
      const tierIntakePath = requiredAcceptanceArtifactInput(opts, 'tierIntakePath') as string;
      const stageEvidencePaths = requiredAcceptanceArtifactInput(opts, 'stageEvidencePaths') as string[];
      const authorDispositionsPath = requiredAcceptanceArtifactInput(opts, 'authorDispositionsPath') as string;
      const artifactOptions = {
        reviewDir,
        tierIntakePath,
        stageEvidencePaths,
        authorDispositionsPath,
        claudeProducerEvidencePaths: opts.claudeProducerEvidencePaths,
        waiverPath: opts.waiverPath,
        outputDir: opts.outputDir,
        phase: opts.phase,
        operatorAdjudication: operatorAcceptanceAdjudication(opts),
        repositoryFullName: opts.repo,
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
      const stage = parseRequiredNonEmptyString(opts.stage, '--stage') as LifecycleReviewStage;
      const result = startReviewCycle(transport, {
        repo: opts.repo,
        issueNumber,
        sourceRevision,
        stage,
        stageAttemptId: opts.stageAttemptId ? parseRequiredNonEmptyString(opts.stageAttemptId, '--stage-attempt-id') : undefined,
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
