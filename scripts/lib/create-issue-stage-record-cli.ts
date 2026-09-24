import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runProcessSync } from '../kernel/subprocess.ts';
import { join, resolve } from 'node:path';
import { defaultGhTransport, fetchIssueRevision } from './create-issue-stage-record-gh.ts';
import {
  publishSettledStageRecord,
  retryPendingEvents,
  semanticStageAttemptId,
  startReviewCycle,
} from './create-issue-stage-record-core.ts';
import { runFinalAcceptance } from './create-issue-final-acceptance.ts';
import {
  ACCEPTANCE_ARTIFACT_REQUIRED_INPUTS,
  bindPublishedCommentToSlot,
  inspectAcceptanceArtifacts,
  inspectLatestGovernedAuthorDisposition,
  produceAcceptanceArtifacts,
  readCanonicalZeroSendTerminal,
  produceAuthorDispositions,
  readEvidenceZeroSendTerminal,
  reconcileCreateIssueStage,
  reconcileStageReadIsRetryable,
  type ZeroSendTerminalObservation,
} from './create-issue-stage-record-artifacts.ts';
import {
  createIssueExternalPauseResult,
  createIssueNextAction,
  createIssueRecoverableResult,
  createIssueStaleNextAction,
  createIssueTerminalResult,
  existingPacedBoundedRetryAction,
  projectBlockedOnToExternalPause,
  projectZeroSendManagerResult,
  validateCreateIssueBlockedOn,
  validateCreateIssueManagerResult,
  type CreateIssueActionBinding,
  type CreateIssueBlockedOn,
  type CreateIssueContractDefectResult,
  type CreateIssueNextAction,
  type CreateIssueZeroSendReason,
} from './create-issue-next-action.ts';
import {
  emitCreateIssueManagerResult,
  type CreateIssueManagerBoundaryProducer,
} from './create-issue-manager-boundary.ts';
import { resolveCanonicalReviewDirectory } from './stage-completeness-core.ts';
import {
  admitStageLaunch,
  composeTerminalBundle,
  inspectLifecycleInvocationBinding,
  loadCanonicalLifecycleAuthority,
  parseLifecycleTierIntake,
  type LifecycleReviewStage,
} from './create-issue-stage-lifecycle.ts';
import { checkTierGateGuard } from './tier-gate-core.ts';
import { checkContractEvidence } from '../contract-evidence-validator.mjs';
import {
  classifyAuthorDispositionFailure,
  renderAuthorDispositionPromptFragment,
  type AuthorDispositionDiagnostic,
} from './create-issue-author-dispositions-schema.ts';
import { isPublicActor, PUBLIC_ACTORS } from './create-issue-stage-record-marker.ts';
import type { GhTransport, PublicActor } from './create-issue-stage-record-types.ts';
import type { ReviewLaneOverride } from './review-lane-selector.ts';
import {
  dispatchDefaultCliArg,
  isDirectCliExecution,
  parseRequiredNonEmptyString,
  parseRequiredPositiveInt,
  runReviewerTsCli,
} from './reviewer-ts-cli.ts';
import {
  inspectManagerCliInvocation,
  renderManagerCliUsage,
  type ManagerCliDeclaration,
} from './manager-cli-contract.ts';

interface JournalTailCliOptions {
  json: boolean;
  publicActor?: PublicActor;
  workdir?: string;
}

interface StageFinalizeCliOptions extends JournalTailCliOptions {
  command: 'start-cycle' | 'author-round' | 'publish-stage' | 'retry-pending' | 'reconcile-stage' | 'bind-published-comment' | 'produce-author-dispositions' | 'produce-artifacts' | 'check-artifacts';
  repo: string;
  issueNumber: number;
  sourceRevision?: string;
  stage?: LifecycleReviewStage;
  stageAttemptId?: string;
  permittedLaneOverride?: ReviewLaneOverride;
  tier?: string;
  competitiveDecision?: 'required' | 'skipped';
  competitiveRationale?: string;
  predecessorCycleId?: string;
  receiptPath?: string;
  waiverPath?: string;
  reviewDir?: string;
  outputDir?: string;
  tierIntakePath?: string;
  stageEvidencePaths: string[];
  authorDispositionsPath?: string;
  claudeProducerEvidencePaths: string[];
  phase?: 'pre-lens' | 'post-lens' | 'final-acceptance';
  operatorIssueNumber?: string;
  operatorSourceRevision?: string;
  operatorVerdictUrl?: string;
  operatorVerdictSha256?: string;
  operatorVerdictByteLength?: string;
  operatorFindingCount?: string;
  operatorReason?: string;
  commentUrl?: string;
  invocationId?: string;
  reviewerSlot?: string;
  expectedSourceRevision?: string;
  expectedStage?: LifecycleReviewStage;
  expectedStageAttemptId?: string;
  blockedOn?: CreateIssueBlockedOn;
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
  operatorIssueNumber?: string;
  operatorSourceRevision?: string;
  operatorVerdictUrl?: string;
  operatorVerdictSha256?: string;
  operatorVerdictByteLength?: string;
  operatorFindingCount?: string;
  operatorReason?: string;
}

export interface AuthorRoundRunnerInput {
  repository: string;
  issueNumber: number;
  sourceRevision: string;
  stage: LifecycleReviewStage;
  stageAttemptId?: string;
  reviewDir: string;
  prompt: string;
  promptPath: string;
  outputPath: string;
}

export interface AuthorRoundRunnerResult {
  ok: boolean;
  blocker?: string;
}

export type AuthorRoundRunner = (input: AuthorRoundRunnerInput) => AuthorRoundRunnerResult;

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
    const token = argv[index + 1] ?? '';
    if (!isPublicActor(token)) {
      throw new Error(
        `--public-actor must be one of ${[...PUBLIC_ACTORS].join(', ')}; received "${token}"`,
      );
    }
    opts.publicActor = token;
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
  const requiredMessage = `${descriptor.flag} is required; ${descriptor.classification}: record/provide the observed ${descriptor.file} via ${descriptor.flag}`;
  if (descriptor.repeatable) {
    if (!Array.isArray(value) || value.length === 0) throw new Error(requiredMessage);
    return value.map((item) => {
      const parsed = typeof item === 'string' ? item.trim() : '';
      if (!parsed) throw new Error(requiredMessage);
      return parsed;
    });
  }
  const parsed = typeof value === 'string' ? value.trim() : '';
  if (!parsed) throw new Error(requiredMessage);
  return parsed;
}

function operatorAcceptanceAdjudication(opts: {
  phase?: StageFinalizeCliOptions['phase'];
  operatorIssueNumber?: string;
  operatorSourceRevision?: string;
  operatorVerdictUrl?: string;
  operatorVerdictSha256?: string;
  operatorVerdictByteLength?: string;
  operatorFindingCount?: string;
  operatorReason?: string;
}) {
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

function parseBlockedOnJson(raw: string): CreateIssueBlockedOn {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('--blocked-on-json must be valid JSON');
  }
  const errors = validateCreateIssueBlockedOn(value);
  if (errors.length > 0) {
    throw new Error('--blocked-on-json is invalid: ' + errors.join('; '));
  }
  return value as CreateIssueBlockedOn;
}

function appendBlockedOnArgv(argv: string[], blockedOn?: CreateIssueBlockedOn): string[] {
  if (blockedOn) argv.push('--blocked-on-json', JSON.stringify(blockedOn));
  return argv;
}

function emitManagerBoundary(
  producer: CreateIssueManagerBoundaryProducer,
  argv: readonly string[],
  result: unknown,
): number {
  return emitCreateIssueManagerResult({
    producer,
    currentArgv: argv,
    produce: () => result,
  }).exitCode;
}

function emitFinalAcceptanceBoundary(
  argv: readonly string[],
  result: unknown,
): number {
  const evaluation = emitCreateIssueManagerResult({
    producer: 'create-issue-final-acceptance',
    currentArgv: argv,
    produce: () => result,
  });
  return evaluation.exitCode;
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
    const command = argv[2] ?? '';
    const managerShaped = argv.includes('--blocked-on-json')
      || argv.includes('--expected-source-revision')
      || argv.includes('--expected-stage')
      || argv.includes('--expected-stage-attempt-id')
      || (command === 'start-cycle' && argv.includes('--tier'));
    // Bare/incomplete library CLI syntax keeps the historical usage error.
    // Once manager intent is explicit, malformed producer input is a boundary
    // contract defect and therefore exits 5.
    if (!managerShaped) return 2;
    return emitCreateIssueManagerResult({
      producer: toolName,
      currentArgv: argv,
      produce: () => { throw error; },
    }).exitCode;
  }
  try {
    return run(opts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(message + '\n');
    const evaluation = emitCreateIssueManagerResult({
      producer: toolName,
      currentArgv: argv,
      produce: () => { throw error; },
    });
    return evaluation.exitCode;
  }
}

export function stageFinalizeUsage(): string {
  return [
    'Usage:',
    `  create-issue-stage-finalize.ts start-cycle --repo <owner/name> --issue-number <n> --source-revision <rNN> --stage <competitive|architectural-review|architectural-lens|architectural> --tier <T1|T2|T3> [--competitive-decision <required|skipped> --competitive-rationale <text>] [--stage-attempt-id <retry-id>] [--permitted-lane-override <normal|disputed>] [--public-actor <${[...PUBLIC_ACTORS].join('|')}>] [--predecessor-cycle-id <id>] [--workdir <path>] [--expected-source-revision <rNN> --expected-stage <stage> --expected-stage-attempt-id <id>] [--json]`,
    '  create-issue-stage-finalize.ts author-round --repo <owner/name> --issue-number <n> --review-dir <canonical-review-dir> --expected-source-revision <rNN> --expected-stage <stage> [--expected-stage-attempt-id <settled-id>] [--json]',
    '  create-issue-stage-finalize.ts publish-stage --repo <owner/name> --issue-number <n> --receipt <path> [--waiver <path>] [--workdir <path>] [--json]',
    '  create-issue-stage-finalize.ts retry-pending --repo <owner/name> --issue-number <n> [--workdir <path>] [--expected-source-revision <rNN> --expected-stage <stage> --expected-stage-attempt-id <id>] [--json]',
    '  create-issue-stage-finalize.ts reconcile-stage --repo <owner/name> --issue-number <n> --review-dir <path> --stage-evidence <attempt-NNN.json> [--json]',
    '  create-issue-stage-finalize.ts bind-published-comment --repo <owner/name> --issue-number <n> --review-dir <path> --stage-evidence <attempt-NNN.json> --reviewer-slot <slot> --invocation-id <id> --comment-url <url> [--json]',
    '  create-issue-stage-finalize.ts produce-author-dispositions --repo <owner/name> --issue-number <n> --review-dir <path> --source-revision <rNN> [--json]',
    '  create-issue-stage-finalize.ts produce-artifacts --review-dir <path> [--tier-intake <path>] [--stage-evidence <path>...] [--author-dispositions <target-path>] [--claude-producer-evidence <path>...] [--waiver <path>] [--output-dir <path>] [--phase <pre-lens|post-lens|final-acceptance>] [--operator-issue-number <n> --operator-source-revision <rNN> --operator-verdict-url <url> --operator-verdict-sha256 <hex> --operator-verdict-byte-length <n> --operator-finding-count <n> --operator-reason <text>] [--json]',
    '  create-issue-stage-finalize.ts check-artifacts --review-dir <path> [--tier-intake <path>] [--stage-evidence <path>...] [--author-dispositions <derived-path>] [--claude-producer-evidence <path>...] [--waiver <path>] [--output-dir <path>] [--json]',
    '  manager-result commands additionally accept --blocked-on-json <json> only for a coordinator/task-dispatch authoritative active-unsatisfied-blocker assertion',
  ].join('\n');
}

