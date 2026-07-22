import type { FoundationConfig } from './config.ts';

export interface DormantSchedulerState {
  component: 'pr2-foundation-scheduler';
  registered: false;
  running: false;
  claimAcquirer: false;
  activationEpochEnforced: false;
  pollIntervalMs: number;
  leaseMs: number;
}

export interface DormantActuatorResult {
  ok: true;
  executed: false;
  reason: 'foundation_inert';
}

export function buildDormantScheduler(config: FoundationConfig): DormantSchedulerState {
  return {
    component: 'pr2-foundation-scheduler',
    registered: false,
    running: false,
    claimAcquirer: false,
    activationEpochEnforced: false,
    pollIntervalMs: config.scheduler.pollIntervalMs,
    leaseMs: config.scheduler.leaseMs,
  };
}

export function runDormantMergeActuator(_config: FoundationConfig): DormantActuatorResult {
  return { ok: true, executed: false, reason: 'foundation_inert' };
}

export function assertFoundationInert(input: {
  registryChanged: boolean;
  supervisorChanged: boolean;
  schedulerRegistered: boolean;
  schedulerRunning: boolean;
  schedulerClaimAcquirer: boolean;
  activationEpochEnforced: boolean;
  liveStoreOpened: boolean;
  legacyStarterDisabled: boolean;
  nonNotificationRuntimeDelta: boolean;
  notificationTypedConfigLive: boolean;
  dormantTypedConfigReaderLive: boolean;
}): { ok: true; result: 'live-acquirers-unchanged' } | { ok: false; reason: string } {
  const failures: Array<[boolean, string]> = [
    [input.registryChanged, 'registry_changed'],
    [input.supervisorChanged, 'supervisor_changed'],
    [input.schedulerRegistered, 'scheduler_registered'],
    [input.schedulerRunning, 'scheduler_running'],
    [input.schedulerClaimAcquirer, 'scheduler_claim_acquirer'],
    [input.activationEpochEnforced, 'activation_epoch_enforced'],
    [input.liveStoreOpened, 'live_store_opened'],
    [input.legacyStarterDisabled, 'legacy_starter_disabled'],
    [input.nonNotificationRuntimeDelta, 'non_notification_runtime_delta'],
    [!input.notificationTypedConfigLive, 'notification_config_reader_absent'],
    [input.dormantTypedConfigReaderLive, 'dormant_config_reader_live'],
  ];
  const failure = failures.find(([condition]) => condition);
  return failure
    ? { ok: false, reason: failure[1] }
    : { ok: true, result: 'live-acquirers-unchanged' };
}
