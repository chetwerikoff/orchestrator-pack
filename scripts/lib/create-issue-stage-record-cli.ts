import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultGhTransport, fetchIssueRevision } from './create-issue-stage-record-gh.ts';
import {
  publishSettledStageRecord,
  retryPendingEvents,
  startReviewCycle,
} from './create-issue-stage-record-core.ts';
import { runFinalAcceptance } from './create-issue-final-acceptance.ts';
import {
  ACCEPTANCE_ARTIFACT_REQUIRED_INPUTS,
  bindPublishedCommentToSlot,
  inspectAcceptanceArtifacts,
  produceAcceptanceArtifacts,
  readCanonicalZeroSendTerminal,
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
  existingPacedBoundedRetryAction,
  projectBlockedOnToExternalPause,
  projectZeroSendManagerResult,
  validateCreateIssueBlockedOn,
  validateCreateIssueManagerResult,
  type CreateIssueActionBinding,
  type CreateIssueBlockedOn,
  type CreateIssueNextAction,
  type CreateIssueZeroSendReason,
} from './create-issue-next-action.ts';
import {
  emitCreateIssueManagerResult,
  type CreateIssueManagerBoundaryProducer,
} from './create-issue-manager-boundary.ts';
import { resolveCanonicalReviewDirectory } from './stage-completeness-core.ts';
import type { LifecycleReviewStage } from './create-issue-stage-lifecycle.ts';
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

interface JournalTailCliOptions {
  json: boolean;
  publicActor: PublicActor;
  workdir?: string;
}

interface StageFinalizeCliOptions extends JournalTailCliOptions {
  command: 'start-cycle' | 'publish-stage' | 'retry-pending' | 'reconcile-stage' | 'bind-published-comment' | 'produce-artifacts' | 'check-artifacts';
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
    const evaluation = emitCreateIssueManagerResult({
      producer: toolName,
      currentArgv: argv,
      produce: () => { throw error; },
    });
    return evaluation.exitCode;
  }
  try {
    return run(opts);
  } catch (error) {
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
    '  create-issue-stage-finalize.ts publish-stage --repo <owner/name> --issue-number <n> --receipt <path> [--waiver <path>] [--workdir <path>] [--json]',
    '  create-issue-stage-finalize.ts retry-pending --repo <owner/name> --issue-number <n> [--workdir <path>] [--expected-source-revision <rNN> --expected-stage <stage> --expected-stage-attempt-id <id>] [--json]',
    '  create-issue-stage-finalize.ts reconcile-stage --repo <owner/name> --issue-number <n> --review-dir <path> --stage-evidence <attempt-NNN.json> [--json]',
    '  create-issue-stage-finalize.ts bind-published-comment --repo <owner/name> --issue-number <n> --review-dir <path> --stage-evidence <attempt-NNN.json> --reviewer-slot <slot> --invocation-id <id> --comment-url <url> [--json]',
    '  create-issue-stage-finalize.ts produce-artifacts --review-dir <path> [--tier-intake <path>] [--stage-evidence <path>...] [--author-dispositions <target-path>] [--claude-producer-evidence <path>...] [--waiver <path>] [--output-dir <path>] [--phase <pre-lens|post-lens|final-acceptance>] [--operator-issue-number <n> --operator-source-revision <rNN> --operator-verdict-url <url> --operator-verdict-sha256 <hex> --operator-verdict-byte-length <n> --operator-finding-count <n> --operator-reason <text>] [--json]',
    '  create-issue-stage-finalize.ts check-artifacts --review-dir <path> [--tier-intake <path>] [--stage-evidence <path>...] [--author-dispositions <derived-path>] [--claude-producer-evidence <path>...] [--waiver <path>] [--output-dir <path>] [--json]',
    '  manager-result commands additionally accept --blocked-on-json <json> only for a coordinator/task-dispatch authoritative active-unsatisfied-blocker assertion',
  ].join('\n');
}