export function parseStageFinalizeArgs(argv: string[]): StageFinalizeCliOptions {
  const command = argv[2];
  if (command !== 'start-cycle' && command !== 'author-round' && command !== 'publish-stage' && command !== 'retry-pending' && command !== 'reconcile-stage' && command !== 'bind-published-comment' && command !== 'produce-author-dispositions' && command !== 'produce-artifacts' && command !== 'check-artifacts') {
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
  const artifactCommand = command === 'reconcile-stage' || command === 'bind-published-comment' || command === 'produce-artifacts' || command === 'check-artifacts';
  const reviewDirCommand = artifactCommand || command === 'author-round' || command === 'produce-author-dispositions';
  const boundActionCommand = artifactCommand || command === 'start-cycle' || command === 'author-round' || command === 'retry-pending';
  const requireArtifactCommand = (arg: string): void => {
    if (!artifactCommand) throw new Error(`${arg} is only valid with reconcile-stage, produce-artifacts, or check-artifacts`);
  };
  const requireBoundActionCommand = (arg: string): void => {
    if (!boundActionCommand) throw new Error(`${arg} is only valid with a state-bound create-Issue action command`);
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
        if (command === 'author-round') throw new Error('--source-revision is not valid with author-round; use --expected-source-revision');
        opts.sourceRevision = String(argv[++i] ?? '');
        break;
      case '--stage': {
        if (command === 'author-round') throw new Error('--stage is not valid with author-round; use --expected-stage');
        const stage = String(argv[++i] ?? '');
        if (stage !== 'competitive' && stage !== 'architectural-review' && stage !== 'architectural-lens' && stage !== 'architectural') {
          throw new Error('--stage must be competitive, architectural-review, architectural-lens, or architectural');
        }
        opts.stage = stage;
        break;
      }
      case '--stage-attempt-id':
        if (command === 'author-round') throw new Error('--stage-attempt-id is not valid with author-round; use --expected-stage-attempt-id');
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
      case '--competitive-decision': {
        const decision = String(argv[++i] ?? '');
        if (decision !== 'required' && decision !== 'skipped') throw new Error('--competitive-decision must be required or skipped');
        opts.competitiveDecision = decision;
        break;
      }
      case '--competitive-rationale':
        opts.competitiveRationale = String(argv[++i] ?? '');
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
      case '--comment-url':
        if (command !== 'bind-published-comment') throw new Error(`${arg} is only valid with bind-published-comment`);
        opts.commentUrl = String(argv[++i] ?? '');
        break;
      case '--invocation-id':
        if (command !== 'bind-published-comment') throw new Error(`${arg} is only valid with bind-published-comment`);
        opts.invocationId = String(argv[++i] ?? '');
        break;
      case '--reviewer-slot':
        if (command !== 'bind-published-comment') throw new Error(`${arg} is only valid with bind-published-comment`);
        opts.reviewerSlot = String(argv[++i] ?? '');
        break;
      case '--review-dir':
        if (!reviewDirCommand) throw new Error(`${arg} is only valid with a review-directory command`);
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
        if (phase !== 'pre-lens' && phase !== 'post-lens' && phase !== 'final-acceptance') throw new Error('--phase must be pre-lens, post-lens, or final-acceptance');
        opts.phase = phase;
        break;
      }
      case '--blocked-on-json':
        if (command === 'bind-published-comment' || command === 'produce-author-dispositions') throw new Error('--blocked-on-json is not valid with this command');
        if (opts.blockedOn) throw new Error('--blocked-on-json may be supplied only once');
        opts.blockedOn = parseBlockedOnJson(String(argv[++i] ?? ''));
        break;
      case '--expected-source-revision':
        requireBoundActionCommand(arg);
        opts.expectedSourceRevision = String(argv[++i] ?? '');
        break;
      case '--expected-stage': {
        requireBoundActionCommand(arg);
        const expectedStage = String(argv[++i] ?? '');
        if (expectedStage !== 'competitive' && expectedStage !== 'architectural-review' && expectedStage !== 'architectural-lens' && expectedStage !== 'architectural') {
          throw new Error('--expected-stage is invalid');
        }
        opts.expectedStage = expectedStage;
        break;
      }
      case '--expected-stage-attempt-id':
        requireBoundActionCommand(arg);
        opts.expectedStageAttemptId = String(argv[++i] ?? '');
        break;
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

const CREATE_ISSUE_FINAL_ACCEPTANCE_CLI_DECLARATION = {
  program: 'create-issue-final-acceptance',
  options: [
    { flag: '--repo', value: 'owner/name' },
    { flag: '--issue-number', value: 'n' },
    { flag: '--cycle-id', value: 'id' },
    { flag: '--issue-body', value: 'path' },
    { flag: '--issue-revision', value: 'revision' },
    { flag: '--review-dir', value: 'path' },
    { flag: '--stage-receipt', value: 'path', repeatable: true },
    { flag: '--capture', value: 'path', repeatable: true },
    { flag: '--ledger', value: 'path' },
    { flag: '--relay-evidence', value: 'path', repeatable: true },
    { flag: '--claude-producer-evidence', value: 'path', repeatable: true },
    { flag: '--external-pass-receipt', value: 'path' },
    { flag: '--operator-issue-number', value: 'n' },
    { flag: '--operator-source-revision', value: 'revision' },
    { flag: '--operator-verdict-url', value: 'url' },
    { flag: '--operator-verdict-sha256', value: 'hex' },
    { flag: '--operator-verdict-byte-length', value: 'n' },
    { flag: '--operator-finding-count', value: 'n' },
    { flag: '--operator-reason', value: 'text' },
    { flag: '--public-actor', value: 'actor', required: true, values: [...PUBLIC_ACTORS] },
    { flag: '--workdir', value: 'path' },
    { flag: '--json' },
  ],
} as const satisfies ManagerCliDeclaration;


function finalAcceptanceUsage(): string {
  return renderManagerCliUsage(CREATE_ISSUE_FINAL_ACCEPTANCE_CLI_DECLARATION);
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
      case '--operator-issue-number':
        opts.operatorIssueNumber = String(argv[++i] ?? '');
        break;
      case '--operator-source-revision':
        opts.operatorSourceRevision = String(argv[++i] ?? '');
        break;
      case '--operator-verdict-url':
        opts.operatorVerdictUrl = String(argv[++i] ?? '');
        break;
      case '--operator-verdict-sha256':
        opts.operatorVerdictSha256 = String(argv[++i] ?? '');
        break;
      case '--operator-verdict-byte-length':
        opts.operatorVerdictByteLength = String(argv[++i] ?? '');
        break;
      case '--operator-finding-count':
        opts.operatorFindingCount = String(argv[++i] ?? '');
        break;
      case '--operator-reason':
        opts.operatorReason = String(argv[++i] ?? '');
        break;
      default:
        i = finalizeJournalArgvIndex(arg, argv, i, opts, finalAcceptanceUsage());
        break;
    }
  }
  return opts;
}


function artifactIssueNumber(opts: StageFinalizeCliOptions, reviewDir: string): number {
  if (Number.isSafeInteger(opts.issueNumber) && opts.issueNumber > 0) return opts.issueNumber;
  const intakePath = opts.tierIntakePath?.trim() || join(reviewDir, 'tier-intake.json');
  try {
    const intake = JSON.parse(readFileSync(intakePath, 'utf8')) as Record<string, unknown>;
    const match = /^issue:([1-9][0-9]*)$/.exec(String(intake.taskIdentity ?? ''));
    if (match) return Number(match[1]);
  } catch {
    // fall through to the ordinary required-argument diagnostic
  }
  return parseRequiredPositiveInt(String(opts.issueNumber || ''), '--issue-number or tier-intake.taskIdentity');
}

function canonicalAttemptPaths(reviewDir: string, requested: readonly string[]): string[] {
  if (requested.length > 0) return [...requested];
  try {
    return readdirSync(reviewDir)
      .filter((name) => /^attempt-[0-9]{3}\.json$/.test(name))
      .sort()
      .map((name) => join(reviewDir, name));
  } catch {
    return [];
  }
}

function artifactBindingFromState(
  opts: StageFinalizeCliOptions,
  reviewDir: string,
  issueNumber: number,
  transport: GhTransport = defaultGhTransport(),
): CreateIssueActionBinding | null {
  let liveRevision = '';
  try {
    const live = fetchIssueRevision(transport, opts.repo, issueNumber);
    liveRevision = /<!--\s*source-revision:\s*(r[0-9]+)\s*-->/i.exec(live.body)?.[1] ?? '';
  } catch {
    return null;
  }
  const candidates = canonicalAttemptPaths(reviewDir, opts.stageEvidencePaths)
    .flatMap((path) => {
      try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        const rawStage = value.stage;
        if (rawStage !== 'competitive' && rawStage !== 'architectural-review' && rawStage !== 'architectural-lens' && rawStage !== 'architectural') return [];
        const stage: LifecycleReviewStage = rawStage;
        const sequence = Number(value.stageSequence);
        const attempt = typeof value.stageAttemptId === 'string' ? value.stageAttemptId : '';
        const revision = typeof value.sourceRevision === 'string' ? value.sourceRevision : '';
        return Number.isInteger(sequence) && attempt && revision
          ? [{ sequence, stage, attempt, revision }]
          : [];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.sequence - left.sequence);
  const latest = candidates[0];
  if (!latest || !liveRevision) return null;
  return {
    repository: opts.repo,
    issueNumber,
    sourceRevision: liveRevision,
    stage: latest.stage,
    stageAttemptId: latest.attempt,
  };
}


function artifactCommandArgv(
  command: 'produce-artifacts' | 'check-artifacts',
  opts: StageFinalizeCliOptions,
  reviewDir: string,
  issueNumber: number,
  binding: CreateIssueActionBinding,
): string[] {
  const argv = [
    'node', '--experimental-strip-types', 'scripts/create-issue-stage-finalize.ts',
    command,
    '--repo', opts.repo,
    '--issue-number', String(issueNumber),
    '--review-dir', reviewDir,
    '--phase', opts.phase ?? 'final-acceptance',
    '--expected-source-revision', binding.sourceRevision,
    '--expected-stage', binding.stage,
    '--expected-stage-attempt-id', binding.stageAttemptId ?? '',
    '--json',
  ];
  for (const path of opts.stageEvidencePaths) argv.push('--stage-evidence', path);
  for (const path of opts.claudeProducerEvidencePaths) argv.push('--claude-producer-evidence', path);
  if (opts.waiverPath) argv.push('--waiver', opts.waiverPath);
  if (opts.outputDir) argv.push('--output-dir', opts.outputDir);
  return appendBlockedOnArgv(argv, opts.blockedOn);
}

function evidencePathForBinding(
  reviewDir: string,
  binding: CreateIssueActionBinding,
): string | undefined {
  if (!existsSync(reviewDir)) return undefined;
  for (const name of readdirSync(reviewDir).sort()) {
    if (!name.endsWith('.json')) continue;
    const path = join(reviewDir, name);
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      if (
        value.sourceRevision === binding.sourceRevision
        && value.stage === binding.stage
        && (binding.stageAttemptId === undefined || value.stageAttemptId === binding.stageAttemptId)
      ) return path;
    } catch {
      // Read-only reconciliation ignores unrelated or malformed JSON here; the owning
      // evidence producer will classify it when that file is authoritative.
    }
  }
  return undefined;
}

function reconcileStageReadOnlyAction(
  opts: Pick<StageFinalizeCliOptions, 'repo' | 'blockedOn'>,
  issueNumber: number,
  binding: CreateIssueActionBinding,
  reviewDir?: string,
  stageEvidencePath?: string,
): CreateIssueNextAction {
  const argv = [
    'node', '--experimental-strip-types', 'scripts/create-issue-stage-finalize.ts',
    'reconcile-stage',
    '--repo', opts.repo,
    '--issue-number', String(issueNumber),
    '--expected-source-revision', binding.sourceRevision,
    '--expected-stage', binding.stage,
    ...(binding.stageAttemptId ? ['--expected-stage-attempt-id', binding.stageAttemptId] : []),
    '--json',
  ];
  if (reviewDir) argv.push('--review-dir', reviewDir);
  if (stageEvidencePath) argv.push('--stage-evidence', stageEvidencePath);
  return createIssueNextAction({
    kind: 'reconcile-stage-read-only',
    binding,
    argv: appendBlockedOnArgv(argv, opts.blockedOn),
  });
}

function staleArtifactBinding(
  opts: StageFinalizeCliOptions,
  reviewDir: string,
  issueNumber: number,
  transport: GhTransport = defaultGhTransport(),
): ReturnType<typeof createIssueStaleNextAction> | null {
  if (!opts.expectedSourceRevision && !opts.expectedStage && !opts.expectedStageAttemptId) return null;
  if (!opts.expectedSourceRevision || !opts.expectedStage || !opts.expectedStageAttemptId) {
    throw new Error('expected action binding requires revision, stage, and stage-attempt-id together');
  }
  const expected: CreateIssueActionBinding = {
    repository: opts.repo,
    issueNumber,
    sourceRevision: opts.expectedSourceRevision,
    stage: opts.expectedStage,
    stageAttemptId: opts.expectedStageAttemptId,
  };
  const observed = artifactBindingFromState(opts, reviewDir, issueNumber, transport);
  if (observed
    && observed.repository.toLowerCase() === expected.repository.toLowerCase()
    && observed.issueNumber === expected.issueNumber
    && observed.sourceRevision.toLowerCase() === expected.sourceRevision.toLowerCase()
    && observed.stage === expected.stage
    && observed.stageAttemptId === expected.stageAttemptId) {
    return null;
  }
  const stageEvidencePath = opts.stageEvidencePaths[0] ?? evidencePathForBinding(reviewDir, expected);
  return createIssueStaleNextAction({
    binding: expected,
    observed: observed ?? {
      repository: opts.repo,
      issueNumber,
    },
    nextAction: reconcileStageReadOnlyAction(opts, issueNumber, expected, reviewDir, stageEvidencePath),
  });
}


