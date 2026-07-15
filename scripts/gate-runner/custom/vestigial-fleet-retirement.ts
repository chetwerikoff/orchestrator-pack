import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  JsonContractError,
  expectBoolean,
  expectInteger,
  expectRecord,
  expectString,
  parseJsonDocument,
} from '#opk-kernel/json-contract';
import {
  failGate,
  passGate,
  skipGate,
  type EvidenceObservation,
  type GateResult,
} from '../contracts.ts';
import type { SourceSnapshot } from '../source-snapshot.ts';

const RETIRED = [
  { id: 'review-run-recovery', script: 'review-run-recovery.ps1', lock: 'review-run-recovery-side-effect.lock' },
  { id: 'review-stuck-run-reaper', script: 'review-stuck-run-reaper.ps1', lock: 'review-stuck-run-reaper-side-effect.lock' },
  { id: 'review-finding-delivery-confirm', script: 'review-finding-delivery-confirm.ps1', lock: 'delivery-confirm-side-effect.lock' },
  { id: 'ci-failure-notification-reaction', script: 'ci-failure-notification-reaction.ps1', lock: null },
  { id: 'listener', script: 'orchestrator-wake-listener.ps1', lock: 'listener-side-effect.lock' },
] as const;

const BINDING_FILES = [
  'scripts/orchestrator-wake-supervisor.ps1',
  'scripts/launch-argv-inventory.json',
  'scripts/orchestrator-escalation-emitter-inventory.json',
  'scripts/orchestrator-message-audit-roots.manifest.json',
  'scripts/orchestrator-message-protected-runtime.manifest.json',
  'scripts/orchestrator-message-send-helpers.manifest.json',
  'scripts/orchestrator-message-catalog.json',
  'scripts/fixtures/mechanical-json-state/state-coverage-manifest.json',
  'docs/orchestrator-message-map.md',
  'docs/review-pipeline-spawn-budget.mjs',
  'docs/review-pipeline-spawn-budget-attribution.mjs',
] as const;

const COMPATIBILITY_FILES = [
  'docs/review-finding-delivery-confirm.mjs',
  'docs/review-finding-delivery-confirm.d.mts',
] as const;

export const LISTENER_EVIDENCE_PATH = 'tests/fixtures/listener-disposition/retire.json';

interface ListenerEvidence {
  readonly issue: number;
  readonly baseCommitSha: string;
  readonly aoVersion: string;
  readonly disposition: string;
  readonly productionAudit: { readonly inboundWebhookPosts: number };
  readonly finalBaseProbe: {
    readonly bindingVerified: boolean;
    readonly inboundWebhookPosts: number;
    readonly observationWindowSeconds: number;
  };
}

export interface TextReader {
  read(relativePath: string): string | undefined;
}

