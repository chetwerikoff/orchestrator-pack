import {
  checkPositiveOutcome,
  checkSmokeTestPlan,
  parseBehaviorKind,
} from '../draft-discipline.mjs';
import { checkContractEvidence } from '../contract-evidence-validator.mjs';
import { canonicalizeEntry } from '../pr-scope-declaration.ts';
import { parseIssueScopeFences } from '@orchestrator-pack/shared/lib/issue_parser.js';

export interface TierGateFloorOptions {
  repoRoot?: string;
  draftPath?: string;
}

function hasFence(text: string, name: string): boolean {
  return new RegExp('`{3}' + name + '\\s*\\n[\\s\\S]*?`{3}', 'm').test(text);
}

export function checkWorkerSafetyFloor(draftText: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const heading of [
    'Prerequisite',
    'Goal',
    'Binding surface',
    'Files in scope',
    'Files out of scope',
    'Acceptance criteria',
    'Upgrade-safety check',
    'Verification',
  ]) {
    const escaped = heading.replace(/[.*+?^$()|[\\]{}]/g, '\\$&');
    if (!new RegExp('^##\\s+' + escaped + '\\b', 'mi').test(draftText)) {
      errors.push('substantive floor: missing ## ' + heading + ' section');
    }
  }
  const parsedScope = parseIssueScopeFences(draftText);
  for (const fence of [
    'behavior-kind',
    'complexity-tier',
    'denylist',
    'allowed-roots',
    'smoke-test-plan',
    'contract-evidence',
  ]) {
    const present = fence === 'denylist' || fence === 'allowed-roots'
      ? parsedScope.occurrences.some((occurrence) => occurrence.kind === fence)
      : hasFence(draftText, fence);
    if (!present) {
      errors.push('substantive floor: missing ' + fence + ' fence');
    }
  }
  // Shared parser preserves field-local indices across repeated scope fences.
  const scope = parsedScope.constraints;
  for (const required of ['packages/core/**', 'vendor/**']) {
    if (!scope.denylist.includes(required)) {
      errors.push('worker-safety floor: denylist must include ' + required);
    }
  }
  for (const [entries, field] of [
    [scope.denylist, 'denylist'],
    [scope.allowed_roots ?? [], 'allowed_roots'],
  ] as const) {
    entries.forEach((entry, index) => {
      const result = canonicalizeEntry(entry, field, index);
      if (!result.ok) errors.push(result.error);
    });
  }
  return { ok: errors.length === 0, errors };
}

export function checkBehaviorKindFloor(draftText: string): { ok: boolean; errors: string[] } {
  if (!parseBehaviorKind(draftText)) {
    return { ok: false, errors: ['behavior-kind floor: missing or invalid behavior-kind fence'] };
  }
  const result = checkPositiveOutcome(draftText);
  return result.ok
    ? { ok: true, errors: [] }
    : { ok: false, errors: result.errors.map((error: string) => 'behavior-kind floor: ' + error) };
}

export function checkContractEvidenceFloor(
  draftText: string,
  options: TierGateFloorOptions = {},
): { ok: boolean; errors: string[] } {
  const result = checkContractEvidence(draftText, {
    repoRoot: options.repoRoot ?? process.cwd(),
    draftPath: options.draftPath,
  }) as { ok: boolean; errors: string[]; skipped?: boolean };
  if (result.ok || result.skipped) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: result.errors.map((error) => 'contract-evidence floor: ' + error),
  };
}

export function checkNeverSkippedFloors(
  draftText: string,
  options: TierGateFloorOptions = {},
): { ok: boolean; errors: string[] } {
  const checks = [
    checkWorkerSafetyFloor(draftText),
    checkBehaviorKindFloor(draftText),
    checkContractEvidenceFloor(draftText, options),
    checkSmokeTestPlan(draftText),
  ];
  const errors = checks.flatMap((check) => check.ok ? [] : check.errors);
  return { ok: errors.length === 0, errors };
}