function zeroSendTerminalProjection(
  observation: ZeroSendTerminalObservation,
  repository: string,
  issueNumber: number,
  reconcileAction: CreateIssueNextAction,
): { cause: string; blocker?: string; reason?: CreateIssueZeroSendReason; nextAction: CreateIssueNextAction | null; pause?: unknown; stageAttemptId?: string } | null {
  if (
    observation.stage !== 'competitive'
    && observation.stage !== 'architectural-review'
    && observation.stage !== 'architectural-lens'
    && observation.stage !== 'architectural'
  ) return null;
  const binding: CreateIssueActionBinding = {
    repository,
    issueNumber,
    sourceRevision: observation.sourceRevision,
    stage: observation.stage,
    stageAttemptId: observation.stageAttemptId,
  };
  const projected = projectZeroSendManagerResult({
    policy: observation.policy,
    attemptOrdinal: observation.attemptOrdinal,
    binding,
    invocationId: observation.invocationId,
    reviewerSlot: observation.reviewerSlot,
    owned_prompt_seen: observation.owned_prompt_seen,
    observed_user_heads: observation.observed_user_heads,
    pacedRetryAction: existingPacedBoundedRetryAction(binding, observation.reviewerSlot),
    reconcileAction,
  });
  return projected ? { ...projected, stageAttemptId: observation.stageAttemptId } : null;
}

function validatedManagerSurfaceOutput<T extends { ok: boolean }>(
  result: T,
  failureCause: string,
  nextAction: CreateIssueNextAction | null,
  blocker?: string,
  reason?: CreateIssueZeroSendReason,
  blockedOn?: CreateIssueBlockedOn,
): T & Record<string, unknown> {
  if (!result.ok && blockedOn) {
    return projectBlockedOnToExternalPause(blockedOn) as unknown as T & Record<string, unknown>;
  }
  const output = result.ok
    ? { ...result, cause: 'completed', nextAction: null }
    : nextAction
      ? {
          ...result,
          cause: failureCause,
          ...(blocker ? { blocker } : {}),
          ...(reason ? { reason } : {}),
          nextAction,
        }
      : null;
  if (!output) {
    throw new Error(`manager_result_without_recovery:${failureCause}:${blocker ?? ''}`);
  }
  const errors = validateCreateIssueManagerResult(output);
  if (errors.length > 0) throw new Error('invalid create-Issue manager result: ' + errors.join('; '));
  return output as T & Record<string, unknown>;
}

function stageDiagnosticBlocker(result: { diagnostics?: Array<{ message?: string }> }): string | undefined {
  const messages = (result.diagnostics ?? []).map((item) => item.message ?? '').filter(Boolean);
  return messages.length > 0 ? messages.join('; ') : undefined;
}

function stageReceiptActionBinding(
  repo: string,
  issueNumber: number,
  receipt: unknown,
): CreateIssueActionBinding | null {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  const value = receipt as Record<string, unknown>;
  const stage = value.stage;
  if (stage !== 'competitive' && stage !== 'architectural-review' && stage !== 'architectural-lens' && stage !== 'architectural') return null;
  const sourceRevision = typeof value.sourceRevision === 'string' ? value.sourceRevision : '';
  const stageAttemptId = typeof value.stageAttemptId === 'string' ? value.stageAttemptId : '';
  if (!/^r[0-9]+$/i.test(sourceRevision) || !stageAttemptId) return null;
  return { repository: repo, issueNumber, sourceRevision, stage, stageAttemptId };
}

function retryPendingActionArgv(
  opts: StageFinalizeCliOptions,
  issueNumber: number,
  binding: CreateIssueActionBinding,
): string[] {
  const argv = [
    'node', '--experimental-strip-types', 'scripts/create-issue-stage-finalize.ts',
    'retry-pending',
    '--repo', opts.repo,
    '--issue-number', String(issueNumber),
    '--expected-source-revision', binding.sourceRevision,
    '--expected-stage', binding.stage,
    '--expected-stage-attempt-id', binding.stageAttemptId ?? '',
    '--json',
  ];
  if (opts.workdir) argv.push('--workdir', opts.workdir);
  return appendBlockedOnArgv(argv, opts.blockedOn);
}

function poisonSuccessorStartCycleArgv(
  opts: StageFinalizeCliOptions,
  issueNumber: number,
  binding: CreateIssueActionBinding,
  tier: string,
): string[] {
  const argv = [
    'node', '--experimental-strip-types', 'scripts/create-issue-stage-finalize.ts',
    'start-cycle',
    '--repo', opts.repo,
    '--issue-number', String(issueNumber),
    '--source-revision', binding.sourceRevision,
    '--stage', binding.stage,
    '--stage-attempt-id', binding.stageAttemptId ?? '',
    '--tier', tier,
    '--expected-source-revision', binding.sourceRevision,
    '--expected-stage', binding.stage,
    '--expected-stage-attempt-id', binding.stageAttemptId ?? '',
    '--json',
  ];
  if (opts.publicActor) argv.push('--public-actor', opts.publicActor);
  if (opts.competitiveDecision) argv.push('--competitive-decision', opts.competitiveDecision);
  if (opts.competitiveRationale) argv.push('--competitive-rationale', opts.competitiveRationale);
  if (opts.permittedLaneOverride) argv.push('--permitted-lane-override', opts.permittedLaneOverride);
  if (opts.workdir) argv.push('--workdir', opts.workdir);
  return appendBlockedOnArgv(argv, opts.blockedOn);
}

function startCycleRetryArgv(
  opts: StageFinalizeCliOptions,
  issueNumber: number,
  binding: CreateIssueActionBinding,
): string[] {
  const argv = [
    'node', '--experimental-strip-types', 'scripts/create-issue-stage-finalize.ts',
    'start-cycle',
    '--repo', opts.repo,
    '--issue-number', String(issueNumber),
    '--source-revision', binding.sourceRevision,
    '--stage', binding.stage,
    '--stage-attempt-id', binding.stageAttemptId ?? '',
    '--tier', String(opts.tier ?? ''),
    '--expected-source-revision', binding.sourceRevision,
    '--expected-stage', binding.stage,
    '--expected-stage-attempt-id', binding.stageAttemptId ?? '',
    '--json',
  ];
  if (opts.competitiveDecision) argv.push('--competitive-decision', opts.competitiveDecision);
  if (opts.competitiveRationale) argv.push('--competitive-rationale', opts.competitiveRationale);
  if (opts.permittedLaneOverride) argv.push('--permitted-lane-override', opts.permittedLaneOverride);
  if (opts.predecessorCycleId) argv.push('--predecessor-cycle-id', opts.predecessorCycleId);
  if (opts.publicActor) argv.push('--public-actor', opts.publicActor);
  if (opts.workdir) argv.push('--workdir', opts.workdir);
  return appendBlockedOnArgv(argv, opts.blockedOn);
}

function staleStartCycleBinding(
  opts: StageFinalizeCliOptions,
  issueNumber: number,
  transport: GhTransport = defaultGhTransport(),
): ReturnType<typeof createIssueStaleNextAction> | null {
  if (!opts.expectedSourceRevision && !opts.expectedStage && !opts.expectedStageAttemptId) return null;
  if (!opts.expectedSourceRevision || !opts.expectedStage) {
    throw new Error('expected start-cycle binding requires revision and stage');
  }
  const expected: CreateIssueActionBinding = {
    repository: opts.repo,
    issueNumber,
    sourceRevision: opts.expectedSourceRevision,
    stage: opts.expectedStage,
    ...(opts.expectedStageAttemptId ? { stageAttemptId: opts.expectedStageAttemptId } : {}),
  };
  let liveRevision = '';
  try {
    const live = fetchIssueRevision(transport, opts.repo, issueNumber);
    liveRevision = /<!--\s*source-revision:\s*(r[0-9]+)\s*-->/i.exec(live.body)?.[1] ?? '';
  } catch {
    const canonical = resolveCanonicalReviewDirectory({ taskIdentity: 'issue:' + issueNumber });
    return createIssueStaleNextAction({
      binding: expected,
      observed: { repository: opts.repo, issueNumber },
      nextAction: reconcileStageReadOnlyAction(
        opts,
        issueNumber,
        expected,
        canonical.directory,
        evidencePathForBinding(canonical.directory, expected),
      ),
    });
  }
  const observed: CreateIssueActionBinding = {
    repository: opts.repo,
    issueNumber,
    sourceRevision: liveRevision,
    stage: opts.stage ?? opts.expectedStage,
    ...(opts.stageAttemptId ? { stageAttemptId: opts.stageAttemptId } : {}),
  };
  if (expected.repository.toLowerCase() === observed.repository.toLowerCase()
    && expected.issueNumber === observed.issueNumber
    && expected.sourceRevision.toLowerCase() === observed.sourceRevision.toLowerCase()
    && expected.stage === observed.stage
    && (expected.stageAttemptId === undefined || expected.stageAttemptId === observed.stageAttemptId)) {
    return null;
  }
  const canonical = resolveCanonicalReviewDirectory({ taskIdentity: 'issue:' + issueNumber });
  return createIssueStaleNextAction({
    binding: expected,
    observed,
    nextAction: reconcileStageReadOnlyAction(
      opts,
      issueNumber,
      expected,
      canonical.directory,
      evidencePathForBinding(canonical.directory, expected),
    ),
  });
}

function staleRetryPendingBinding(
  opts: StageFinalizeCliOptions,
  issueNumber: number,
  transport: GhTransport = defaultGhTransport(),
): ReturnType<typeof createIssueStaleNextAction> | null {
  if (!opts.expectedSourceRevision && !opts.expectedStage && !opts.expectedStageAttemptId) return null;
  if (!opts.expectedSourceRevision || !opts.expectedStage || !opts.expectedStageAttemptId) {
    throw new Error('expected retry-pending binding requires revision, stage, and stage-attempt-id');
  }
  const expected: CreateIssueActionBinding = {
    repository: opts.repo,
    issueNumber,
    sourceRevision: opts.expectedSourceRevision,
    stage: opts.expectedStage,
    stageAttemptId: opts.expectedStageAttemptId,
  };
  const canonical = resolveCanonicalReviewDirectory({ taskIdentity: 'issue:' + issueNumber });
  const observed = artifactBindingFromState({ ...opts, stageEvidencePaths: [] }, canonical.directory, issueNumber, transport);
  if (observed
    && observed.repository.toLowerCase() === expected.repository.toLowerCase()
    && observed.issueNumber === expected.issueNumber
    && observed.sourceRevision.toLowerCase() === expected.sourceRevision.toLowerCase()
    && observed.stage === expected.stage
    && observed.stageAttemptId === expected.stageAttemptId) {
    return null;
  }
  return createIssueStaleNextAction({
    binding: expected,
    observed: observed ?? { repository: opts.repo, issueNumber },
    nextAction: reconcileStageReadOnlyAction(
      opts,
      issueNumber,
      expected,
      canonical.directory,
      evidencePathForBinding(canonical.directory, expected),
    ),
  });
}


function issueSourceRevision(body: string): string {
  const matches = [...body.matchAll(/<!--\s*source-revision:\s*(r[0-9]+)\s*-->/gi)];
  return matches.length === 1 && matches[0]?.[1] ? matches[0][1] : '';
}

function bodyFloorDiagnostics(body: string, tier?: string): string[] {
  const errors: string[] = [];
  const tierResult = checkTierGateGuard(body, {
    ...(tier ? { tier } : {}),
    repoRoot: process.cwd(),
  });
  if (!tierResult.ok) {
    errors.push(...tierResult.errors.map((item) => 'tier-gate: ' + item));
  }
  const contractResult = checkContractEvidence(body, { repoRoot: process.cwd() }) as {
    ok: boolean;
    errors: string[];
    skipped?: boolean;
  };
  if (!contractResult.ok && !contractResult.skipped) {
    errors.push(...contractResult.errors.map((item) => 'contract-evidence: ' + item));
  }
  return [...new Set(errors)];
}

function canonicalAuthorRoundDirectory(issueNumber: number): string {
  return resolveCanonicalReviewDirectory({ taskIdentity: 'issue:' + issueNumber }).directory;
}

function preMintAuthorRoundAction(
  binding: CreateIssueActionBinding,
  reviewDir: string,
 ): CreateIssueNextAction {
  const argv = [
    'node', '--experimental-strip-types', 'scripts/create-issue-stage-finalize.ts',
    'author-round',
    '--repo', binding.repository,
    '--issue-number', String(binding.issueNumber),
    '--review-dir', reviewDir,
    '--expected-source-revision', binding.sourceRevision,
    '--expected-stage', binding.stage,
  ];
  if (binding.stageAttemptId) argv.push('--expected-stage-attempt-id', binding.stageAttemptId);
  argv.push('--json');
  return createIssueNextAction({ kind: 'author-round', binding, argv });
}

