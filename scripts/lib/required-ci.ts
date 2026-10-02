// @vitest-ci-lane light
import {
  isCiCheckFailure,
  isCiCheckPending,
  isCiCheckSuccess,
  PACK_MERGE_CONTRACT_CHECK_NAMES,
} from '../../docs/review-ready-stuck-guard.mjs';
import { PACK_REVIEW_REQUIRED_STATUS_CONTEXT } from './pack-review-delivery.ts';
import type { TargetContext } from './target-context.ts';

export interface RequiredCiCheckRow {
  readonly name?: string;
  readonly workflow?: string;
  readonly state?: string;
  readonly conclusion?: string;
  readonly status?: string;
  readonly bucket?: string;
}

export type RequiredCiSelector =
  | Readonly<{ kind: 'actions'; workflow: string; job: string }>
  | Readonly<{ kind: 'context'; name: string }>;

export interface RequiredCiProtectionPolicy {
  readonly contexts?: readonly unknown[];
  readonly checks?: readonly (string | Readonly<{ context?: unknown }> | null)[];
}

export type RequiredCiProtectionRead =
  | Readonly<{ kind: 'ok'; policy: RequiredCiProtectionPolicy }>
  | Readonly<{ kind: 'unavailable'; httpStatus: 403 | 404 }>;

export type RequiredCiSource =
  | 'project_card'
  | 'branch_protection'
  | 'merge_contract_fallback'
  | 'lookup_unavailable'
  | 'none';

export type RequiredCiState = 'green' | 'pending' | 'failure';

export type RequiredCiReason =
  | 'green'
  | 'base_branch_mismatch'
  | 'lookup_unavailable'
  | 'no_required_ci_configured'
  | 'projection_unavailable'
  | 'head_changed'
  | 'evidence_stale'
  | 'required_selector_missing'
  | 'required_selector_pending'
  | 'required_selector_failed';

export interface RequiredCiResult {
  readonly state: RequiredCiState;
  readonly green: boolean;
  readonly source: RequiredCiSource;
  readonly reason: RequiredCiReason;
  readonly expectedHeadSha: string;
  readonly postProjectionHeadSha: string;
  readonly headBinding: 'inferred_current' | 'mismatch' | 'unavailable';
  readonly selectors: readonly RequiredCiSelector[];
  readonly diagnostics: readonly string[];
}

export interface ResolveRequiredCiInput {
  readonly target: Pick<TargetContext, 'projectId' | 'repository' | 'defaultBranch' | 'requiredCi'>;
  readonly prNumber: number;
  readonly expectedHeadSha: string;
  readonly prBaseRef: string;
  readonly readProtection: () => Promise<RequiredCiProtectionRead>;
  readonly readChecks: () => Promise<readonly RequiredCiCheckRow[]>;
  readonly readCurrentHead: () => Promise<string>;
}

const PACK_REPOSITORY = 'chetwerikoff/orchestrator-pack';

function normalized(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function display(value: unknown): string {
  return String(value ?? '').trim();
}

function result(
  input: ResolveRequiredCiInput,
  fields: Omit<RequiredCiResult, 'expectedHeadSha' | 'green'>,
): RequiredCiResult {
  return Object.freeze({
    ...fields,
    green: fields.state === 'green',
    expectedHeadSha: normalized(input.expectedHeadSha),
    selectors: Object.freeze([...fields.selectors]),
    diagnostics: Object.freeze([...fields.diagnostics]),
  });
}

export function requiredStatusChecksEndpoint(repository: string, branch: string): string {
  const repo = display(repository);
  const base = display(branch);
  if (!repo || !base) throw new Error('required CI protection repository/default branch is empty');
  return `repos/${repo}/branches/${encodeURIComponent(base)}/protection/required_status_checks`;
}

export function parseRequiredCiSelector(selector: string): Readonly<{ workflow: string; job: string }> {
  const parts = String(selector).split(' / ');
  if (parts.length !== 2 || !parts[0]!.trim() || !parts[1]!.trim()) {
    throw new Error(`invalid requiredCi selector: ${selector}`);
  }
  return Object.freeze({ workflow: parts[0]!.trim(), job: parts[1]!.trim() });
}

export function branchProtectionContexts(policy: RequiredCiProtectionPolicy): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  const add = (value: unknown): void => {
    const name = display(value);
    if (!name) return;
    const key = normalized(name);
    if (seen.has(key)) return;
    seen.add(key);
    names.push(name);
  };
  for (const value of policy.contexts ?? []) add(value);
  for (const value of policy.checks ?? []) {
    if (typeof value === 'string') add(value);
    else if (value && typeof value === 'object') add(value.context);
  }
  return names;
}

