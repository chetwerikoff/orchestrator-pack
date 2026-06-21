/**
 * Falsifiable workflow-ordering guard: privileged auth material must not be exposed
 * to PR-head scripts before the trusted legacy-list guard step completes.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

export const LEGACY_LIST_GUARD_WORKFLOW_REL_PATH = '.github/workflows/contract-evidence-legacy-list-guard.yml';

/**
 * @param {string} job
 * @returns {{ name: string, body: string }[]}
 */
export function extractLegacyListGuardJobSteps(job) {
  const lines = job.split('\n');
  let stepsLineIndex = -1;
  let stepsIndent = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([ \t]+)steps:\s*$/);
    if (match) {
      stepsLineIndex = index;
      stepsIndent = match[1].length;
      break;
    }
  }
  if (stepsLineIndex < 0) {
    return [];
  }

  /** @type {string[]} */
  const stepLines = [];
  for (let index = stepsLineIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') {
      stepLines.push(line);
      continue;
    }
    const indent = line.match(/^([ \t]*)/)?.[1].length ?? 0;
    if (indent <= stepsIndent) {
      break;
    }
    stepLines.push(line);
  }

  /** @type {{ name: string, body: string }[]} */
  const steps = [];
  const block = stepLines.join('\n');
  const parts = block.split(/\n(?=[ \t]*- name:)/);
  for (const part of parts) {
    const nameMatch = part.match(/- name:\s*(.+)/);
    if (!nameMatch) {
      continue;
    }
    steps.push({ name: nameMatch[1].trim(), body: part });
  }
  return steps;
}

/**
 * @param {string} stepBody
 */
function isTrustedGuardStep(stepBody) {
  return /run-contract-evidence-legacy-list-guard\.mjs/.test(stepBody);
}

/**
 * @param {string} stepBody
 */
function isAllowedCheckoutStep(stepBody) {
  return /uses:\s*actions\/checkout@v4/.test(stepBody) && !/^\s+run:/m.test(stepBody);
}

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
  const steps = extractLegacyListGuardJobSteps(job);
  const guardIndex = steps.findIndex((step) => isTrustedGuardStep(step.body));

  if (!steps.some((step) => /Checkout PR head/.test(step.name))) {
    errors.push('job must checkout PR head');
  }
  if (!steps.some((step) => /Checkout trusted legacy list guard/.test(step.name))) {
    errors.push('job must checkout trusted base guard before evaluation');
  }
  if (guardIndex < 0) {
    errors.push('job must invoke pinned run-contract-evidence-legacy-list-guard.mjs entrypoint');
  }
  if (!/trusted-legacy-list-guard/.test(job)) {
    errors.push('job must run guard from trusted-legacy-list-guard path');
  }
  if (/LEGACY_LIST_GUARD_BOOTSTRAP/.test(job)) {
    errors.push('job must not expose reusable bootstrap environment override');
  }
  if (/LEGACY_LIST_GUARD_AUTH_SECRET[\s\S]*run-contract-evidence-legacy-list-guard/.test(job)) {
    errors.push('privileged auth material must not appear before trusted guard step');
  }
  if (/npm run[\s\S]*legacy-list/.test(job)) {
    errors.push('job must not route guard through PR-head npm script indirection');
  }

  if (guardIndex >= 0) {
    for (let index = 0; index < guardIndex; index += 1) {
      const step = steps[index];
      if (/^\s+run:/m.test(step.body)) {
        errors.push(
          `executable step "${step.name}" must not run before trusted guard completes`,
        );
        continue;
      }
      if (!isAllowedCheckoutStep(step.body)) {
        errors.push(
          `step "${step.name}" before trusted guard must be actions/checkout@v4 only`,
        );
      }
    }
  }

  const trustedIndex = steps.findIndex((step) => /Checkout trusted legacy list guard/.test(step.name));
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
