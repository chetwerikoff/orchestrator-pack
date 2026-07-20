#!/usr/bin/env node
/**
 * Public merge-triage entrypoint.
 *
 * The mature Issue #648 implementation remains byte-identical in
 * `merge-triage-gate-core.mjs`. This wrapper preserves its public exports and CLI while
 * adding the Issue #933 direct-operator decision: an active approval for the exact
 * repository/PR/head is a fail-closed merge-policy result, never an implicit payload bypass.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readStdinJson, printJson } from './review-mechanical-cli.mjs';

const originalCliEntry = process.argv[1];
process.argv[1] = 'merge-triage-gate-core-import.mjs';
let core;
try {
  core = await import('./merge-triage-gate-core.mjs');
} finally {
  process.argv[1] = originalCliEntry;
}

export const TRIAGE_SCHEMA_VERSION = core.TRIAGE_SCHEMA_VERSION;
export const TERMINAL_AT_CAP_OPEN_FINDINGS = core.TERMINAL_AT_CAP_OPEN_FINDINGS;
export const TERMINAL_CLEAN_EARLY_STOP = core.TERMINAL_CLEAN_EARLY_STOP;
export const TERMINAL_MERGE_TRIAGE_CLEARED = core.TERMINAL_MERGE_TRIAGE_CLEARED;
export const VERDICT_BLOCK = core.VERDICT_BLOCK;
export const VERDICT_DEFER = core.VERDICT_DEFER;
export const VERDICT_PENDING_ARCHITECT = core.VERDICT_PENDING_ARCHITECT;
export const VERDICT_PENDING_OPERATOR = core.VERDICT_PENDING_OPERATOR;
export const VERDICT_ACK_RESET = core.VERDICT_ACK_RESET;
export const DEFAULT_MARKER_FILE = core.DEFAULT_MARKER_FILE;

export const sha256 = core.sha256;
export const normalizeTriageText = core.normalizeTriageText;
export const buildFindingText = core.buildFindingText;
export const loadMarkerList = core.loadMarkerList;
export const classifyFinding = core.classifyFinding;
export const resolveStateRoot = core.resolveStateRoot;
export const ensureDir = core.ensureDir;
export const readPackFindingStore = core.readPackFindingStore;
export const computeOpenFindingsSnapshotHash = core.computeOpenFindingsSnapshotHash;
export const readArchitectInbox = core.readArchitectInbox;
export const issueArchitectProvenanceToken = core.issueArchitectProvenanceToken;
export const fileWorkerAppeal = core.fileWorkerAppeal;
export const adjudicateArchitectFinding = core.adjudicateArchitectFinding;
export const acknowledgeArchitectPermissiveBudget = core.acknowledgeArchitectPermissiveBudget;

const OPERATOR_APPROVAL_SCHEMA_VERSION = 1;
const OPERATOR_APPROVAL_EVENT = 'operator_merge_approved';

function normalizeProjectId(value = 'orchestrator-pack') {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');
  return normalized || null;
}

function normalizeRepoSlug(value) {
  const repoSlug = String(value ?? '').trim();
  return /^[^/\s]+\/[^/\s]+$/.test(repoSlug) ? repoSlug : null;
}

function resolveDirectOperatorSessionKind(input = {}) {
  const envKind = normalizeTriageText(process.env.AO_SESSION_KIND ?? '');
  const payloadKind = normalizeTriageText(input.sessionKind ?? '');
  if (envKind && payloadKind && envKind !== payloadKind) {
    return { ok: false, reason: 'session_kind_conflict' };
  }
  const kind = envKind || payloadKind;
  return kind === 'operator'
    ? { ok: true, kind }
    : { ok: false, reason: kind ? 'session_kind_not_operator' : 'operator_session_kind_missing' };
}

function operatorApprovalRecordPath(input, prNumber) {
  const projectId = normalizeProjectId(input.projectId ?? 'orchestrator-pack');
  if (!projectId) return null;
  return path.join(
    resolveStateRoot(input),
    'operator-merge-approvals',
    projectId,
    `pr-${prNumber}.json`,
  );
}

function readExactHeadOperatorApproval(input = {}) {
  if (input.directOperatorMerge !== true) {
    return { applicable: false, approved: false, reason: 'not_direct_operator_merge' };
  }

  const session = resolveDirectOperatorSessionKind(input);
  if (!session.ok) return { applicable: true, approved: false, reason: session.reason };

  const projectId = normalizeProjectId(input.projectId ?? 'orchestrator-pack');
  const repoSlug = normalizeRepoSlug(input.repoSlug);
  const prNumber = Number(input.prNumber);
  const headSha = String(input.headSha ?? input.currentHeadSha ?? '').trim().toLowerCase();
  if (!projectId) return { applicable: true, approved: false, reason: 'project_id_invalid' };
  if (!repoSlug) return { applicable: true, approved: false, reason: 'repo_slug_invalid' };
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { applicable: true, approved: false, reason: 'pr_number_invalid' };
  }
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    return { applicable: true, approved: false, reason: 'head_sha_invalid' };
  }

  const recordPath = operatorApprovalRecordPath(input, prNumber);
  if (!recordPath || !existsSync(recordPath)) {
    return { applicable: true, approved: false, reason: 'approval_missing' };
  }

  let record;
  try {
    record = JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch {
    return { applicable: true, approved: false, reason: 'approval_malformed' };
  }

  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { applicable: true, approved: false, reason: 'approval_malformed' };
  }
  if (
    Number(record.schemaVersion) !== OPERATOR_APPROVAL_SCHEMA_VERSION ||
    record.event !== OPERATOR_APPROVAL_EVENT ||
    String(record.projectId ?? '') !== projectId ||
    String(record.repoSlug ?? '') !== repoSlug ||
    Number(record.prNumber) !== prNumber ||
    String(record.headSha ?? '').toLowerCase() !== headSha ||
    !String(record.approvalId ?? '').trim() ||
    !String(record.reason ?? '').trim() ||
    !String(record.actor ?? '').trim() ||
    !Number.isFinite(Date.parse(String(record.createdAtUtc ?? '')))
  ) {
    return { applicable: true, approved: false, reason: 'approval_malformed' };
  }
  if (String(record.revokedAtUtc ?? '').trim()) {
    return { applicable: true, approved: false, reason: 'approval_revoked', record };
  }

  return { applicable: true, approved: true, reason: 'approved', record };
}

function directOperatorPolicyResult(input = {}) {
  const approval = readExactHeadOperatorApproval(input);
  if (!approval.applicable) return null;
  if (!approval.approved) {
    return {
      allow: false,
      reason: 'operator_merge_approval_unavailable',
      approvalReason: approval.reason,
    };
  }
  return {
    allow: true,
    reason: 'operator_merge_approved',
    approvalId: approval.record.approvalId,
    approvedHeadSha: approval.record.headSha,
    approvalActor: approval.record.actor,
    approvalReason: approval.record.reason,
  };
}

export function evaluateMergePolicy(input = {}) {
  return directOperatorPolicyResult(input) ?? core.evaluateMergePolicy(input);
}

export function runMergeTriageGate(input = {}) {
  const direct = directOperatorPolicyResult(input);
  if (!direct) return core.runMergeTriageGate(input);
  if (!direct.allow) {
    return {
      ok: false,
      ran: true,
      reason: direct.reason,
      approvalReason: direct.approvalReason,
    };
  }
  return {
    ok: true,
    ran: true,
    reason: direct.reason,
    approvalId: direct.approvalId,
    approvedHeadSha: direct.approvedHeadSha,
    approvalActor: direct.approvalActor,
    approvalReason: direct.approvalReason,
  };
}

const MERGE_TRIAGE_CLI_HANDLERS = {
  classifyFinding: () => classifyFinding(readStdinJson()),
  runGate: () => runMergeTriageGate(readStdinJson()),
  evaluateMergePolicy: () => evaluateMergePolicy(readStdinJson()),
  readArchitectInbox: () => readArchitectInbox(readStdinJson()),
  issueArchitectToken: () => issueArchitectProvenanceToken(readStdinJson()),
  fileWorkerAppeal: () => fileWorkerAppeal(readStdinJson()),
  adjudicateArchitectFinding: () => adjudicateArchitectFinding(readStdinJson()),
  acknowledgeArchitectBudget: () => acknowledgeArchitectPermissiveBudget(readStdinJson()),
};

function mergeTriageCliShouldExitNonZero(subcommand, result) {
  if (subcommand === 'evaluateMergePolicy') {
    return Boolean(result && result.allow === false);
  }
  if (subcommand !== 'runGate' || !result || result.ok !== false || result.ran !== true) {
    return false;
  }
  if (
    result.reason === 'open_findings_unavailable' ||
    result.reason === 'operator_merge_approval_unavailable'
  ) {
    return true;
  }
  return Array.isArray(result.classifications) &&
    result.classifications.some((classification) => classification?.reason === 'empty_finding_text');
}

const mergeTriageCliEntry = process.argv[1] ?? '';
const isMergeTriageCli =
  mergeTriageCliEntry.endsWith('merge-triage-gate.mjs') ||
  mergeTriageCliEntry.endsWith('merge-triage-gate.js');

if (isMergeTriageCli) {
  const subcommand = process.argv[2];
  const handler = MERGE_TRIAGE_CLI_HANDLERS[subcommand];
  if (!handler) {
    console.error(`Usage: node merge-triage-gate.mjs <${Object.keys(MERGE_TRIAGE_CLI_HANDLERS).join('|')}>`);
    process.exit(2);
  }
  try {
    const result = handler();
    printJson(result);
    process.exit(mergeTriageCliShouldExitNonZero(subcommand, result) ? 1 : 0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
