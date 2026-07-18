import { failGate, passGate, skipGate, type EvidenceObservation, type GateResult } from '../contracts.ts';
import type { GateEvaluationContext, GateRegistration } from '../registry.ts';
import type { SourceSnapshot } from '../source-snapshot.ts';

interface ReadOutcome {
  readonly text?: string;
  readonly missing?: string;
  readonly unreachable?: string;
}

function readSource(snapshot: SourceSnapshot, path: string): ReadOutcome {
  const text = snapshot.files.get(path);
  if (text !== undefined) return { text };
  if (snapshot.unreadable.has(path)) return { unreachable: `${path}: ${snapshot.unreadable.get(path)}` };
  return { missing: `missing required file: ${path}` };
}

function staticEvidence(
  snapshot: SourceSnapshot,
  state: EvidenceObservation['state'] = 'present',
  detail?: string,
): EvidenceObservation[] {
  return [{ class: 'static-source', state, source: snapshot.root, detail }];
}

function completeStaticGate(
  gateId: string,
  summary: string,
  passStdout: string,
  snapshot: SourceSnapshot,
  failures: readonly string[],
  unreachable: readonly string[] = [],
  failureStdout?: string,
): GateResult {
  if (unreachable.length > 0) {
    return skipGate(
      gateId,
      `${summary} Source evidence is unreachable.`,
      staticEvidence(snapshot, 'unreachable', unreachable.join('; ')),
      unreachable,
    );
  }
  if (failures.length > 0) {
    return failGate(gateId, summary, staticEvidence(snapshot), failures, failureStdout);
  }
  return passGate(gateId, summary, ['static-source'], staticEvidence(snapshot), {
    legacyStdout: passStdout,
  });
}

function requireText(
  snapshot: SourceSnapshot,
  path: string,
  failures: string[],
  unreachable: string[],
): string | undefined {
  const result = readSource(snapshot, path);
  if (result.missing) failures.push(result.missing);
  if (result.unreachable) unreachable.push(result.unreachable);
  return result.text;
}

export function evaluateAgentsReportContract(snapshot: SourceSnapshot): GateResult {
  const gateId = 'agents-report-contract';
  const failures: string[] = [];
  const unreachable: string[] = [];

  for (const path of ['AGENTS.md', 'scripts/pack-worker-report.ps1']) {
    requireText(snapshot, path, failures, unreachable);
  }

  return completeStaticGate(
    gateId,
    'Worker instructions and pack-owned report entrypoint exist',
    'check-agents-report-contract: PASS\n',
    snapshot,
    failures,
    unreachable,
    failures[0] ? `${failures[0]}\n` : undefined,
  );
}

export function evaluateCoworkerDelegationThreshold(snapshot: SourceSnapshot): GateResult {
  const gateId = 'coworker-delegation-threshold-drift';
  const failures: string[] = [];
  const unreachable: string[] = [];
  const source = readSource(snapshot, 'AGENTS.md');
  if (source.unreachable) unreachable.push(source.unreachable);
  if (source.missing) {
    failures.push('[FAIL] missing canonical policy: AGENTS.md');
  } else if (source.text !== undefined && !/more than 400 lines/iu.test(source.text)) {
    failures.push('[FAIL] AGENTS.md must state T1 volume floor of 400 lines');
  }

  if (failures.length === 0) {
    const stale = ['more than 600 lines', 'total **more than 600', 'together total **more than 600'];
    for (const path of ['AGENTS.md', 'CLAUDE.md']) {
      const result = readSource(snapshot, path);
      if (result.unreachable) unreachable.push(result.unreachable);
      if (result.text === undefined) continue;
      for (const literal of stale) {
        if (result.text.includes(literal)) {
          failures.push(`${path} still contains stale volume-floor literal: ${literal}`);
        }
      }
    }
  }

  const failureStdout = failures.length === 0
    ? undefined
    : failures[0]!.startsWith('[FAIL]')
      ? `${failures[0]}\n`
      : `[FAIL] coworker delegation threshold drift:\n${failures.map((failure) => ` - ${failure}`).join('\n')}\n`;

  return completeStaticGate(
    gateId,
    'Coworker delegation T1 volume-floor contract',
    '[PASS] coworker delegation T1 floor is 400 with no stale 600 volume-floor literals in tracked policy files.\n',
    snapshot,
    failures,
    unreachable,
    failureStdout,
  );
}

const LIVE_PACK_REVIEW_PATHS = [
  'scripts/pack-review-runner.ts',
  'scripts/invoke-pack-review.ps1',
  'scripts/lib/pack-review-delivery.ts',
] as const;

