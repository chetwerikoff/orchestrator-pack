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
  interpretDispatchFenceLifecycle,
  isSubmitDeliveryEvictable,
  maxChildOutputBytesForStorage,
  parseCompleteJsonText,
  storageBytesWithinTransportEnvelope,
  SUBMIT_DELIVERY_RETENTION_MS,
  FAILED_DELIVERY_RESOLVED,
  withPendingDispatchFence,
} from '../docs/mechanical-reconcile-bounds.mjs';
import { admitDispatchJournalRecord } from '../docs/worker-message-dispatch-observe.mjs';
import { planWorkerMessageSubmitActions } from '../docs/worker-message-submit-reconcile.mjs';

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
    const failedDeliveries: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 40; i++) {
      failedDeliveries[`failed-${i}`] = {
        deliveryId: `failed-${i}`,
        sessionId: 'opk-bounded',
        reason: 'resolved_test',
        unresolvedState: FAILED_DELIVERY_RESOLVED,
        resolvedAtMs,
        payload: 'x'.repeat(6000),
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
    expect(result.overCapacity).not.toBe(true);
  });
});