function existingAttemptForStage(
  reviewDir: string,
  stage: LifecycleReviewStage,
): { stageAttemptId: string; sourceRevision: string } | null {
  const candidates = canonicalAttemptPaths(reviewDir, []).flatMap((path) => {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      if (value.stage !== stage) return [];
      const stageAttemptId = typeof value.stageAttemptId === 'string' ? value.stageAttemptId : '';
      const sourceRevision = typeof value.sourceRevision === 'string' ? value.sourceRevision : '';
      return stageAttemptId && sourceRevision ? [{ stageAttemptId, sourceRevision }] : [];
    } catch {
      return [];
    }
  });
  return candidates.at(-1) ?? null;
}

function nextAuthorReplyPaths(reviewDir: string): {
  round: number;
  promptPath: string;
  outputPath: string;
} {
  let maximum = 0;
  if (existsSync(reviewDir)) {
    for (const name of readdirSync(reviewDir)) {
      const match = /^round-([0-9]+)-author-reply\.(?:md|txt)$/.exec(name);
      if (match?.[1]) maximum = Math.max(maximum, Number(match[1]));
    }
  }
  const round = maximum + 1;
  const token = String(round).padStart(2, '0');
  return {
    round,
    promptPath: join(reviewDir, `round-${token}-author-prompt.txt`),
    outputPath: join(reviewDir, `round-${token}-author-reply.txt`),
  };
}

function authorRoundPrompt(input: {
  repository: string;
  issueNumber: number;
  sourceRevision: string;
  stage: LifecycleReviewStage;
  stageAttemptId?: string;
  repairClass: 'body-floor' | 'author-schema';
  diagnostics: readonly string[];
  schemaFragment: string;
}): string {
  const issueUrl = `https://github.com/${input.repository}/issues/${input.issueNumber}`;
  const repairInstruction = input.repairClass === 'body-floor'
    ? [
        'This is a pre-mint Issue-body repair. Edit only the target Issue title/body as needed to satisfy every diagnostic below.',
        'If Issue bytes change, advance the source-revision marker exactly once. Do not create a review cycle, stage attempt, PR, label, milestone, or unrelated mutation.',
        'After authoritative Issue read-back, return one governed author payload for the resulting revision with findings: [] and m4.inventory: [].',
      ]
    : [
        'This is a pure governed author-output/schema repair for an already-settled stage.',
        'Do not edit the Issue title/body and do not change its source revision.',
        'Return a corrected governed author payload for the same revision and the same settled stage evidence. Do not create/reopen a reviewer stage or stage attempt.',
      ];
  return [
    `Role: author for ${input.repository}.`,
    'Mode: revise-existing-issue.',
    `Authoritative input: live Issue ${issueUrl}; expected revision: ${input.sourceRevision}.`,
    '',
    'Read the live target through GitHub. Follow the canonical create-issue-draft role boundary.',
    ...repairInstruction,
    '',
    `Bound semantic stage: ${input.stage}${input.stageAttemptId ? `; settled stageAttemptId: ${input.stageAttemptId}` : '; no stageAttemptId exists yet'}.`,
    '',
    'Current validation diagnostics (all must be addressed; do not invent replacements):',
    ...input.diagnostics.map((item) => '- ' + item),
    '',
    input.schemaFragment,
    '',
    'Output only the whole-line schema label followed by the JSON payload. The Markdown fence is optional.',
    'Never include or fabricate an OPKTURNV1 transport marker.',
  ].join('\n');
}

function defaultAuthorRoundRunner(input: AuthorRoundRunnerInput): AuthorRoundRunnerResult {
  const profile = process.env.DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR?.trim() ?? '';
  const projectUrl = process.env.DISCUSS_WITH_GPT_PROJECT_URL?.trim() ?? '';
  const cdp = process.env.CDP_ENDPOINT?.trim() ?? '';
  if (!profile || !projectUrl || !cdp) {
    return {
      ok: false,
      blocker: 'Browser-GPT author-round requires DISCUSS_WITH_GPT_CHROME_USER_DATA_DIR, DISCUSS_WITH_GPT_PROJECT_URL, and the existing CDP_ENDPOINT shell binding',
    };
  }
  mkdirSync(input.reviewDir, { recursive: true });
  writeFileSync(input.promptPath, input.prompt, { encoding: 'utf8', flag: 'wx' });
  const invocationId = randomUUID();
  const runIdentity = 'author-round-' + randomUUID();
  const attemptIdentity = 'author-round-attempt-' + randomUUID();
  const handoffReceipt = join(input.reviewDir, `.author-round-${invocationId}.handoff.json`);
  const terminalEnvelope = join(input.reviewDir, `.author-round-${invocationId}.terminal.json`);
  const child = runProcessSync({
    command: process.execPath,
    args: [
      '--experimental-strip-types',
      'scripts/flow-manager-browser-gpt-long-run.ts',
      '--run-identity', runIdentity,
      '--attempt-identity', attemptIdentity,
      '--invocation-id', invocationId,
      '--handoff-receipt', handoffReceipt,
      '--terminal-envelope', terminalEnvelope,
      '--output', input.outputPath,
      '--profile', profile,
      '--cdp', cdp,
      '--input', input.promptPath,
      '--new-chat',
      '--project-url', projectUrl,
    ],
    cwd: process.cwd(),
    env: { OPK_FM_LONG_CHILD_DISABLE_DETACH: '1' },
    inheritParentEnv: true,
    encoding: 'utf8',
    timeoutMs: 20 * 60 * 1000,
  });
  if (!child.ok || !existsSync(input.outputPath)) {
    return {
      ok: false,
      blocker: (child.error || child.stderr || child.stdout || `Browser-GPT author round exited ${String(child.exitCode)}`).trim(),
    };
  }
  return { ok: true };
}

function authorSchemaDiagnostics(
  reviewDir: string,
): { diagnostics: AuthorDispositionDiagnostic[]; schemaFragment: string } {
  const inspection = inspectLatestGovernedAuthorDisposition(reviewDir);
  if (!inspection) {
    return {
      diagnostics: [{
        reason: 'missing_schema_label',
        ownership: 'author-owned',
        field: 'schema-label',
        message: 'no governed round-NN-author-reply.* exists for the current author correction',
      }],
      schemaFragment: renderAuthorDispositionPromptFragment(),
    };
  }
  return {
    diagnostics: inspection.diagnostics,
    schemaFragment: inspection.schemaFragment,
  };
}

function authorRoundPhase(stage: LifecycleReviewStage): 'pre-lens' | 'post-lens' | 'final-acceptance' {
  if (stage === 'architectural') return 'final-acceptance';
  if (stage === 'architectural-lens') return 'post-lens';
  return 'pre-lens';
}

function nextRevision(revision: string): string | null {
  const match = /^r([0-9]+)$/i.exec(revision);
  if (!match?.[1]) return null;
  const width = match[1].length;
  return 'r' + String(Number(match[1]) + 1).padStart(width, '0');
}