export function fileTextReader(repoRoot: string): TextReader {
  return {
    read(relativePath: string): string | undefined {
      try {
        return readFileSync(resolve(repoRoot, relativePath), 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

function validateListenerEvidence(value: unknown, path: string): ListenerEvidence {
  const record = expectRecord(value, path);
  const productionAudit = expectRecord(record.productionAudit, `${path}.productionAudit`);
  const finalBaseProbe = expectRecord(record.finalBaseProbe, `${path}.finalBaseProbe`);
  return {
    issue: expectInteger(record.issue, `${path}.issue`),
    baseCommitSha: expectString(record.baseCommitSha, `${path}.baseCommitSha`),
    aoVersion: expectString(record.aoVersion, `${path}.aoVersion`),
    disposition: expectString(record.disposition, `${path}.disposition`),
    productionAudit: {
      inboundWebhookPosts: expectInteger(productionAudit.inboundWebhookPosts, `${path}.productionAudit.inboundWebhookPosts`),
    },
    finalBaseProbe: {
      bindingVerified: expectBoolean(finalBaseProbe.bindingVerified, `${path}.finalBaseProbe.bindingVerified`),
      inboundWebhookPosts: expectInteger(finalBaseProbe.inboundWebhookPosts, `${path}.finalBaseProbe.inboundWebhookPosts`),
      observationWindowSeconds: expectInteger(finalBaseProbe.observationWindowSeconds, `${path}.finalBaseProbe.observationWindowSeconds`),
    },
  };
}

function staticFailures(snapshot: SourceSnapshot): string[] {
  const failures: string[] = [];
  const registryText = snapshot.files.get('scripts/orchestrator-side-process-registry.json');
  if (registryText === undefined) {
    failures.push('scripts/orchestrator-side-process-registry.json: binding surface missing');
  } else {
    try {
      const registry = JSON.parse(registryText) as {
        requiredChildIds?: unknown[];
        children?: Array<{ id?: unknown; script?: unknown; sideEffectLockFile?: unknown }>;
      };
      const required = new Set((registry.requiredChildIds ?? []).map(String));
      for (const retired of RETIRED) {
        if (required.has(retired.id)) failures.push(`scripts/orchestrator-side-process-registry.json: ${retired.id} (retired id present in requiredChildIds)`);
        for (const child of registry.children ?? []) {
          if (String(child.id ?? '') === retired.id) failures.push(`scripts/orchestrator-side-process-registry.json: ${retired.id} (retired child row present)`);
          if (String(child.script ?? '') === retired.script) failures.push(`scripts/orchestrator-side-process-registry.json: ${retired.script} (retired entrypoint present in child row)`);
          if (retired.lock && String(child.sideEffectLockFile ?? '') === retired.lock) failures.push(`scripts/orchestrator-side-process-registry.json: ${retired.lock} (retired lock name present in child row)`);
        }
      }
    } catch (error) {
      failures.push(`scripts/orchestrator-side-process-registry.json: <invalid-json> (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  for (const path of BINDING_FILES) {
    const text = snapshot.files.get(path);
    if (text === undefined) {
      failures.push(`${path}: <missing> (binding surface missing)`);
      continue;
    }
    for (const retired of RETIRED) {
      for (const marker of [retired.id, retired.script, retired.lock]) {
        if (marker && text.includes(marker)) failures.push(`${path}: ${marker} (retired marker reintroduced)`);
      }
    }
  }

  for (const retired of RETIRED) {
    const path = `scripts/${retired.script}`;
    if (snapshot.paths.includes(path)) failures.push(`${path}: ${retired.script} (retired entrypoint still exists)`);
  }
  for (const path of COMPATIBILITY_FILES) {
    if (!snapshot.paths.includes(path)) failures.push(`${path}: <missing> (declared compatibility surface missing)`);
  }
  return failures;
}

function liveFailures(evidence: ListenerEvidence): string[] {
  const failures: string[] = [];
  if (evidence.issue !== 745) failures.push(`${LISTENER_EVIDENCE_PATH}: issue (listener disposition evidence must bind to issue 745)`);
  if (evidence.baseCommitSha !== '9728896230f8f66de09c485dff613dfdee5cfd9f') failures.push(`${LISTENER_EVIDENCE_PATH}: baseCommitSha (listener probe must bind to the PR-A merge commit)`);
  if (evidence.aoVersion !== '0.10.2') failures.push(`${LISTENER_EVIDENCE_PATH}: aoVersion (listener probe must record AO 0.10.2)`);
  if (evidence.disposition !== 'retire') failures.push(`${LISTENER_EVIDENCE_PATH}: disposition (listener disposition is not retire)`);
  if (!evidence.finalBaseProbe.bindingVerified) failures.push(`${LISTENER_EVIDENCE_PATH}: bindingVerified (final-base listener bind was not verified)`);
  if (evidence.productionAudit.inboundWebhookPosts !== 0 || evidence.finalBaseProbe.inboundWebhookPosts !== 0) failures.push(`${LISTENER_EVIDENCE_PATH}: inboundWebhookPosts (listener retirement requires zero observed POSTs)`);
  if (evidence.finalBaseProbe.observationWindowSeconds < 60) failures.push(`${LISTENER_EVIDENCE_PATH}: observationWindowSeconds (listener observation window is shorter than 60 seconds)`);
  return failures;
}

function legacyFailure(failures: readonly string[]): string {
  return `vestigial fleet retirement guard: FAIL\n${failures.map((failure) => `- ${failure}`).join('\n')}\n`;
}

export function evaluateVestigialFleetRetirement(
  snapshot: SourceSnapshot,
  reader: TextReader,
): GateResult {
  const staticEvidence: EvidenceObservation = { class: 'static-source', state: 'present', source: snapshot.root };
  const firstCapture = reader.read(LISTENER_EVIDENCE_PATH);
  if (firstCapture === undefined) {
    return skipGate(
      'vestigial-fleet-retirement',
      'Listener-retirement capture is missing; the custom gate cannot prove retirement.',
      [
        staticEvidence,
        { class: 'capture-schema', state: 'missing', source: LISTENER_EVIDENCE_PATH },
        { class: 'live-adoption', state: 'missing', source: LISTENER_EVIDENCE_PATH },
      ],
      [`missing ${LISTENER_EVIDENCE_PATH}`],
    );
  }

  let parsed: ListenerEvidence;
  try {
    parsed = parseJsonDocument(firstCapture, validateListenerEvidence).value;
  } catch (error) {
    const detail = error instanceof JsonContractError
      ? error.issues.map((issue) => `${issue.path}: ${issue.message}`)
      : [error instanceof Error ? error.message : String(error)];
    return failGate(
      'vestigial-fleet-retirement',
      'Listener-retirement capture schema is invalid.',
      [staticEvidence, { class: 'capture-schema', state: 'present', source: LISTENER_EVIDENCE_PATH }],
      detail,
      legacyFailure(detail),
    );
  }

  // Re-read at evaluation time. A capture removed after schema load must not leave a stale PASS.
  const currentCapture = reader.read(LISTENER_EVIDENCE_PATH);
  if (currentCapture === undefined) {
    return skipGate(
      'vestigial-fleet-retirement',
      'Listener-retirement capture became unreachable before live-adoption evaluation.',
      [
        staticEvidence,
        { class: 'capture-schema', state: 'present', source: LISTENER_EVIDENCE_PATH },
        { class: 'live-adoption', state: 'unreachable', source: LISTENER_EVIDENCE_PATH },
      ],
      [`${LISTENER_EVIDENCE_PATH} disappeared between schema load and evaluation`],
    );
  }

  try {
    parsed = parseJsonDocument(currentCapture, validateListenerEvidence).value;
  } catch (error) {
    const detail = [error instanceof Error ? error.message : String(error)];
    return failGate(
      'vestigial-fleet-retirement',
      'Listener-retirement capture changed to an invalid schema before evaluation.',
      [
        staticEvidence,
        { class: 'capture-schema', state: 'present', source: LISTENER_EVIDENCE_PATH },
        { class: 'live-adoption', state: 'present', source: LISTENER_EVIDENCE_PATH },
      ],
      detail,
      legacyFailure(detail),
    );
  }

  const failures = [...staticFailures(snapshot), ...liveFailures(parsed)];
  const evidence: EvidenceObservation[] = [
    staticEvidence,
    { class: 'capture-schema', state: 'present', source: LISTENER_EVIDENCE_PATH },
    { class: 'live-adoption', state: 'present', source: LISTENER_EVIDENCE_PATH },
  ];
  if (failures.length > 0) {
    return failGate(
      'vestigial-fleet-retirement',
      'Vestigial fleet retirement invariants failed.',
      evidence,
      failures,
      legacyFailure(failures),
    );
  }
  return passGate(
    'vestigial-fleet-retirement',
    'Vestigial fleet retirement remains proven by static bindings and the recorded live probe.',
    ['static-source', 'capture-schema', 'live-adoption'],
    evidence,
    { legacyStdout: 'vestigial fleet retirement guard: PASS\n' },
  );
}
