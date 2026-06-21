/**
 * Falsifiable workflow-ordering guard: privileged auth material must not be exposed
 * to PR-head scripts before the trusted legacy-list guard step completes.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

export const LEGACY_LIST_GUARD_WORKFLOW_REL_PATH = '.github/workflows/contract-evidence-legacy-list-guard.yml';

/**
 * @param {string} workflowContent
 */
export function validateLegacyListGuardWorkflowOrdering(workflowContent) {
  /** @type {string[]} */
  const errors = [];
  if (!/pull_request_target:/.test(workflowContent)) {
    errors.push('workflow must trigger on pull_request_target so PRs cannot neuter job steps');
  }
  const jobMatch = workflowContent.match(
    /contract-evidence-legacy-list-guard:[\s\S]*?(?=\n[a-zA-Z0-9_-]+:|$)/,
  );
  if (!jobMatch) {
    errors.push('missing contract-evidence-legacy-list-guard job');
    return { ok: false, errors };
  }
  const job = jobMatch[0];
  const trustedCheckout = /Checkout trusted legacy list guard \(base ref\)/.test(job);
  const prHeadCheckout = /Checkout PR head/.test(job);
  const runGuard = /run-contract-evidence-legacy-list-guard\.mjs/.test(job);
  const trustedPath = /trusted-legacy-list-guard/.test(job);
  const privilegedBeforeGuard = /LEGACY_LIST_GUARD_AUTH_SECRET[\s\S]*run-contract-evidence-legacy-list-guard/.test(job);

  if (!prHeadCheckout) {
    errors.push('job must checkout PR head');
  }
  if (!trustedCheckout) {
    errors.push('job must checkout trusted base guard before evaluation');
  }
  if (!runGuard) {
    errors.push('job must invoke pinned run-contract-evidence-legacy-list-guard.mjs entrypoint');
  }
  if (!trustedPath) {
    errors.push('job must run guard from trusted-legacy-list-guard path');
  }
  if (/LEGACY_LIST_GUARD_BOOTSTRAP/.test(job)) {
    errors.push('job must not expose reusable bootstrap environment override');
  }
  if (privilegedBeforeGuard) {
    errors.push('privileged auth material must not appear before trusted guard step');
  }
  if (/npm run[\s\S]*legacy-list/.test(job)) {
    errors.push('job must not route guard through PR-head npm script indirection');
  }

  const stepLines = job.split('\n');
  let trustedIndex = -1;
  let guardIndex = -1;
  for (let index = 0; index < stepLines.length; index += 1) {
    if (stepLines[index]?.includes('Checkout trusted legacy list guard')) {
      trustedIndex = index;
    }
    if (stepLines[index]?.includes('run-contract-evidence-legacy-list-guard.mjs')) {
      guardIndex = index;
    }
  }
  if (trustedIndex >= 0 && guardIndex >= 0 && trustedIndex > guardIndex) {
    errors.push('trusted base checkout must precede guard invocation');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * @param {string} repoRoot
 */
export function runLegacyListGuardWorkflowOrderingCheck(repoRoot) {
  const workflowPath = path.join(repoRoot, LEGACY_LIST_GUARD_WORKFLOW_REL_PATH);
  const content = readFileSync(workflowPath, 'utf8');
  return validateLegacyListGuardWorkflowOrdering(content);
}