export function runStageFinalizeCli(
  argv: string[],
  artifactSourceTransport?: GhTransport,
  authorRoundRunner?: AuthorRoundRunner,
): number {
  return runParsedCli(argv, 'create-issue-stage-finalize', parseStageFinalizeArgs, (opts) => {
    if (opts.command === 'produce-author-dispositions') {
      const issueNumber = parseRequiredPositiveInt(String(opts.issueNumber || ''), '--issue-number');
      const reviewDir = parseRequiredNonEmptyString(opts.reviewDir, '--review-dir');
      const sourceRevision = parseRequiredNonEmptyString(opts.sourceRevision, '--source-revision');
      const result = produceAuthorDispositions({
        reviewDir,
        repositoryFullName: opts.repo,
        issueNumber,
        sourceRevision,
        ...(artifactSourceTransport ? { artifactSourceTransport } : {}),
      });
      if (opts.json) console.log(JSON.stringify(result));
      else if (!result.ok) process.stderr.write(result.errors.join('\n') + '\n');
      return result.ok ? 0 : 1;
    }
    const transport = artifactSourceTransport ?? defaultGhTransport();

    if (opts.command === 'author-round') {
      const issueNumber = parseRequiredPositiveInt(String(opts.issueNumber || ''), '--issue-number');
      const reviewDir = parseRequiredNonEmptyString(opts.reviewDir, '--review-dir');
      const canonicalReviewDir = canonicalAuthorRoundDirectory(issueNumber);
      if (resolve(reviewDir) !== resolve(canonicalReviewDir)) {
        const output: CreateIssueContractDefectResult = {
          ok: false,
          cause: 'producer_contract_defect',
          defect: {
            producer: 'create-issue-stage-record-cli.ts:main',
            detail: [`author-round requires canonical review directory ${canonicalReviewDir}`],
          },
          nextAction: null,
        };
        return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, output);
      }
      const expectedSourceRevision = parseRequiredNonEmptyString(
        opts.expectedSourceRevision,
        '--expected-source-revision',
      );
      const expectedStage = parseRequiredNonEmptyString(
        opts.expectedStage,
        '--expected-stage',
      ) as LifecycleReviewStage;
      const binding: CreateIssueActionBinding = {
        repository: opts.repo,
        issueNumber,
        sourceRevision: expectedSourceRevision,
        stage: expectedStage,
        ...(opts.expectedStageAttemptId
          ? { stageAttemptId: parseRequiredNonEmptyString(opts.expectedStageAttemptId, '--expected-stage-attempt-id') }
          : {}),
      };

      let live;
      try {
        live = fetchIssueRevision(transport, opts.repo, issueNumber);
      } catch (error) {
        const evidence = error instanceof Error ? error.message : String(error);
        const output = createIssueExternalPauseResult({
          cause: 'external:github_unavailable',
          remedy: 'restore GitHub Issue reads, then resume this same Dispatch',
          resumeWhen: { operator: true },
          evidence,
          blocker: evidence,
        });
        return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, output);
      }
      const liveRevision = issueSourceRevision(live.body);
      if (liveRevision.toLowerCase() !== expectedSourceRevision.toLowerCase()) {
        const stale = createIssueStaleNextAction({
          binding,
          observed: {
            repository: opts.repo,
            issueNumber,
            ...(liveRevision ? { sourceRevision: liveRevision } : {}),
            stage: expectedStage,
          },
          nextAction: reconcileStageReadOnlyAction(opts, issueNumber, binding, reviewDir),
        });
        return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, stale);
      }

      let repairClass: 'body-floor' | 'author-schema';
      let diagnostics: string[];
      let schemaFragment = renderAuthorDispositionPromptFragment();

      if (binding.stageAttemptId) {
        const observed = artifactBindingFromState(
          { ...opts, stageEvidencePaths: [] },
          reviewDir,
          issueNumber,
          transport,
        );
        if (!observed
          || observed.repository.toLowerCase() !== binding.repository.toLowerCase()
          || observed.issueNumber !== binding.issueNumber
          || observed.sourceRevision.toLowerCase() !== binding.sourceRevision.toLowerCase()
          || observed.stage !== binding.stage
          || observed.stageAttemptId !== binding.stageAttemptId) {
          const stale = createIssueStaleNextAction({
            binding,
            observed: observed ?? { repository: opts.repo, issueNumber, sourceRevision: liveRevision },
            nextAction: reconcileStageReadOnlyAction(opts, issueNumber, binding, reviewDir),
          });
          return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, stale);
        }
        repairClass = 'author-schema';
        const inspected = authorSchemaDiagnostics(reviewDir);
        if (inspected.diagnostics.length > 0) {
          schemaFragment = inspected.schemaFragment;
          diagnostics = inspected.diagnostics.map(
            (item) => `${item.reason}:${item.field}: ${item.message}`,
          );
        } else {
          const validation = produceAcceptanceArtifacts({
            reviewDir,
            tierIntakePath: join(reviewDir, 'tier-intake.json'),
            stageEvidencePaths: [],
            authorDispositionsPath: join(reviewDir, 'author-dispositions.json'),
            outputDir: reviewDir,
            phase: authorRoundPhase(expectedStage),
            repositoryFullName: opts.repo,
            artifactSourceTransport: transport,
          });
          if (validation.ok) {
            const output = createIssueTerminalResult({
              ok: true,
              cause: 'author_round_not_required',
            });
            return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, output);
          }
          const lifecycleOwned = validation.errors.some(
            (error) => classifyAuthorDispositionFailure(error) === 'lifecycle-injected',
          );
          const authorDiagnostics = validation.authorDiagnostics ?? [];
          if (lifecycleOwned || authorDiagnostics.length === 0) {
            const output = createIssueRecoverableResult({
              cause: lifecycleOwned
                ? 'author_round_lifecycle_validation_failed'
                : 'author_round_non_author_failure',
              blocker: validation.errors.join('; '),
              nextAction: reconcileStageReadOnlyAction(opts, issueNumber, binding, reviewDir),
            });
            return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, output);
          }
          schemaFragment = validation.authorSchemaFragment ?? renderAuthorDispositionPromptFragment();
          diagnostics = authorDiagnostics.map(
            (item) => `${item.reason}:${item.field}: ${item.message}`,
          );
        }
      } else {
        const existing = existingAttemptForStage(reviewDir, expectedStage);
        if (existing) {
          const stale = createIssueStaleNextAction({
            binding,
            observed: {
              repository: opts.repo,
              issueNumber,
              sourceRevision: liveRevision,
              stage: expectedStage,
              stageAttemptId: existing.stageAttemptId,
            },
            nextAction: reconcileStageReadOnlyAction(opts, issueNumber, binding, reviewDir),
          });
          return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, stale);
        }
        repairClass = 'body-floor';
        diagnostics = bodyFloorDiagnostics(live.body);
        if (diagnostics.length === 0) {
          const output = createIssueTerminalResult({
            ok: true,
            cause: 'author_round_not_required',
          });
          return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, output);
        }
      }

      const paths = nextAuthorReplyPaths(reviewDir);
      mkdirSync(reviewDir, { recursive: true });
      const prompt = authorRoundPrompt({
        repository: opts.repo,
        issueNumber,
        sourceRevision: expectedSourceRevision,
        stage: expectedStage,
        stageAttemptId: binding.stageAttemptId,
        repairClass,
        diagnostics,
        schemaFragment,
      });
      const runner = authorRoundRunner ?? defaultAuthorRoundRunner;
      const launched = runner({
        repository: opts.repo,
        issueNumber,
        sourceRevision: expectedSourceRevision,
        stage: expectedStage,
        stageAttemptId: binding.stageAttemptId,
        reviewDir,
        prompt,
        promptPath: paths.promptPath,
        outputPath: paths.outputPath,
      });
      if (!launched.ok) {
        const evidence = launched.blocker ?? 'Browser-GPT author round failed without a diagnostic';
        const output = createIssueExternalPauseResult({
          cause: 'external:chrome_not_running',
          remedy: 'restore the Browser-GPT transport, then resume this same Dispatch',
          resumeWhen: { operator: true },
          evidence,
          blocker: evidence,
        });
        return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, output);
      }
      if (!existsSync(paths.outputPath)) {
        const evidence = `Browser-GPT author round did not publish ${paths.outputPath}`;
        return emitManagerBoundary(
          'create-issue-stage-record-cli.ts:main',
          argv,
          createIssueRecoverableResult({
            cause: 'author_round_output_missing',
            blocker: evidence,
            nextAction: reconcileStageReadOnlyAction(opts, issueNumber, binding, reviewDir),
          }),
        );
      }

      const after = fetchIssueRevision(transport, opts.repo, issueNumber);
      const afterRevision = issueSourceRevision(after.body);
      if (repairClass === 'body-floor') {
        const expectedNext = nextRevision(expectedSourceRevision);
        const floorErrors = bodyFloorDiagnostics(after.body);
        if (!expectedNext || afterRevision.toLowerCase() !== expectedNext.toLowerCase() || floorErrors.length > 0) {
          const output = createIssueRecoverableResult({
            cause: 'author_round_body_floor_unresolved',
            blocker: [
              `expected exactly one revision advance ${expectedSourceRevision} -> ${expectedNext ?? '<invalid>'}; observed ${afterRevision || '<missing>'}`,
              ...floorErrors,
            ].join('; '),
            nextAction: reconcileStageReadOnlyAction(opts, issueNumber, binding, reviewDir),
          });
          return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, output);
        }
      } else {
        if (afterRevision.toLowerCase() !== expectedSourceRevision.toLowerCase()) {
          const stale = createIssueStaleNextAction({
            binding,
            observed: {
              repository: opts.repo,
              issueNumber,
              sourceRevision: afterRevision,
              stage: expectedStage,
              stageAttemptId: binding.stageAttemptId,
            },
            nextAction: reconcileStageReadOnlyAction(opts, issueNumber, binding, reviewDir),
          });
          return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, stale);
        }
        const inspected = authorSchemaDiagnostics(reviewDir);
        if (inspected.diagnostics.length > 0) {
          const output = createIssueRecoverableResult({
            cause: 'author_round_schema_unresolved',
            blocker: inspected.diagnostics
              .map((item) => `${item.reason}:${item.field}: ${item.message}`)
              .join('; '),
            nextAction: reconcileStageReadOnlyAction(opts, issueNumber, binding, reviewDir),
          });
          return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, output);
        }
        const produced = produceAcceptanceArtifacts({
          reviewDir,
          tierIntakePath: join(reviewDir, 'tier-intake.json'),
          stageEvidencePaths: [],
          authorDispositionsPath: join(reviewDir, 'author-dispositions.json'),
          outputDir: reviewDir,
          phase: authorRoundPhase(expectedStage),
          repositoryFullName: opts.repo,
          artifactSourceTransport: transport,
        });
        if (!produced.ok) {
          const lifecycleOwned = produced.errors.some(
            (error) => classifyAuthorDispositionFailure(error) === 'lifecycle-injected',
          );
          const output = createIssueRecoverableResult({
            cause: lifecycleOwned
              ? 'author_round_lifecycle_validation_failed'
              : 'author_round_post_validation_failed',
            blocker: produced.errors.join('; '),
            nextAction: reconcileStageReadOnlyAction(opts, issueNumber, binding, reviewDir),
          });
          return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, output);
        }
      }

      const output = createIssueTerminalResult({
        ok: true,
        cause: 'author_round_completed',
      });
      const completedOutput = {
        ...output,
        authorRound: {
          repairClass,
          round: paths.round,
          replyPath: paths.outputPath,
          sourceRevision: repairClass === 'body-floor' ? afterRevision : expectedSourceRevision,
          stage: expectedStage,
          ...(binding.stageAttemptId ? { stageAttemptId: binding.stageAttemptId } : {}),
        },
      };
      return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, completedOutput);
    }

    if (opts.command === 'bind-published-comment') {
      const issueNumber = parseRequiredPositiveInt(String(opts.issueNumber || ''), '--issue-number');
      const reviewDir = parseRequiredNonEmptyString(opts.reviewDir, '--review-dir');
      if (opts.stageEvidencePaths.length !== 1) {
        throw new Error('bind-published-comment requires exactly one --stage-evidence');
      }
      const stageEvidencePath = parseRequiredNonEmptyString(opts.stageEvidencePaths[0], '--stage-evidence');
      const reviewerSlot = parseRequiredNonEmptyString(opts.reviewerSlot, '--reviewer-slot');
      const invocationId = parseRequiredNonEmptyString(opts.invocationId, '--invocation-id');
      const commentUrl = parseRequiredNonEmptyString(opts.commentUrl, '--comment-url');
      const result = bindPublishedCommentToSlot({
        reviewDir,
        stageEvidencePath,
        repositoryFullName: opts.repo,
        issueNumber,
        reviewerSlot,
        invocationId,
        commentUrl,
      });
      const binding = artifactBindingFromState(opts, reviewDir, issueNumber);
      const nextAction = !result.ok && binding
        ? reconcileStageReadOnlyAction(opts, issueNumber, binding, reviewDir, stageEvidencePath)
        : null;
      const output = validatedManagerSurfaceOutput(
        result,
        'published_comment_binding_failed',
        nextAction,
        result.ok ? undefined : result.errors.join('; '),
        undefined,
        opts.blockedOn,
      );
      if (!result.ok) process.stderr.write(result.errors.join('\n') + '\n');
      return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, output);
    }
    if (opts.command === 'reconcile-stage') {
      const issueNumber = parseRequiredPositiveInt(String(opts.issueNumber || ''), '--issue-number');

      if (opts.stageEvidencePaths.length === 0) {
        if (!opts.expectedSourceRevision || !opts.expectedStage) {
          throw new Error('binding-only reconcile-stage requires --expected-source-revision and --expected-stage');
        }
        const live = fetchIssueRevision(defaultGhTransport(), opts.repo, issueNumber);
        const liveRevision = /<!--\s*source-revision:\s*(r[0-9]+)\s*-->/i.exec(live.body)?.[1];
        if (!liveRevision) {
          const paused = createIssueExternalPauseResult({
            cause: 'external:content_authority_conflict',
            remedy: 'restore the canonical source-revision marker on the live Issue, then resume this same Dispatch',
            resumeWhen: { operator: true },
            evidence: 'live Issue has no canonical source-revision marker',
          });
          return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, paused);
        }
        const canonical = resolveCanonicalReviewDirectory({ taskIdentity: 'issue:' + issueNumber });
        const stage = opts.expectedStage;
        const canonicalAttemptId = semanticStageAttemptId(opts.repo, issueNumber, stage);
        const binding: CreateIssueActionBinding = {
          repository: opts.repo,
          issueNumber,
          sourceRevision: liveRevision,
          stage,
          stageAttemptId: canonicalAttemptId,
        };
        const reconcileAction = (): CreateIssueNextAction => {
          const evidencePath = evidencePathForBinding(canonical.directory, binding);
          return reconcileStageReadOnlyAction(
            opts,
            issueNumber,
            binding,
            canonical.directory,
            evidencePath,
          );
        };
        const reconcile = (blocker: string): number => {
          process.stderr.write(blocker + '\n');
          return emitManagerBoundary(
            'create-issue-stage-record-cli.ts:main',
            argv,
            createIssueRecoverableResult({
              cause: 'repository_invariant_requires_reconciliation',
              blocker,
              nextAction: reconcileAction(),
            }),
          );
        };
        let authority: ReturnType<typeof loadCanonicalLifecycleAuthority>;
        try {
          authority = loadCanonicalLifecycleAuthority(issueNumber);
        } catch (error) {
          return reconcile(error instanceof Error ? error.message : String(error));
        }
        const intake = parseLifecycleTierIntake(authority.intake);
        if (!intake) {
          return reconcile('canonical tier-intake/v1 is missing or malformed');
        }
        const admissionInput = {
          issueNumber,
          tier: intake.priorTier,
          stage,
          sourceRevision: liveRevision,
          issueBody: live.body,
          intake,
          receiptValues: authority.receiptValues,
        };
        let admission = admitStageLaunch(admissionInput);
        if (admission.code === 'terminal_bundle_unavailable' && admission.intake) {
          try {
            const terminalBundle = composeTerminalBundle({
              reviewDir: authority.reviewDir,
              reviewEpisodeId: `${admission.intake.taskIdentity}@${admission.intake.firstRevision}`,
              sourceRevision: liveRevision,
              predecessorStage: admission.predecessorStage ?? null,
              issueBody: live.body,
            });
            admission = admitStageLaunch({ ...admissionInput, terminalBundle });
          } catch (error) {
            return reconcile(error instanceof Error ? error.message : String(error));
          }
        }
        if (!admission.ok) {
          return reconcile(admission.message ?? 'stage lifecycle admission refused retry');
        }
        let lifecycleBinding;
        try {
          lifecycleBinding = inspectLifecycleInvocationBinding({
            issueNumber,
            stage,
            stageAttemptId: canonicalAttemptId,
            sourceRevision: liveRevision,
          });
        } catch (error) {
          return reconcile(error instanceof Error ? error.message : String(error));
        }
        const observedAttemptId = lifecycleBinding.observed.stageAttemptId;
        const noRecordedAttempt = !lifecycleBinding.ok
          && observedAttemptId === undefined
          && /observed 0$/.test(lifecycleBinding.message ?? '');
        if (!lifecycleBinding.ok && !noRecordedAttempt) {
          return reconcile(lifecycleBinding.message ?? 'lifecycle stage binding is not admissible');
        }
        const retryOpts = { ...opts, tier: intake.priorTier };
        const output = createIssueRecoverableResult({
          cause: 'reconciliation_failed',
          blocker: `readonly reconciliation admitted live source revision ${liveRevision}`,
          nextAction: createIssueNextAction({
            kind: 'retry-start-cycle',
            binding,
            argv: startCycleRetryArgv(retryOpts, issueNumber, binding),
          }),
        });
        return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, output);
      }
      const reviewDir = parseRequiredNonEmptyString(opts.reviewDir, '--review-dir');
      if (opts.stageEvidencePaths.length !== 1) {
        throw new Error('reconcile-stage requires exactly one --stage-evidence');
      }
      const stageEvidencePath = parseRequiredNonEmptyString(opts.stageEvidencePaths[0], '--stage-evidence');
      const deterministicTerminal = readEvidenceZeroSendTerminal(stageEvidencePath);
      if (deterministicTerminal?.policy.class === 'deterministic-input') {
        const deterministicBinding: CreateIssueActionBinding = {
          repository: opts.repo,
          issueNumber,
          sourceRevision: deterministicTerminal.sourceRevision,
          stage: deterministicTerminal.stage as LifecycleReviewStage,
          stageAttemptId: deterministicTerminal.stageAttemptId,
        };
        const projected = zeroSendTerminalProjection(
          deterministicTerminal,
          opts.repo,
          issueNumber,
          reconcileStageReadOnlyAction(opts, issueNumber, deterministicBinding, reviewDir, stageEvidencePath),
        );
        if (projected) {
          return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, projected);
        }
      }
      const stale = staleArtifactBinding(opts, reviewDir, issueNumber, transport);
      if (stale) {
        return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, stale);
      }
      const result = reconcileCreateIssueStage({
        reviewDir,
        stageEvidencePath,
        repositoryFullName: opts.repo,
        issueNumber,
        ...(artifactSourceTransport ? { artifactSourceTransport } : {}),
      });
      const obsoleteIssueRevisionError = result.errors.find((error) =>
        /^stale_next_action: live Issue revision is (r[0-9]+), expected (r[0-9]+)$/.test(error),
      );
      const obsoleteIssueRevision = obsoleteIssueRevisionError
        ? /^stale_next_action: live Issue revision is (r[0-9]+), expected (r[0-9]+)$/.exec(obsoleteIssueRevisionError)
        : null;
      if (obsoleteIssueRevision && result.stage && result.stageAttemptId && result.sourceRevision) {
        process.stderr.write(result.errors.join('\n') + '\n');
        const binding: CreateIssueActionBinding = {
          repository: opts.repo,
          issueNumber,
          sourceRevision: result.sourceRevision,
          stage: result.stage,
          stageAttemptId: result.stageAttemptId,
        };
        const observed = createIssueStaleNextAction({
          binding,
          observed: {
            repository: opts.repo,
            issueNumber,
            sourceRevision: obsoleteIssueRevision[1]!,
            stage: result.stage,
            stageAttemptId: result.stageAttemptId,
          },
          nextAction: reconcileStageReadOnlyAction(opts, issueNumber, binding, reviewDir, stageEvidencePath),
        });
        return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, observed);
      }
      let nextAction = null;
      if (result.stage && result.stageAttemptId && result.sourceRevision) {
        const binding: CreateIssueActionBinding = {
          repository: opts.repo,
          issueNumber,
          sourceRevision: result.sourceRevision,
          stage: result.stage,
          stageAttemptId: result.stageAttemptId,
        };
        const reconcileArgv = [
          'node', '--experimental-strip-types', 'scripts/create-issue-stage-finalize.ts',
          'reconcile-stage',
          '--repo', opts.repo,
          '--issue-number', String(issueNumber),
          '--review-dir', reviewDir,
          '--stage-evidence', stageEvidencePath,
          '--expected-source-revision', result.sourceRevision,
          '--expected-stage', result.stage,
          '--expected-stage-attempt-id', result.stageAttemptId,
          '--json',
        ];
        appendBlockedOnArgv(reconcileArgv, opts.blockedOn);
        const retryableRead = reconcileStageReadIsRetryable(result);
        if (result.ok) {
          nextAction = createIssueNextAction({
            kind: 'produce-acceptance-artifacts',
            binding,
            argv: appendBlockedOnArgv([
              'node', '--experimental-strip-types', 'scripts/create-issue-stage-finalize.ts',
              'produce-artifacts',
              '--repo', opts.repo,
              '--issue-number', String(issueNumber),
              '--review-dir', reviewDir,
              '--stage-evidence', stageEvidencePath,
              '--phase', result.stage === 'architectural' ? 'final-acceptance' : 'pre-lens',
              '--expected-source-revision', result.sourceRevision,
              '--expected-stage', result.stage,
              '--expected-stage-attempt-id', result.stageAttemptId,
              '--json',
            ], opts.blockedOn),
          });
        } else if (!result.ok && retryableRead && !result.errors.some((error) => error.includes('stale_next_action'))) {
          nextAction = createIssueNextAction({
            kind: 'reconcile-stage-read-only',
            binding,
            argv: reconcileArgv,
          });
        }
      }
      const zeroSendTerminal = nextAction ? null : readEvidenceZeroSendTerminal(stageEvidencePath);
      const reconciliationBinding: CreateIssueActionBinding | null = result.stage && result.sourceRevision
        ? {
            repository: opts.repo,
            issueNumber,
            sourceRevision: result.sourceRevision,
            stage: result.stage,
            ...(result.stageAttemptId ? { stageAttemptId: result.stageAttemptId } : {}),
          }
        : null;
      const zeroSendProjection = zeroSendTerminal
        && reconciliationBinding
        ? zeroSendTerminalProjection(
            zeroSendTerminal,
            opts.repo,
            issueNumber,
            reconcileStageReadOnlyAction(opts, issueNumber, reconciliationBinding, reviewDir, stageEvidencePath),
          )
        : null;
      const authorityConflict = !result.ok && result.errors.some((error) =>
        /permanently_noncanonical_publication|authoritative GitHub artifact (?:was )?edited|foreign[- ]comment|publisher mismatch|principal mismatch|edited publication/i.test(error)
      );
      const output = opts.blockedOn
        ? projectBlockedOnToExternalPause(opts.blockedOn)
        : zeroSendProjection
          ?? (authorityConflict
            ? createIssueExternalPauseResult({
                cause: 'external:content_authority_conflict',
                remedy: 'resolve the authoritative GitHub publication conflict, then resume this same Dispatch',
                resumeWhen: { operator: true },
                evidence: result.errors.join('; '),
                blocker: result.errors.join('; '),
              })
            : result.ok
              ? (() => {
                  if (!nextAction) throw new Error('manager_result_without_recovery:reconciliation_failed');
                  return createIssueRecoverableResult({
                    cause: result.temporary ?? 'reconciliation_failed',
                    nextAction,
                  });
                })()
              : validatedManagerSurfaceOutput(
                  result,
                  result.temporary ?? 'reconciliation_failed',
                  nextAction,
                  result.errors.join('; '),
                ));
      if (!result.ok) process.stderr.write(result.errors.join('\n') + '\n');
      return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, output);
    }

    if (opts.command === 'produce-artifacts' || opts.command === 'check-artifacts') {
      const reviewDir = parseRequiredNonEmptyString(opts.reviewDir, '--review-dir');
      const issueNumber = artifactIssueNumber(opts, reviewDir);
      const stale = staleArtifactBinding(opts, reviewDir, issueNumber, transport);
      if (stale) {
        return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, stale);
      }
      const tierIntakePath = opts.tierIntakePath?.trim() || join(reviewDir, 'tier-intake.json');
      const stageEvidencePaths = opts.stageEvidencePaths;
      const authorDispositionsPath = opts.authorDispositionsPath?.trim() || join(reviewDir, 'author-dispositions.json');
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
        artifactSourceTransport: transport,
      };
      const result = opts.command === 'produce-artifacts'
        ? produceAcceptanceArtifacts(artifactOptions)
        : inspectAcceptanceArtifacts(artifactOptions);
      const messages = result.ok
        ? []
        : ('errors' in result ? result.errors : result.missing.map((item) => item.reason));
      const managerSurface = opts.json
        || opts.blockedOn !== undefined
        || opts.expectedSourceRevision !== undefined
        || opts.expectedStage !== undefined
        || opts.expectedStageAttemptId !== undefined;
      // Acceptance-artifact helpers are also imported as library checks by
      // nongoverned callers. Preserve their 0/1 contract unless the invocation
      // explicitly opts into the manager surface.
      if (!managerSurface) {
        if (!result.ok) process.stderr.write(`${messages.join('\n')}\n`);
        return result.ok ? 0 : 1;
      }
      const binding = artifactBindingFromState(opts, reviewDir, issueNumber, transport);
      let nextAction = null;
      if (binding && !result.ok) {
        const errors = 'errors' in result ? result.errors : result.missing.map((item) => item.reason);
        const resultWithAuthorDiagnostics = result as typeof result & {
          authorDiagnostics?: AuthorDispositionDiagnostic[];
          authorSchemaFragment?: string;
        };
        const structuredAuthorDiagnostics = Array.isArray(resultWithAuthorDiagnostics.authorDiagnostics)
          ? resultWithAuthorDiagnostics.authorDiagnostics
          : [];
        const onlyAuthorActionable = structuredAuthorDiagnostics.length > 0
          && structuredAuthorDiagnostics.every((item) => item.ownership === 'author-owned');
        const lifecycleInjectedFailure = errors.some(
          (error) => classifyAuthorDispositionFailure(error) === 'lifecycle-injected',
        );
        if (opts.command === 'produce-artifacts' && !opts.blockedOn && lifecycleInjectedFailure) {
          return emitManagerBoundary(
            'create-issue-stage-record-cli.ts:main',
            argv,
            createIssueRecoverableResult({
              cause: 'author_round_lifecycle_validation_failed',
              blocker: errors.join('; '),
              nextAction: reconcileStageReadOnlyAction(opts, issueNumber, binding, reviewDir),
            }),
          );
        }
        if (opts.command === 'produce-artifacts' && !opts.blockedOn && onlyAuthorActionable) {
          const output = {
            ok: false,
            cause: 'acceptance_artifact_production_failed',
            blocker: messages.join('; '),
            authorDiagnostics: structuredAuthorDiagnostics,
            authorSchemaFragment: typeof resultWithAuthorDiagnostics.authorSchemaFragment === 'string'
              ? resultWithAuthorDiagnostics.authorSchemaFragment
              : renderAuthorDispositionPromptFragment(),
            nextAction: preMintAuthorRoundAction(binding, reviewDir),
          };
          return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, output);
        }
        const terminalExternal = errors.some((error) => (
          error.includes('operator')
          || error.includes('stage_slot_consumed')
          || error.includes('stale_next_action')
        ));
        if (!lifecycleInjectedFailure && !terminalExternal) {
          nextAction = createIssueNextAction({
            kind: 'produce-acceptance-artifacts',
            binding,
            argv: artifactCommandArgv('produce-artifacts', opts, reviewDir, issueNumber, binding),
          });
        }
      }
      const authorityConflict = !result.ok && messages.some((error) =>
        error.includes('authority=author-owned')
        || error.includes('operator')
        || error.includes('stage_slot_consumed')
        || error.includes('stale_next_action')
      );
      const output = authorityConflict && !opts.blockedOn
        ? createIssueExternalPauseResult({
            cause: 'external:content_authority_conflict',
            remedy: 'resolve the authoritative author/operator content conflict, then resume this same Dispatch',
            resumeWhen: { operator: true },
            evidence: messages.join('; '),
          })
        : validatedManagerSurfaceOutput(
            result,
            opts.command === 'check-artifacts' ? 'acceptance_artifact_check_failed' : 'acceptance_artifact_production_failed',
            nextAction,
            result.ok ? undefined : messages.join('; '),
            undefined,
            opts.blockedOn,
          );
      if (!result.ok) process.stderr.write(`${messages.join('\n')}\n`);
      return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, output);
    }
    const issueNumber = parseRequiredPositiveInt(String(opts.issueNumber || ''), '--issue-number');

    if (opts.command === 'start-cycle') {
      const sourceRevision = parseRequiredNonEmptyString(opts.sourceRevision, '--source-revision');
      const tier = parseRequiredNonEmptyString(opts.tier, '--tier');
      const stage = parseRequiredNonEmptyString(opts.stage, '--stage') as LifecycleReviewStage;
      const deterministicTerminal = readCanonicalZeroSendTerminal({
        issueNumber,
        sourceRevision,
        stage,
      });
      if (deterministicTerminal?.policy.class === 'deterministic-input') {
        const deterministicBinding: CreateIssueActionBinding = {
          repository: opts.repo,
          issueNumber,
          sourceRevision: deterministicTerminal.sourceRevision,
          stage: deterministicTerminal.stage as LifecycleReviewStage,
          stageAttemptId: deterministicTerminal.stageAttemptId,
        };
        const canonical = resolveCanonicalReviewDirectory({ taskIdentity: 'issue:' + issueNumber });
        const projected = zeroSendTerminalProjection(
          deterministicTerminal,
          opts.repo,
          issueNumber,
          reconcileStageReadOnlyAction(
            opts,
            issueNumber,
            deterministicBinding,
            canonical.directory,
            evidencePathForBinding(canonical.directory, deterministicBinding),
          ),
        );
        if (projected) {
          return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, projected);
        }
      }
      const stale = staleStartCycleBinding(opts, issueNumber);
      if (stale) {
        return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, stale);
      }

      let live;
      try {
        live = fetchIssueRevision(transport, opts.repo, issueNumber);
      } catch (error) {
        const evidence = error instanceof Error ? error.message : String(error);
        const output = createIssueExternalPauseResult({
          cause: 'external:github_unavailable',
          remedy: 'restore GitHub Issue reads, then resume this same Dispatch',
          resumeWhen: { operator: true },
          evidence,
          blocker: evidence,
        });
        return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, output);
      }
      const liveRevision = issueSourceRevision(live.body);
      if (!liveRevision || liveRevision.toLowerCase() !== sourceRevision.toLowerCase()) {
        const binding: CreateIssueActionBinding = {
          repository: opts.repo,
          issueNumber,
          sourceRevision,
          stage,
        };
        const canonical = resolveCanonicalReviewDirectory({ taskIdentity: 'issue:' + issueNumber });
        const staleLive = createIssueStaleNextAction({
          binding,
          observed: {
            repository: opts.repo,
            issueNumber,
            ...(liveRevision ? { sourceRevision: liveRevision } : {}),
            stage,
          },
          nextAction: reconcileStageReadOnlyAction(
            opts,
            issueNumber,
            binding,
            canonical.directory,
            evidencePathForBinding(canonical.directory, binding),
          ),
        });
        return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, staleLive);
      }
      const reconciledContinuation = Boolean(
        opts.expectedSourceRevision
        && opts.expectedSourceRevision.toLowerCase() === sourceRevision.toLowerCase()
        && opts.expectedStage === stage
        && opts.expectedStageAttemptId
        && opts.expectedStageAttemptId === opts.stageAttemptId
        && opts.stageAttemptId === semanticStageAttemptId(opts.repo, issueNumber, stage),
      );
      const floorErrors = reconciledContinuation ? [] : bodyFloorDiagnostics(live.body, tier);
      if (floorErrors.length > 0) {
        const binding: CreateIssueActionBinding = {
          repository: opts.repo,
          issueNumber,
          sourceRevision,
          stage,
        };
        if (opts.blockedOn) {
          return emitManagerBoundary(
            'create-issue-stage-record-cli.ts:main',
            argv,
            projectBlockedOnToExternalPause(opts.blockedOn),
          );
        }
        const output = {
          ok: false,
          cause: 'body_floor_rejected',
          blocker: floorErrors.join('; '),
          nextAction: preMintAuthorRoundAction(binding, canonicalAuthorRoundDirectory(issueNumber)),
        };
        return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, output);
      }

      const result = startReviewCycle(transport, {
        repo: opts.repo,
        issueNumber,
        sourceRevision,
        stage,
        stageAttemptId: opts.stageAttemptId ? parseRequiredNonEmptyString(opts.stageAttemptId, '--stage-attempt-id') : undefined,
        permittedLaneOverride: opts.permittedLaneOverride,
        tier,
        competitiveDecision: opts.competitiveDecision,
        competitiveRationale: opts.competitiveRationale,
        publicActor: opts.publicActor!,
        predecessorCycleId: opts.predecessorCycleId,
        workdir: opts.workdir,
      });
      const hardFailure = result.diagnostics.some((item) => (
        item.code === 'stage_authority_invalid'
        || item.code === 'stage_slot_consumed'
        || item.code === 'stage_order_violation'
        || item.code === 'conflicting-remote-event'
        || item.code === 'orphan-cycle'
        || item.code === 'malformed-marker'
      ));
      const retryBinding = !result.ok
        ? {
            repository: opts.repo,
            issueNumber,
            sourceRevision,
            stage,
            ...(result.stageAttemptId ? { stageAttemptId: result.stageAttemptId } : {}),
          } satisfies CreateIssueActionBinding
        : null;
      const nextAction = retryBinding
        ? hardFailure || !result.stageAttemptId
          ? (() => {
              const canonical = resolveCanonicalReviewDirectory({ taskIdentity: 'issue:' + issueNumber });
              return reconcileStageReadOnlyAction(
                opts,
                issueNumber,
                retryBinding,
                canonical.directory,
                evidencePathForBinding(canonical.directory, retryBinding),
              );
            })()
          : createIssueNextAction({
              kind: 'retry-start-cycle',
              binding: retryBinding,
              argv: startCycleRetryArgv(opts, issueNumber, retryBinding),
            })
        : null;
      const output = validatedManagerSurfaceOutput(
        result,
        'stage_record_start_failed',
        nextAction,
        result.ok ? undefined : stageDiagnosticBlocker(result),
        undefined,
        opts.blockedOn,
      );
      if (!result.ok) process.stderr.write(`${result.diagnostics.map((item) => item.message).join('\n')}\n`);
      return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, output);
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
      const binding = stageReceiptActionBinding(opts.repo, issueNumber, receipt);
      const nextAction = !result.ok && binding
        ? result.projectionPendingRepair && result.eventKey
          ? createIssueNextAction({
              kind: 'retry-stage-record-publication',
              binding,
              argv: retryPendingActionArgv(opts, issueNumber, binding),
            })
          : (() => {
              const canonical = resolveCanonicalReviewDirectory({ taskIdentity: 'issue:' + issueNumber });
              return reconcileStageReadOnlyAction(
                opts,
                issueNumber,
                binding,
                canonical.directory,
                evidencePathForBinding(canonical.directory, binding),
              );
            })()
        : null;
      const output = validatedManagerSurfaceOutput(
        result,
        'stage_record_publication_failed',
        nextAction,
        result.ok ? undefined : stageDiagnosticBlocker(result),
        undefined,
        opts.blockedOn,
      );
      if (!result.ok) process.stderr.write(`${result.diagnostics.map((item) => item.message).join('\n')}\n`);
      return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, output);
    }

    const stale = staleRetryPendingBinding(opts, issueNumber, transport);
    if (stale) {
      process.stderr.write('stale_next_action\n');
      return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, stale);
    }
    const results = retryPendingEvents(transport, opts.repo, issueNumber, opts.workdir);
    const ok = results.every((item) => item.ok);
    const recovery = results.length === 1 ? results[0]?.recovery : undefined;
    const recoveryBinding = recovery
      && opts.expectedSourceRevision
      && opts.expectedStage
      && opts.expectedStageAttemptId
      && recovery.sourceRevision.toLowerCase() === opts.expectedSourceRevision.toLowerCase()
      ? {
          repository: opts.repo,
          issueNumber,
          sourceRevision: opts.expectedSourceRevision,
          stage: opts.expectedStage,
          stageAttemptId: opts.expectedStageAttemptId,
        } satisfies CreateIssueActionBinding
      : null;
    const expectedBinding: CreateIssueActionBinding | null = opts.expectedSourceRevision && opts.expectedStage
      ? {
          repository: opts.repo,
          issueNumber,
          sourceRevision: opts.expectedSourceRevision,
          stage: opts.expectedStage,
          ...(opts.expectedStageAttemptId ? { stageAttemptId: opts.expectedStageAttemptId } : {}),
        }
      : null;
    const nextAction = recoveryBinding && recovery && opts.publicActor
      ? createIssueNextAction({
          kind: 'retry-start-cycle',
          binding: recoveryBinding,
          argv: poisonSuccessorStartCycleArgv(opts, issueNumber, recoveryBinding, recovery.tier),
        })
      : !ok && expectedBinding
        ? (() => {
            const canonical = resolveCanonicalReviewDirectory({ taskIdentity: 'issue:' + issueNumber });
            return reconcileStageReadOnlyAction(
              opts,
              issueNumber,
              expectedBinding,
              canonical.directory,
              evidencePathForBinding(canonical.directory, expectedBinding),
            );
          })()
        : null;
    const output = validatedManagerSurfaceOutput(
      { ok, results },
      'stage_record_retry_exhausted',
      nextAction,
      ok ? undefined : results.flatMap((item) => item.diagnostics.map((diagnostic) => diagnostic.message)).join('; '),
      undefined,
      opts.blockedOn,
    );
    if (!ok) process.stderr.write((typeof output.blocker === 'string' ? output.blocker : 'retry-pending failed') + '\n');
    return emitManagerBoundary('create-issue-stage-record-cli.ts:main', argv, output);
  });
}