export function reviewIndependentRequiredCiContexts(contexts: readonly string[]): string[] {
  const self = normalized(PACK_REVIEW_REQUIRED_STATUS_CONTEXT);
  return contexts.filter((name) => normalized(name) !== self);
}

function projectCardSelectors(requiredCi: readonly string[]): readonly RequiredCiSelector[] {
  return requiredCi.map((selector) => {
    const parsed = parseRequiredCiSelector(selector);
    return Object.freeze({ kind: 'actions' as const, workflow: parsed.workflow, job: parsed.job });
  });
}

function contextSelectors(names: readonly string[]): readonly RequiredCiSelector[] {
  return names.map((name) => Object.freeze({ kind: 'context' as const, name }));
}

function selectorRows(
  selector: RequiredCiSelector,
  rows: readonly RequiredCiCheckRow[],
): readonly RequiredCiCheckRow[] {
  if (selector.kind === 'context') {
    const wanted = normalized(selector.name);
    return rows.filter((row) => normalized(row.name) === wanted);
  }
  const workflow = normalized(selector.workflow);
  const job = normalized(selector.job);
  return rows.filter((row) =>
    normalized(row.workflow) === workflow
    && normalized(row.name) === job);
}

function evaluateSelectors(
  selectors: readonly RequiredCiSelector[],
  rows: readonly RequiredCiCheckRow[],
): { state: RequiredCiState; reason: RequiredCiReason; diagnostics: string[] } {
  if (selectors.length === 0) {
    return { state: 'green', reason: 'green', diagnostics: [] };
  }
  let sawPending = false;
  for (const selector of selectors) {
    const matched = selectorRows(selector, rows);
    const selectorName = selector.kind === 'actions'
      ? `${selector.workflow} / ${selector.job}`
      : selector.name;
    if (matched.length === 0) {
      return {
        state: 'pending',
        reason: 'required_selector_missing',
        diagnostics: [`required_selector_missing:${selectorName}`],
      };
    }
    if (matched.some((row) => isCiCheckPending(row))) {
      sawPending = true;
      continue;
    }
    if (matched.some((row) => isCiCheckFailure(row))) {
      return {
        state: 'failure',
        reason: 'required_selector_failed',
        diagnostics: [`required_selector_failed:${selectorName}`],
      };
    }
    if (!matched.every((row) => isCiCheckSuccess(row))) {
      return {
        state: 'pending',
        reason: 'required_selector_pending',
        diagnostics: [`required_selector_unresolved:${selectorName}`],
      };
    }
  }
  return sawPending
    ? { state: 'pending', reason: 'required_selector_pending', diagnostics: ['required_selector_pending'] }
    : { state: 'green', reason: 'green', diagnostics: [] };
}

function canonicalPackTarget(target: ResolveRequiredCiInput['target']): boolean {
  return normalized(target.projectId) === 'orchestrator-pack'
    && normalized(target.repository) === PACK_REPOSITORY;
}

