export {
  buildIssueTupleKey,
  buildTupleKey,
  evaluateNudgeGate,
  normalizeIssueNumber,
  resolveIssueOwnerSessionForNudge,
  resolveWorkerTargetFromIssueClaim,
  syncIssueOwnershipClaimRecord,
} from '../docs/worker-nudge-gate.mjs';

export { repoRoot } from './_test-pwsh-helpers.js';

export const TASK_CONTINUATION_PROJECT_ID = 'orchestrator-pack';
export const TASK_CONTINUATION_ISSUE_NUMBER = 417;
export const TASK_CONTINUATION_SESSION_ID = 'opk-430';
export const TASK_CONTINUATION_GENERATION = 'a1b2c3d4e5f6';
export const TASK_CONTINUATION_PR_NUMBER = 427;
