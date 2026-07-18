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
  const agents = readSource(snapshot, 'AGENTS.md');
  const report = readSource(snapshot, 'scripts/pack-worker-report.ps1');

  if (agents.unreachable) unreachable.push(agents.unreachable);
  if (report.unreachable) unreachable.push(report.unreachable);
  if (agents.missing) failures.push(agents.missing);

  let failureStdout: string | undefined;
  if (report.missing) {
    if (agents.text !== undefined && /\bao\s+report\b/iu.test(agents.text)) {
      failures.push('AGENTS.md still references removed ao report command');
      failureStdout = 'AGENTS.md still references removed ao report command\n';
    } else {
      failures.push(report.missing);
    }
  }

  return completeStaticGate(
    gateId,
    'Worker instructions and pack-owned report entrypoint exist',
    'check-agents-report-contract: PASS\n',
    snapshot,
    failures,
    unreachable,
    failureStdout ?? (failures[0] ? `${failures[0]}\n` : undefined),
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

interface PackReviewEvaluation {
  readonly failures: string[];
  readonly unreachable: string[];
  readonly sources: Map<string, string>;
}

function hasLivePackReviewSource(snapshot: SourceSnapshot): boolean {
  return LIVE_PACK_REVIEW_PATHS.some(
    (path) => snapshot.files.has(path) || snapshot.unreadable.has(path),
  );
}

function executableReviewInvocation(text: string): boolean {
  const withoutComments = text
    .replace(/<#[\s\S]*?#>/gu, '')
    .replace(/^\s*#.*$/gmu, '')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
  return /(?:^|[;&|]\s*|\b(?:exec|spawn|spawnSync|runProcess|runProcessSync)\s*\([^\n]*)\bao\s+review\s+(?:run|list|send|execute|submit)\b/iu.test(withoutComments)
    || /&\s*(?:\$[A-Za-z_][A-Za-z0-9_]*|ao)\s+@?\([^\n]*['"]review['"][^\n]*['"](?:run|list|send|execute|submit)['"]/iu.test(withoutComments);
}

function executableAoReviewApiInvocation(text: string): boolean {
  const withoutComments = text
    .replace(/<#[\s\S]*?#>/gu, '')
    .replace(/^\s*#.*$/gmu, '')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
  return /(?:^|[;&|]\s*)Invoke-AoReviewApi\b/mu.test(withoutComments)
    || /(?:fetch|request|Invoke-RestMethod)\s*\([^\n]*(?:\/reviews\/trigger|\/reviews\b)/iu.test(withoutComments);
}

function evaluateLivePackReviewSources(snapshot: SourceSnapshot): PackReviewEvaluation {
  const failures: string[] = [];
  const unreachable: string[] = [];
  const sources = new Map<string, string>();

  for (const path of LIVE_PACK_REVIEW_PATHS) {
    const text = requireText(snapshot, path, failures, unreachable);
    if (text !== undefined) sources.set(path, text);
  }

  for (const [path, text] of sources) {
    if (executableReviewInvocation(text)) failures.push(`${path}: live pack-review path invokes AO review CLI`);
    if (executableAoReviewApiInvocation(text)) failures.push(`${path}: live pack-review path depends on AO review HTTP`);
  }

  return { failures, unreachable, sources };
}

function evaluateLegacyDeadReviewArgv(snapshot: SourceSnapshot): PackReviewEvaluation | undefined {
  const failures: string[] = [];
  const pattern = /(?:\[\s*|,\s*)['"]review['"]\s*,\s*['"](?:run|list|send|execute|submit)['"]/iu;
  for (const [path, text] of snapshot.files) {
    if (!/^scripts\/.+\.(?:[cm]?[jt]s|ps1)$/iu.test(path)) continue;
    if (pattern.test(text)) failures.push(`${path}: dead ao review CLI argv`);
  }
  if (failures.length === 0) return undefined;
  return { failures, unreachable: [], sources: new Map() };
}

export function evaluateReview010Vocabulary(snapshot: SourceSnapshot): GateResult {
  const gateId = 'review-010-vocabulary';
  const legacy = hasLivePackReviewSource(snapshot) ? undefined : evaluateLegacyDeadReviewArgv(snapshot);
  const evaluated = legacy ?? evaluateLivePackReviewSources(snapshot);
  const failureStdout = evaluated.failures.length === 0
    ? undefined
    : legacy
      ? `AO 0.10 review vocabulary violations:\n${evaluated.failures.map((failure) => `  ${failure}`).join('\n')}\n`
      : `Pack review runtime boundary violations:\n${evaluated.failures.map((failure) => `  ${failure}`).join('\n')}\n`;

  return completeStaticGate(
    gateId,
    'Live pack review does not invoke AO Reviews',
    '[PASS] AO 0.10 review vocabulary guard (no dead CLI / false-equivalence fields)\n',
    snapshot,
    evaluated.failures,
    evaluated.unreachable,
    failureStdout,
  );
}

function readLegacyReviewCommand(snapshot: SourceSnapshot): string | undefined {
  const yaml = snapshot.files.get('agent-orchestrator.yaml.example');
  if (yaml === undefined) return undefined;
  const match = /(?:^|\r?\n)[^\r\n]*REVIEW_COMMAND[^\r\n]*\r?\n\s+([^\r\n]+)/iu.exec(yaml);
  return match?.[1]?.trim();
}

export function evaluateReviewCommandNotAo(snapshot: SourceSnapshot): GateResult {
  const gateId = 'review-command-not-ao';
  const legacyCommand = hasLivePackReviewSource(snapshot) ? undefined : readLegacyReviewCommand(snapshot);

  if (legacyCommand !== undefined && /(?:^|\s|[\\/])\.ao[\\/]/iu.test(legacyCommand)) {
    const failure = 'Canonical REVIEW_COMMAND must not use gitignored .ao/ paths';
    return completeStaticGate(
      gateId,
      'Pack runner owns review and exact-head status authority',
      '[PASS] example REVIEW_COMMAND does not use .ao/ as primary path\n',
      snapshot,
      [failure],
      [],
      `[FAIL] ${failure}\n  REVIEW_COMMAND: ${legacyCommand}\n`,
    );
  }

  const evaluated = evaluateLivePackReviewSources(snapshot);
  const failures = [...evaluated.failures];
  const combinedRuntime = [...evaluated.sources.values()].join('\n');
  if (combinedRuntime.length > 0 && !combinedRuntime.includes('orchestrator-pack/pack-review')) {
    failures.push('live pack-review sources are missing the exact required-status context');
  }

  return completeStaticGate(
    gateId,
    'Pack runner owns review and exact-head status authority',
    '[PASS] example REVIEW_COMMAND does not use .ao/ as primary path\n',
    snapshot,
    failures,
    evaluated.unreachable,
    failures.length > 0 ? `[FAIL] pack review runtime authority:\n${failures.map((failure) => ` - ${failure}`).join('\n')}\n` : undefined,
  );
}

export const VERIFY_CONTRACT_MARKERS: Readonly<Record<string, readonly string[]>> = {
  'plugins/ao-task-declaration/README.md': ['DD-026', 'DD-027', 'declared_files', 'denylist', 'one amendment', 'baseline'],
  'plugins/ao-scope-guard/README.md': ['DD-024', 'runtime guard', 'git add', 'commit', 'PR-level CI', 'second line'],
  'plugins/ao-token-chain-ledger/README.md': ['chain_id', 'planner', 'reviewer', 'worker', 'per-session cost', 'estimated_cost_usd'],
  'plugins/ao-codex-pr-reviewer/README.md': ['Codex', 'gpt-5.5', 'PR review', 'GitHub Issues', 'no core patch'],
};

export const VERIFY_PROMPT_GLOB = 'prompts/*.md';

const VERIFY_RUNTIME_ARTIFACTS: Readonly<Record<string, string>> = {
  'plugins/ao-task-declaration/README.md': 'plugins/ao-task-declaration/package.json',
  'plugins/ao-scope-guard/README.md': 'scripts/pr-scope-check.ts',
  'plugins/ao-token-chain-ledger/README.md': 'plugins/ao-token-chain-ledger/package.json',
  'plugins/ao-codex-pr-reviewer/README.md': 'plugins/ao-codex-pr-reviewer/bin/review.ts',
};

function matchesVerifyPromptGlob(path: string): boolean {
  const [prefix = '', suffix = ''] = VERIFY_PROMPT_GLOB.split('*', 2);
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return false;
  return !path.slice(prefix.length, path.length - suffix.length).includes('/');
}

function hasCurrentVerifyRuntime(snapshot: SourceSnapshot): boolean {
  return Object.values(VERIFY_RUNTIME_ARTIFACTS).some(
    (path) => snapshot.files.has(path) || snapshot.unreadable.has(path),
  );
}

function isHistoricalVerifyMarkerFixture(snapshot: SourceSnapshot): boolean {
  return snapshot.files.get('plugins/ao-scope-guard/README.md')?.includes('runtime_guard_removed') === true;
}

function evaluateHistoricalVerifyFixture(
  snapshot: SourceSnapshot,
  failures: string[],
  unreachable: string[],
): void {
  for (const [path, markers] of Object.entries(VERIFY_CONTRACT_MARKERS)) {
    const text = snapshot.files.get(path);
    if (text === undefined) continue;
    for (const marker of markers) {
      if (!text.toLocaleLowerCase().includes(marker.toLocaleLowerCase())) failures.push(`Contract ${path} missing marker: ${marker}`);
    }
  }
  for (const path of snapshot.unreadable.keys()) {
    if (path in VERIFY_CONTRACT_MARKERS) unreachable.push(`${path}: ${snapshot.unreadable.get(path)}`);
  }
}

export function evaluateVerifyStructureContract(snapshot: SourceSnapshot): GateResult {
  const gateId = 'verify-structure-contract';
  const failures: string[] = [];
  const unreachable: string[] = [];
  if (snapshot.paths.filter(matchesVerifyPromptGlob).length === 0) failures.push('Missing prompt markdown files');

  if (hasCurrentVerifyRuntime(snapshot) && !isHistoricalVerifyMarkerFixture(snapshot)) {
    for (const [readmePath, runtimePath] of Object.entries(VERIFY_RUNTIME_ARTIFACTS)) {
      requireText(snapshot, readmePath, failures, unreachable);
      requireText(snapshot, runtimePath, failures, unreachable);
    }
  } else {
    evaluateHistoricalVerifyFixture(snapshot, failures, unreachable);
  }

  return completeStaticGate(
    gateId,
    'Prompt inventory and executable plugin/runtime artifacts',
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
