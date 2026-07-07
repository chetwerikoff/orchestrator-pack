/**
 * AO 0.10 harness review bridge — pack [Pn] submit contract (Issue #658).
 * Vitest: scripts/harness-review-bridge.test.ts
 */
import { join } from 'node:path';
import { classifyReviewerHarnessAbort } from './ao-0-10-review-api.mjs';

export { classifyReviewerHarnessAbort };

/**
 * @param {string} stdout
 */
export function parseTerminalVerdictPayload(stdout) {
  try {
    const parsed = JSON.parse(String(stdout ?? '').trim());
    if (parsed.verdict !== 'clean' && parsed.verdict !== 'findings') {
      return null;
    }
    if (typeof parsed.findingCount !== 'number' || !Number.isFinite(parsed.findingCount)) {
      return null;
    }
    if (!Array.isArray(parsed.findings)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export const HARNESS_BRIDGE_KILL_SWITCH_ENV = 'PACK_HARNESS_BRIDGE_DISABLED';
export const HARNESS_NESTED_BUDGET_ENV = 'PACK_HARNESS_REVIEW_NESTED_ACTIVE';

/** Board / #213 producer fields the harness bridge must never emit. */
export const HARNESS_BOARD_FIELD_DENYLIST = [
  'boardStatus',
  'boardColumn',
  'columnStatus',
  'producerSchema',
  'reviewsBoard',
  'harnessReviewState',
];

const PROSE_SUBMIT_PATTERNS = [
  /^Finding:\s/m,
  /^BLOCKING:\s/m,
  /^Non-blocking:\s/im,
  /^##\s+Finding\b/m,
];

const PN_TITLE_PATTERN = /^\[P[0-3]\]/i;

/**
 * @param {string} trustedPackRoot
 */
export function resolveHarnessExecutionSurfaces(trustedPackRoot) {
  const root = String(trustedPackRoot ?? '').trim();
  if (!root) {
    throw new Error('trusted pack root is required');
  }
  return {
    trustedPackRoot: root,
    promptPath: join(root, 'prompts/codex_review_prompt.md'),
    bridgeEntrypoint: join(root, 'scripts/harness-review-bridge.ps1'),
    bridgeRunner: join(root, 'scripts/harness-review-bridge.ts'),
    mapperPath: join(root, 'plugins/ao-codex-pr-reviewer/lib/review_jsonl.ts'),
    reviewScript: join(root, 'plugins/ao-codex-pr-reviewer/bin/review.ps1'),
  };
}

/**
 * @param {string} candidatePath
 * @param {string} workerWorktreeRoot
 */
export function isPathUnderWorkerWorktree(candidatePath, workerWorktreeRoot) {
  const candidate = String(candidatePath ?? '').trim();
  const worker = String(workerWorktreeRoot ?? '').trim();
  if (!candidate || !worker) {
    return false;
  }
  const normalizedCandidate = candidate.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedWorker = worker.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalizedCandidate.toLowerCase() === normalizedWorker.toLowerCase()) {
    return true;
  }
  return normalizedCandidate.toLowerCase().startsWith(`${normalizedWorker.toLowerCase()}/`);
}

/**
 * @param {ReturnType<typeof resolveHarnessExecutionSurfaces>} surfaces
 * @param {string} workerWorktreeRoot
 */
export function assertTrustedPackRootExecution(surfaces, workerWorktreeRoot = '') {
  const violations = [];
  const trusted = String(surfaces?.trustedPackRoot ?? '').trim();
  const worker = String(workerWorktreeRoot ?? '').trim();

  const checks = [
    ['prompt', surfaces.promptPath],
    ['bridgeEntrypoint', surfaces.bridgeEntrypoint],
    ['mapper', surfaces.mapperPath],
  ];

  for (const [label, resolvedPath] of checks) {
    const path = String(resolvedPath ?? '').trim();
    if (!path) {
      violations.push(`${label}: missing path`);
      continue;
    }
    const normalizedPath = path.replace(/\\/g, '/');
    const normalizedTrusted = trusted.replace(/\\/g, '/').replace(/\/+$/, '');
    if (
      normalizedTrusted &&
      normalizedPath.toLowerCase() !== normalizedTrusted.toLowerCase() &&
      !normalizedPath.toLowerCase().startsWith(`${normalizedTrusted.toLowerCase()}/`)
    ) {
      violations.push(`${label}: must resolve under trusted pack root (${trusted})`);
    }
    if (
      worker &&
      trusted &&
      worker.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() !==
        normalizedTrusted.toLowerCase() &&
      isPathUnderWorkerWorktree(path, worker) &&
      !isPathUnderWorkerWorktree(path, trusted)
    ) {
      violations.push(`${label}: must not resolve under worker worktree (${worker})`);
    }
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function evaluateHarnessKillSwitch(env = process.env) {
  const raw = String(env[HARNESS_BRIDGE_KILL_SWITCH_ENV] ?? '').trim().toLowerCase();
  const disabled = raw === '1' || raw === 'true' || raw === 'yes';
  return {
    disabled,
    reason: disabled ? 'harness_bridge_kill_switch' : '',
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function evaluateNestedReviewBudget(env = process.env) {
  if (String(env[HARNESS_NESTED_BUDGET_ENV] ?? '').trim() === '1') {
    return { ok: false, reason: 'nested_review_budget_exceeded' };
  }
  return { ok: true, reason: '' };
}

/**
 * @param {string} text
 */
export function containsProseSubmitMarkers(text) {
  const value = String(text ?? '');
  return PROSE_SUBMIT_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * @param {string} stdout
 */
export function validateMapperSubmitPayload(stdout) {
  const trimmed = String(stdout ?? '').trim();
  if (!trimmed) {
    return { ok: false, reason: 'empty_mapper_output' };
  }
  if (containsProseSubmitMarkers(trimmed)) {
    return { ok: false, reason: 'prose_submit_markers' };
  }

  const payload = parseTerminalVerdictPayload(trimmed);
  if (!payload) {
    return { ok: false, reason: 'invalid_terminal_verdict_payload' };
  }

  if (payload.verdict === 'clean') {
    if (payload.findingCount !== 0) {
      return { ok: false, reason: 'clean_verdict_finding_count_mismatch' };
    }
    return { ok: true, payload };
  }

  if (payload.verdict !== 'findings' || !Array.isArray(payload.findings)) {
    return { ok: false, reason: 'invalid_findings_verdict' };
  }

  for (const finding of payload.findings) {
    const title = String(finding?.title ?? '');
    const body = String(finding?.body ?? '');
    if (!title) {
      return { ok: false, reason: 'finding_missing_title' };
    }
    if (containsProseSubmitMarkers(`${title}\n${body}`)) {
      return { ok: false, reason: 'prose_submit_markers' };
    }
    const hasPnTitle = PN_TITLE_PATTERN.test(title);
    const hasScopeMarker = /\[scope-violation\]/i.test(title);
    if (!hasPnTitle && !hasScopeMarker) {
      return { ok: false, reason: 'finding_missing_pn_title_prefix' };
    }
    if (!/\bseverity:\s*(blocking|non-blocking)\b/i.test(body)) {
      return { ok: false, reason: 'finding_missing_architecture_f_severity' };
    }
  }

  return { ok: true, payload };
}

/**
 * @param {string} body
 */
export function validateHarnessSubmitBody(body) {
  const text = String(body ?? '').trim();
  if (!text) {
    return { ok: false, reason: 'empty_submit_body' };
  }
  if (containsProseSubmitMarkers(text)) {
    return { ok: false, reason: 'prose_submit_markers' };
  }
  try {
    const parsed = JSON.parse(text);
    return validateMapperSubmitPayload(JSON.stringify(parsed));
  } catch {
    return { ok: false, reason: 'submit_body_not_structured_json' };
  }
}

/**
 * @param {import('../plugins/ao-codex-pr-reviewer/lib/emit.ts').TerminalVerdictPayload} payload
 */
export function buildHarnessSubmitVerdict(payload) {
  if (payload.verdict === 'clean' && payload.findingCount === 0) {
    return 'approved';
  }
  return 'changes_requested';
}

/**
 * @param {unknown} value
 * @param {string} [path]
 */
export function assertNoBoardFieldEmission(value, path = '') {
  const violations = [];
  if (value === null || value === undefined) {
    return violations;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      violations.push(...assertNoBoardFieldEmission(entry, `${path}[${index}]`));
    });
    return violations;
  }
  if (typeof value !== 'object') {
    return violations;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (HARNESS_BOARD_FIELD_DENYLIST.includes(key)) {
      violations.push(`${path ? `${path}.` : ''}${key}`);
    }
    violations.push(...assertNoBoardFieldEmission(nested, path ? `${path}.${key}` : key));
  }
  return violations;
}

/**
 * @param {import('../plugins/ao-codex-pr-reviewer/lib/emit.ts').TerminalVerdictPayload} payload
 */
export function formatHarnessSubmitBody(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * @param {string} failureClass
 */
export function classifyHarnessBridgeFailure(failureClass) {
  const known = new Set([
    'harness_bridge_kill_switch',
    'reviewers_harness_misconfig',
    'nested_review_budget_exceeded',
    'empty_mapper_output',
    'invalid_terminal_verdict_payload',
    'finding_missing_pn_title_prefix',
    'prose_submit_markers',
    'timeout_no_verdict',
    'contradictory_review_output',
    'stuck_running_no_submit',
    'unstructured_github_body',
    'claude_supersede_policy',
  ]);
  return {
    classified: known.has(failureClass),
    failureClass,
  };
}
