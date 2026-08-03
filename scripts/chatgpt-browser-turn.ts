#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  controlExitCode,
  publicationExitCode,
  turnExitCode,
  type ControlResultV1,
  type FailureScope,
  type PublicationStatusV1,
  type TurnResultV1,
  type TurnState,
} from './chatgpt-browser-turn/contracts.ts';
import {
  acquireDomainLock,
  clearDomainLock,
  destinationIdentity,
  reserveDestination,
  type DestinationReservation,
  type DomainLock,
} from './chatgpt-browser-turn/coordination.ts';
import {
  boundedResourceCleanup,
  closeOwnedTurnPage,
  connectCdpBrowser,
  releaseCdpBrowser,
  RESOURCE_CLEANUP_BOUND_MS,
  trimExcessCdpPageTargets,
} from './chatgpt-browser-turn/browser-session.ts';
import { probeProfileReady } from './chatgpt-browser-turn/profile-probe.ts';
import { publicationStatus, publishReply } from './chatgpt-browser-turn/publication.ts';
import { runtimeCapabilityBinding } from './chatgpt-browser-turn/runtime-binding.ts';
import {
  adjudicateTombstone,
  capabilityStatus,
  clearReadable,
  deleteIncident,
  applyCapabilityAfterSuccessfulTurn,
  mutateCapabilityAdmissionPolicy,
  listReadableIncidents,
  quarantineOpaque,
  profileStartupCompatibility,
  statusList,
  statusListForConfiguredProfile,
  updateIncident,
  writeIncident,
} from './chatgpt-browser-turn/state.ts';
import { configuredProfileKey, legacyProfileKeyAmbiguous, profileNamespaceExists, resolveConfiguredProfile, sha256 } from './chatgpt-browser-turn/storage-common.ts';
import {
  runGateBCharacterization,
  bindGateBCharacterizationRecord,
  writeGateBCharacterizationRecord,
} from './chatgpt-browser-turn/dispatch-observation.ts';
import { recordSwallowedDriverException } from './chatgpt-browser-turn/diagnostics.ts';
import { readStableInput } from './chatgpt-browser-turn/input.ts';
import { publishStateLightReply } from './chatgpt-browser-turn/state-light-turn.ts';
import {
  directPublicationReceipt,
  reviewerSourceMetadata,
  validateDirectPublicationInputs,
  type DirectPublicationConfig,
} from './chatgpt-browser-turn/terminal-witness.ts';
import {
  BrowserOperationTimeoutError,
  browserOperationClassFromError,
  coerceBrowserOperationTimeout,
  createFreshIdentityRetention,
  createPreSendSegmentBudget,
  loadChromium,
  normalizeConversationUrl,
  openGateBCharacterizationPage,
  openTurnPage,
  resolveCanonicalFreshConversation,
  runtimeWitnessSurfaceAvailable,
  sendTurn,
  type BrowserConfig,
  witnessSurfaceProbeRequiresDowngrade,
  type WitnessSurfaceProbe,
  verifyProfile,
} from './chatgpt-browser-turn/ui-adapter.ts';

const DEFAULT_TIMEOUT_MS = 1_800_000;
const STALE_PRE_SEND_MS = 120_000;
const BOOLEAN_OPTIONS = new Set(['new-chat', 'quarantine', 'adjudicate']);

interface ParsedArgs {
  readonly command: string;
  readonly options: Map<string, string | true>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0] ?? '';
  const options = new Map<string, string | true>();
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (!token?.startsWith('--') || token.length <= 2) throw new Error('argument_invalid');
    const key = token.slice(2);
    if (options.has(key)) throw new Error('argument_duplicate');
    if (BOOLEAN_OPTIONS.has(key)) {
      options.set(key, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('argument_value_missing');
    options.set(key, value);
    index++;
  }
  return { command, options };
}

function option(args: ParsedArgs, key: string): string | undefined {
  const value = args.options.get(key);
  return typeof value === 'string' ? value : undefined;
}

function required(args: ParsedArgs, key: string): string {
  const value = option(args, key);
  if (!value) throw new Error(`argument_required:${key}`);
  return value;
}

function flag(args: ParsedArgs, key: string): boolean {
  return args.options.get(key) === true;
}

