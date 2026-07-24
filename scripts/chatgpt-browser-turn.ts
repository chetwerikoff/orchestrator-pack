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
import { probeProfileReady } from './chatgpt-browser-turn/profile-probe.ts';
import { publicationStatus, publishReply } from './chatgpt-browser-turn/publication.ts';
import { runtimeCapabilityBinding } from './chatgpt-browser-turn/runtime-binding.ts';
import {
  adjudicateTombstone,
  capabilityStatus,
  clearReadable,
  deleteIncident,
  downgradeCapability,
  listReadableIncidents,
  quarantineOpaque,
  statusList,
  updateIncident,
  writeCapability,
  writeIncident,
} from './chatgpt-browser-turn/state.ts';
import { configuredProfileKey, sha256 } from './chatgpt-browser-turn/storage-common.ts';
import { readStableInput } from './chatgpt-browser-turn/input.ts';
import {
  loadChromium,
  normalizeConversationUrl,
  openTurnPage,
  runtimeWitnessSurfaceAvailable,
  sendTurn,
  type BrowserConfig,
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

function emitTurnAndCode(result: TurnResultV1): number {
  emit(result);
  return turnExitCode(result.state);
}

async function runTurn(args: ParsedArgs): Promise<number> {
  assertAllowedOptions(args, ['profile', 'cdp', 'input', 'output', 'chat-url', 'new-chat', 'project-url', 'timeout-ms']);
  const invocationId = randomUUID();
  let profileKey = 'profile-unresolved';
  let reservation: DestinationReservation | null = null;
  let scheduleLock: DomainLock | null = null;
  let incidentId: string | undefined;
  let possibleDelivery = false;
  let opened: { page: any; owned: boolean; provisionalId?: string } | undefined;

  try {
    const config = browserConfig(args);
    profileKey = configuredProfileKey(config.profile, config.cdp);
    const snapshot = readStableInput(required(args, 'input'));
    const destination = destinationIdentity(required(args, 'output'));
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

    const verification = await verifyProfile(config);
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
    let capability = capabilityStatus(profileKey, expectedBinding);
    const lockKey = capability.state === 'ok'
      ? (conversationId ? `conversation:${conversationId}` : `fresh:${randomUUID()}`)
      : `profile:${profileKey}`;
    scheduleLock = acquireDomainLock(profileKey, lockKey);
    if (!scheduleLock) {
      safeReleaseDestination(reservation);
      reservation = null;
      const state: TurnState = capability.state === 'ok' && conversationId ? 'conversation_busy' : 'profile_busy';
      const scope: FailureScope = state === 'conversation_busy' ? 'conversation' : 'profile';
      return emitTurnAndCode(turnResult(state, scope, 'scheduling_lock_busy', invocationId, profileKey, {
        ...(conversationId ? { conversation_id: conversationId } : {}),
      }));
    }

    const chromium = loadChromium();
    const browser = await chromium.connectOverCDP(config.cdp);
    opened = await openTurnPage(browser, config);
    const turnPage = opened.page;

    let witnessSurface = await runtimeWitnessSurfaceAvailable(turnPage);
    if (capability.state === 'ok' && !witnessSurface) {
      downgradeCapability(profileKey);
      safeRelease(scheduleLock);
      scheduleLock = acquireDomainLock(profileKey, `profile:${profileKey}`);
      capability = capabilityStatus(profileKey, expectedBinding);
      if (!scheduleLock) {
        if (opened.owned) await opened.page.close().catch(() => {});
        safeReleaseDestination(reservation);
        reservation = null;
        return emitTurnAndCode(turnResult('profile_busy', 'profile', 'witness_downgrade_fallback_busy', invocationId, profileKey));
      }
    }

    if (capability.state === 'ok') {
      const rechecked = capabilityStatus(profileKey, expectedBinding);
      witnessSurface = await runtimeWitnessSurfaceAvailable(turnPage);
      if (rechecked.state !== 'ok' || !witnessSurface) {
        if (!witnessSurface) downgradeCapability(profileKey);
        safeRelease(scheduleLock);
        scheduleLock = acquireDomainLock(profileKey, `profile:${profileKey}`);
        capability = capabilityStatus(profileKey, expectedBinding);
        if (!scheduleLock) {
          if (opened.owned) await opened.page.close().catch(() => {});
          safeReleaseDestination(reservation);
          reservation = null;
          return emitTurnAndCode(turnResult('profile_busy', 'profile', 'pre_send_parallel_recheck_failed', invocationId, profileKey));
        }
      }
    }

    const finalBlocker = blockerBeforeSend(profileKey, reservation.identity, conversationId);
    if (finalBlocker) {
      if (opened.owned) await opened.page.close().catch(() => {});
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
      if (capability.state === 'ok') {
        if (!(await runtimeWitnessSurfaceAvailable(turnPage))) {
          downgradeCapability(profileKey);
          capability = capabilityStatus(profileKey, expectedBinding);
          throw new Error('pre_send_witness_unavailable');
        }
        const currentCapability = capabilityStatus(profileKey, expectedBinding);
        if (currentCapability.state !== 'ok') {
          capability = currentCapability;
          throw new Error('pre_send_capability_changed');
        }
      }
      possibleDelivery = true;
      updateIncident(profileKey, incidentId!, { phase: 'possible_delivery' });
      scheduleLock!.updatePhase('possible_delivery');
      reservation!.markPossibleDelivery();
    });

    if (!result.possibleDelivery) {
      deleteIncident(profileKey, incidentId);
      incidentId = undefined;
      safeRelease(scheduleLock);
      scheduleLock = null;
      safeReleaseDestination(reservation);
      reservation = null;
      if (opened.owned) await opened.page.close().catch(() => {});

      if (result.state === 'quota' || result.state === 'challenge' || result.state === 'login') {
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
      const wallMatch = /^profile_wall:(quota|challenge|login)$/.exec(result.cause);
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
    const publication = publishReply(profileKey, invocationId, reservation.finalPath, reservation.identity, result.reply);
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
    deleteIncident(profileKey, incidentId);
    incidentId = undefined;
    safeRelease(scheduleLock);
    scheduleLock = null;
    safeReleaseDestination(reservation);
    reservation = null;

    const gateEvidence = process.env.CHATGPT_BROWSER_TURN_GATE_B_DIGEST;
    if (capability.state !== 'ok' && witnessSurface && gateEvidence === expectedBinding.gate_digest) {
      const priorGeneration = capability.capability?.downgrade_generation ?? 0;
      const observedAt = new Date();
      writeCapability(profileKey, {
        ...expectedBinding,
        browser_provenance: String(browser.version?.() ?? 'chromium-cdp'),
        evidence_digest: sha256(`${result.userMessageId}\n${result.assistantMessageId}\n${canonicalConversation}`),
        observed_at: observedAt.toISOString(),
        expires_at: new Date(observedAt.getTime() + 4 * 60 * 60 * 1000).toISOString(),
        downgrade_generation: priorGeneration + 1,
        parallel_eligible: true,
      });
    }

    return emitTurnAndCode(turnResult('ok', 'none', 'completed', invocationId, profileKey, {
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
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'driver_error';
    if (!possibleDelivery && message.startsWith('pre_send_')) {
      if (incidentId) {
        try {
          deleteIncident(profileKey, incidentId);
          incidentId = undefined;
        } catch {
          // Existing durable state remains fail-closed.
        }
      }
      if (opened?.owned) await opened.page.close().catch(() => {});
      safeRelease(scheduleLock);
      safeReleaseDestination(reservation);
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
      return emitTurnAndCode(turnResult('profile_busy', 'profile', message, invocationId, profileKey));
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

    if (incidentId) {
      if (possibleDelivery) {
        try {
          updateIncident(profileKey, incidentId, {
            kind: 'conversation_incident',
            phase: 'possible_delivery',
            cause,
            owner: undefined,
          });
        } catch {
          // Existing durable state remains fail-closed.
        }
      } else {
        try {
          deleteIncident(profileKey, incidentId);
          incidentId = undefined;
        } catch {
          // Existing durable state remains fail-closed.
        }
      }
    }
    if (!possibleDelivery && opened?.owned) await opened.page.close().catch(() => {});
    safeRelease(scheduleLock);
    safeReleaseDestination(reservation);
    return emitTurnAndCode(turnResult(state, scope, cause, invocationId, profileKey, {
      ...(incidentId ? { incident_id: incidentId } : {}),
    }));
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
  const { profileKey } = profileArgs(args);
  return emitControlAndCode(statusList(profileKey));
}

async function runCapability(args: ParsedArgs): Promise<number> {
  assertAllowedOptions(args, ['profile', 'cdp']);
  const { profileKey, cdp } = profileArgs(args);
  const expectedBinding = runtimeCapabilityBinding(profileKey, cdp);
  const result = capabilityStatus(profileKey, expectedBinding);
  emit({ ...result, expected_binding: expectedBinding });
  return controlExitCode(result.state);
}

async function runPublicationStatus(args: ParsedArgs): Promise<number> {
  assertAllowedOptions(args, ['profile', 'cdp', 'invocation']);
  const { profileKey } = profileArgs(args);
  const invocationId = required(args, 'invocation');
  const result = publicationStatus(profileKey, invocationId);
  if (result.state === 'committed_ok') {
    emit(result);
    return publicationExitCode(result.state);
  }
  if (statusList(profileKey).state === 'profile_blocked' && result.state !== 'profile_blocked') {
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
  const { profileKey, profile, cdp } = profileArgs(args);
  const identity = required(args, 'identity');
  const generation = parseInteger(required(args, 'generation'), 0);

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
    if (args.command === 'publication-status') return await runPublicationStatus(args);
    emit({ schema: 'control-result/v1', operation: 'status/list', state: 'driver_error', configured_profile_key: 'profile-unresolved', cause: 'command_invalid' });
    return 22;
  } catch {
    emit({ schema: 'control-result/v1', operation: args.command === 'clear' ? 'clear' : args.command === 'capability' ? 'capability' : 'status/list', state: 'driver_error', configured_profile_key: 'profile-unresolved', cause: 'command_failed' });
    return 22;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