function appendFinalAcceptanceOperatorArgs(argv: string[], opts: FinalAcceptanceCliOptions): void {
  const pairs: Array<[string, string | undefined]> = [
    ['--operator-issue-number', opts.operatorIssueNumber],
    ['--operator-source-revision', opts.operatorSourceRevision],
    ['--operator-verdict-url', opts.operatorVerdictUrl],
    ['--operator-verdict-sha256', opts.operatorVerdictSha256],
    ['--operator-verdict-byte-length', opts.operatorVerdictByteLength],
    ['--operator-finding-count', opts.operatorFindingCount],
    ['--operator-reason', opts.operatorReason],
  ];
  for (const [flag, value] of pairs) if (value) argv.push(flag, value);
}

function finalAcceptanceRetryAction(
  opts: FinalAcceptanceCliOptions,
  issueNumber: number,
  reviewDir: string,
  sourceRevision: string,
): CreateIssueNextAction {
  const binding: CreateIssueActionBinding = {
    repository: opts.repo,
    issueNumber,
    sourceRevision,
    stage: 'acceptance',
  };
  const actionArgv = [
    'node', '--experimental-strip-types', 'scripts/create-issue-final-acceptance.ts',
    '--repo', opts.repo,
    '--issue-number', String(issueNumber),
    '--review-dir', reviewDir,
    '--issue-revision', sourceRevision,
    '--json',
  ];
  if (opts.publicActor) actionArgv.push('--public-actor', opts.publicActor);
  if (opts.workdir) actionArgv.push('--workdir', opts.workdir);
  if (opts.externalPassReceiptPath) actionArgv.push('--external-pass-receipt', opts.externalPassReceiptPath);
  for (const path of opts.claudeProducerEvidencePaths) actionArgv.push('--claude-producer-evidence', path);
  appendFinalAcceptanceOperatorArgs(actionArgv, opts);
  return createIssueNextAction({
    kind: 'retry-final-acceptance',
    binding,
    argv: actionArgv,
  });
}

