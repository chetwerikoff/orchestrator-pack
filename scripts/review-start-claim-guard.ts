#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOTS = ['scripts', 'docs', 'prompts', '.github', 'plugins'] as const;
const EXTENSIONS = new Set(['.ps1', '.psm1', '.mjs', '.js', '.ts', '.yml', '.yaml', '.md', '.json']);

function normalize(value: string): string {
  return value.replaceAll('\\', '/');
}
function extension(path: string): string {
  const match = /\.[^./]+$/u.exec(path);
  return match?.[0]?.toLowerCase() ?? '';
}
function walk(root: string, current: string): string[] {
  if (!existsSync(current)) return [];
  const rows: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) rows.push(...walk(root, absolute));
    else if (entry.isFile() && EXTENSIONS.has(extension(entry.name))) rows.push(normalize(relative(root, absolute)));
  }
  return rows;
}

export function reviewStartClaimGuard(repoRoot = resolve(import.meta.dirname, '..')): readonly string[] {
  const violations: string[] = [];
  const allowPath = join(repoRoot, 'scripts/review-start-claim-guard.allowlist.json');
  const allow = new Set<string>();
  if (existsSync(allowPath)) {
    const entries = JSON.parse(readFileSync(allowPath, 'utf8')) as Array<{ path?: string; justification?: string; interactiveOnly?: boolean }>;
    for (const entry of entries) {
      const path = normalize(String(entry.path ?? ''));
      if (!path || !entry.justification) violations.push('allowlist entry requires path and justification');
      else if (entry.interactiveOnly !== true) violations.push(`allowlist entry is not interactive-only: ${path}`);
      else allow.add(path);
    }
  }

  const retiredCli = String.fromCharCode(97, 111);
  const reviewRun = new RegExp(`(?:\\b${retiredCli}\\s+review\\s+run\\b|\\[\\s*['"]review['"]\\s*,\\s*['"]run['"]|@runArgs)`, 'isu');
  const claimGate = /(?:Acquire-ReviewStartClaim|acquireReviewStartClaim|review-start-claim-store\.ts|Review-StartClaimLifecycle\.ps1|Invoke-ReviewWakeTriggerOnCompletionWake|Invoke-ReviewTriggerReevalPlannedRun|Invoke-PlannedReviewRun|Invoke-OrchestratorClaimedReviewRun|invoke-orchestrator-claimed-review-run\.ps1)/isu;

  const paths = ROOTS.flatMap((root) => walk(repoRoot, join(repoRoot, root))).sort();
  for (const path of paths) {
    const runtimeScript = /^(?:scripts|plugins)\/.+\.(?:ps1|mjs|js|ts)$/u.test(path);
    if (!runtimeScript || allow.has(path)) continue;
    if (/^scripts\/check-.+\.ps1$/u.test(path)
      || /^scripts\/.*test.*\.ps1$/u.test(path)
      || path === 'scripts/reviewer-workspace-preflight.ps1'
      || path === 'scripts/lib/Invoke-ReviewerWorkspacePreflight.ps1'
      || path === 'scripts/lib/Review-MechanicalForbiddenCommand.ps1'
      || path === 'scripts/review-send-reconcile.ps1') continue;
    const source = readFileSync(join(repoRoot, path), 'utf8');
    if (reviewRun.test(source) && !claimGate.test(source)) {
      violations.push(`${path} reaches the retired review-run command without Review-StartClaim`);
    }
  }

  const bridge = join(repoRoot, 'scripts/lib/Review-StartClaimLifecycle.ps1');
  if (existsSync(bridge)) violations.push('retired PowerShell review-start claim bridge still exists');
  const store = join(repoRoot, 'scripts/lib/review-start-claim-store.ts');
  const runner = join(repoRoot, 'scripts/pack-review-runner.ts');
  if (!existsSync(store)) violations.push('TypeScript review-start claim authority is missing after bridge removal');
  if (!existsSync(runner)) violations.push('pack-review runner is missing after bridge removal');
  else {
    const source = readFileSync(runner, 'utf8');
    if (!/from\s+['"]\.\/lib\/review-start-claim-store\.ts['"]/u.test(source)) violations.push('pack-review runner is not bound directly to the TypeScript claim authority');
    if (source.includes('Review-StartClaimLifecycle.ps1')) violations.push('pack-review runner still references the removed claim bridge');
  }
  return violations;
}

if (import.meta.main) {
  const failures = reviewStartClaimGuard();
  if (failures.length) {
    process.stderr.write('review-start-claim guard failed:\n' + failures.map((item) => ` - ${item}`).join('\n') + '\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('[PASS] review-start-claim guard: TypeScript claim authority and empty retired executable closure verified\n');
  }
}
