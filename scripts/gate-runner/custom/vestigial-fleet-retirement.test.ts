import { describe, expect, it } from 'vitest';
import { evaluateVestigialFleetRetirement, LISTENER_EVIDENCE_PATH, type TextReader } from './vestigial-fleet-retirement.ts';
import { memorySnapshot } from '../source-snapshot.ts';

const capture = JSON.stringify({
  issue: 745,
  baseCommitSha: '9728896230f8f66de09c485dff613dfdee5cfd9f',
  aoVersion: '0.10.2',
  disposition: 'retire',
  productionAudit: { inboundWebhookPosts: 0 },
  finalBaseProbe: { bindingVerified: true, inboundWebhookPosts: 0, observationWindowSeconds: 60 },
});

const requiredFiles = {
  'scripts/orchestrator-side-process-registry.json': JSON.stringify({ requiredChildIds: [], children: [] }),
  'scripts/orchestrator-wake-supervisor.ps1': '# clean',
  'scripts/launch-argv-inventory.json': '{}',
  'scripts/orchestrator-escalation-emitter-inventory.json': '{}',
  'scripts/orchestrator-message-audit-roots.manifest.json': '{}',
  'scripts/orchestrator-message-protected-runtime.manifest.json': '{}',
  'scripts/orchestrator-message-send-helpers.manifest.json': '{}',
  'scripts/orchestrator-message-catalog.json': '{}',
  'scripts/fixtures/mechanical-json-state/state-coverage-manifest.json': '{}',
  'docs/orchestrator-message-map.md': '# clean',
  'docs/review-pipeline-spawn-budget.mjs': '// clean',
  'docs/review-pipeline-spawn-budget-attribution.mjs': '// clean',
  'docs/review-finding-delivery-confirm.mjs': 'export const compatibility = true;',
  'docs/review-finding-delivery-confirm.d.mts': 'export declare const compatibility: boolean;',
};

function reader(values: readonly (string | undefined)[]): TextReader {
  let index = 0;
  return { read: () => values[Math.min(index++, values.length - 1)] };
}

describe('custom capture-schema/live-adoption gate', () => {
  it('passes only with static, schema, and live-adoption evidence', () => {
    const result = evaluateVestigialFleetRetirement(memorySnapshot(requiredFiles), reader([capture, capture]));
    expect(result.status).toBe('PASS');
    expect(result.evidence.map((item) => item.class)).toEqual(['static-source', 'capture-schema', 'live-adoption']);
  });

  it('fails a falsified live-adoption capture', () => {
    const bad = JSON.stringify({ ...JSON.parse(capture), finalBaseProbe: { bindingVerified: false, inboundWebhookPosts: 0, observationWindowSeconds: 60 } });
    expect(evaluateVestigialFleetRetirement(memorySnapshot(requiredFiles), reader([bad, bad])).status).toBe('FAIL');
  });

  it('SKIPs when the capture is absent instead of converting absence to PASS', () => {
    expect(evaluateVestigialFleetRetirement(memorySnapshot(requiredFiles), reader([undefined])).status).toBe('SKIP');
  });

  it('SKIPs a race where evidence disappears between schema load and evaluation', () => {
    const result = evaluateVestigialFleetRetirement(memorySnapshot(requiredFiles), reader([capture, undefined]));
    expect(result.status).toBe('SKIP');
    expect(result.details?.join('\n')).toContain('disappeared');
  });

  it('fails malformed capture schema', () => {
    const result = evaluateVestigialFleetRetirement(memorySnapshot(requiredFiles), reader(['{}', '{}']));
    expect(result.status).toBe('FAIL');
    expect(result.evidence.some((item) => item.class === 'capture-schema')).toBe(true);
  });

  it('binds the expected capture path', () => {
    expect(LISTENER_EVIDENCE_PATH).toBe('tests/fixtures/listener-disposition/retire.json');
  });
});