function finalAcceptanceArtifactAction(
  opts: FinalAcceptanceCliOptions,
  issueNumber: number,
  reviewDir: string,
  binding: CreateIssueActionBinding,
): CreateIssueNextAction {
  const actionArgv = [
    'node', '--experimental-strip-types', 'scripts/create-issue-stage-finalize.ts',
    'produce-artifacts',
    '--repo', opts.repo,
    '--issue-number', String(issueNumber),
    '--review-dir', reviewDir,
    '--phase', 'final-acceptance',
    '--expected-source-revision', binding.sourceRevision,
    '--expected-stage', binding.stage,
    '--expected-stage-attempt-id', binding.stageAttemptId ?? '',
    '--json',
  ];
  for (const path of opts.claudeProducerEvidencePaths) actionArgv.push('--claude-producer-evidence', path);
  appendFinalAcceptanceOperatorArgs(actionArgv, opts);
  return createIssueNextAction({
    kind: 'produce-acceptance-artifacts',
    binding,
    argv: actionArgv,
  });
}

function finalAcceptanceBootstrapArtifactAction(
  opts: FinalAcceptanceCliOptions,
  issueNumber: number,
  reviewDir: string,
  sourceRevision: string,
): CreateIssueNextAction {
  const binding: CreateIssueActionBinding = {
    repository: opts.repo,
    issueNumber,
    sourceRevision,
    stage: 'architectural',
  };
  const actionArgv = [
    'node', '--experimental-strip-types', 'scripts/create-issue-stage-finalize.ts',
    'produce-artifacts',
    '--repo', opts.repo,
    '--issue-number', String(issueNumber),
    '--review-dir', reviewDir,
    '--phase', 'final-acceptance',
    '--json',
  ];
  for (const path of opts.claudeProducerEvidencePaths) actionArgv.push('--claude-producer-evidence', path);
  appendFinalAcceptanceOperatorArgs(actionArgv, opts);
  return createIssueNextAction({
    kind: 'produce-acceptance-artifacts',
    binding,
    argv: actionArgv,
  });
}

function finalAcceptanceRecoveryAction(
  opts: FinalAcceptanceCliOptions,
  issueNumber: number,
  reviewDir: string,
  liveRevision: string,
  terminalBinding: CreateIssueActionBinding,
  result: {
    ok: boolean;
    guardErrors: string[];
    diagnostics: Array<{ message: string }>;
    projectionPendingRepair?: boolean;
  },
): CreateIssueNextAction | null {
  if (result.ok) return null;
  const messages = [...result.guardErrors, ...result.diagnostics.map((item) => item.message)];
  const producerRepair = messages.some((message) =>
    message === 'finding-ledger: ledger path is required for final acceptance'
    || /^finding-ledger: unable to read /.test(message)
    || message === 'stage-completeness: review episode relay is incomplete'
    || /^stage-completeness: unable to read /.test(message)
  );
  if (producerRepair) {
    return finalAcceptanceArtifactAction(opts, issueNumber, reviewDir, terminalBinding);
  }
  const transientRead = messages.some((message) =>
    /^unable to (?:read|re-read|confirm) /.test(message)
  );
  if (transientRead || result.projectionPendingRepair === true) {
    return finalAcceptanceRetryAction(opts, issueNumber, reviewDir, liveRevision);
  }
  return reconcileStageReadOnlyAction(
    { repo: opts.repo },
    issueNumber,
    terminalBinding,
    reviewDir,
    evidencePathForBinding(reviewDir, terminalBinding),
  );
}

