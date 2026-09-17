import { releaseCdpBrowser } from './browser-session.ts';
import { classifyOwnedMessageDeliveryTimeout } from './message-delivery-timeout.ts';
import { classifyProductMessage } from './product-page-selectors.ts';
import { configuredProfileKey } from './storage-common.ts';
import {
  readStateLightTurnObservation,
  type StateLightTurnObservationRecord,
} from './state-light-turn-observation.ts';
import { recoveryMarkerCardinality } from './state-light-turn-recovery.ts';
import {
  readPageObservation,
  resolveOwnedReplyWindow,
} from './state-light-turn.ts';
import {
  loadChromium,
  normalizeConversationUrl,
  productStatusText,
  verifyProfile,
  type BrowserConfig,
  type ProductStatusSurface,
} from './ui-adapter.ts';

export const EXECUTION_TIMEOUT_CHECKPOINT_SCHEMA = 'execute-issue-timeout-checkpoint-observation/v1' as const;

export type ExecutionTimeoutCheckpointClassification =
  | 'message_delivery_timed_out'
  | 'owned_reply_generating'
  | 'owned_reply_completed'
  | 'owned_turn_unsettled'
  | 'ambiguous';

export interface ExecutionTimeoutCheckpointObservation {
  readonly schema: typeof EXECUTION_TIMEOUT_CHECKPOINT_SCHEMA;
  readonly classification: ExecutionTimeoutCheckpointClassification;
  readonly cause: string;
  readonly invocation_id: string;
  readonly configured_profile_key: string;
  readonly conversation_id?: string;
  readonly send_count?: number;
}

interface CheckpointSample {
  readonly classification:
    | 'timeout_candidate'
    | 'owned_reply_generating'
    | 'owned_reply_completed'
    | 'owned_turn_unsettled'
    | 'ambiguous';
  readonly cause: string;
}

export interface ExecutionTimeoutCheckpointDependencies {
  readonly readObservation?: typeof readStateLightTurnObservation;
  readonly verifyProfile?: typeof verifyProfile;
  readonly connectOverCDP?: (cdp: string, timeoutMs: number) => Promise<any>;
  readonly releaseBrowser?: (browser: unknown) => Promise<void>;
  readonly readPage?: typeof readPageObservation;
  readonly readProductStatus?: (page: any, waitSource?: number | (() => number)) => Promise<ProductStatusSurface>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

const CHECKPOINT_READ_BUDGET_MS = 5_000;
const CHECKPOINT_STABILITY_DELAY_MS = 100;

function optionValue(argv: readonly string[], key: string): string | undefined {
  const flag = `--${key}`;
  let found: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== flag) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--') || found !== undefined) return undefined;
    found = value;
  }
  return found;
}

function requiredOption(argv: readonly string[], key: string): string {
  const value = optionValue(argv, key);
  if (!value) throw new Error(`checkpoint_argument_required:${key}`);
  return value;
}

function rejectUnknownOptions(argv: readonly string[]): void {
  const allowed = new Set(['--profile', '--cdp', '--invocation-id']);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith('--') || !allowed.has(token)) {
      throw new Error(`checkpoint_argument_unknown:${token}`);
    }
    index += 1;
  }
}

function resultFor(
  classification: ExecutionTimeoutCheckpointClassification,
  cause: string,
  invocationId: string,
  profileKey: string,
  record?: StateLightTurnObservationRecord,
): ExecutionTimeoutCheckpointObservation {
  return {
    schema: EXECUTION_TIMEOUT_CHECKPOINT_SCHEMA,
    classification,
    cause,
    invocation_id: invocationId,
    configured_profile_key: profileKey,
    ...(record?.conversation_url ? { conversation_id: record.conversation_url } : {}),
    ...(record?.send_count !== undefined ? { send_count: record.send_count } : {}),
  };
}

function pageConversationMatches(page: any, conversationUrl: string): boolean {
  try {
    return normalizeConversationUrl(String(page.url())) === conversationUrl;
  } catch {
    return false;
  }
}