export function parseStageFinalizeArgs(argv: string[]): StageFinalizeCliOptions {
  const command = argv[2];
  if (command !== 'start-cycle' && command !== 'publish-stage' && command !== 'retry-pending' && command !== 'reconcile-stage' && command !== 'bind-published-comment' && command !== 'produce-artifacts' && command !== 'check-artifacts') {
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
  const boundActionCommand = artifactCommand || command === 'start-cycle' || command === 'retry-pending';
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
        if (phase !== 'pre-lens' && phase !== 'post-lens' && phase !== 'final-acceptance') throw new Error('--phase must be pre-lens, post-lens, or final-acceptance');
        opts.phase = phase;
        break;
      }
      case '--blocked-on-json':
        if (command === 'bind-published-comment') throw new Error('--blocked-on-json is not valid with bind-published-comment');
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

function finalAcceptanceUsage(): string {
  return [
    'Usage:',
    `  create-issue-final-acceptance.ts --repo <owner/name> --issue-number <n> --review-dir <path> [--cycle-id <assertion>] [--issue-body <assertion-path>] [--issue-revision <assertion-rNN>] [--stage-receipt <assertion-path>...] [--capture <path>...] [--ledger <path>] [--relay-evidence <path>...] [--claude-producer-evidence <path>...] [--external-pass-receipt <path>] [--operator-issue-number <n> --operator-source-revision <rNN> --operator-verdict-url <url> --operator-verdict-sha256 <hex> --operator-verdict-byte-length <n> --operator-finding-count <n> --operator-reason <text>] [--public-actor <${[...PUBLIC_ACTORS].join('|')}>] [--workdir <path>] [--json]`,
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
): CreateIssueActionBinding | null {
  let liveRevision = '';
  try {
    const live = fetchIssueRevision(defaultGhTransport(), opts.repo, issueNumber);
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
  const observed = artifactBindingFromState(opts, reviewDir, issueNumber);
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
): { cause: string; blocker?: string; reason?: CreateIssueZeroSendReason; nextAction: CreateIssueNextAction | null; pause?: unknown } | null {
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
  return projected;
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
    return projectBlockedOnToExternalPause(blockedOn) as T & Record<string, unknown>;
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
    '--public-actor', opts.publicActor,
    '--json',
  ];
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
    const live = fetchIssueRevision(defaultGhTransport(), opts.repo, issueNumber);
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
  const observed = artifactBindingFromState({ ...opts, stageEvidencePaths: [] }, canonical.directory, issueNumber);
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

export function runStageFinalizeCli(argv: string[], artifactSourceTransport?: GhTransport): number {
  return runParsedCli(argv, 'create-issue-stage-finalize', parseStageFinalizeArgs, (opts) => {
    if (opts.command === 'bind-published-comment') {
      const issueNumber = parseRequiredPositiveInt(String(opts.issueNumber || ''), '--issue-number');
      const reviewDir = parseRequiredNonEmptyString(opts.reviewDir, '--review-dir');
      if (opts.stageEvidencePaths.length !== 1) {
        process.stderr.write('create-issue-stage-finalize: bind-published-comment requires exactly one --stage-evidence\n');
        return 2;
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
      if (opts.json) console.log(JSON.stringify(result));
      else if (!result.ok) process.stderr.write(result.errors.join('\n') + '\n');
      return result.ok ? 0 : 1;
    }

    if (opts.command === 'reconcile-stage') {
      const issueNumber = parseRequiredPositiveInt(String(opts.issueNumber || ''), '--issue-number');
      const reviewDir = parseRequiredNonEmptyString(opts.reviewDir, '--review-dir');
      if (opts.stageEvidencePaths.length !== 1) {
        process.stderr.write('create-issue-stage-finalize: reconcile-stage requires exactly one --stage-evidence\n');
        return 2;
      }
      const stageEvidencePath = parseRequiredNonEmptyString(opts.stageEvidencePaths[0], '--stage-evidence');
      const deterministicTerminal = readEvidenceZeroSendTerminal(stageEvidencePath);
      if (deterministicTerminal?.policy.class === 'deterministic-input') {
        const projected = zeroSendTerminalProjection(deterministicTerminal, opts.repo, issueNumber);
        if (projected) {
          const output = validatedManagerSurfaceOutput(
            { ok: false, stageAttemptId: deterministicTerminal.stageAttemptId },
            projected.cause,
            null,
            projected.blocker,
            projected.reason,
            opts.blockedOn,
          );
          if (opts.json) console.log(JSON.stringify(output));
          else process.stderr.write((projected.blocker ?? projected.cause) + '\n');
          return 1;
        }
      }
      const stale = staleArtifactBinding(opts, reviewDir, issueNumber);
      if (stale) {
        if (opts.json) console.log(JSON.stringify(stale));
        else process.stderr.write('stale_next_action\n');
        return 1;
      }
      const result = reconcileCreateIssueStage({
        reviewDir,
        stageEvidencePath,
        repositoryFullName: opts.repo,
        issueNumber,
        ...(artifactSourceTransport ? { artifactSourceTransport } : {}),
      });
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
        if (result.ok && !result.alreadySettled) {
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
      const zeroSendProjection = zeroSendTerminal
        && (zeroSendTerminal.policy.class === 'deterministic-input' || zeroSendTerminal.policy.class === 'state-conflict')
        ? zeroSendTerminalProjection(zeroSendTerminal, opts.repo, issueNumber)
        : null;
      const output = validatedManagerSurfaceOutput(
        result,
        zeroSendProjection?.cause ?? result.temporary ?? 'reconciliation_failed',
        nextAction,
        result.ok ? undefined : (zeroSendProjection?.blocker ?? result.errors.join('; ')),
        zeroSendProjection?.reason,
        opts.blockedOn,
      );
      if (opts.json) console.log(JSON.stringify(output));
      else if (!result.ok) process.stderr.write(result.errors.join('\n') + '\n');
      return result.ok ? 0 : 1;
    }

    if (opts.command === 'produce-artifacts' || opts.command === 'check-artifacts') {
      const reviewDir = parseRequiredNonEmptyString(opts.reviewDir, '--review-dir');
      const issueNumber = artifactIssueNumber(opts, reviewDir);
      const stale = staleArtifactBinding(opts, reviewDir, issueNumber);
      if (stale) {
        if (opts.json) console.log(JSON.stringify(stale));
        else process.stderr.write('stale_next_action\n');
        return 1;
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
      };
      const result = opts.command === 'produce-artifacts'
        ? produceAcceptanceArtifacts(artifactOptions)
        : inspectAcceptanceArtifacts(artifactOptions);
      const binding = artifactBindingFromState(opts, reviewDir, issueNumber);
      let nextAction = null;
      if (binding && !result.ok) {
        const errors = 'errors' in result ? result.errors : result.missing.map((item) => item.reason);
        const external = errors.some((error) => error.includes('authority=author-owned')
          || error.includes('operator')
          || error.includes('stage_slot_consumed')
          || error.includes('stale_next_action'));
        if (!external) {
          nextAction = createIssueNextAction({
            kind: 'produce-acceptance-artifacts',
            binding,
            argv: artifactCommandArgv('produce-artifacts', opts, reviewDir, issueNumber, binding),
          });
        }
      }
      const output = validatedManagerSurfaceOutput(
        result,
        opts.command === 'check-artifacts' ? 'acceptance_artifact_check_failed' : 'acceptance_artifact_production_failed',
        nextAction,
        result.ok ? undefined : ('errors' in result ? result.errors : result.missing.map((item) => item.reason)).join('; '),
        undefined,
        opts.blockedOn,
      );
      if (opts.json) console.log(JSON.stringify(output));
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
      const deterministicTerminal = readCanonicalZeroSendTerminal({
        issueNumber,
        sourceRevision,
        stage,
      });
      if (deterministicTerminal?.policy.class === 'deterministic-input') {
        const projected = zeroSendTerminalProjection(deterministicTerminal, opts.repo, issueNumber);
        if (projected) {
          const output = validatedManagerSurfaceOutput(
            { ok: false, stageAttemptId: deterministicTerminal.stageAttemptId },
            projected.cause,
            null,
            projected.blocker,
            projected.reason,
            opts.blockedOn,
          );
          if (opts.json) console.log(JSON.stringify(output));
          else process.stderr.write((projected.blocker ?? projected.cause) + '\n');
          return 1;
        }
      }
      const stale = staleStartCycleBinding(opts, issueNumber);
      if (stale) {
        if (opts.json) console.log(JSON.stringify(stale));
        else process.stderr.write('stale_next_action\n');
        return 1;
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
        publicActor: opts.publicActor,
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
      const retryBinding = !result.ok && !hardFailure && result.stageAttemptId && result.eventKey
        ? {
            repository: opts.repo,
            issueNumber,
            sourceRevision,
            stage,
            stageAttemptId: result.stageAttemptId,
          } satisfies CreateIssueActionBinding
        : null;
      const nextAction = retryBinding
        ? createIssueNextAction({
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
      if (opts.json) console.log(JSON.stringify(output));
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
      const binding = stageReceiptActionBinding(opts.repo, issueNumber, receipt);
      const nextAction = !result.ok && result.projectionPendingRepair && result.eventKey && binding
        ? createIssueNextAction({
            kind: 'retry-stage-record-publication',
            binding,
            argv: retryPendingActionArgv(opts, issueNumber, binding),
          })
        : null;
      const output = validatedManagerSurfaceOutput(
        result,
        'stage_record_publication_failed',
        nextAction,
        result.ok ? undefined : stageDiagnosticBlocker(result),
        undefined,
        opts.blockedOn,
      );
      if (opts.json) console.log(JSON.stringify(output));
      else if (!result.ok) process.stderr.write(`${result.diagnostics.map((item) => item.message).join('\n')}\n`);
      return result.ok ? 0 : 1;
    }

    const stale = staleRetryPendingBinding(opts, issueNumber);
    if (stale) {
      if (opts.json) console.log(JSON.stringify(stale));
      else process.stderr.write('stale_next_action\n');
      return 1;
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
    const nextAction = recoveryBinding && recovery
      ? createIssueNextAction({
          kind: 'retry-start-cycle',
          binding: recoveryBinding,
          argv: poisonSuccessorStartCycleArgv(opts, issueNumber, recoveryBinding, recovery.tier),
        })
      : null;
    const output = validatedManagerSurfaceOutput(
      { ok, results },
      'stage_record_retry_exhausted',
      nextAction,
      ok ? undefined : results.flatMap((item) => item.diagnostics.map((diagnostic) => diagnostic.message)).join('; '),
      undefined,
      opts.blockedOn,
    );
    if (opts.json) console.log(JSON.stringify(output));
    else if (!ok) process.stderr.write((output.blocker ?? 'retry-pending failed') + '\n');
    return ok ? 0 : 1;
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
  const argv = [
    'node', '--experimental-strip-types', 'scripts/create-issue-final-acceptance.ts',
    '--repo', opts.repo,
    '--issue-number', String(issueNumber),
    '--review-dir', reviewDir,
    '--issue-revision', sourceRevision,
    '--public-actor', opts.publicActor,
    '--json',
  ];
  if (opts.workdir) argv.push('--workdir', opts.workdir);
  if (opts.externalPassReceiptPath) argv.push('--external-pass-receipt', opts.externalPassReceiptPath);
  for (const path of opts.claudeProducerEvidencePaths) argv.push('--claude-producer-evidence', path);
  appendFinalAcceptanceOperatorArgs(argv, opts);
  return createIssueNextAction({
    kind: 'retry-final-acceptance',
    binding,
    argv,
  });
}

function finalAcceptanceArtifactAction(
  opts: FinalAcceptanceCliOptions,
  issueNumber: number,
  reviewDir: string,
  binding: CreateIssueActionBinding,
): CreateIssueNextAction {
  const argv = [
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
  for (const path of opts.claudeProducerEvidencePaths) argv.push('--claude-producer-evidence', path);
  appendFinalAcceptanceOperatorArgs(argv, opts);
  return createIssueNextAction({
    kind: 'produce-acceptance-artifacts',
    binding,
    argv,
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
  return null;
}

export function runFinalAcceptanceCli(argv: string[]): number {
  return runParsedCli(argv, 'create-issue-final-acceptance', parseFinalAcceptanceArgs, (opts) => {
    const issueNumber = parseRequiredPositiveInt(String(opts.issueNumber || ''), '--issue-number');
    const reviewDir = parseRequiredNonEmptyString(opts.reviewDir, '--review-dir');
    const transport = defaultGhTransport();

    let liveIssue: ReturnType<typeof fetchIssueRevision>;
    try {
      liveIssue = fetchIssueRevision(transport, opts.repo, issueNumber);
    } catch (error) {
      const output = createIssueTerminalResult({
        ok: false,
        cause: 'source-unavailable',
        blocker: error instanceof Error ? error.message : String(error),
      });
      if (opts.json) console.log(JSON.stringify(output));
      else process.stderr.write(output.blocker + '\n');
      return 1;
    }
    const liveRevision = /<!--\s*source-revision:\s*(r[0-9]+)\s*-->/i.exec(liveIssue.body)?.[1];
    if (!liveRevision) {
      const output = createIssueTerminalResult({
        ok: false,
        cause: 'source-revision-unavailable',
        blocker: 'live Issue has no canonical source-revision marker',
      });
      if (opts.json) console.log(JSON.stringify(output));
      else process.stderr.write(output.blocker + '\n');
      return 1;
    }
    if (opts.issueRevision && opts.issueRevision !== liveRevision) {
      const output = createIssueStaleNextAction({
        binding: { repository: opts.repo, issueNumber, sourceRevision: opts.issueRevision, stage: 'acceptance' },
        observed: { repository: opts.repo, issueNumber, sourceRevision: liveRevision, stage: 'acceptance' },
        nextAction: null,
      });
      if (opts.json) console.log(JSON.stringify(output));
      else process.stderr.write('stale_next_action\n');
      return 1;
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
        : null;
      const output = nextAction
        ? createIssueRecoverableResult({
            cause: 'acceptance-input-missing',
            blocker: 'issue-rNN-body snapshot is missing or disagrees with the stable live Issue; field=issue snapshot authority=GitHub-witnessed',
            nextAction,
          })
        : createIssueTerminalResult({
            ok: false,
            cause: 'acceptance-input-missing',
            blocker: 'issue-rNN-body snapshot is missing or disagrees with the stable live Issue; field=issue snapshot authority=GitHub-witnessed',
          });
      if (opts.json) console.log(JSON.stringify(output));
      else process.stderr.write(output.blocker + '\n');
      return 1;
    }
    if (opts.issueBodyPath) {
      let asserted = '';
      try { asserted = readFileSync(opts.issueBodyPath, 'utf8'); } catch {}
      if (asserted !== liveIssue.body && resolve(opts.issueBodyPath) !== resolve(currentSnapshotPath)) {
        const output = createIssueTerminalResult({
          ok: false,
          cause: 'acceptance-authority-conflict',
          blocker: '--issue-body is assertion-only and does not match the canonical GitHub-witnessed snapshot',
        });
        if (opts.json) console.log(JSON.stringify(output));
        else process.stderr.write(output.blocker + '\n');
        return 1;
      }
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
      const output = createIssueTerminalResult({
        ok: false,
        cause: 'acceptance-input-missing',
        blocker: 'canonical terminal stage receipt is missing',
      });
      if (opts.json) console.log(JSON.stringify(output));
      else process.stderr.write(output.blocker + '\n');
      return 1;
    }
    const terminalSnapshotPath = join(reviewDir, 'issue-' + terminal.value.sourceRevision + '-body.json');
    let terminalSnapshot: Record<string, unknown> | null = null;
    try { terminalSnapshot = JSON.parse(readFileSync(terminalSnapshotPath, 'utf8')) as Record<string, unknown>; } catch { terminalSnapshot = null; }
    if (!terminalSnapshot || terminalSnapshot.schema !== 'create-issue-live-snapshot/v1' || typeof terminalSnapshot.body !== 'string') {
      const output = createIssueTerminalResult({
        ok: false,
        cause: 'acceptance-input-missing',
        blocker: 'terminal source Issue snapshot is missing; field=terminalSourceBody authority=GitHub-witnessed',
      });
      if (opts.json) console.log(JSON.stringify(output));
      else process.stderr.write(output.blocker + '\n');
      return 1;
    }

    if (opts.stageReceipts.length > 0) {
      const requested = opts.stageReceipts.map((path) => resolve(path)).sort();
      const canonical = canonicalReceiptPaths.map((path) => resolve(path)).sort();
      if (JSON.stringify(requested) !== JSON.stringify(canonical)) {
        const output = createIssueTerminalResult({
          ok: false,
          cause: 'acceptance-authority-conflict',
          blocker: 'caller stage-receipt list does not equal canonical receipt inventory',
        });
        if (opts.json) console.log(JSON.stringify(output));
        else process.stderr.write(output.blocker + '\n');
        return 1;
      }
    }
    if (opts.cycleId && opts.cycleId !== terminal.value.cycleId) {
      const output = createIssueTerminalResult({
        ok: false,
        cause: 'acceptance-authority-conflict',
        blocker: 'caller cycle-id disagrees with lifecycle terminal receipt',
      });
      if (opts.json) console.log(JSON.stringify(output));
      else process.stderr.write(output.blocker + '\n');
      return 1;
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
      publicActor: opts.publicActor,
      workdir: opts.workdir,
    });

    const terminalBinding: CreateIssueActionBinding = {
      repository: opts.repo,
      issueNumber,
      sourceRevision: liveRevision,
      stage: 'architectural',
      stageAttemptId: terminal.value.stageAttemptId,
    };
    const recoveryAction = finalAcceptanceRecoveryAction(
      opts,
      issueNumber,
      reviewDir,
      liveRevision,
      terminalBinding,
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
    if (opts.json) console.log(JSON.stringify(output));
    else if (!result.ok) {
      for (const error of result.guardErrors) process.stderr.write(error + '\n');
      for (const diagnostic of result.diagnostics) process.stderr.write(diagnostic.message + '\n');
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
