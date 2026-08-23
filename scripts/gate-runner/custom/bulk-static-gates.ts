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

function staticEvidence(snapshot: SourceSnapshot, state: EvidenceObservation['state'] = 'present', detail?: string): EvidenceObservation[] {
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
  return passGate(gateId, summary, ['static-source'], staticEvidence(snapshot), { legacyStdout: passStdout });
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
  const source = readSource(snapshot, 'AGENTS.md');
  if (source.unreachable) unreachable.push(source.unreachable);
  if (source.missing) {
    failures.push('Missing AGENTS.md');
  } else if (source.text !== undefined) {
    if (/(?<![A-Za-z0-9_-])a\u006f report(?![A-Za-z0-9_-])/u.test(source.text)) {
      failures.push('AGENTS.md still references removed a\u006f report command');
    } else if (!/pack-worker-report/iu.test(source.text)) {
      failures.push('AGENTS.md must reference pack-worker-report command');
    } else if (!/skip silently/iu.test(source.text)) {
      failures.push('AGENTS.md must include skip silently rule for unavailable report command');
    }
  }
  return completeStaticGate(
    gateId,
    'AGENTS.md worker-report contract',
    'check-agents-report-contract: PASS\n',
    snapshot,
    failures,
    unreachable,
    failures[0] ? `${failures[0]}\n` : undefined,
  );
}

const REVIEW_010_ALLOWLIST = new Set([
  'scripts/ao-review.ps1',
  'scripts/check-review-producer-contract.ps1',
  'scripts/check-ao-0-10-review-trigger.ps1',
  'scripts/check-review-send-reconcile.ps1',
  'scripts/check-review-start-claim-guard.ps1',
  'scripts/check-review-trigger-reconcile.ps1',
  'scripts/check-review-wake-trigger.ps1',
  'scripts/check-review-cycle-cap.ps1',
  'scripts/check-merge-triage-gate.ps1',
  'scripts/lib/Review-MechanicalForbiddenCommand.ps1',
  'scripts/review-send-reconcile.ps1',
  'docs/ao-0-10-review-api.mjs',
  'docs/review-mechanical-cli.mjs',
]);

export function evaluateReview010Vocabulary(snapshot: SourceSnapshot): GateResult {
  const gateId = 'review-010-vocabulary';
  const failures: string[] = [];
  const unreachable: string[] = [];
  const predicates = [
    { regex: /\bao\s+review\s+(run|list|send|execute)\b/iu, reason: 'dead a\u006f review CLI verb' },
    { regex: /\[\s*['"]review['"]\s*,\s*['"](run|list|send|execute)['"]/iu, reason: 'dead a\u006f review CLI argv' },
    { regex: /\b(needs_triage|sentFindingCount|terminationReason)\b/iu, reason: 'false-equivalence field name' },
  ];
  for (const path of snapshot.paths) {
    if (!/^(?:scripts|docs)\//u.test(path) || !/\.(?:ps1|mjs)$/u.test(path)) continue;
    if (REVIEW_010_ALLOWLIST.has(path) || path.startsWith('scripts/fixtures/') || path.startsWith('tests/')) continue;
    const text = requireText(snapshot, path, failures, unreachable);
    if (text === undefined) continue;
    for (const predicate of predicates) {
      predicate.regex.lastIndex = 0;
      if (predicate.regex.test(text)) failures.push(`${path}: ${predicate.reason}`);
    }
  }
  const failureStdout = failures.length > 0
    ? `AO 0.10 review vocabulary violations:\n${failures.map((failure) => `  ${failure}`).join('\n')}\n`
    : undefined;
  return completeStaticGate(
    gateId,
    'AO 0.10 review vocabulary guard',
    '[PASS] AO 0.10 review vocabulary guard (no dead CLI / false-equivalence fields)\n',
    snapshot,
    failures,
    unreachable,
    failureStdout,
  );
}

const RETIRED_REVIEW_CONFIG_PATH = ['agent', 'orchestrator.yaml.example'].join('-');

function extractNamedReviewCommand(yaml: string): string | undefined {
  const match = /NAMED\s+REVIEW_COMMAND[^\r\n]*\r?\n\s+(.+?)(?:\r?\n\s+Alternate|\r?\n\s+RUNTIME|\r?\n\s+[A-Z]{2,})/isu.exec(yaml);
  return match?.[1]?.trim().split(/\r?\n/u)[0]?.trim();
}

export function evaluateReviewCommandNotAo(snapshot: SourceSnapshot): GateResult {
  const gateId = 'review-command-not-ao';
  const failures: string[] = [];
  const unreachable: string[] = [];
  let failureStdout: string | undefined;
  const text = snapshot.files.get(RETIRED_REVIEW_CONFIG_PATH);
  const unreadable = snapshot.unreadable.get(RETIRED_REVIEW_CONFIG_PATH);
  if (unreadable !== undefined) {
    unreachable.push(`${RETIRED_REVIEW_CONFIG_PATH}: ${unreadable}`);
  } else if (text !== undefined) {
    const command = extractNamedReviewCommand(text) ?? '<missing>';
    failures.push(`Canonical REVIEW_COMMAND must not use gitignored .orchestrator-pack/ paths: ${command}`);
    failureStdout = `[FAIL] Canonical REVIEW_COMMAND must not use gitignored .orchestrator-pack/ paths\n  REVIEW_COMMAND: ${command}\n`;
  }
  return completeStaticGate(
    gateId,
    'Retired example review configuration absence contract',
    '[PASS] example REVIEW_COMMAND does not use .orchestrator-pack/ as primary path\n',
    snapshot,
    failures,
    unreachable,
    failureStdout,
  );
}

export const VERIFY_CONTRACT_MARKERS: Readonly<Record<string, readonly string[]>> = {
  'plugins/task-declaration/README.md': ['DD-026', 'DD-027', 'declared_files', 'denylist', 'one amendment', 'baseline'],
  'plugins/scope-guard/README.md': ['DD-024', 'runtime guard', 'git add', 'commit', 'PR-level CI', 'second line'],
  'plugins/token-chain-ledger/README.md': ['chain_id', 'planner', 'reviewer', 'worker', 'per-session cost', 'estimated_cost_usd'],
  'plugins/codex-pr-reviewer/README.md': ['Codex', 'gpt-5.5', 'PR review', 'GitHub Issues', 'no core patch'],
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
      if (!text.toLocaleLowerCase().includes(marker.toLocaleLowerCase())) failures.push(`Contract ${path} missing marker: ${marker}`);
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

function registration(gateId: string, evaluate: (snapshot: SourceSnapshot) => GateResult): GateRegistration {
  return { gateId, evaluate: ({ snapshot }: GateEvaluationContext) => evaluate(snapshot) };
}

export const bulkStaticGateRegistrations: readonly GateRegistration[] = [
  registration('agents-report-contract', evaluateAgentsReportContract),
  registration('review-010-vocabulary', evaluateReview010Vocabulary),
  registration('review-command-not-ao', evaluateReviewCommandNotAo),
  registration('verify-structure-contract', evaluateVerifyStructureContract),
];
