import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MECHANICAL_PIPE_BUFFER_BYTES,
  MECHANICAL_STORAGE_CEILING_BYTES,
  MECHANICAL_TRANSPORT_ENVELOPE_BYTES,
  assertTransportEnvelope,
  compactDispatchJournal,
  compactWorkerMessageSubmitTracking,
  convergeOversizedReconcileState,
  evaluateDispatchJournalAdmission,
  evaluateSubmitTrackingCapacity,
  estimateSerializedUtf8Bytes,
  interpretDispatchFenceLifecycle,
  isSubmitDeliveryEvictable,
  maxChildOutputBytesForStorage,
  parseCompleteJsonText,
  storageBytesWithinTransportEnvelope,
  DISPATCH_JOURNAL_RETENTION_MS,
  DISPATCH_OUTCOME_SEND_FAILED,
  DISPATCH_OUTCOME_UNKNOWN,
  SUBMIT_DELIVERY_RETENTION_MS,
  FAILED_DELIVERY_RESOLVED,
  FENCE_LIFECYCLE_FAILED_UNCERTAIN,
  isDispatchJournalEntryEvictable,
  withPendingDispatchFence,
} from '../docs/mechanical-reconcile-bounds.mjs';
import { admitDispatchJournalRecord, finalizeDispatchJournalRecord } from '../docs/worker-message-dispatch-observe.mjs';
import { planWorkerMessageSubmitActions } from '../docs/worker-message-submit-reconcile.mjs';
import type { FailedDeliveryRecord } from '../docs/worker-message-submit-reconcile.d.mts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const libScript = path.join(repoRoot, 'scripts/lib/MechanicalReconcileNode.ps1');
const echoFilter = path.join(repoRoot, 'scripts/fixtures/mechanical-json-state/echo-filter.mjs');