function assertAllowedOptions(args: ParsedArgs, allowed: readonly string[]): void {
  const set = new Set(allowed);
  for (const key of args.options.keys()) if (!set.has(key)) throw new Error(`argument_unknown:${key}`);
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function turnResult(
  state: TurnState,
  scope: FailureScope,
  cause: string,
  invocationId: string,
  profileKey: string,
  extra: Partial<TurnResultV1> = {},
): TurnResultV1 {
  return {
    schema: 'turn-result/v1',
    state,
    scope,
    cause,
    invocation_id: invocationId,
    configured_profile_key: profileKey,
    ...extra,
  };
}

function controlResult(operation: ControlResultV1['operation'], state: string, profileKey: string, cause?: string): ControlResultV1 {
  return {
    schema: 'control-result/v1',
    operation,
    state,
    configured_profile_key: profileKey,
    ...(cause ? { cause } : {}),
  };
}

function parseInteger(value: string, minimum = 0): number {
  if (!/^\d+$/.test(value)) throw new Error('argument_integer_invalid');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error('argument_integer_invalid');
  return parsed;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeRelease(lock: DomainLock | null | undefined): void {
  if (!lock) return;
  try {
    lock.release();
  } catch {
    // Durable state remains authoritative when cleanup cannot prove ownership.
  }
}

function safeReleaseDestination(reservation: DestinationReservation | null | undefined): void {
  if (!reservation) return;
  try {
    reservation.release();
  } catch {
    // Durable state remains authoritative when cleanup cannot prove ownership.
  }
}

function tryDeleteActiveOwnerIncident(
  profileKey: string,
  incidentId: string | undefined,
): { incidentId: string | undefined; incidentCleanupFailed: boolean } {
  if (!incidentId) {
    return { incidentId: undefined, incidentCleanupFailed: false };
  }
  try {
    deleteIncident(profileKey, incidentId);
    return { incidentId: undefined, incidentCleanupFailed: false };
  } catch {
    return { incidentId, incidentCleanupFailed: true };
  }
}



async function probeLiveBrowserProvenance(cdp: string): Promise<string> {
  const chromium = loadChromium();
  const browser = await chromium.connectOverCDP(cdp);
  try {
    return String(browser.version?.() ?? 'chromium-cdp');
  } finally {
    await releaseCdpBrowser(browser);
  }
}

function stalePreSendOwner(record: ReturnType<typeof listReadableIncidents>[number]['record']): boolean {
  if (record.kind !== 'active_owner' || record.phase !== 'pre_send' || !record.owner) return false;
  const updated = Date.parse(record.updated_at);
  return Number.isFinite(updated)
    && Date.now() - updated >= STALE_PRE_SEND_MS
    && !pidAlive(record.owner.pid);
}

function reclaimSafePreSend(profileKey: string): void {
  let incidents: ReturnType<typeof listReadableIncidents>;
  try {
    incidents = listReadableIncidents(profileKey);
  } catch {
    return;
  }
  for (const { identity, record } of incidents) {
    if (!stalePreSendOwner(record)) continue;
    if (record.output_identity) clearDomainLock(profileKey, `destination:${record.output_identity}`);
    clearReadable(profileKey, identity, record.generation, record.evidence_token);
  }
}

function wallState(cause: string | undefined): TurnState {
  if (cause === 'quota') return 'quota';
  if (cause === 'challenge') return 'challenge';
  if (cause === 'login') return 'login';
  if (cause === 'profile_mismatch') return 'profile_mismatch';
  if (cause === 'chrome_not_running') return 'chrome_not_running';
  return 'profile_busy';
}

function findProfileWall(profileKey: string): ReturnType<typeof listReadableIncidents>[number] | undefined {
  try {
    return listReadableIncidents(profileKey).find(({ record }) => record.kind === 'profile_wall');
  } catch {
    return undefined;
  }
}

function ensureProfileWall(profileKey: string, cause: TurnState): { identity: string; generation: number } {
  const existing = findProfileWall(profileKey);
  if (existing) return { identity: existing.identity, generation: existing.record.generation };
  const lock = acquireDomainLock(profileKey, `profile-wall:${profileKey}`);
  if (!lock) {
    const raced = findProfileWall(profileKey);
    if (raced) return { identity: raced.identity, generation: raced.record.generation };
    throw new Error('profile_wall_race');
  }
  try {
    const raced = findProfileWall(profileKey);
    if (raced) return { identity: raced.identity, generation: raced.record.generation };
    const created = writeIncident(profileKey, {
      kind: 'profile_wall',
      generation: 1,
      phase: 'pre_send',
      cause,
    });
    return { identity: created.identity, generation: created.record.generation };
  } finally {
    safeRelease(lock);
  }
}

function blockerBeforeSend(
  profileKey: string,
  outputIdentity: string,
  conversationId?: string,
): { state: TurnState; scope: FailureScope; cause: string; incidentId?: string; generation?: number } | null {
  const listed = statusList(profileKey);
  if (listed.state === 'profile_blocked') {
    return { state: 'incompatible_record', scope: 'profile', cause: 'configured_profile_store_blocked' };
  }
  let incidents: ReturnType<typeof listReadableIncidents>;
  try {
    incidents = listReadableIncidents(profileKey);
  } catch {
    return { state: 'incompatible_record', scope: 'profile', cause: 'configured_profile_store_blocked' };
  }
  const wall = incidents.find(({ record }) => record.kind === 'profile_wall');
  if (wall) {
    return {
      state: wallState(wall.record.cause),
      scope: 'profile',
      cause: 'profile_wall_active',
      incidentId: wall.identity,
      generation: wall.record.generation,
    };
  }
  const orphan = incidents.find(({ record }) => record.kind === 'fresh_orphan');
  if (orphan) {
    return {
      state: 'orphaned_fresh_turn',
      scope: 'profile',
      cause: 'fresh_orphan_unresolved',
      incidentId: orphan.identity,
      generation: orphan.record.generation,
    };
  }
  const outputBlock = incidents.find(({ record }) => record.output_identity === outputIdentity && record.phase !== 'pre_send');
  if (outputBlock) {
    return {
      state: 'recovery_required',
      scope: 'blocking_domain',
      cause: 'destination_bound_to_unresolved_delivery',
      incidentId: outputBlock.identity,
      generation: outputBlock.record.generation,
    };
  }
  if (conversationId) {
    const conversationBlock = incidents.find(({ record }) => record.conversation_id === conversationId);
    if (conversationBlock) {
      return {
        state: 'conversation_busy',
        scope: 'conversation',
        cause: 'conversation_incident_active',
        incidentId: conversationBlock.identity,
        generation: conversationBlock.record.generation,
      };
    }
  }
  return null;
}

function browserConfig(args: ParsedArgs): BrowserConfig {
  const cdp = required(args, 'cdp');
  const profile = required(args, 'profile');
  const newChat = flag(args, 'new-chat');
  const timeoutRaw = option(args, 'timeout-ms');
  const timeoutMs = timeoutRaw ? parseInteger(timeoutRaw, 1) : DEFAULT_TIMEOUT_MS;
  const chatUrl = option(args, 'chat-url');
  const projectUrl = option(args, 'project-url');
  if (newChat === Boolean(chatUrl)) throw new Error('argument_mode_invalid');
  if (newChat && !projectUrl) throw new Error('argument_required:project-url');
  return { cdp, profile, newChat, timeoutMs, ...(chatUrl ? { chatUrl } : {}), ...(projectUrl ? { projectUrl } : {}) };
}

function directPublicationConfig(
  args: ParsedArgs,
  invocationId: string,
  prompt: string,
): DirectPublicationConfig | undefined {
  const sourceOutput = option(args, 'reviewer-source-output');
  const directKeys = ['invocation-id', 'reviewer-source', 'repository', 'issue-number', 'source-revision'];
  if (!sourceOutput) {
    if (directKeys.some((key) => args.options.has(key))) throw new Error('input_invalid:direct_publication_requires_source_output');
    return undefined;
  }
  const repositoryFullName = required(args, 'repository');
  const issueNumber = parseInteger(required(args, 'issue-number'), 1);
  const sourceRevision = required(args, 'source-revision');
  const reviewerSource = required(args, 'reviewer-source');
  const validation = validateDirectPublicationInputs({ invocationId, prompt, reviewerSource, repositoryFullName, issueNumber, sourceRevision });
  if (validation) throw new Error(`input_invalid:${validation}`);
  return {
    target: { repositoryFullName, issueNumber, sourceRevision, invocationId },
    reviewerSource,
    reviewerSourceOutput: sourceOutput,
  };
}

function canonicalConversationFromOpenedPage(
  config: BrowserConfig,
  opened: { page: any } | undefined,
  freshIdentity?: ReturnType<typeof createFreshIdentityRetention>,
  retainedUserMessageId?: string,
): string | undefined {
  if (!config.newChat || !config.projectUrl) return undefined;
  return resolveCanonicalFreshConversation(
    config,
    freshIdentity,
    opened?.page,
    undefined,
    retainedUserMessageId,
  );
}

function emitTurnAndCode(result: TurnResultV1): number {
  emit(result);
  return turnExitCode(result.state);
}

async function runTurn(args: ParsedArgs): Promise<number> {
  assertAllowedOptions(args, [
    'profile', 'cdp', 'input', 'output', 'chat-url', 'new-chat', 'project-url', 'timeout-ms',
    'invocation-id', 'reviewer-source-output', 'reviewer-source', 'repository', 'issue-number', 'source-revision',
  ]);
  const invocationId = option(args, 'invocation-id') ?? randomUUID();
  let profileKey = 'profile-unresolved';
  let reservation: DestinationReservation | null = null;
  let scheduleLock: DomainLock | null = null;
  let incidentId: string | undefined;
  let possibleDelivery = false;
  let opened: { page: any; owned: boolean; provisionalId?: string } | undefined;
  let browser: any = null;
  let config: BrowserConfig | undefined;
  const freshIdentity = createFreshIdentityRetention((canonicalConversationId) => {
    if (!incidentId || profileKey === 'profile-unresolved') {
      throw new Error('fresh_identity_retention_before_incident');
    }
    updateIncident(profileKey, incidentId, { conversation_id: canonicalConversationId });
  });
  let retainedUserMessageId: string | undefined;

  try {
    const baseConfig = browserConfig(args);
    const snapshot = readStableInput(required(args, 'input'));
    const direct = directPublicationConfig(args, invocationId, snapshot.text);
    const directDestination = direct ? destinationIdentity(direct.reviewerSourceOutput) : undefined;
    config = direct ? { ...baseConfig, directPublication: direct } : baseConfig;
    profileKey = configuredProfileKey(config.profile, config.cdp);
    const startupCompatibility = profileStartupCompatibility(config.profile, config.cdp);
    if (startupCompatibility) {
      return emitTurnAndCode(turnResult(
        'incompatible_record',
        'profile',
        startupCompatibility.cause ?? 'legacy_profile_namespace_active',
        invocationId,
        profileKey,
        {
          legacy_configured_profile_key: startupCompatibility.legacy_configured_profile_key,
          legacy_namespace_root: startupCompatibility.legacy_namespace_root,
        },
      ));
    }
    const destination = destinationIdentity(required(args, 'output'));
    if (direct && directDestination?.finalPath === destination.finalPath) {
      throw new Error('input_invalid:direct_publication_artifact_alias');
    }
    const conversationId = config.chatUrl ? normalizeConversationUrl(config.chatUrl) : undefined;

    reclaimSafePreSend(profileKey);
    const initialBlocker = blockerBeforeSend(profileKey, destination.identity, conversationId);
    if (initialBlocker) {
      return emitTurnAndCode(turnResult(
        initialBlocker.state,
        initialBlocker.scope,
        initialBlocker.cause,
        invocationId,
        profileKey,
        {
          ...(conversationId ? { conversation_id: conversationId } : {}),
          ...(initialBlocker.incidentId ? { incident_id: initialBlocker.incidentId } : {}),
          ...(initialBlocker.generation ? { generation: initialBlocker.generation } : {}),
        },
      ));
    }

    reservation = reserveDestination(profileKey, destination.finalPath);
    const racedBlocker = blockerBeforeSend(profileKey, reservation.identity, conversationId);
    if (racedBlocker) {
      safeReleaseDestination(reservation);
      reservation = null;
      return emitTurnAndCode(turnResult(
        racedBlocker.state,
        racedBlocker.scope,
        racedBlocker.cause,
        invocationId,
        profileKey,
        {
          ...(conversationId ? { conversation_id: conversationId } : {}),
          ...(racedBlocker.incidentId ? { incident_id: racedBlocker.incidentId } : {}),
          ...(racedBlocker.generation ? { generation: racedBlocker.generation } : {}),
        },
      ));
    }

    const segmentBudget = createPreSendSegmentBudget(config.timeoutMs);
    const verification = await verifyProfile(config, segmentBudget);
    if (verification.state !== 'verified') {
      const state: TurnState = verification.state === 'unavailable' ? 'chrome_not_running' : 'profile_mismatch';
      const wall = ensureProfileWall(profileKey, state);
      safeReleaseDestination(reservation);
      reservation = null;
      return emitTurnAndCode(turnResult(state, 'profile', verification.cause, invocationId, profileKey, {
        incident_id: wall.identity,
        generation: wall.generation,
      }));
    }

    const expectedBinding = runtimeCapabilityBinding(profileKey, config.cdp);
    const capabilityAtSchedule = capabilityStatus(profileKey, expectedBinding);
    const lockKey = conversationId ? `conversation:${conversationId}` : `fresh:${randomUUID()}`;
    scheduleLock = acquireDomainLock(profileKey, lockKey, 120_000, {
      admissionRetryDeadlineMs: segmentBudget.endsAtMs,
    });
    if (!scheduleLock) {
      safeReleaseDestination(reservation);
      reservation = null;
      const state: TurnState = conversationId ? 'conversation_busy' : 'driver_error';
      const scope: FailureScope = conversationId ? 'conversation' : 'machine';
      return emitTurnAndCode(turnResult(state, scope, 'scheduling_lock_busy', invocationId, profileKey, {
        ...(conversationId ? { conversation_id: conversationId } : {}),
      }));
    }

    const chromium = loadChromium();
    const connectWaitMs = segmentBudget.clampOperationWaitMs();
    if (connectWaitMs <= 0) throw new BrowserOperationTimeoutError('connect_over_cdp');
    const connectPromise = chromium.connectOverCDP(config.cdp, { timeout: connectWaitMs });
    try {
      browser = await connectPromise;
    } catch (connectError) {
      connectPromise
        .then((lateBrowser: unknown) => releaseCdpBrowser(lateBrowser, RESOURCE_CLEANUP_BOUND_MS))
        .catch(() => {});
      throw coerceBrowserOperationTimeout(connectError, 'connect_over_cdp');
    }
    const browserProvenance = String(browser.version?.() ?? 'chromium-cdp');
    const storedProvenance = capabilityAtSchedule.capability?.browser_provenance;
    const provenanceDriftObserved = Boolean(
      storedProvenance
      && storedProvenance !== browserProvenance,
    );
    opened = await openTurnPage(browser, config, { segmentBudget });
    const turnPage = opened.page;

    const freshConversation = config.newChat;
    const witnessSurfaceProbe: WitnessSurfaceProbe = await runtimeWitnessSurfaceAvailable(turnPage, segmentBudget);
    if (witnessSurfaceProbeRequiresDowngrade(witnessSurfaceProbe, freshConversation)) {
      await closeOwnedTurnPage(opened, { retainPage: false });
      safeRelease(scheduleLock);
      scheduleLock = null;
      safeReleaseDestination(reservation);
      reservation = null;
      return emitTurnAndCode(turnResult('driver_error', 'invocation', 'pre_send_witness_unavailable', invocationId, profileKey));
    }

    const finalBlocker = blockerBeforeSend(profileKey, reservation.identity, conversationId);
    if (finalBlocker) {
      await closeOwnedTurnPage(opened, { retainPage: false });
      safeRelease(scheduleLock);
      scheduleLock = null;
      safeReleaseDestination(reservation);
      reservation = null;
      return emitTurnAndCode(turnResult(
        finalBlocker.state,
        finalBlocker.scope,
        finalBlocker.cause,
        invocationId,
        profileKey,
        {
          ...(conversationId ? { conversation_id: conversationId } : {}),
          ...(finalBlocker.incidentId ? { incident_id: finalBlocker.incidentId } : {}),
          ...(finalBlocker.generation ? { generation: finalBlocker.generation } : {}),
        },
      ));
    }

    const created = writeIncident(profileKey, {
      kind: 'active_owner',
      generation: scheduleLock.generation,
      phase: 'pre_send',
      invocation_id: invocationId,
      output_identity: reservation.identity,
      ...(conversationId ? { conversation_id: conversationId } : {}),
      ...(opened.provisionalId ? { provisional_id: opened.provisionalId } : {}),
      lock_key: scheduleLock.key,
      owner: { pid: process.pid, started_at: new Date().toISOString(), nonce: scheduleLock.nonce },
    });
    incidentId = created.identity;

    const result = await sendTurn(turnPage, snapshot.text, config, opened.provisionalId, async () => {
      if (statusList(profileKey).state === 'profile_blocked') throw new Error('pre_send_profile_blocked');
      if (findProfileWall(profileKey)) throw new Error('pre_send_profile_wall');
      if (witnessSurfaceProbeRequiresDowngrade(await runtimeWitnessSurfaceAvailable(turnPage, segmentBudget), freshConversation)) {
        throw new Error('pre_send_witness_unavailable');
      }
      possibleDelivery = true;
      updateIncident(profileKey, incidentId!, { phase: 'possible_delivery' });
      scheduleLock!.updatePhase('possible_delivery');
      reservation!.markPossibleDelivery();
    }, segmentBudget, freshIdentity);

    if (result.userMessageId) retainedUserMessageId = result.userMessageId;

    if (!result.possibleDelivery) {
      await closeOwnedTurnPage(opened, { retainPage: false });
      const preDispatchCleanup = tryDeleteActiveOwnerIncident(profileKey, incidentId);
      incidentId = preDispatchCleanup.incidentId;
      if (!preDispatchCleanup.incidentCleanupFailed) {
        safeRelease(scheduleLock);
        scheduleLock = null;
        safeReleaseDestination(reservation);
        reservation = null;
      } else {
        return emitTurnAndCode(turnResult('driver_error', 'invocation', 'pre_send_incident_cleanup_failed', invocationId, profileKey, {
          incident_id: incidentId,
        }));
      }

      if (result.state === 'quota' || result.state === 'rate_limit' || result.state === 'challenge' || result.state === 'login') {
        const wall = ensureProfileWall(profileKey, result.state);
        return emitTurnAndCode(turnResult(result.state, 'profile', result.cause, invocationId, profileKey, {
          incident_id: wall.identity,
          generation: wall.generation,
        }));
      }
      return emitTurnAndCode(turnResult(result.state, 'invocation', result.cause, invocationId, profileKey));
    }

    const canonicalConversation = result.conversationId ?? conversationId;
    if (config.newChat && (!canonicalConversation || canonicalConversation === normalizeConversationUrl(config.projectUrl!))) {
      const incident = updateIncident(profileKey, incidentId, {
        kind: 'fresh_orphan',
        phase: 'possible_delivery',
        cause: 'canonical_fresh_conversation_unproven',
        owner: undefined,
        ...(result.userMessageId ? { service_user_id: result.userMessageId } : {}),
        ...(result.assistantMessageId ? { service_assistant_id: result.assistantMessageId } : {}),
      });
      safeRelease(scheduleLock);
      scheduleLock = null;
      safeReleaseDestination(reservation);
      reservation = null;
      return emitTurnAndCode(turnResult('orphaned_fresh_turn', 'profile', 'canonical_fresh_conversation_unproven', invocationId, profileKey, {
        provisional_id: opened.provisionalId,
        incident_id: incidentId,
        generation: incident.generation,
      }));
    }

    if (result.state !== 'ok' || !result.reply || !result.userMessageId || !result.assistantMessageId) {
      const wallMatch = /^profile_wall:(quota|rate_limit|challenge|login)$/.exec(result.cause);
      if (wallMatch) ensureProfileWall(profileKey, wallMatch[1] as TurnState);
      const incident = updateIncident(profileKey, incidentId, {
        kind: 'conversation_incident',
        phase: 'possible_delivery',
        cause: result.cause,
        owner: undefined,
        ...(canonicalConversation ? { conversation_id: canonicalConversation } : {}),
        ...(result.userMessageId ? { service_user_id: result.userMessageId } : {}),
        ...(result.assistantMessageId ? { service_assistant_id: result.assistantMessageId } : {}),
      });
      safeRelease(scheduleLock);
      scheduleLock = null;
      safeReleaseDestination(reservation);
      reservation = null;
      return emitTurnAndCode(turnResult(result.state, 'conversation', result.cause, invocationId, profileKey, {
        ...(canonicalConversation ? { conversation_id: canonicalConversation } : {}),
        ...(opened.provisionalId ? { provisional_id: opened.provisionalId } : {}),
        incident_id: incidentId,
        generation: incident.generation,
      }));
    }

    updateIncident(profileKey, incidentId, {
      kind: 'conversation_incident',
      phase: 'reply_complete',
      conversation_id: canonicalConversation,
      service_user_id: result.userMessageId,
      service_assistant_id: result.assistantMessageId,
      cause: 'reply_complete',
    });
    let publication: { state: string; cause?: string; output_bytes?: number; output_sha256?: string };
    let directReviewerSource = null as ReturnType<typeof reviewerSourceMetadata>;
    if (config.directPublication) {
      const settlement = result.directPublication;
      if (!settlement || settlement.state === 'possible-delivery') {
        updateIncident(profileKey, incidentId, {
          kind: 'conversation_incident',
          phase: 'possible_delivery',
          cause: settlement?.cause ?? 'direct_publication_observation_missing',
          owner: undefined,
        });
        return emitTurnAndCode(turnResult('recovery_required', 'conversation', settlement?.cause ?? 'direct_publication_observation_missing', invocationId, profileKey, {
          conversation_id: canonicalConversation,
          incident_id: incidentId,
        }));
      }
      directReviewerSource = reviewerSourceMetadata(settlement, config.directPublication.target);
      const managerReply = settlement.state === 'success'
        ? directPublicationReceipt(settlement, config.directPublication.target)
        : result.reply;
      if (!directReviewerSource || !managerReply || !settlement.sourceBytes) {
        updateIncident(profileKey, incidentId, {
          kind: 'conversation_incident',
          phase: 'possible_delivery',
          cause: 'direct_publication_source_or_receipt_invalid',
          owner: undefined,
        });
        return emitTurnAndCode(turnResult('recovery_required', 'conversation', 'direct_publication_source_or_receipt_invalid', invocationId, profileKey, {
          conversation_id: canonicalConversation,
          incident_id: incidentId,
        }));
      }
      const sourcePublication = publishStateLightReply(config.directPublication.reviewerSourceOutput, invocationId, settlement.sourceBytes);
      if (sourcePublication.state !== 'committed_ok') {
        return emitTurnAndCode(turnResult('recovery_required', 'blocking_domain', sourcePublication.cause ?? sourcePublication.state, invocationId, profileKey));
      }
      publication = publishStateLightReply(reservation.finalPath, invocationId, managerReply);
    } else {
      publication = publishReply(profileKey, invocationId, reservation.finalPath, reservation.identity, result.reply);
    }
    if (publication.state !== 'committed_ok') {
      const incident = updateIncident(profileKey, incidentId, {
        kind: 'publication_incident',
        phase: 'publication_prepared',
        cause: publication.cause ?? publication.state,
        owner: undefined,
      });
      safeRelease(scheduleLock);
      scheduleLock = null;
      safeReleaseDestination(reservation);
      reservation = null;
      return emitTurnAndCode(turnResult('recovery_required', 'blocking_domain', publication.cause ?? publication.state, invocationId, profileKey, {
        conversation_id: canonicalConversation,
        ...(opened.provisionalId ? { provisional_id: opened.provisionalId } : {}),
        incident_id: incidentId,
        generation: incident.generation,
      }));
    }

    updateIncident(profileKey, incidentId, { phase: 'committed', cause: 'committed' });
    await closeOwnedTurnPage(opened, { retainPage: false });
    deleteIncident(profileKey, incidentId);
    incidentId = undefined;
    safeRelease(scheduleLock);
    scheduleLock = null;
    safeReleaseDestination(reservation);
    reservation = null;

    const capabilityOutcome = applyCapabilityAfterSuccessfulTurn(profileKey, {
      expectedBinding,
      browserProvenance,
      evidenceDigest: sha256(`${result.userMessageId}\n${result.assistantMessageId}\n${canonicalConversation}`),
      witnessed: result.state === 'ok'
        && Boolean(result.userMessageId && result.assistantMessageId),
      invocationId,
    });
    if (!capabilityOutcome.applied && capabilityOutcome.reason === 'write_failed') {
      recordSwallowedDriverException(
        profileKey,
        invocationId,
        'capability_mutation_failed',
        capabilityOutcome.error,
        { invocation_id: invocationId },
      );
    }

    return emitTurnAndCode(turnResult('ok', 'none', provenanceDriftObserved ? 'browser_provenance_drift_observed' : 'completed', invocationId, profileKey, {
      conversation_id: canonicalConversation,
      ...(opened.provisionalId ? { provisional_id: opened.provisionalId } : {}),
      output: {
        byte_length: publication.output_bytes!,
        sha256: publication.output_sha256!,
      },
      witness: {
        user_message_id: result.userMessageId,
        assistant_message_id: result.assistantMessageId,
        relation: 'reply_to',
        source: 'service',
      },
      ...(directReviewerSource ? { reviewer_source: directReviewerSource } : {}),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'driver_error';
    if (!possibleDelivery && message.startsWith('pre_send_')) {
      await closeOwnedTurnPage(opened, { retainPage: false });
      const preSendCleanup = tryDeleteActiveOwnerIncident(profileKey, incidentId);
      incidentId = preSendCleanup.incidentId;
      const incidentCleanupFailed = preSendCleanup.incidentCleanupFailed;
      if (!incidentCleanupFailed) {
        safeRelease(scheduleLock);
        scheduleLock = null;
        safeReleaseDestination(reservation);
        reservation = null;
      }
      if (incidentCleanupFailed) {
        return emitTurnAndCode(turnResult('driver_error', 'invocation', 'pre_send_incident_cleanup_failed', invocationId, profileKey, {
          incident_id: incidentId,
        }));
      }
      if (message === 'pre_send_profile_blocked') {
        return emitTurnAndCode(turnResult('incompatible_record', 'profile', 'configured_profile_store_blocked', invocationId, profileKey));
      }
      if (message === 'pre_send_profile_wall') {
        const wall = findProfileWall(profileKey);
        const state = wall ? wallState(wall.record.cause) : 'profile_busy';
        return emitTurnAndCode(turnResult(state, 'profile', wall ? 'profile_wall_active' : message, invocationId, profileKey, {
          ...(wall ? { incident_id: wall.identity, generation: wall.record.generation } : {}),
        }));
      }
      if (message === 'pre_send_witness_unavailable') {
        return emitTurnAndCode(turnResult('driver_error', 'invocation', 'pre_send_witness_unavailable', invocationId, profileKey));
      }
      return emitTurnAndCode(turnResult('driver_error', 'invocation', message, invocationId, profileKey));
    }

    const isInput = message.startsWith('input_invalid:');
    const isOutput = message.startsWith('output_conflict:');
    const isUiContract = message.startsWith('ui_contract_mismatch:');
    const state: TurnState = isInput
      ? 'input_invalid'
      : isOutput
        ? 'output_conflict'
        : isUiContract
          ? 'ui_contract_mismatch'
          : 'driver_error';
    const scope: FailureScope = isInput || isOutput || isUiContract
      ? 'invocation'
      : possibleDelivery
        ? 'conversation'
        : 'machine';
    const cause = isInput || isOutput || isUiContract
      ? message
      : possibleDelivery
        ? 'driver_exception_after_possible_delivery'
        : 'driver_exception_before_send';

    await closeOwnedTurnPage(opened, { retainPage: possibleDelivery });
    if (possibleDelivery && config?.newChat && incidentId) {
      const canonicalConversation = canonicalConversationFromOpenedPage(config, opened, freshIdentity, retainedUserMessageId);
      const canonicalFreshUnproven = !canonicalConversation;
      if (canonicalFreshUnproven) {
        try {
          const incident = updateIncident(profileKey, incidentId, {
            kind: 'fresh_orphan',
            phase: 'possible_delivery',
            cause: 'canonical_fresh_conversation_unproven',
            owner: undefined,
          });
          safeRelease(scheduleLock);
          safeReleaseDestination(reservation);
          const operationClass = browserOperationClassFromError(error);
          const driverDiagnosticId = recordSwallowedDriverException(
            profileKey !== 'profile-unresolved' ? profileKey : undefined,
            profileKey !== 'profile-unresolved' ? invocationId : undefined,
            cause,
            error,
            {
              invocation_id: invocationId,
              ...(operationClass ? { operation: 'browser_operation_timeout:' + operationClass } : {}),
            },
          );
          return emitTurnAndCode(turnResult('orphaned_fresh_turn', 'profile', 'canonical_fresh_conversation_unproven', invocationId, profileKey, {
            ...(opened?.provisionalId ? { provisional_id: opened.provisionalId } : {}),
            incident_id: incidentId,
            generation: incident.generation,
            ...(driverDiagnosticId ? { driver_diagnostic_id: driverDiagnosticId } : {}),
          }));
        } catch {
          // Existing durable state remains fail-closed.
        }
      }
    }
    if (incidentId) {
      if (possibleDelivery) {
        try {
          const recoveryConversationId = config?.newChat
            ? canonicalConversationFromOpenedPage(config, opened, freshIdentity, retainedUserMessageId)
            : (config?.chatUrl ? normalizeConversationUrl(config.chatUrl) : undefined);
          updateIncident(profileKey, incidentId, {
            kind: 'conversation_incident',
            phase: 'possible_delivery',
            cause,
            owner: undefined,
            ...(recoveryConversationId ? { conversation_id: recoveryConversationId } : {}),
          });
        } catch {
          // Existing durable state remains fail-closed.
        }
      } else {
        const catchCleanup = tryDeleteActiveOwnerIncident(profileKey, incidentId);
        incidentId = catchCleanup.incidentId;
        if (catchCleanup.incidentCleanupFailed) {
          return emitTurnAndCode(turnResult('driver_error', 'invocation', 'pre_send_incident_cleanup_failed', invocationId, profileKey, {
            incident_id: incidentId,
          }));
        }
      }
    }
    safeRelease(scheduleLock);
    safeReleaseDestination(reservation);
    const operationClass = browserOperationClassFromError(error);
    const driverDiagnosticId = (cause === 'driver_exception_before_send' || cause === 'driver_exception_after_possible_delivery')
      ? recordSwallowedDriverException(
        profileKey !== 'profile-unresolved' ? profileKey : undefined,
        profileKey !== 'profile-unresolved' ? invocationId : undefined,
        cause,
        error,
        {
          invocation_id: invocationId,
          ...(operationClass ? { operation: 'browser_operation_timeout:' + operationClass } : {}),
        },
      )
      : undefined;
    return emitTurnAndCode(turnResult(state, scope, cause, invocationId, profileKey, {
      ...(incidentId ? { incident_id: incidentId } : {}),
      ...(driverDiagnosticId ? { driver_diagnostic_id: driverDiagnosticId } : {}),
    }));
  } finally {
    await releaseCdpBrowser(browser, RESOURCE_CLEANUP_BOUND_MS);
  }
}

function profileArgs(args: ParsedArgs): { profile: string; cdp: string; profileKey: string } {
  const profile = required(args, 'profile');
  const cdp = required(args, 'cdp');
  return { profile, cdp, profileKey: configuredProfileKey(profile, cdp) };
}

function emitControlAndCode(result: ControlResultV1): number {
  emit(result);
  return controlExitCode(result.state);
}

async function runStatus(args: ParsedArgs): Promise<number> {
  assertAllowedOptions(args, ['profile', 'cdp']);
  const { profile, cdp } = profileArgs(args);
  return emitControlAndCode(statusListForConfiguredProfile(profile, cdp));
}


async function runGateBCharacterizationCommand(args: ParsedArgs): Promise<number> {
  assertAllowedOptions(args, ['profile', 'cdp', 'chat-url']);
  const { profile, cdp, profileKey } = profileArgs(args);
  const chatUrl = option(args, 'chat-url') ?? 'https://chatgpt.com/';
  const config: BrowserConfig = {
    cdp,
    profile,
    chatUrl,
    newChat: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  let browser: Awaited<ReturnType<ReturnType<typeof loadChromium>['connectOverCDP']>> | undefined;
  try {
    await trimExcessCdpPageTargets(config.cdp, { urlIncludes: 'chatgpt.com', keep: 3 });
    const chromium = loadChromium();
    browser = await connectCdpBrowser(chromium, config.cdp);
    const opened = await openGateBCharacterizationPage(browser, chatUrl);
    const result = bindGateBCharacterizationRecord(
      await runGateBCharacterization(opened.page),
      profileKey,
      cdp,
    );
    writeGateBCharacterizationRecord(profileKey, result);
    const control: ControlResultV1 = {
      schema: 'control-result/v1',
      operation: 'status/list',
      state: result.complete ? 'ok' : 'refused_active',
      configured_profile_key: profileKey,
      ...(result.complete ? {} : { cause: 'gate_b_characterization_incomplete' }),
    };
    emit(control);
    if (opened.owned) await opened.page.close().catch(() => {});
    return result.complete ? 0 : 10;
  } finally {
    await releaseCdpBrowser(browser);
  }
}

async function runCapability(args: ParsedArgs): Promise<number> {
  assertAllowedOptions(args, ['profile', 'cdp', 'admission-policy']);
  const { profileKey, cdp } = profileArgs(args);
  const expectedBinding = runtimeCapabilityBinding(profileKey, cdp);
  const policyArg = option(args, 'admission-policy');
  if (policyArg) {
    if (policyArg !== 'parallel' && policyArg !== 'serialized') {
      return emitControlAndCode(controlResult('capability', 'driver_error', profileKey, 'argument_invalid'));
    }
    const browserProvenance = policyArg === 'parallel'
      ? () => probeLiveBrowserProvenance(cdp)
      : undefined;
    let result;
    try {
      result = await mutateCapabilityAdmissionPolicy(
        profileKey,
        policyArg,
        expectedBinding,
        browserProvenance,
      );
    } catch {
      return emitControlAndCode(controlResult('capability', 'driver_error', profileKey, 'cdp_unavailable'));
    }
    emit({ ...result, expected_binding: expectedBinding });
    return controlExitCode(result.state);
  }
  const result = capabilityStatus(profileKey, expectedBinding);
  emit({ ...result, expected_binding: expectedBinding });
  return controlExitCode(result.state);
}

async function runPublicationStatus(args: ParsedArgs): Promise<number> {
  assertAllowedOptions(args, ['profile', 'cdp', 'invocation']);
  const { profileKey, profile, cdp } = profileArgs(args);
  const invocationId = required(args, 'invocation');
  const resolvedProfile = resolveConfiguredProfile(profile, cdp);
  let result = publicationStatus(profileKey, invocationId);
  if (result.state === 'not_committed'
    && resolvedProfile.keysDiffer
    && profileNamespaceExists(resolvedProfile.legacyProfileKey)) {
    const legacyResult = publicationStatus(resolvedProfile.legacyProfileKey, invocationId);
    if (legacyResult.state !== 'not_committed') {
      result = {
        ...legacyResult,
        legacy_configured_profile_key: resolvedProfile.legacyProfileKey,
        ...(statusListForConfiguredProfile(profile, cdp).legacy_namespace_root
          ? { legacy_namespace_root: statusListForConfiguredProfile(profile, cdp).legacy_namespace_root }
          : {}),
      };
    }
  }
  if (result.state === 'committed_ok') {
    emit(result);
    return publicationExitCode(result.state);
  }
  const configuredProfileStatus = statusListForConfiguredProfile(profile, cdp);
  if (result.state === 'not_committed' && configuredProfileStatus.state === 'profile_blocked') {
    const blocked: PublicationStatusV1 = {
      schema: 'publication-status/v1',
      state: 'profile_blocked',
      configured_profile_key: profileKey,
      invocation_id: invocationId,
      cause: 'configured_profile_store_blocked',
    };
    emit(blocked);
    return publicationExitCode(blocked.state);
  }
  emit(result);
  return publicationExitCode(result.state);
}

async function runClear(args: ParsedArgs): Promise<number> {
  assertAllowedOptions(args, [
    'profile', 'cdp', 'identity', 'generation', 'evidence-token', 'quarantine', 'adjudicate',
    'adjudication-evidence-file', 'expected-adjudication-sha256',
  ]);
  let { profileKey, profile, cdp } = profileArgs(args);
  const identity = required(args, 'identity');
  const generation = parseInteger(required(args, 'generation'), 0);
  const resolvedProfile = resolveConfiguredProfile(profile, cdp);
  const sourceKeys = [profileKey, ...(resolvedProfile.keysDiffer ? [resolvedProfile.legacyProfileKey] : [])];
  const matchingKeys = sourceKeys.filter((sourceKey) => {
    try {
      return statusList(sourceKey, { ensureDirectories: false }).items
        ?.some((item) => item.identity === identity && item.generation === generation) ?? false;
    } catch {
      return false;
    }
  });
  if (matchingKeys.length > 1) {
    return emitControlAndCode(controlResult('clear', 'profile_blocked', profileKey, 'legacy_profile_clear_ambiguous'));
  }
  if (
    matchingKeys.length === 1
    && matchingKeys[0] === resolvedProfile.legacyProfileKey
    && legacyProfileKeyAmbiguous(profile)
  ) {
    return emitControlAndCode(controlResult('clear', 'profile_blocked', profileKey, 'legacy_profile_clear_ambiguous'));
  }
  if (matchingKeys[0]) profileKey = matchingKeys[0];

  if (flag(args, 'quarantine')) {
    if (flag(args, 'adjudicate')) return emitControlAndCode(controlResult('clear', 'driver_error', profileKey, 'clear_mode_conflict'));
    return emitControlAndCode(quarantineOpaque(profileKey, identity, generation));
  }

  if (flag(args, 'adjudicate')) {
    const evidencePath = required(args, 'adjudication-evidence-file');
    const expected = required(args, 'expected-adjudication-sha256');
    let actual: string;
    try {
      actual = sha256(readFileSync(evidencePath));
    } catch {
      return emitControlAndCode(controlResult('clear', 'evidence_changed', profileKey, 'adjudication_evidence_unreadable'));
    }
    return emitControlAndCode(adjudicateTombstone(profileKey, identity, generation, expected, actual));
  }

  const evidenceToken = required(args, 'evidence-token');
  let target: ReturnType<typeof listReadableIncidents>[number] | undefined;
  try {
    target = listReadableIncidents(profileKey).find((entry) => entry.identity === identity);
  } catch {
    return emitControlAndCode(controlResult('clear', 'profile_blocked', profileKey, 'configured_profile_store_blocked'));
  }
  if (target?.record.kind === 'profile_wall') {
    const probe = await probeProfileReady({ cdp, profile, newChat: false, timeoutMs: DEFAULT_TIMEOUT_MS });
    if (!probe.ready) {
      const state = probe.state === 'profile_mismatch' ? 'profile_mismatch' : probe.state === 'driver_error' ? 'driver_error' : 'refused_active';
      return emitControlAndCode(controlResult('clear', state, profileKey, probe.cause));
    }
  }
  if (target?.record.output_identity && !clearDomainLock(profileKey, `destination:${target.record.output_identity}`)) {
    return emitControlAndCode(controlResult('clear', 'refused_active', profileKey, 'destination_reservation_active'));
  }
  return emitControlAndCode(clearReadable(profileKey, identity, generation, evidenceToken));
}

function controlOperation(args: ParsedArgs): ControlResultV1['operation'] {
  if (args.command === 'clear') return 'clear';
  if (args.command === 'gate-b-characterization') return 'status/list';
  if (args.command === 'capability') return 'capability';
  return 'status/list';
}

function resolvedControlProfileKey(args: ParsedArgs): string {
  try {
    return profileArgs(args).profileKey;
  } catch {
    return 'profile-unresolved';
  }
}

export async function runCli(argv: readonly string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch {
    emit({ schema: 'control-result/v1', operation: 'status/list', state: 'driver_error', configured_profile_key: 'profile-unresolved', cause: 'argument_invalid' });
    return 22;
  }
  try {
    if (args.command === 'turn') return await runTurn(args);
    if (args.command === 'status/list') return await runStatus(args);
    if (args.command === 'clear') return await runClear(args);
    if (args.command === 'capability') return await runCapability(args);
    if (args.command === 'gate-b-characterization') return await runGateBCharacterizationCommand(args);
    if (args.command === 'publication-status') return await runPublicationStatus(args);
    emit({ schema: 'control-result/v1', operation: 'status/list', state: 'driver_error', configured_profile_key: 'profile-unresolved', cause: 'command_invalid' });
    return 22;
  } catch (error) {
    const operation = controlOperation(args);
    const resolvedProfileKey = resolvedControlProfileKey(args);
    const diagnosticIdentity = resolvedProfileKey !== 'profile-unresolved' ? randomUUID() : undefined;
    const driverDiagnosticId = recordSwallowedDriverException(
      resolvedProfileKey !== 'profile-unresolved' ? resolvedProfileKey : undefined,
      diagnosticIdentity,
      'command_failed',
      error,
      { operation },
    );
    emit({
      schema: 'control-result/v1',
      operation,
      state: 'driver_error',
      configured_profile_key: 'profile-unresolved',
      cause: 'command_failed',
      ...(driverDiagnosticId ? { driver_diagnostic_id: driverDiagnosticId } : {}),
    });
    return 22;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