export async function resolveRequiredCi(input: ResolveRequiredCiInput): Promise<RequiredCiResult> {
  const expectedHeadSha = normalized(input.expectedHeadSha);
  const prBaseRef = display(input.prBaseRef);
  const defaultBranch = display(input.target.defaultBranch);
  if (!expectedHeadSha || prBaseRef !== defaultBranch) {
    return result(input, {
      state: 'failure',
      source: input.target.requiredCi ? 'project_card' : 'none',
      reason: 'base_branch_mismatch',
      postProjectionHeadSha: '',
      headBinding: 'unavailable',
      selectors: [],
      diagnostics: [`base_branch_mismatch:expected=${defaultBranch}:observed=${prBaseRef || '<empty>'}`],
    });
  }

  let source: RequiredCiSource;
  let selectors: readonly RequiredCiSelector[];

  if (input.target.requiredCi) {
    source = 'project_card';
    selectors = projectCardSelectors(input.target.requiredCi);
  } else {
    let protection: RequiredCiProtectionRead;
    try {
      protection = await input.readProtection();
    } catch {
      return result(input, {
        state: 'pending',
        source: 'lookup_unavailable',
        reason: 'lookup_unavailable',
        postProjectionHeadSha: '',
        headBinding: 'unavailable',
        selectors: [],
        diagnostics: ['lookup_unavailable:transport_error'],
      });
    }
    if (protection.kind === 'unavailable') {
      return result(input, {
        state: 'pending',
        source: 'lookup_unavailable',
        reason: 'lookup_unavailable',
        postProjectionHeadSha: '',
        headBinding: 'unavailable',
        selectors: [],
        diagnostics: [`lookup_unavailable:http_${protection.httpStatus}`],
      });
    }
    const rawContexts = branchProtectionContexts(protection.policy);
    if (rawContexts.length === 0) {
      if (!canonicalPackTarget(input.target)) {
        return result(input, {
          state: 'pending',
          source: 'none',
          reason: 'no_required_ci_configured',
          postProjectionHeadSha: '',
          headBinding: 'unavailable',
          selectors: [],
          diagnostics: ['no_required_ci_configured'],
        });
      }
      source = 'merge_contract_fallback';
      selectors = contextSelectors(PACK_MERGE_CONTRACT_CHECK_NAMES);
    } else {
      source = 'branch_protection';
      selectors = contextSelectors(reviewIndependentRequiredCiContexts(rawContexts));
    }
  }

  let rows: readonly RequiredCiCheckRow[];
  try {
    rows = await input.readChecks();
  } catch {
    return result(input, {
      state: 'pending',
      source,
      reason: 'projection_unavailable',
      postProjectionHeadSha: '',
      headBinding: 'unavailable',
      selectors,
      diagnostics: ['projection_unavailable'],
    });
  }

  let postProjectionHeadSha = '';
  try {
    postProjectionHeadSha = normalized(await input.readCurrentHead());
  } catch {
    return result(input, {
      state: 'pending',
      source,
      reason: 'evidence_stale',
      postProjectionHeadSha: '',
      headBinding: 'unavailable',
      selectors,
      diagnostics: ['evidence_stale:post_projection_head_unavailable'],
    });
  }
  if (!postProjectionHeadSha || postProjectionHeadSha !== expectedHeadSha) {
    return result(input, {
      state: 'pending',
      source,
      reason: 'head_changed',
      postProjectionHeadSha,
      headBinding: 'mismatch',
      selectors,
      diagnostics: [
        `head_changed:expectedHeadSha=${expectedHeadSha}:postProjectionHeadSha=${postProjectionHeadSha || '<empty>'}`,
        'evidence_stale',
      ],
    });
  }

  // The canonical pr-checks projection does not expose the head it sampled. A
  // matching pre-bound expected head and immediate post-projection live read
  // therefore infer current-head binding. The H1 -> H2 -> H1 ABA residual is
  // intentionally not hidden and this contract adds no second evidence transport.
  const evaluated = evaluateSelectors(selectors, rows);
  return result(input, {
    ...evaluated,
    source,
    postProjectionHeadSha,
    headBinding: 'inferred_current',
    selectors,
  });
}