function runPwsh(command: string): string {
  return execFileSync('pwsh', ['-NoProfile', '-Command', command], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
}

function buildLargePayload(minBytes: number) {
  const padding = 'x'.repeat(Math.max(0, minBytes - 200));
  return {
    marker: 'over-buffer-fixture',
    padding,
    nested: { values: Array.from({ length: 32 }, (_, i) => `row-${i}-${padding.slice(0, 64)}`) },
  };
}

describe('mechanical reconcile bounds constants', () => {
  it('keeps storage ceiling below transport envelope with encoding headroom', () => {
    expect(MECHANICAL_STORAGE_CEILING_BYTES).toBeLessThan(MECHANICAL_TRANSPORT_ENVELOPE_BYTES);
    const childOutput = maxChildOutputBytesForStorage(MECHANICAL_STORAGE_CEILING_BYTES);
    expect(storageBytesWithinTransportEnvelope(childOutput)).toBe(true);
  });

  it('uses the observed pipe buffer boundary as reference', () => {
    expect(MECHANICAL_PIPE_BUFFER_BYTES).toBe(65536);
  });
});

describe('fence lifecycle interpretation', () => {
  it('never treats legacy terminal journal records as pending', () => {
    expect(
      interpretDispatchFenceLifecycle({
        dispatchOutcome: 'dispatched',
        draftState: 'draft_present',
      }),
    ).toBe('completed');
  });

  it('treats in-flight dispatch records as pending', () => {
    expect(
      interpretDispatchFenceLifecycle({
        dispatchOutcome: 'dispatch_in_flight',
        draftState: 'draft_present',
      }),
    ).toBe('pending');
  });
});

describe('submit tracking compaction', () => {
  it('retains active dedupe fences while evicting old terminal deliveries', () => {
    const nowMs = 2_000_000_000_000;
    const tracking = {
      deliveries: {
        active: {
          deliveryId: 'active',
          sessionId: 's1',
          firstObservedAtMs: nowMs - 1000,
        },
        oldSubmitted: {
          deliveryId: 'oldSubmitted',
          sessionId: 's1',
          terminalState: 'submitted',
          firstObservedAtMs: nowMs - SUBMIT_DELIVERY_RETENTION_MS - 60_000,
          consumedAtMs: nowMs - SUBMIT_DELIVERY_RETENTION_MS - 30_000,
        },
      },
      failedDeliveries: {},
      audit: [],
    };

    expect(isSubmitDeliveryEvictable(tracking.deliveries.oldSubmitted, nowMs)).toBe(true);
    const compacted = compactWorkerMessageSubmitTracking(tracking, nowMs);
    const deliveries = compacted.tracking.deliveries as Record<string, unknown>;
    expect(deliveries.active).toBeTruthy();
    expect(deliveries.oldSubmitted).toBeUndefined();
  });

  it('fails closed when only required entries remain over ceiling', () => {
    const nowMs = Date.now();
    const huge = 'z'.repeat(MECHANICAL_STORAGE_CEILING_BYTES);
    const tracking = {
      deliveries: {
        active: { deliveryId: 'active', sessionId: 's1', payload: huge },
      },
      failedDeliveries: {},
      audit: [],
    };
    const result = convergeOversizedReconcileState({ tracking, nowMs });
    expect(result.overCapacity).toBe(true);
    expect(result.ok).toBe(false);
  });
});

describe('dispatch journal admission', () => {
  it('refuses admission when only required entries fill the ceiling', () => {
    const nowMs = Date.now();
    const journal: Record<string, unknown> = {
      required: withPendingDispatchFence({
        deliveryId: 'required',
        sessionId: 's1',
        deliveredAtMs: nowMs - 1000,
        dispatchOutcome: 'dispatch_in_flight',
        draftState: 'draft_present',
        payload: 'r'.repeat(MECHANICAL_STORAGE_CEILING_BYTES),
      }),
    };
    const admission = evaluateDispatchJournalAdmission(journal, {
      deliveryId: 'new',
      sessionId: 's1',
      deliveredAtMs: nowMs,
      dispatchOutcome: 'dispatch_in_flight',
      draftState: 'draft_present',
    });
    expect(admission.ok).toBe(false);
    expect(admission.reason).toBe('over_capacity');
  });

  it('admits a new record once compactable entries free capacity', () => {
    const nowMs = 2_000_000_000_000;
    const journal: Record<string, unknown> = {
      old: {
        deliveryId: 'old',
        sessionId: 's1',
        deliveredAtMs: nowMs - SUBMIT_DELIVERY_RETENTION_MS - 60_000,
        dispatchOutcome: 'dispatched',
        draftState: 'draft_present',
        fenceLifecycle: 'completed',
      },
    };
    const compacted = compactDispatchJournal(journal, nowMs);
    expect(compacted.evicted).toContain('old');
    const admitted = admitDispatchJournalRecord(compacted.journal, {
      deliveryId: 'new',
      sessionId: 's1',
      deliveredAtMs: nowMs,
      dispatchOutcome: 'dispatch_in_flight',
      draftState: 'draft_present',
    }, nowMs);
    expect(admitted.ok).toBe(true);
    expect((admitted.record as Record<string, unknown>)?.fenceLifecycle).toBe('pending');
  });

  it('measures the complete journal including property keys before admitting', () => {
    const nowMs = Date.now();
    const longDeliveryId = `k-${'x'.repeat(8000)}`;
    const journal: Record<string, unknown> = {
      keep: {
        deliveryId: 'keep',
        sessionId: 's1',
        deliveredAtMs: nowMs - 1000,
        dispatchOutcome: 'dispatched',
        draftState: 'draft_present',
        blob: 'a'.repeat(MECHANICAL_STORAGE_CEILING_BYTES - 9000),
      },
    };
    const candidate = withPendingDispatchFence({
      deliveryId: longDeliveryId,
      sessionId: 's1',
      deliveredAtMs: nowMs,
      dispatchOutcome: 'dispatch_in_flight',
      draftState: 'draft_present',
    });
    const currentBytes = estimateSerializedUtf8Bytes(journal);
    const legacyReservedBytes = estimateSerializedUtf8Bytes(candidate);
    const admittedJournalBytes = estimateSerializedUtf8Bytes({ ...journal, [longDeliveryId]: candidate });

    expect(currentBytes + legacyReservedBytes).toBeLessThanOrEqual(MECHANICAL_STORAGE_CEILING_BYTES);
    expect(admittedJournalBytes).toBeGreaterThan(MECHANICAL_STORAGE_CEILING_BYTES);

    const admission = evaluateDispatchJournalAdmission(journal, candidate);
    expect(admission.ok).toBe(false);
    expect(admission.reason).toBe('over_capacity');
  });
});


describe('dispatch journal retention', () => {
  it('allows terminal failed dispatches to age out after retention', () => {
    const nowMs = Date.now();
    const deliveredAtMs = nowMs - DISPATCH_JOURNAL_RETENTION_MS - 60_000;
    const sendFailed = {
      deliveryId: 'failed-send',
      sessionId: 's1',
      deliveredAtMs,
      dispatchOutcome: DISPATCH_OUTCOME_SEND_FAILED,
      fenceLifecycle: FENCE_LIFECYCLE_FAILED_UNCERTAIN,
    };
    const dispatchUnknown = {
      deliveryId: 'failed-unknown',
      sessionId: 's1',
      deliveredAtMs,
      dispatchOutcome: DISPATCH_OUTCOME_UNKNOWN,
      fenceLifecycle: FENCE_LIFECYCLE_FAILED_UNCERTAIN,
    };

    expect(isDispatchJournalEntryEvictable(sendFailed, nowMs)).toBe(true);
    expect(isDispatchJournalEntryEvictable(dispatchUnknown, nowMs)).toBe(true);

    const compacted = compactDispatchJournal({
      [sendFailed.deliveryId]: sendFailed,
      [dispatchUnknown.deliveryId]: dispatchUnknown,
    }, nowMs);
    expect(compacted.evicted).toEqual(expect.arrayContaining(['failed-send', 'failed-unknown']));
  });

  it('retains in-flight or fresh terminal failures until retention expires', () => {
    const nowMs = Date.now();
    const freshFailed = {
      deliveryId: 'fresh-failed',
      sessionId: 's1',
      deliveredAtMs: nowMs - 1000,
      dispatchOutcome: DISPATCH_OUTCOME_SEND_FAILED,
      fenceLifecycle: FENCE_LIFECYCLE_FAILED_UNCERTAIN,
    };
    const inFlightUnknown = {
      deliveryId: 'in-flight-unknown',
      sessionId: 's1',
      deliveredAtMs: nowMs - DISPATCH_JOURNAL_RETENTION_MS - 60_000,
      dispatchOutcome: DISPATCH_OUTCOME_UNKNOWN,
    };

    expect(isDispatchJournalEntryEvictable(freshFailed, nowMs)).toBe(false);
    expect(isDispatchJournalEntryEvictable(inFlightUnknown, nowMs)).toBe(false);
  });

  it('bounds retention of completed adoption probe records', () => {
    const nowMs = Date.now();
    const deliveredAtMs = nowMs - DISPATCH_JOURNAL_RETENTION_MS - 60_000;
    const probe = {
      deliveryId: 'probe-old',
      sessionId: 'synthetic',
      deliveredAtMs,
      source: 'adoption-probe',
      adoptionProbe: true,
      dispatchOutcome: 'dispatched',
      draftState: 'auto_submitted',
      fenceLifecycle: 'completed',
    };

    expect(isDispatchJournalEntryEvictable(probe, nowMs)).toBe(true);
    const compacted = compactDispatchJournal({ [probe.deliveryId]: probe }, nowMs);
    expect(compacted.evicted).toContain('probe-old');
  });

  it('retains in-flight adoption probe records until finalized and aged', () => {
    const nowMs = Date.now();
    const probe = {
      deliveryId: 'probe-fresh',
      sessionId: 'synthetic',
      deliveredAtMs: nowMs - 1000,
      source: 'adoption-probe',
      adoptionProbe: true,
      dispatchOutcome: 'dispatch_in_flight',
      fenceLifecycle: 'pending',
    };

    expect(isDispatchJournalEntryEvictable(probe, nowMs)).toBe(false);
  });
});

describe('transport envelope parsing', () => {
  it('rejects truncated JSON text', () => {
    expect(() => parseCompleteJsonText('{"sent":{')).toThrow(/malformed_child_output/);
  });

  it('rejects payloads beyond the declared envelope', () => {
    const text = `{"blob":"${'a'.repeat(MECHANICAL_TRANSPORT_ENVELOPE_BYTES)}"}`;
    expect(() => assertTransportEnvelope(text)).toThrow(/transport_envelope_exceeded/);
  });
});

describe('Invoke-MechanicalNodeFilterCli over-buffer round-trip', () => {
  it('round-trips state larger than the pipe buffer within the envelope', () => {
    const payload = buildLargePayload(MECHANICAL_PIPE_BUFFER_BYTES + 4096);
    const payloadJson = JSON.stringify(payload);
    expect(Buffer.byteLength(payloadJson, 'utf8')).toBeGreaterThan(MECHANICAL_PIPE_BUFFER_BYTES);

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mech-transport-'));
    const inputPath = path.join(stateDir, 'in.json');
    const outputPath = path.join(stateDir, 'out.json');
    fs.writeFileSync(inputPath, payloadJson, 'utf8');
    try {
      const escapedLib = libScript.replace(/'/g, "''");
      const escapedFilter = echoFilter.replace(/'/g, "''");
      const escapedInput = inputPath.replace(/'/g, "''");
      const escapedOutput = outputPath.replace(/'/g, "''");
      const resultJson = runPwsh(`
        . '${escapedLib}'
        $payload = Get-Content -LiteralPath '${escapedInput}' -Raw | ConvertFrom-Json
        $hashtable = @{}
        foreach ($prop in $payload.PSObject.Properties) { $hashtable[$prop.Name] = $prop.Value }
        $result = Invoke-MechanicalNodeFilterCli -FilterCliPath '${escapedFilter}' -Subcommand 'echo' -Payload $hashtable -Label 'transport-test' -JsonDepth 30
        $result | ConvertTo-Json -Depth 30 -Compress
      `);
      const parsed = JSON.parse(resultJson);
      expect(parsed.marker).toBe('over-buffer-fixture');
      expect(String(parsed.padding).length).toBeGreaterThan(MECHANICAL_PIPE_BUFFER_BYTES);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('does not commit partial child output', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mech-partial-'));
    const outputPath = path.join(stateDir, 'partial.out.json');
    fs.writeFileSync(outputPath, '{"sent":{', 'utf8');
    try {
      const escapedLib = libScript.replace(/'/g, "''");
      const escapedOutput = outputPath.replace(/'/g, "''");
      expect(() => {
        runPwsh(`
          . '${escapedLib}'
          Read-MechanicalNodeFilterCliOutput -OutputPath '${escapedOutput}' -Label 'transport-test' -Subcommand 'echo'
        `);
      }).toThrow(/malformed or truncated JSON/);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('fails closed beyond the declared transport envelope', () => {
    const payload = buildLargePayload(MECHANICAL_TRANSPORT_ENVELOPE_BYTES + 1024);
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mech-over-envelope-'));
    const payloadPath = path.join(stateDir, 'payload.json');
    fs.writeFileSync(payloadPath, JSON.stringify(payload), 'utf8');
    const escapedLib = libScript.replace(/'/g, "''");
    const escapedFilter = echoFilter.replace(/'/g, "''");
    const escapedPayload = payloadPath.replace(/'/g, "''");
    try {
      expect(() => {
        runPwsh(`
          . '${escapedLib}'
          $payload = Get-Content -LiteralPath '${escapedPayload}' -Raw | ConvertFrom-Json
          $hashtable = @{}
          foreach ($prop in $payload.PSObject.Properties) { $hashtable[$prop.Name] = $prop.Value }
          Invoke-MechanicalNodeFilterCli -FilterCliPath '${escapedFilter}' -Subcommand 'echo' -Payload $hashtable -Label 'transport-test' -JsonDepth 5
        `);
      }).toThrow(/exceeds transport envelope/);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('creates user-private transport temp files on unix hosts', () => {
    if (process.platform === 'win32') {
      return;
    }
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mech-perms-'));
    const escapedLib = libScript.replace(/'/g, "''");
    const escapedRoot = stateDir.replace(/'/g, "''");
    try {
      runPwsh(`
        $env:AO_MECHANICAL_TRANSPORT_TEMP = '${escapedRoot}'
        . '${escapedLib}'
        $paths = New-MechanicalTransportTempPaths
        Write-MechanicalTransportPrivateFile -Path $paths.InputPath -Content '{"private":true}'
        Write-Output $paths.InputPath
      `);
      const rootMode = fs.statSync(stateDir).mode & 0o777;
      const inputPath = path.join(stateDir, fs.readdirSync(stateDir).find((name) => name.endsWith('.in.json')) ?? '');
      const fileMode = fs.statSync(inputPath).mode & 0o777;
      expect(rootMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe('submit tracking capacity helper', () => {
  it('reports over-capacity when tracking exceeds the ceiling', () => {
    const tracking = { deliveries: { x: { blob: 'a'.repeat(MECHANICAL_STORAGE_CEILING_BYTES) } } };
    const capacity = evaluateSubmitTrackingCapacity(tracking);
    expect(capacity.overCapacity).toBe(true);
  });
});

describe('issue #339 bounded reconcile state', () => {
  it('builds failed-delivery state from compacted tracking after convergence', () => {
    const nowMs = Date.now();
    const resolvedAtMs = nowMs - SUBMIT_DELIVERY_RETENTION_MS - 60_000;
    const failedDeliveries: Record<string, FailedDeliveryRecord> = {};
    for (let i = 0; i < 40; i++) {
      failedDeliveries[`failed-${i}`] = {
        deliveryId: `failed-${i}`,
        sessionId: 'opk-bounded',
        reason: 'resolved_test:' + 'x'.repeat(6000),
        unresolvedState: FAILED_DELIVERY_RESOLVED,
        resolvedAtMs,
      };
    }

    const result = planWorkerMessageSubmitActions({
      sessions: [],
      dispatchJournal: {},
      tracking: { deliveries: {}, failedDeliveries, audit: [] },
      nowMs,
    });

    for (let i = 0; i < 40; i++) {
      expect(result.tracking.failedDeliveries?.[`failed-${i}`]).toBeUndefined();
    }
    expect(result.actions.some((action) => action.deliveryId === 'over-capacity')).toBe(false);
  });

  it('reconciles against compacted dispatch journal after convergence', () => {
    const nowMs = Date.now();
    const deliveredAtMs = nowMs - DISPATCH_JOURNAL_RETENTION_MS - 60_000;
    const dispatchJournal: Record<string, Record<string, unknown>> = {};
    const entryCount = Math.ceil(MECHANICAL_STORAGE_CEILING_BYTES / 50_000) + 5;
    for (let i = 0; i < entryCount; i++) {
      const id = `old:${i}:${deliveredAtMs}:ao-send`;
      dispatchJournal[id] = {
        deliveryId: id,
        sessionId: 'opk-stale',
        deliveredAtMs,
        source: 'ao-send',
        deliveryPath: 'pending-draft',
        dispatchOutcome: 'dispatched',
        draftState: 'draft_present',
        messageShape: { charLength: 240, lineCount: 3 },
        note: 'x'.repeat(50_000),
      };
    }

    const result = planWorkerMessageSubmitActions({
      sessions: [{
        sessionId: 'opk-stale',
        role: 'worker',
        status: 'working',
        runtime: 'alive',
        activity: 'idle',
        reports: [],
      }],
      dispatchJournal,
      tracking: { deliveries: {}, failedDeliveries: {}, audit: [] },
      nowMs,
    });

    expect(result.deliveryCount).toBe(0);
    expect(result.actions.some((action) => action.type === 'escalate')).toBe(false);
  });

  it('finalizes draft state atomically before compaction evicts stale records', () => {
    const nowMs = Date.now();
    const deliveredAtMs = nowMs - DISPATCH_JOURNAL_RETENTION_MS - 60_000;
    const deliveryId = 'old:1000:ao-send';
    const journal = {
      [deliveryId]: {
        deliveryId,
        sessionId: 'opk-stale',
        deliveredAtMs,
        source: 'ao-send',
        dispatchOutcome: 'dispatch_in_flight',
        draftState: 'unknown',
      },
    };

    const result = finalizeDispatchJournalRecord(
      journal,
      deliveryId,
      'dispatched',
      nowMs,
      'draft_present',
    );

    expect(result.ok).toBe(true);
    expect(result.evicted).toBe(true);
    expect(result.journal[deliveryId]).toBeUndefined();
  });
});
