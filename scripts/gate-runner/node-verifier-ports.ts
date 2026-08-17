import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runProcess } from '#opk-kernel/subprocess';
import type { VerifyLine } from '../verify.ts';

export interface NodeVerifierPortResult {
  readonly lines: readonly VerifyLine[];
  readonly failures: readonly string[];
}

async function runGhInventoryStatic(repoRoot: string): Promise<string | undefined> {
  const guard = resolve(repoRoot, 'scripts/lib/gh-inventory-static-guard.mjs');
  const inventory = resolve(repoRoot, 'scripts/lib/graphql-quota-github-read-inventory.mjs');
  const roots = [
    ['scripts/lib/Gh-PrChecks.ps1', 'reconcile'],
    ['scripts/pr-scope-check.ps1', 'reconcile'],
    ['scripts/lib/Get-AutoReviewPrContext.ps1', 'reconcile'],
    ['scripts/worker-smoke-run.ts', 'reconcile'],
    ['AGENTS.md', 'rules'],
    ['CLAUDE.md', 'rules'],
    ['prompts/investigate_root_cause.md', 'rules'],
  ] as const;
  for (const [relativePath, mode] of roots) {
    const path = resolve(repoRoot, relativePath);
    if (!existsSync(path)) continue;
    const result = await runProcess({ command: 'node', args: [guard, path, '--mode', mode], cwd: repoRoot, inheritParentEnv: true, allowEmptyStdout: true });
    if (!result.ok) return `GitHub inventory guard failed for ${relativePath}: ${result.stderr || result.stdout || result.error || result.outcome}`;
  }
  const validation = await runProcess({ command: 'node', args: [inventory, 'validate', repoRoot], cwd: repoRoot, inheritParentEnv: true, allowEmptyStdout: true });
  if (!validation.ok) return `GitHub read inventory completeness failed: ${validation.stderr || validation.stdout || validation.error || validation.outcome}`;
  return undefined;
}

function reviewDeliveryFailure(repoRoot: string): string | undefined {
  const ps1 = ['ps', '1'].join('');
  const retired = [
    `scripts/lib/Invoke-ScriptedReviewStdoutDelivery.${ps1}`,
    `scripts/lib/Invoke-ScriptedReviewPostSubmitDelivery.${ps1}`,
  ];
  for (const relativePath of retired) if (existsSync(resolve(repoRoot, relativePath))) return `${relativePath} must remain absent after the delivery hard cut`;
  const deliveryPath = resolve(repoRoot, 'scripts/lib/pack-review-delivery.ts');
  if (!existsSync(deliveryPath)) return 'TypeScript pack-review delivery authority is missing';
  const delivery = readFileSync(deliveryPath, 'utf8');
  for (const marker of ['deliverPackReviewVerdict', 'writeRequiredStatus', 'notifyWorker', 'journalOutcome']) {
    if (!delivery.includes(marker)) return `pack-review-delivery.ts is missing required delivery marker: ${marker}`;
  }
  const forbidden = [
    'submit_visibility_timeout', 'Wait-ScriptedReviewSubmittedRun', 'find-submitted-run', 'resolve-submit-visibility-config',
    ['journaled-worker-send', ps1].join('.'), 'Get-RuntimeWorkerReviewsJson',
  ];
  for (const token of forbidden) if (delivery.includes(token)) return `pack-review-delivery.ts references retired delivery token: ${token}`;
  return undefined;
}

export async function runNodeVerificationPorts(repoRoot: string): Promise<NodeVerifierPortResult> {
  const lines: VerifyLine[] = [];
  const failures: string[] = [];
  const inventoryFailure = await runGhInventoryStatic(repoRoot);
  if (inventoryFailure) {
    failures.push(inventoryFailure);
    lines.push({ name: 'gh inventory static guard', status: 'FAIL', detail: inventoryFailure });
  } else lines.push({ name: 'gh inventory static guard', status: 'PASS', detail: 'Node-owned' });
  const deliveryFailure = reviewDeliveryFailure(repoRoot);
  if (deliveryFailure) {
    failures.push(deliveryFailure);
    lines.push({ name: 'review delivery hard-cut guard', status: 'FAIL', detail: deliveryFailure });
  } else lines.push({ name: 'review delivery hard-cut guard', status: 'PASS', detail: 'Node-owned' });
  return { lines, failures };
}