async function sampleOwnedTurn(
  page: any,
  record: StateLightTurnObservationRecord,
  deps: Required<Pick<ExecutionTimeoutCheckpointDependencies, 'readPage' | 'readProductStatus' | 'now'>>,
): Promise<CheckpointSample> {
  const deadlineMs = deps.now() + CHECKPOINT_READ_BUDGET_MS;
  const observation = await deps.readPage(
    page,
    record.marker,
    0,
    true,
    deadlineMs,
  );
  if (observation.transcriptIncomplete || !observation.snapshot.complete) {
    return { classification: 'ambiguous', cause: 'checkpoint_transcript_incomplete' };
  }

  const cardinality = recoveryMarkerCardinality(observation.messages, record.marker);
  if (
    cardinality.matchingUserCarrierCount !== 1
    || cardinality.exactMarkerTokenCount !== 1
  ) {
    return { classification: 'ambiguous', cause: 'checkpoint_owned_marker_ambiguous' };
  }

  const replyWindow = resolveOwnedReplyWindow(observation.messages, 0, record.marker);
  if (replyWindow.uncertainCause) {
    return { classification: 'ambiguous', cause: `checkpoint_${replyWindow.uncertainCause}` };
  }

  const generation = observation.pageTurnEvidence?.generationInProgress ?? 'unknown';
  if (generation === true) {
    return { classification: 'owned_reply_generating', cause: 'owned_reply_still_generating' };
  }

  const assistants = replyWindow.replyWindow.filter((message) => message.role === 'assistant');
  const finalAssistantText = assistants.at(-1)?.text.trim() ?? '';
  if (assistants.length > 0 && observation.ownedWindowCompletionReady && finalAssistantText) {
    return { classification: 'owned_reply_completed', cause: 'attributable_completed_reply_observed' };
  }

  const remainingMs = (): number => Math.max(0, deadlineMs - deps.now());
  const surface = await deps.readProductStatus(page, remainingMs);
  const ownedTimeout = classifyOwnedMessageDeliveryTimeout({
    surface,
    marker: record.marker,
    transcriptComplete: true,
    generationInProgress: generation,
    messages: observation.messages,
  });
  if (ownedTimeout.state === 'message_delivery_timed_out') {
    return { classification: 'timeout_candidate', cause: 'message_delivery_timed_out' };
  }

  if (generation === 'unknown') {
    return { classification: 'ambiguous', cause: 'checkpoint_generation_state_unknown' };
  }
  if (classifyProductMessage(surface).state === 'message_delivery_timed_out') {
    return { classification: 'ambiguous', cause: 'checkpoint_timeout_ownership_or_reply_state_unproven' };
  }
  if (assistants.length > 0) {
    return { classification: 'owned_turn_unsettled', cause: 'owned_reply_present_but_not_complete' };
  }
  return { classification: 'owned_turn_unsettled', cause: 'owned_turn_not_terminal' };
}

function settleSample(
  sample: CheckpointSample,
  invocationId: string,
  profileKey: string,
  record: StateLightTurnObservationRecord,
): ExecutionTimeoutCheckpointObservation {
  const classification = sample.classification === 'timeout_candidate'
    ? 'ambiguous'
    : sample.classification;
  const cause = sample.classification === 'timeout_candidate'
    ? 'checkpoint_timeout_stability_unproven'
    : sample.cause;
  return resultFor(classification, cause, invocationId, profileKey, record);
}