function acceptanceAuthorityPause(evidence: string) {
  return createIssueExternalPauseResult({
    cause: 'external:content_authority_conflict',
    remedy: 'resolve the canonical acceptance authority conflict, then resume this same Dispatch',
    resumeWhen: { operator: true },
    evidence,
    blocker: evidence,
  });
}

export function runFinalAcceptanceCli(argv: string[], acceptanceTransport?: GhTransport): number {
  const inspected = inspectManagerCliInvocation(
    CREATE_ISSUE_FINAL_ACCEPTANCE_CLI_DECLARATION,
    argv.slice(2),
    { validateRequired: acceptanceTransport === undefined },
  );
  if (inspected.help) {
    process.stdout.write(inspected.help + '\n');
    return 0;
  }
  const managerShaped = argv.includes('--blocked-on-json')
    || argv.includes('--expected-source-revision')
    || argv.includes('--expected-stage')
    || argv.includes('--expected-stage-attempt-id');
  if (inspected.error && !managerShaped) {
    process.stderr.write('create-issue-final-acceptance: ' + inspected.error + '\n');
    return 2;
  }
  return runParsedCli(argv, 'create-issue-final-acceptance', parseFinalAcceptanceArgs, (opts) => {
    const issueNumber = parseRequiredPositiveInt(String(opts.issueNumber || ''), '--issue-number');
    const reviewDir = parseRequiredNonEmptyString(opts.reviewDir, '--review-dir');
    const transport = acceptanceTransport ?? defaultGhTransport();

    let liveIssue: ReturnType<typeof fetchIssueRevision>;
    try {
      liveIssue = fetchIssueRevision(transport, opts.repo, issueNumber);
    } catch (error) {
      const evidence = error instanceof Error ? error.message : String(error);
      const output = opts.issueRevision && /^r[0-9]+$/i.test(opts.issueRevision)
        ? createIssueRecoverableResult({
            cause: 'source-unavailable',
            blocker: evidence,
            nextAction: finalAcceptanceRetryAction(opts, issueNumber, reviewDir, opts.issueRevision),
          })
        : createIssueExternalPauseResult({
            cause: 'external:github_unavailable',
            remedy: 'restore GitHub Issue reads, then resume this same Dispatch',
            resumeWhen: { operator: true },
            evidence,
            blocker: evidence,
          });
      process.stderr.write(evidence + '\n');
      return emitFinalAcceptanceBoundary(argv, output);
    }

    const liveRevision = /<!--\s*source-revision:\s*(r[0-9]+)\s*-->/i.exec(liveIssue.body)?.[1];
    if (!liveRevision) {
      const evidence = 'live Issue has no canonical source-revision marker';
      process.stderr.write(evidence + '\n');
      return emitFinalAcceptanceBoundary(
        argv,
        acceptanceAuthorityPause(evidence),
      );
    }

    if (opts.issueRevision && opts.issueRevision !== liveRevision) {
      const expectedBinding: CreateIssueActionBinding = {
        repository: opts.repo,
        issueNumber,
        sourceRevision: opts.issueRevision,
        stage: 'architectural',
      };
      const output = createIssueRecoverableResult({
        cause: 'stale_next_action',
        blocker: `final acceptance was bound to ${opts.issueRevision}; live Issue is ${liveRevision}`,
        nextAction: reconcileStageReadOnlyAction(
          { repo: opts.repo },
          issueNumber,
          expectedBinding,
          reviewDir,
          evidencePathForBinding(reviewDir, expectedBinding),
        ),
      });
      process.stderr.write('stale_next_action\n');
      return emitFinalAcceptanceBoundary(argv, output);
    }

    const currentSnapshotPath = join(reviewDir, 'issue-' + liveRevision + '-body.json');
    let currentSnapshot: Record<string, unknown> | null = null;
    try {
      currentSnapshot = JSON.parse(readFileSync(currentSnapshotPath, 'utf8')) as Record<string, unknown>;
    } catch {
      currentSnapshot = null;
    }
    const snapshotValid = currentSnapshot
      && currentSnapshot.schema === 'create-issue-live-snapshot/v1'
      && currentSnapshot.issueNumber === issueNumber
      && currentSnapshot.sourceRevision === liveRevision
      && currentSnapshot.title === liveIssue.title
      && currentSnapshot.body === liveIssue.body;
    if (!snapshotValid) {
      const binding = artifactBindingFromState({
        ...opts,
        command: 'produce-artifacts',
        stageEvidencePaths: [],
        claudeProducerEvidencePaths: opts.claudeProducerEvidencePaths,
      } as StageFinalizeCliOptions, reviewDir, issueNumber);
      const nextAction = binding
        ? createIssueNextAction({
            kind: 'produce-acceptance-artifacts',
            binding,
            argv: [
              'node', '--experimental-strip-types', 'scripts/create-issue-stage-finalize.ts',
              'produce-artifacts',
              '--repo', opts.repo,
              '--issue-number', String(issueNumber),
              '--review-dir', reviewDir,
              '--phase', 'final-acceptance',
              '--expected-source-revision', binding.sourceRevision,
              '--expected-stage', binding.stage,
              '--expected-stage-attempt-id', binding.stageAttemptId ?? '',
              '--json',
            ],
          })
        : finalAcceptanceBootstrapArtifactAction(opts, issueNumber, reviewDir, liveRevision);
      const blocker = 'issue-rNN-body snapshot is missing or disagrees with the stable live Issue; field=issue snapshot authority=GitHub-witnessed';
      const output = createIssueRecoverableResult({
        cause: 'acceptance-input-missing',
        blocker,
        nextAction,
      });
      process.stderr.write(blocker + '\n');
      return emitFinalAcceptanceBoundary(argv, output);
    }


    const canonicalReceiptPaths = readdirSync(reviewDir)
      .filter((name) => /^stage-completeness-receipt-.+\.json$/.test(name))
      .sort()
      .map((name) => join(reviewDir, name));
    const receiptRows = canonicalReceiptPaths.flatMap((path) => {
      try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        return [{ path, value }];
      } catch {
        return [];
      }
    }).sort((left, right) => Number(left.value.stageSequence ?? 0) - Number(right.value.stageSequence ?? 0));

    const terminal = [...receiptRows].reverse().find((row) => row.value.stage === 'architectural');
    if (
      !terminal
      || typeof terminal.value.sourceRevision !== 'string'
      || typeof terminal.value.cycleId !== 'string'
      || typeof terminal.value.stageAttemptId !== 'string'
      || !terminal.value.stageAttemptId.trim()
    ) {
      const blocker = 'canonical terminal stage receipt is missing';
      const output = createIssueRecoverableResult({
        cause: 'acceptance-input-missing',
        blocker,
        nextAction: finalAcceptanceBootstrapArtifactAction(opts, issueNumber, reviewDir, liveRevision),
      });
      process.stderr.write(blocker + '\n');
      return emitFinalAcceptanceBoundary(argv, output);
    }

    const terminalBinding: CreateIssueActionBinding = {
      repository: opts.repo,
      issueNumber,
      sourceRevision: String(terminal.value.sourceRevision),
      stage: 'architectural',
      stageAttemptId: String(terminal.value.stageAttemptId),
    };

    const terminalSnapshotPath = join(reviewDir, 'issue-' + terminal.value.sourceRevision + '-body.json');
    let terminalSnapshot: Record<string, unknown> | null = null;
    try {
      terminalSnapshot = JSON.parse(readFileSync(terminalSnapshotPath, 'utf8')) as Record<string, unknown>;
    } catch {
      terminalSnapshot = null;
    }
    if (!terminalSnapshot || terminalSnapshot.schema !== 'create-issue-live-snapshot/v1' || typeof terminalSnapshot.body !== 'string') {
      const blocker = 'terminal source Issue snapshot is missing; field=terminalSourceBody authority=GitHub-witnessed';
      const output = createIssueRecoverableResult({
        cause: 'acceptance-input-missing',
        blocker,
        nextAction: finalAcceptanceArtifactAction(opts, issueNumber, reviewDir, terminalBinding),
      });
      process.stderr.write(blocker + '\n');
      return emitFinalAcceptanceBoundary(argv, output);
    }

    if (opts.issueBodyPath) {
      let asserted = '';
      try { asserted = readFileSync(opts.issueBodyPath, 'utf8'); } catch {}
      const canonicalBody = typeof currentSnapshot?.body === 'string' ? currentSnapshot.body : liveIssue.body;
      if (asserted !== canonicalBody) {
        const blocker = '--issue-body is assertion-only and does not match the canonical Issue snapshot';
        process.stderr.write(blocker + '\n');
        return emitFinalAcceptanceBoundary(
          argv,
          createIssueRecoverableResult({
            cause: 'final_acceptance_caller_bookkeeping_mismatch',
            blocker,
            nextAction: reconcileStageReadOnlyAction(
              { repo: opts.repo },
              issueNumber,
              terminalBinding,
              reviewDir,
              terminal.path,
            ),
          }),
        );
      }
    }

    if (opts.stageReceipts.length > 0) {
      const requested = opts.stageReceipts.map((path) => resolve(path)).sort();
      const canonical = canonicalReceiptPaths.map((path) => resolve(path)).sort();
      if (JSON.stringify(requested) !== JSON.stringify(canonical)) {
        const blocker = 'caller stage-receipt list does not equal canonical receipt inventory';
        process.stderr.write(blocker + '\n');
        return emitFinalAcceptanceBoundary(
          argv,
          createIssueRecoverableResult({
            cause: 'final_acceptance_caller_bookkeeping_mismatch',
            blocker,
            nextAction: reconcileStageReadOnlyAction(
              { repo: opts.repo },
              issueNumber,
              terminalBinding,
              reviewDir,
              terminal.path,
            ),
          }),
        );
      }
    }
    if (opts.cycleId && opts.cycleId !== terminal.value.cycleId) {
      const blocker = 'caller cycle-id disagrees with lifecycle terminal receipt';
      process.stderr.write(blocker + '\n');
      return emitFinalAcceptanceBoundary(
        argv,
        createIssueRecoverableResult({
          cause: 'final_acceptance_caller_bookkeeping_mismatch',
          blocker,
          nextAction: reconcileStageReadOnlyAction(
            { repo: opts.repo },
            issueNumber,
            terminalBinding,
            reviewDir,
            terminal.path,
          ),
        }),
      );
    }

    const captures = receiptRows.flatMap(({ value }) => (
      Array.isArray(value.relayEligibleCaptures)
        ? value.relayEligibleCaptures.flatMap((capture) => (
            capture && typeof capture === 'object' && typeof (capture as Record<string, unknown>).name === 'string'
              ? [join(reviewDir, String((capture as Record<string, unknown>).name))]
              : []
          ))
        : []
    ));
    const ledgerPath = opts.ledgerPath ?? join(reviewDir, 'finding-disposition-ledger.json');
    const relayPaths = opts.relayEvidencePaths.length > 0
      ? opts.relayEvidencePaths
      : [join(reviewDir, 'verified-relay-evidence.json')];
    const claudePaths = opts.claudeProducerEvidencePaths.length > 0
      ? opts.claudeProducerEvidencePaths
      : (existsSync(join(reviewDir, 'claude-producer-evidence.json')) ? [join(reviewDir, 'claude-producer-evidence.json')] : []);

    const result = runFinalAcceptance(transport, {
      repo: opts.repo,
      issueNumber,
      cycleId: String(terminal.value.cycleId),
      issueBody: liveIssue.body,
      terminalSourceBody: String(terminalSnapshot.body),
      issueRevision: liveRevision,
      reviewDir,
      stageReceiptPaths: canonicalReceiptPaths,
      capturePaths: captures,
      ledgerPath,
      relayEvidencePaths: relayPaths,
      claudeProducerEvidencePaths: claudePaths,
      externalPassReceiptPath: opts.externalPassReceiptPath,
      operatorAdjudication: operatorAcceptanceAdjudication({ ...opts, phase: 'final-acceptance' }),
      publicActor: opts.publicActor!,
      workdir: opts.workdir,
    });

    const currentTerminalBinding: CreateIssueActionBinding = {
      ...terminalBinding,
      sourceRevision: liveRevision,
    };
    const recoveryAction = finalAcceptanceRecoveryAction(
      opts,
      issueNumber,
      reviewDir,
      liveRevision,
      currentTerminalBinding,
      result,
    );
    const output = validatedManagerSurfaceOutput(
      result,
      'final_acceptance_failed',
      recoveryAction,
      result.ok
        ? undefined
        : [...result.guardErrors, ...result.diagnostics.map((item) => item.message)].join('; '),
    );
    if (!result.ok) {
      for (const error of result.guardErrors) process.stderr.write(error + '\n');
      for (const diagnostic of result.diagnostics) process.stderr.write(diagnostic.message + '\n');
    }
    return emitFinalAcceptanceBoundary(argv, output);
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