function evaluateLivePackReviewSources(snapshot: SourceSnapshot): {
  failures: string[];
  unreachable: string[];
  sources: Map<string, string>;
} {
  const failures: string[] = [];
  const unreachable: string[] = [];
  const sources = new Map<string, string>();

  for (const path of LIVE_PACK_REVIEW_PATHS) {
    const text = requireText(snapshot, path, failures, unreachable);
    if (text !== undefined) sources.set(path, text);
  }

  for (const [path, text] of sources) {
    if (/\bao\s+review\s+(?:run|list|send|execute|submit)\b/iu.test(text)) {
      failures.push(`${path}: live pack-review path invokes AO review CLI`);
    }
    if (/Invoke-AoReviewApi|POST\s+\/reviews\/trigger|GET\s+\/reviews/iu.test(text)) {
      failures.push(`${path}: live pack-review path depends on AO review HTTP`);
    }
  }

  return { failures, unreachable, sources };
}

export function evaluateReview010Vocabulary(snapshot: SourceSnapshot): GateResult {
  const gateId = 'review-010-vocabulary';
  const evaluated = evaluateLivePackReviewSources(snapshot);
  const failureStdout = evaluated.failures.length > 0
    ? `Pack review runtime boundary violations:\n${evaluated.failures.map((failure) => `  ${failure}`).join('\n')}\n`
    : undefined;

  return completeStaticGate(
    gateId,
    'Live pack review does not invoke AO Reviews',
    '[PASS] live pack review does not invoke AO review CLI or HTTP\n',
    snapshot,
    evaluated.failures,
    evaluated.unreachable,
    failureStdout,
  );
}

export function evaluateReviewCommandNotAo(snapshot: SourceSnapshot): GateResult {
  const gateId = 'review-command-not-ao';
  const evaluated = evaluateLivePackReviewSources(snapshot);
  const failures = [...evaluated.failures];
  const combinedRuntime = [...evaluated.sources.values()].join('\n');

  if (combinedRuntime.length > 0 && !combinedRuntime.includes('orchestrator-pack/pack-review')) {
    failures.push('live pack-review sources are missing the exact required-status context');
  }

  const failureStdout = failures.length > 0
    ? `[FAIL] pack review runtime authority:\n${failures.map((failure) => ` - ${failure}`).join('\n')}\n`
    : undefined;

  return completeStaticGate(
    gateId,
    'Pack runner owns review and exact-head status authority',
    '[PASS] pack runner owns review and exact-head status authority\n',
    snapshot,
    failures,
    evaluated.unreachable,
    failureStdout,
  );
}

export const VERIFY_CONTRACT_MARKERS: Readonly<Record<string, readonly string[]>> = {
  'plugins/ao-task-declaration/README.md': [
    'DD-026',
    'DD-027',
    'declared_files',
    'denylist',
    'one amendment',
    'baseline',
  ],
  'plugins/ao-scope-guard/README.md': [
    'DD-024',
    'runtime guard',
    'git add',
    'commit',
    'PR-level CI',
    'second line',
  ],
  'plugins/ao-token-chain-ledger/README.md': [
    'chain_id',
    'planner',
    'reviewer',
    'worker',
    'per-session cost',
    'estimated_cost_usd',
  ],
  'plugins/ao-codex-pr-reviewer/README.md': [
    'Codex',
    'gpt-5.5',
    'PR review',
    'GitHub Issues',
    'no core patch',
  ],
};

export const VERIFY_PROMPT_GLOB = 'prompts/*.md';

function matchesVerifyPromptGlob(path: string): boolean {
  const [prefix = '', suffix = ''] = VERIFY_PROMPT_GLOB.split('*', 2);
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return false;
  return !path.slice(prefix.length, path.length - suffix.length).includes('/');
}

export function evaluateVerifyStructureContract(snapshot: SourceSnapshot): GateResult {
  const gateId = 'verify-structure-contract';
  const failures: string[] = [];
  const unreachable: string[] = [];
  const promptFiles = snapshot.paths.filter(matchesVerifyPromptGlob);
  if (promptFiles.length === 0) failures.push('Missing prompt markdown files');

  for (const [path, markers] of Object.entries(VERIFY_CONTRACT_MARKERS)) {
    const text = requireText(snapshot, path, failures, unreachable);
    if (text === undefined) continue;
    for (const marker of markers) {
      if (!text.toLocaleLowerCase().includes(marker.toLocaleLowerCase())) {
        failures.push(`Contract ${path} missing marker: ${marker}`);
      }
    }
  }

  return completeStaticGate(
    gateId,
    'Prompt inventory and plugin contract markers',
    '[PASS] verify prompt inventory and plugin contract markers\n',
    snapshot,
    failures,
    unreachable,
  );
}

function registration(
  gateId: string,
  evaluate: (snapshot: SourceSnapshot) => GateResult,
): GateRegistration {
  return { gateId, evaluate: ({ snapshot }: GateEvaluationContext) => evaluate(snapshot) };
}

export const bulkStaticGateRegistrations: readonly GateRegistration[] = [
  registration('agents-report-contract', evaluateAgentsReportContract),
  registration('coworker-delegation-threshold-drift', evaluateCoworkerDelegationThreshold),
  registration('review-010-vocabulary', evaluateReview010Vocabulary),
  registration('review-command-not-ao', evaluateReviewCommandNotAo),
  registration('verify-structure-contract', evaluateVerifyStructureContract),
];