export async function observeExecutionTimeoutCheckpoint(
  argv: readonly string[],
  dependencies: ExecutionTimeoutCheckpointDependencies = {},
): Promise<ExecutionTimeoutCheckpointObservation> {
  let invocationId = optionValue(argv, 'invocation-id') ?? '';
  let profileKey = 'profile-unresolved';
  let record: StateLightTurnObservationRecord | undefined;
  let browser: unknown;

  const readObservation = dependencies.readObservation ?? readStateLightTurnObservation;
  const verify = dependencies.verifyProfile ?? verifyProfile;
  const connect = dependencies.connectOverCDP ?? (async (cdp: string, timeoutMs: number) => {
    const chromium = loadChromium();
    return await chromium.connectOverCDP(cdp, { timeout: timeoutMs });
  });
  const releaseBrowser = dependencies.releaseBrowser ?? releaseCdpBrowser;
  const readPage = dependencies.readPage ?? readPageObservation;
  const readProductStatus = dependencies.readProductStatus ?? productStatusText;
  const sleep = dependencies.sleep ?? (async (milliseconds: number) => {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  });
  const now = dependencies.now ?? (() => Date.now());

  try {
    rejectUnknownOptions(argv);
    const profile = requiredOption(argv, 'profile');
    const cdp = requiredOption(argv, 'cdp');
    invocationId = requiredOption(argv, 'invocation-id');
    profileKey = configuredProfileKey(profile, cdp);
    record = readObservation(profileKey, invocationId);

    if (record.phase === 'harvested') {
      return resultFor(
        'owned_reply_completed',
        'turn_already_harvested',
        invocationId,
        profileKey,
        record,
      );
    }
    if (record.phase !== 'sent_unharvested'
      || record.send_count !== 1
      || !record.conversation_url) {
      return resultFor(
        'ambiguous',
        'checkpoint_sent_turn_binding_unavailable',
        invocationId,
        profileKey,
        record,
      );
    }

    const conversationUrl = normalizeConversationUrl(record.conversation_url);
    const config: BrowserConfig = {
      cdp,
      profile,
      newChat: false,
      chatUrl: conversationUrl,
      timeoutMs: CHECKPOINT_READ_BUDGET_MS,
    };
    const verified = await verify(config);
    if (verified.state !== 'verified') {
      return resultFor(
        'ambiguous',
        `checkpoint_profile_${verified.state}`,
        invocationId,
        profileKey,
        record,
      );
    }

    browser = await connect(cdp, CHECKPOINT_READ_BUDGET_MS);
    const contexts = (browser as { contexts: () => any[] }).contexts();
    if (!Array.isArray(contexts) || contexts.length !== 1) {
      return resultFor('ambiguous', 'checkpoint_context_count_unproven', invocationId, profileKey, record);
    }
    const pages = contexts[0].pages();
    if (!Array.isArray(pages)) {
      return resultFor('ambiguous', 'checkpoint_page_census_unavailable', invocationId, profileKey, record);
    }
    const exactPages = pages.filter((page: any) => pageConversationMatches(page, conversationUrl));
    if (exactPages.length !== 1) {
      return resultFor('ambiguous', 'checkpoint_exact_page_not_unique', invocationId, profileKey, record);
    }
    const page = exactPages[0]!;

    const sampleDeps = { readPage, readProductStatus, now };
    const first = await sampleOwnedTurn(page, record, sampleDeps);
    if (first.classification !== 'timeout_candidate') {
      return settleSample(first, invocationId, profileKey, record);
    }

    await sleep(CHECKPOINT_STABILITY_DELAY_MS);
    if (!pageConversationMatches(page, conversationUrl)) {
      return resultFor('ambiguous', 'checkpoint_page_identity_changed', invocationId, profileKey, record);
    }
    const second = await sampleOwnedTurn(page, record, sampleDeps);
    if (second.classification !== 'timeout_candidate') {
      return settleSample(second, invocationId, profileKey, record);
    }

    return resultFor(
      'message_delivery_timed_out',
      'message_delivery_timed_out',
      invocationId,
      profileKey,
      record,
    );
  } catch (error) {
    return resultFor(
      'ambiguous',
      error instanceof Error ? error.message : 'checkpoint_observation_failed',
      invocationId,
      profileKey,
      record,
    );
  } finally {
    if (browser) await releaseBrowser(browser);
  }
}

export async function runExecutionTimeoutCheckpoint(
  argv: readonly string[],
  dependencies: ExecutionTimeoutCheckpointDependencies = {},
): Promise<number> {
  const observation = await observeExecutionTimeoutCheckpoint(argv, dependencies);
  process.stdout.write(`${JSON.stringify(observation)}\n`);
  return observation.classification === 'ambiguous' ? 2 : 0;
}
